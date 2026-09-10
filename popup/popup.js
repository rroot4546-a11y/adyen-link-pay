"use strict";

document.addEventListener('DOMContentLoaded', () => {
  loadRequests();
  proxyStatus();

  document.getElementById('clear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURED' });
    render([]);
  });

  document.getElementById('proxy').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ADYEN_REQUEST_CAPTURED') {
      loadRequests();
    }
  });
});

function proxyStatus() {
  chrome.runtime.sendMessage({ action: 'PROXY_STATUS' }, (res) => {
    const el = document.getElementById('proxy-status');
    if (!el) return;
    if (chrome.runtime.lastError || !res) return;
    el.style.display = 'block';
    el.innerHTML = (res.enabled && res.proxy)
      ? 'Proxy: <b>' + (res.proxy.label || res.label) + '</b>' +
        ' ' + (res.proxy.mode ? '' : '') +
        (res.proxy.username ? ' · auth' : '') +
        ' · <span id="open-options">settings</span>'
      : 'Proxy: <b>OFF</b> · <span id="open-options">settings</span>';
    const link = document.getElementById('open-options');
    if (link) {
      link.style.cssText = 'cursor:pointer;text-decoration:underline;color:#7fd4c2';
      link.addEventListener('click', () => chrome.runtime.openOptionsPage());
    }
  });
}

function loadRequests() {
  chrome.runtime.sendMessage({ type: 'GET_CAPTURED' }, (res) => {
    if (chrome.runtime.lastError) {
      console.warn('GET_CAPTURED error:', chrome.runtime.lastError.message);
    }
    render((res && res.captured) || []);
  });
}

function render(requests) {
  const container = document.getElementById('requests');
  const countEl = document.getElementById('count');
  countEl.textContent = String(requests.length);

  if (requests.length === 0) {
    container.innerHTML = `
      <div class="empty">
        Waiting for checkoutshopper requests…<br>
        <small>Only sessions / payment submits are kept.</small>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  requests.forEach((req, idx) => {
    const card = document.createElement('div');
    card.className = 'req-card';

    let curlText = '';
    let curlError = false;
    try {
      curlText = generateCurl(req);
    } catch (e) {
      console.error('generateCurl failed', e);
      curlError = true;
      curlText = '// Error generating cURL:\n// ' + e.message + '\n// Raw URL: ' + req.url;
    }

    card.innerHTML =
      '<div class="req-header" data-idx="' + idx + '">' +
        '<div class="url-wrap"><span class="url"><span class="method">' +
        escapeHtml(req.method || 'REQ') + '</span>' +
        escapeHtml(truncate(req.url, 46)) + '</span></div>' +
        '<button class="btn-copy" data-idx="' + idx + '">Copy</button>' +
      '</div>' +
      '<div class="detail" id="detail-' + idx + '">' +
        '<div class="detail-label">cURL Command</div>' +
        '<pre id="curl-' + idx + '">' + escapeHtml(curlText) + '</pre>' +
        (curlError ? '' :
        '<div class="detail-actions">' +
          '<button class="btn-copy-detail" data-idx="' + idx + '" aria-label="Copy cURL command to clipboard">' +
            '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
              '<rect x="8" y="8" width="11" height="11" rx="2"></rect>' +
              '<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>' +
            '</svg>' +
            '<span class="btn-label">Copy to Clipboard</span>' +
          '</button>' +
        '</div>') +
      '</div>';

    container.appendChild(card);
  });

  container.onclick = (e) => {
    const header = e.target.closest('.req-header');
    if (header && !e.target.closest('button')) {
      const idx = header.dataset.idx;
      const dt = document.getElementById('detail-' + idx);
      if (dt) dt.classList.toggle('open');
    }

    const copyButton = e.target.closest('.btn-copy, .btn-copy-detail');
    if (copyButton) {
      const idx = copyButton.dataset.idx;
      try {
        copyText(generateCurl(requests[idx]), copyButton);
      } catch (e) {
        console.error('copy failed', e);
      }
    }
  };
}

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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function copyText(text, btn) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);

  const isDetail = btn.classList.contains('btn-copy-detail');
  const labelSpan = btn.querySelector('.btn-label');
  const ori = labelSpan ? labelSpan.textContent : btn.textContent;

  if (labelSpan) labelSpan.textContent = 'Copied!';
  else btn.textContent = 'Copied!';
  btn.classList.add('copied');
  setTimeout(() => {
    if (labelSpan) labelSpan.textContent = ori;
    else btn.textContent = ori;
    btn.classList.remove('copied');
  }, 1500);
}