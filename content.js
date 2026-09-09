"use strict";

(function () {
  const cfgKey = "adyenPayload";
  let running = false;

  function getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get([cfgKey], (res) => {
        resolve(res[cfgKey] || null);
      });
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

  function waitFor(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(timer);
          resolve(el);
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error("timeout: " + selector));
        }
      }, 200);
    });
  }

  async function huntAndFill(card, holder) {
    const frames = Array.from(document.querySelectorAll("iframe"));
    const filled = { number: false, month: false, year: false, cvc: false };

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
        } else if (filled.number && !filled.month && /expiry.*(month|date)|expmonth/i.test(lower)) {
          setNativeValue(inp, card.expiryMonth);
          filled.month = true;
        } else if (filled.month && !filled.year && /expiry.*year|expyear/i.test(lower)) {
          setNativeValue(inp, card.expiryYear.slice(-2));
          filled.year = true;
        } else if (/cvc|cvv|cid/i.test(lower) && !filled.cvc) {
          setNativeValue(inp, card.cvc);
          filled.cvc = true;
        }
      }
    }

    const holderInputs = Array.from(document.querySelectorAll(
      'input[name*="holder"], input[id*="holder"], input[autocomplete*="name"]'
    ));
    holderInputs.forEach((el) => setNativeValue(el, holder));

    fillShadowFields(card, holder);

    return filled;
  }

  function fillShadowFields(card, holder) {
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
    const found = {};
    inputAttrs.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) found[el.type + el.name] = el;
    });

    Object.values(found).forEach((el) => {
      const nameLower = ((el.name || "") + (el.id || "")).toLowerCase();
      if (/card.*number/.test(nameLower) || el.autocomplete === "cc-number") {
        setNativeValue(el, card.number);
      } else if (el.autocomplete === "cc-name") {
        setNativeValue(el, holder);
      } else if (el.autocomplete === "cc-exp") {
        setNativeValue(el, card.expiryMonth + "/" + card.expiryYear.slice(-2));
      } else if (/cvc|csc|security/.test(nameLower)) {
        setNativeValue(el, card.cvc);
      }
    });
  }

  async function submit(tries = 0) {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const b of buttons) {
      const t = (b.innerText || "").toLowerCase();
      if (/pay|continue|submit|confirm/i.test(t)) {
        b.click();
        return true;
      }
    }
    if (tries < 5) {
      setTimeout(() => submit(tries + 1), 1000);
    }
    return false;
  }

  async function run() {
    const cfg = await getConfig();
    if (!cfg || !cfg.enabled) return;
    if (running) return;
    running = true;

    const bin = cfg.bin.replace(/\s/g, "");
    const card = window.CardGen.genCard(bin, {
      length: cfg.cardLength || 16
    });

    cfg.lastCard = card;
    chrome.storage.local.set({ [cfgKey]: cfg });

    await waitFor("iframe", 6000).catch(() => null);

    await huntAndFill(card, cfg.holder);
    await new Promise((r) => setTimeout(r, 800));

    if (cfg.autoSubmit) {
      await submit();
    }

    running = false;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === "autoPay") {
      run().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg && msg.action === "status") {
      sendResponse({ running: running });
      return true;
    }
  });

  getConfig().then((cfg) => {
    if (cfg && cfg.enabled && cfg.autoOnLoad) {
      setTimeout(run, 2500);
    }
  });
})();
