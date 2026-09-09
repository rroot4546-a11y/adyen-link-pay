"use strict";

const RESP_RE = /(api\.stripe\.com|payment_pages|payment_intents|(stripe|checkout)\.stripe\.com.*(confirm|pay|submit))/;

const MAX_STORED = 50;
let captured = [];
let capturedResponses = [];
const dbgPending = new Map();
let dbgTabId = -1;

function walkAll(root) {
  const out = [];
  const seen = new Set();
  (function walk(node) {
    if (!node) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (node.nodeType === 1 || node.nodeType === 9 || node.shadowRoot) {
      let kids = [];
      if (node.nodeType === 9) {
        kids = kids.concat(Array.from(node.children));
      } else {
        if (node.shadowRoot) kids = kids.concat(Array.from(node.shadowRoot.children));
        kids = kids.concat(Array.from(node.children));
      }
      for (const k of kids) walk(k);
      if (node.nodeType === 1) out.push(node);
    }
  })(root);
  return out;
}

function classify(el) {
  const s = ((el.id || "") + " " + (el.name || "") + " " +
    (el.getAttribute("aria-label") || "") + " " +
    (el.getAttribute("placeholder") || "") + " " +
    (el.getAttribute("autocomplete") || "") + " " +
    (el.getAttribute("data-elements-stable-field-name") || "") + " " +
    (typeof el.className === "string" ? el.className : "")).toLowerCase();
  if (/(card\s*[-_ ]*number|ccnum|cc[-_ ]number|cardnumber|encryptedCardNumber|\bpan\b|enter your card number)/.test(s)) return "number";
  if (/(expiry|expiration)[-_ ]*(month)?|cardExpiry|encryptedExpiryMonth|expmonth/.test(s) && !/year/.test(s)) return "month";
  if (/(expiry|expiration)[-_ ]*year|cardExpiryYear|encryptedExpiryYear|expyear/.test(s) || (/exp/.test(s) && /year/.test(s))) return "year";
  if (/(cvc|cvv|csc|security)[-_ ]*(code)?|cardCvc|cardCvcFront|encryptedCvc/.test(s)) return "cvc";
  return null;
}

function typeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (!desc) return;
  desc.set.call(el, "");
  try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })); } catch (e) {}
  const str = String(value);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    desc.set.call(el, el.value + ch);
    try {
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: ch }));
      el.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key: ch }));
      el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: ch }));
    } catch (e) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  try { el.dispatchEvent(new InputEvent("input", { bubbles: true })); } catch (e) {}
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (!desc) return;
  desc.set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function injectFill(card) {
  const fields = { number: false, month: false, year: false, cvc: false };
  let any = false;
  let cvcEl = null;

  for (const inp of walkAll(document)) {
    if (inp.tagName !== "INPUT" && inp.tagName !== "SELECT") continue;
    if (inp.type === "hidden") continue;
    const kind = classify(inp);
    if (!kind) continue;
    if (kind === "number" && !fields.number) {
      typeValue(inp, card.number || "");
      fields.number = true; any = true;
    } else if (kind === "month" && !fields.month) {
      typeValue(inp, String(card.month || card.expiryMonth || "12").padStart(2, "0"));
      fields.month = true; any = true;
    } else if (kind === "year" && !fields.year) {
      typeValue(inp, String(card.year || card.expiryYear || "2029").slice(-2));
      fields.year = true; any = true;
    } else if (kind === "cvc" && !fields.cvc) {
      typeValue(inp, card.cvc || "");
      fields.cvc = true; any = true;
      cvcEl = inp;
    }
  }

  if (!fields.number) {
    const n = walkAll(document).filter((el) =>
      el.matches && el.matches('input[autocomplete="cc-number"], input[name*="cardNumber"], input[id*="cardNumber"]')
    )[0];
    if (n) { typeValue(n, card.number || ""); fields.number = true; any = true; }
  }
  if (!fields.month && !fields.year) {
    const e = walkAll(document).filter((el) =>
      el.matches && el.matches('input[autocomplete="cc-exp"], input[name*="expiry"], input[id*="expiry"]')
    )[0];
    if (e) {
      typeValue(e, String(card.month || card.expiryMonth || "12").padStart(2, "0") + "/" +
        String(card.year || card.expiryYear || "2029").slice(-2));
      fields.month = true; fields.year = true; any = true;
    }
  }
  if (!fields.cvc) {
    const c = walkAll(document).filter((el) =>
      el.matches && el.matches('input[autocomplete="cc-csc"], input[name*="securityCode"], input[name*="cvc"]')
    )[0];
    if (c) { typeValue(c, card.cvc || ""); fields.cvc = true; any = true; cvcEl = c; }
  }

  const holder = walkAll(document).filter((el) =>
    el.matches && el.matches('input[name*="holder"], input[id*="holder"], input[autocomplete="cc-name"]')
  )[0];
  if (holder) setNativeValue(holder, card.holder || "JOHN DOE");

  const email = walkAll(document).filter((el) =>
    el.matches && el.matches('input[type="email"], input[name*="email"], input[id*="email"]')
  )[0];
  const maybeEmail = card.holder && /@/.test(card.holder) ? card.holder : (card.email || "");
  if (email && maybeEmail) setNativeValue(email, maybeEmail);

  if (cvcEl) {
    const enter = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    try {
      cvcEl.dispatchEvent(new KeyboardEvent("keydown", enter));
      cvcEl.dispatchEvent(new KeyboardEvent("keypress", enter));
      cvcEl.dispatchEvent(new KeyboardEvent("keyup", enter));
    } catch (e) {}
  }

  return { fields: fields, any: any, url: location.href.slice(0, 120) };
}

