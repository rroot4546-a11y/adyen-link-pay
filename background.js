"use strict";

const ADYEN_PATTERNS = [
  '*://checkoutshopper-live.adyen.com/checkoutshopper/v1/*',
  '*://checkoutshopper-test.adyen.com/checkoutshopper/v1/*',
  '*://checkoutshopper-live.adyen.com/checkoutshopper/sessions/*',
  '*://*.adyen.com/*/sessions/*'
];

const MAX_STORED = 50;
let captured = [];
const pending = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId === -1) return;

    pending.set(details.requestId, {
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      timeStamp: details.timeStamp,
      body: null,
      requestHeaders: [],
      statusCode: null
    });

    if (details.requestBody) {
      const req = pending.get(details.requestId);
      try {
        if (details.requestBody.raw && details.requestBody.raw[0] && details.requestBody.raw[0].bytes) {
          const bytes = details.requestBody.raw[0].bytes;
          const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          if (!decoded.includes('\uFFFD')) req.body = decoded;
        } else if (details.requestBody.formData) {
          const params = new URLSearchParams();
          for (const [key, values] of Object.entries(details.requestBody.formData)) {
            for (const v of values) params.append(key, v);
          }
          req.body = params.toString();
        }
      } catch (e) {}
    }
  },
  { urls: ADYEN_PATTERNS },
  ['requestBody']
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const req = pending.get(details.requestId);
    if (!req) return;
    req.requestHeaders = details.requestHeaders || [];
  },
  { urls: ADYEN_PATTERNS },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const req = pending.get(details.requestId);
    if (!req) return;

    req.statusCode = details.statusCode;
    pending.delete(details.requestId);

    const isInteresting = req.body &&
      (req.body.includes('sessionData') || req.body.includes('paymentMethod') || req.body.includes('card'));

    if (!isInteresting) return;

    captured.unshift(req);
    if (captured.length > MAX_STORED) captured.pop();

    chrome.action.setBadgeText({ text: String(captured.length), tabId: req.tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4ec9b0' });

    chrome.runtime.sendMessage({
      type: 'ADYEN_REQUEST_CAPTURED',
      request: req,
      curl: generateCurl(req)
    }).catch(() => {});

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Adyen Request Captured',
      message: req.method + ' ' + truncateUrl(req.url)
    }, () => {});
  },
  { urls: ADYEN_PATTERNS }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => pending.delete(details.requestId),
  { urls: ADYEN_PATTERNS }
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'GET_CAPTURED') {
    sendResponse({ captured });
    return true;
  }
  if (msg && msg.type === 'CLEAR_CAPTURED') {
    captured = [];
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
    return true;
  }
});

function stripHdr(h) {
  const name = (h.name || '').toLowerCase();
  return ['host', 'connection', 'content-length', 'accept-encoding'].includes(name);
}

function generateCurl(req) {
  const lines = ["curl '" + (req.url || '') + "'"];

  if (req.requestHeaders && Array.isArray(req.requestHeaders)) {
    const sorted = [...req.requestHeaders]
      .filter((h) => !stripHdr(h))
      .sort((a, b) => {
        const na = (a.name || '').toLowerCase();
        const nb = (b.name || '').toLowerCase();
        if (na === 'user-agent') return 1;
        if (nb === 'user-agent') return -1;
        return na.localeCompare(nb);
      });
    for (const h of sorted) {
      lines.push('  -H ' + sq((h.name || '').toLowerCase() + ': ' + (h.value || '')));
    }
  }

  if (req.body && typeof req.body === 'string') {
    lines.push('  --data-raw $' + dqLD(req.body));
  }

  return lines.join(' \\\n');
}

function sq(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function dqLD(str) {
  return "'" + str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + "'";
}

function truncateUrl(url, max) {
  max = max || 60;
  return url.length > max ? url.slice(0, max) + '…' : url;
}