"use strict";

const PROXY_LIST_KEY = "nonoProxyList";
const PROXY_STATE_KEY = "nonoProxyState";

const DEFAULT_BYPASS = ["localhost", "127.0.0.1", "::1", "<local>"];

async function loadList() {
  const r = await chrome.storage.local.get(PROXY_LIST_KEY);
  return Array.isArray(r[PROXY_LIST_KEY]) ? r[PROXY_LIST_KEY] : [];
}

async function saveList(list) {
  await chrome.storage.local.set({ [PROXY_LIST_KEY]: list });
}

async function loadState() {
  const r = await chrome.storage.local.get(PROXY_STATE_KEY);
  return r[PROXY_STATE_KEY] || {
    enabled: false,
    mode: "single",
    index: 0,
    exitIP: "",
    lastError: ""
  };
}

async function saveState(st) {
  await chrome.storage.local.set({ [PROXY_STATE_KEY]: st });
}

function parseProxyLine(raw) {
  const line = String(raw || "").trim();
  if (!line) return null;
  let input = line;
  let scheme = "http";
  const schemeMatch = /^(https?|socks4|socks5|quic):\/\//i.exec(line);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    input = line.slice(schemeMatch[0].length);
  }
  let userinfo = null;
  const at = input.lastIndexOf("@");
  if (at !== -1) {
    userinfo = input.slice(0, at);
    input = input.slice(at + 1);
  }
  const hostPort = input.split("/")[0].trim();
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(hostPort);
  if (!m || !m[1]) return null;
  const host = m[1];
  const port = m[2]
    ? parseInt(m[2], 10)
    : scheme === "https" ? 443 : scheme.indexOf("socks") === 0 ? 1080 : 8080;
  if (!port || isNaN(port)) return null;
  let username = null;
  let password = null;
  if (userinfo) {
    const sep = userinfo.indexOf(":");
    if (sep === -1) username = userinfo;
    else {
      username = userinfo.slice(0, sep);
      password = userinfo.slice(sep + 1);
    }
  }
  return {
    raw: line,
    scheme: scheme,
    host: host,
    port: port,
    username: username || null,
    password: password || null,
    label: scheme + "://" + host + ":" + port
  };
}

function parseProxyText(text) {
  const out = [];
  for (const l of String(text || "").split(/\r?\n/)) {
    const p = parseProxyLine(l);
    if (p) out.push(p);
  }
  return out;
}

function buildProxyConfig(scheme, host, port) {
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: { scheme: scheme, host: host, port: port },
      bypassList: DEFAULT_BYPASS.slice()
    }
  };
}

function applyProxyServer(p, scope) {
  return new Promise((resolve) => {
    chrome.proxy.settings.set(
      { value: buildProxyConfig(p.scheme, p.host, p.port), scope: scope || "regular" },
      () => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : { ok: true });
      }
    );
  });
}

function clearProxy(scope) {
  return new Promise((resolve) => {
    chrome.proxy.settings.set(
      { value: { mode: "system" }, scope: scope || "regular" },
      () => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : { ok: true });
      }
    );
  });
}

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function applyCurrent() {
  const st = await loadState();
  const list = await loadList();
  if (!st.enabled) {
    const r = await clearProxy();
    return { ok: r.ok, proxy: null, error: r.error };
  }
  if (!list.length) {
    await clearProxy();
    return { ok: false, proxy: null, error: "no proxies loaded" };
  }
  if (st.index >= list.length) st.index = 0;
  const p = list[st.index];
  await saveState(st);
  const r = await applyProxyServer(p);
  return { ok: r.ok, proxy: p, error: r.error };
}

async function rotate(next) {
  const st = await loadState();
  const list = await loadList();
  if (!list.length) return { ok: false, proxy: null, error: "no proxies loaded" };
  let idx;
  if (typeof next === "number" && next >= 0 && next < list.length) {
    idx = next;
  } else {
    idx = st.index + 1;
    if (idx >= list.length) idx = 0;
  }
  st.index = idx;
  st.enabled = true;
  st.lastError = "";
  await saveState(st);
  const p = list[idx];
  const r = await applyProxyServer(p);
  return { ok: r.ok, proxy: p, error: r.error };
}

async function testProxy(index) {
  const list = await loadList();
  if (!list[index]) return { ok: false, error: "no proxy at index " + index };
  const prev = await loadState();
  const t0 = Date.now();
  const applied = await applyProxyServer(list[index]);
  if (!applied.ok) {
    if (prev.enabled && prev.index < list.length) await applyProxyServer(list[prev.index]);
    else await clearProxy();
    return { ok: false, error: applied.error };
  }
  try {
    const res = await fetchWithTimeout("https://api.ipify.org?format=json", 10000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    const ip = (j && j.ip) || "";
    const ms = Date.now() - t0;
    if (prev.enabled && prev.index < list.length) await applyProxyServer(list[prev.index]);
    else await clearProxy();
    return { ok: true, ip: ip, ms: ms, label: list[index].label };
  } catch (e) {
    if (prev.enabled && prev.index < list.length) await applyProxyServer(list[prev.index]);
    else await clearProxy();
    return { ok: false, error: e.name === "AbortError" ? "timeout" : (e.message || String(e)) };
  }
}

async function testAll() {
  const list = await loadList();
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const r = await testProxy(i);
    results.push(Object.assign({ index: i }, r));
    chrome.runtime.sendMessage({ type: "PROXY_PROGRESS", results: results.slice() }).catch(() => {});
  }
  chrome.runtime.sendMessage({ type: "PROXY_TEST_DONE", results: results }).catch(() => {});
  return results;
}

chrome.proxy.onProxyError.addListener((details) => {
  void (async () => {
    const st = await loadState();
    if (!st.enabled) return;
    if (st.mode === "rotate") {
      const r = await rotate();
      if (r.proxy) {
        chrome.runtime.sendMessage({
          type: "PROXY_SWITCHED",
          proxy: r.proxy.label,
          reason: String(details.error || "proxy error")
        }).catch(() => {});
      }
    }
  })();
});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (/^https?:$/.test(String(details.scheme || ""))) {
      void (async () => {
        const st = await loadState();
        const list = await loadList();
        const p = st.enabled ? list[st.index] : null;
        if (p && p.username) {
          callback({ authCredentials: { username: p.username, password: p.password || "" } });
        } else {
          callback({});
        }
      })();
    } else {
      callback({});
    }
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);