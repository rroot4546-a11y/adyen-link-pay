"use strict";

const cfgKey = "adyenPayload";

const binInput = document.getElementById("bin");
const lengthSelect = document.getElementById("cardLength");
const holderInput = document.getElementById("holder");
const autoSubmit = document.getElementById("autoSubmit");
const autoOnLoad = document.getElementById("autoOnLoad");
const payBtn = document.getElementById("payBtn");
const statusDiv = document.getElementById("status");
const lastCardDiv = document.getElementById("lastCardInfo");

function save() {
  const cfg = {
    bin: binInput.value,
    cardLength: parseInt(lengthSelect.value, 10),
    holder: holderInput.value,
    autoSubmit: autoSubmit.checked,
    autoOnLoad: autoOnLoad.checked,
    enabled: true
  };
  chrome.storage.local.set({ [cfgKey]: cfg });
  return cfg;
}

function load() {
  chrome.storage.local.get([cfgKey], (res) => {
    const cfg = res[cfgKey] || {};
    binInput.value = cfg.bin || "";
    lengthSelect.value = String(cfg.cardLength || 16);
    holderInput.value = cfg.holder || "";
    autoSubmit.checked = !!cfg.autoSubmit;
    autoOnLoad.checked = !!cfg.autoOnLoad;
    if (cfg.lastCard) {
      lastCardDiv.textContent =
        "LAST: " + cfg.lastCard.number + " | " +
        cfg.lastCard.expiryMonth + "/" + cfg.lastCard.expiryYear +
        " | CVC " + cfg.lastCard.cvc;
    }
  });
}

payBtn.addEventListener("click", () => {
  if (!binInput.value.trim()) {
    statusDiv.textContent = "ERROR: Enter a BIN first, Chief.";
    return;
  }
  const cfg = save();
  statusDiv.textContent = "Pushing payload to tab...";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      statusDiv.textContent = "ERROR: No active tab.";
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { action: "autoPay" }, (res) => {
      const err = chrome.runtime.lastError;
      if (err || !res || !res.ok) {
        statusDiv.textContent = "Not on an Adyen page? Reload the checkout tab.";
      } else {
        statusDiv.textContent = "Payload fired.";
      }
    });
  });
});

load();
