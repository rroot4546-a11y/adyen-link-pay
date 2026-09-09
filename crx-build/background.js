"use strict";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ adyenPayload: { enabled: false } });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => true
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "pay") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "autoPay" }, (res) => {
          sendResponse(res || { ok: false });
        });
      }
    });
    return true;
  }
});
