"use strict";

const ADYEN_PATTERNS = [
  '*://checkoutshopper-live.adyen.com/checkoutshopper/v1/*',
  '*://checkoutshopper-test.adyen.com/checkoutshopper/v1/*',
  '*://checkoutshopper-live.adyen.com/checkoutshopper/sessions/*',
  '*://*.adyen.com/*/sessions/*'
];

const MAX_STORED = 50;
let captured = [];
const pending = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId === -1) return;

    pending.set(details.requestId, {
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      timeStamp: details.timeStamp,
      body: null,
      requestHeaders: [],
      statusCode: null
    });

    if (details.requestBody) {
      const req = pending.get(details.requestId);
      try {
        if (details.requestBody.raw && details.requestBody.raw[0] && details.requestBody.raw[0].bytes) {
          const bytes = details.requestBody.raw[0].bytes;
          const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          if (!decoded.includes('\uFFFD')) req.body = decoded;
        } else if (details.requestBody.formData) {
          const params = new URLSearchParams();
          for (const [key, values] of Object.entries(details.requestBody.formData)) {
            for (const v of values) params.append(key, v);
          }
          req.body = params.toString();
        }
      } catch (e) {}
    }
  },
  { urls: ADYEN_PATTERNS },
  ['requestBody']
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const req = pending.get(details.requestId);
    if (!req) return;
    req.requestHeaders = details.requestHeaders || [];
  },
  { urls: ADYEN_PATTERNS },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const req = pending.get(details.requestId);
    if (!req) return;

    req.statusCode = details.statusCode;
    pending.delete(details.requestId);

    const isInteresting = req.body &&
      (req.body.includes('sessionData') || req.body.includes('paymentMethod') || req.body.includes('card'));

    if (!isInteresting) return;

    captured.unshift(req);
    if (captured.length > MAX_STORED) captured.pop();

    chrome.action.setBadgeText({ text: String(captured.length), tabId: req.tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4ec9b0' });

    chrome.runtime.sendMessage({
      type: 'ADYEN_REQUEST_CAPTURED',
      request: req,
      curl: generateCurl(req)
    }).catch(() => {});

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Adyen Request Captured',
      message: req.method + ' ' + truncateUrl(req.url)
    }, () => {});
  },
  { urls: ADYEN_PATTERNS }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => pending.delete(details.requestId),
  { urls: ADYEN_PATTERNS }
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'FF_HOOK') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ error: 'no-tab' });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: injectResponseHook
    }).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ error: String((err && err.message) || err) });
    });
    return true;
  }
  if (msg && msg.type === 'GET_CAPTURED') {
    sendResponse({ captured });
    return true;
  }
  if (msg && msg.type === 'CLEAR_CAPTURED') {
    captured = [];
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.action === 'FF_EXEC') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ error: 'no-tab', results: [] });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: injectFill,
      args: [msg.card || {}]
    }).then((res) => {
      const results = (res || [])
        .map((r) => r.result)
        .filter(Boolean);
      const any = results.some((r) => r && r.any);
      const fields = results.reduce((acc, r) => {
        if (!r || !r.fields) return acc;
        ['number', 'month', 'year', 'cvc'].forEach((f) => {
          if (r.fields[f]) acc[f] = true;
        });
        return acc;
      }, { number: false, month: false, year: false, cvc: false });
      sendResponse({ results: results, any: any, fields: fields });
    }).catch((err) => {
      sendResponse({ error: String((err && err.message) || err), results: [] });
    });
    return true;
  }
});