function injectHook() {
  if (window.__stripapihooked) return;
  window.__stripapihooked = true;
  const isS = (u) => /api\.stripe\.com|payment_pages|payment_intents|(confirm|pay|submit)/.test(u);
  const push = (d) => {
    try { document.dispatchEvent(new CustomEvent("stripe-capture", { detail: d })); } catch (e) {}
  };
  const OX = window.XMLHttpRequest;
  if (OX) {
    try {
      window.XMLHttpRequest = function () {
        const x = new OX();
        const o = x.open;
        x.open = function (m, u) {
          x.__nurl = String(u || "");
          try { return o.apply(this, arguments); } catch (e) {}
        };
        x.addEventListener("load", function () {
          try {
            if (isS(String(x.__nurl || ""))) push({ kind: "xhr", url: x.__nurl, status: x.status, body: x.responseText || "" });
          } catch (e) {}
        });
        return x;
      };
      window.XMLHttpRequest.prototype = OX.prototype;
    } catch (e) {}
  }
  const OF = window.fetch;
  if (OF) {
    try {
      window.fetch = function (input) {
        const url = (typeof input === "string") ? input : (input && input.url ? input.url : "");
        const p = OF.apply(this, arguments);
        if (isS(url)) {
          p.then(function (res) {
            try {
              res.clone().text().then(function (t) {
                push({ kind: "fetch", url: url, status: res.status, body: t || "" });
              }).catch(function () {});
            } catch (e) {}
          }).catch(function () {});
        }
        return p;
      };
    } catch (e) {}
  }
}

function attemptPay() {
  const out = { clicked: [], detected: false, submitting: false };
  const els = walkAll(document);
  const candidates = [];
  for (const b of els) {
    if (!b.matches) continue;
    if (!b.matches("button, [role='button'], input[type='submit'], input[type='button'], a")) continue;
    const rect = b.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const label = ((b.innerText || b.value || b.getAttribute("aria-label") || "") + " " +
      (b.getAttribute("data-testid") || "") + " " + (b.id || "")).trim();
    const l = label.toLowerCase();
    const cls = (typeof b.className === "string" ? b.className : "").toLowerCase();
    const isSubmit = b.type === "submit" || b.matches("button[type='submit']") || /submit|pay|confirm|place order/.test(l) || /pay-button|submit/.test(cls);
    if (isSubmit && !b.disabled) candidates.push(b);
  }
  for (const b of candidates) {
    try { b.scrollIntoView({ block: "center" }); } catch (e) {}
    try { b.focus({ preventScroll: true }); } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
      try {
        const Ctor = t.indexOf("pointer") === 0 ? PointerEvent : MouseEvent;
        b.dispatchEvent(new Ctor(t, opts));
      } catch (e) {
        try { b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); } catch (e2) {}
      }
    });
    try { b.click(); } catch (e) {}
    out.clicked.push(((b.innerText || b.value || "btn").trim() || "btn").slice(0, 24));
  }
  const html = document.documentElement ? document.documentElement.innerHTML : "";
  const body = document.body ? document.body.innerText : "";
  out.submitting = /processing|please wait|connecting|spinner/.test(html.toLowerCase() + body.toLowerCase().slice(0, 800));
  out.detected = candidates.length > 0;
  return out;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === dbgTabId) detachDebugger();
});

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (!params) return;
  if (method === "Network.responseReceived") {
    const url = (params.response && params.response.url) || "";
    if (RESP_RE.test(url)) dbgPending.set(params.requestId, { url: url });
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
  } else if (method === "Network.loadingFailed") {
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
  chrome.storage.local.set({ stripe_resp: rec });
  chrome.runtime.sendMessage({ type: "STRIPE_RESPONSE_CAPTURED", resp: rec }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "FF_EXEC") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ error: "no-tab", results: [] }); return true; }
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: injectFill,
      args: [msg.card || {}]
    }).then((res) => {
      const results = (res || []).map((r) => r.result).filter(Boolean);
      const any = results.some((r) => r && r.any);
      const fields = results.reduce((acc, r) => {
        if (!r || !r.fields) return acc;
        ["number", "month", "year", "cvc"].forEach((f) => { if (r.fields[f]) acc[f] = true; });
        return acc;
      }, { number: false, month: false, year: false, cvc: false });
      sendResponse({ results: results, any: any, fields: fields });
    }).catch((err) => sendResponse({ error: String((err && err.message) || err), results: [] }));
    return true;
  }

  if (msg && msg.action === "FF_PAY") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ error: "no-tab", clicked: [], detected: false }); return true; }
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: attemptPay
    }).then((res) => {
      const list = (res || []).map((r) => r.result).filter(Boolean);
      sendResponse({
        clicked: list.reduce((a, r) => a.concat(r.clicked || []), []),
        detected: list.some((r) => r.detected),
        submitting: list.some((r) => r.submitting)
      });
    }).catch((err) => sendResponse({ error: String((err && err.message) || err), clicked: [], detected: false }));
    return true;
  }

  if (msg && msg.action === "FF_HOOK") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ error: "no-tab" }); return true; }
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: injectHook
    }).then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }

  if (msg && msg.action === "DBG_ATTACH") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ error: "no-tab" }); return true; }
    attachDebugger(tabId).then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.action === "DBG_DETACH") {
    detachDebugger();
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === "GET_RESPONSES") {
    sendResponse({ responses: capturedResponses });
    return true;
  }
  return true;
});