function injectFill(card) {
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc) return;
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function typeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc) return;
    desc.set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const str = String(value);
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      desc.set.call(el, el.value + ch);
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch }));
        el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: ch }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch }));
      } catch (e) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function classify(el) {
    const s = ((el.id || '') + ' ' + (el.name || '') + ' ' +
      (el.getAttribute('aria-label') || '') + ' ' +
      (el.getAttribute('data-fieldtype') || '') + ' ' +
      (el.getAttribute('autocomplete') || '') + ' ' +
      (typeof el.className === 'string' ? el.className : '')).toLowerCase();
    if (/(card\s*[-_ ]*number|ccnum|cc[-_ ]number|\bpan\b|encrypted\w*(number|pan))/.test(s)) return 'number';
    if (/(expiry|expiration)[-_ ]*(month)?|encrypted\w*month|expmonth/.test(s) && !/year/.test(s)) return 'month';
    if (/(expiry|expiration)[-_ ]*year|encrypted\w*year|expyear/.test(s) || (/exp/.test(s) && /year/.test(s))) return 'year';
    if (/(cvc|cvv|csc|security)[-_ ]*(code)?/.test(s)) return 'cvc';
    return null;
  }

  const fields = { number: false, month: false, year: false, cvc: false };
  let any = false;

  const inputs = Array.from(document.querySelectorAll('input'));
  for (const inp of inputs) {
    if (inp.type === 'hidden') continue;
    const kind = classify(inp);
    if (!kind) continue;
    if (kind === 'number' && !fields.number) {
      typeValue(inp, card.number || '');
      fields.number = true; any = true;
    } else if (kind === 'month' && !fields.month) {
      typeValue(inp, String(card.month || card.expiryMonth || '12').padStart(2, '0'));
      fields.month = true; any = true;
    } else if (kind === 'year' && !fields.year) {
      typeValue(inp, String(card.year || card.expiryYear || '2029').slice(-2));
      fields.year = true; any = true;
    } else if (kind === 'cvc' && !fields.cvc) {
      typeValue(inp, card.cvc || '');
      fields.cvc = true; any = true;
    }
  }

  if (!fields.number) {
    const n = document.querySelector(
      'input[autocomplete="cc-number"], input[name*="cardNumber"], input[id*="cardNumber"]'
    );
    if (n) { typeValue(n, card.number || ''); fields.number = true; any = true; }
  }
  if (!fields.month && !fields.year) {
    const e = document.querySelector(
      'input[autocomplete="cc-exp"], input[name*="expiry"], input[id*="expiry"]'
    );
    if (e) {
      typeValue(e, String(card.month || card.expiryMonth || '12').padStart(2, '0') + '/' +
        String(card.year || card.expiryYear || '2029').slice(-2));
      fields.month = true; fields.year = true; any = true;
    }
  }
  if (!fields.cvc) {
    const c = document.querySelector(
      'input[autocomplete="cc-csc"], input[name*="securityCode"], input[name*="cvc"]'
    );
    if (c) { typeValue(c, card.cvc || ''); fields.cvc = true; any = true; }
  }

  const holderEl = document.querySelector(
    'input[name*="holder"], input[id*="holder"], input[autocomplete="cc-name"]'
  );
  if (holderEl) setNativeValue(holderEl, card.holder || 'JOHN DOE');

  const emailEl = document.querySelector('input[type="email"], input[name*="email"], input[id*="email"]');
  const candidateEmail = card.holder && /@/.test(card.holder) ? card.holder : (card.email || '');
  if (emailEl && candidateEmail) {
    setNativeValue(emailEl, candidateEmail);
  }

  return { fields: fields, any: any, url: location.href.slice(0, 120) };
}

function injectResponseHook() {
  if (window.__nonohooked) return;
  window.__nonohooked = true;

  const isAdyen = (url) => /checkoutshopper.*\/(payments|sessions|submit)(\?|$)/.test(url);

  const push = (data) => {
    try {
      document.dispatchEvent(new CustomEvent('nonnho-capture', { detail: data }));
    } catch (e) {}
  };

  const OXHR = window.XMLHttpRequest;
  if (OXHR) {
    try {
      window.XMLHttpRequest = function () {
        const x = new OXHR();
        const oOpen = x.open;
        x.open = function (m, url, ...rest) {
          x.__nurl = String(url || '');
          try { return oOpen.apply(this, [m, url, ...rest]); }
          catch (e) { return oOpen.apply(this, arguments); }
        };
        x.addEventListener('load', function () {
          try {
            const u = String(x.__nurl || '');
            if (isAdyen(u)) {
              push({ kind: 'xhr', url: u, status: x.status, body: x.responseText || '' });
            }
          } catch (e) {}
        });
        return x;
      };
      window.XMLHttpRequest.prototype = OXHR.prototype;
    } catch (e) {}
  }

  const OF = window.fetch;
  if (OF) {
    try {
      window.fetch = function (input, init) {
        const url = (typeof input === 'string')
          ? input
          : (input && input.url ? input.url : '');
        const p = OF.apply(this, arguments);
        if (isAdyen(url)) {
          p.then((res) => {
            try {
              const clone = res.clone();
              clone.text().then((t) => {
                push({ kind: 'fetch', url: url, status: res.status, body: t || '' });
              }).catch(() => {});
            } catch (e) {}
          }).catch(() => {});
        }
        return p;
      };
    } catch (e) {}
  }
}

function stripHdr(h) {
  const name = (h.name || '').toLowerCase();
  return ['host', 'connection', 'content-length', 'accept-encoding'].includes(name);
}

function generateCurl(req) {
  const lines = ["curl '" + (req.url || '') + "'"];

  if (req.requestHeaders && Array.isArray(req.requestHeaders)) {
    const sorted = [...req.requestHeaders]
      .filter((h) => !stripHdr(h))
      .sort((a, b) => {
        const na = (a.name || '').toLowerCase();
        const nb = (b.name || '').toLowerCase();
        if (na === 'user-agent') return 1;
        if (nb === 'user-agent') return -1;
        return na.localeCompare(nb);
      });
    for (const h of sorted) {
      lines.push('  -H ' + sq((h.name || '').toLowerCase() + ': ' + (h.value || '')));
    }
  }

  if (req.body && typeof req.body === 'string') {
    lines.push('  --data-raw $' + dqLD(req.body));
  }

  return lines.join(' \\\n');
}

function sq(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function dqLD(str) {
  return "'" + str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + "'";
}

function truncateUrl(url, max) {
  max = max || 60;
  return url.length > max ? url.slice(0, max) + '…' : url;
}