"use strict";

const $ = (id) => document.getElementById(id);

async function send(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ action: action }, payload || {}), (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || {});
    });
  });
}

function setBadge(state) {
  const b = $("active-badge");
  b.textContent = state.enabled ? "PROXY ON" : "PROXY OFF";
  b.className = "badge " + (state.enabled ? "on" : "off");
  $("mode").value = state.mode || "single";
  $("enabled").checked = !!state.enabled;
}

function renderStatus(state, list) {
  const box = $("live-status");
  if (!state.enabled || !list.length) {
    box.textContent = state.lastError
      ? "Last error: " + state.lastError
      : "No proxy applied yet. Enable and pick a proxy.";
    box.className = "status" + (state.lastError ? " err" : "");
    return;
  }
  const p = list[state.index];
  box.className = "status ok";
  box.textContent =
    "Active [" + (state.index + 1) + "/" + list.length + "]  " + (p ? p.label : "?") +
    (p && p.username ? "  (auth configured)" : "") +
    (state.exitIP ? "\nExit IP: " + state.exitIP : "");
}

function renderResults(results) {
  const box = $("results");
  box.innerHTML = "";
  if (!results.length) return;
  for (const r of results) {
    const line = document.createElement("div");
    line.className = "res-line";
    const okCls = r.ok ? "ok" : "bad";
    line.innerHTML =
      '<span class="tag ' + okCls + '">#' + (r.index + 1) + "</span>" +
      '<span>' + (r.label || "") + '</span>' +
      '<span class="' + okCls + '">' + (r.ok ? r.ip + " · " + r.ms + "ms" : (r.error || "fail")) + "</span>";
    box.appendChild(line);
  }
}

async function refresh() {
  const r = await send("PROXY_GET_STATE");
  if (r.state) {
    setBadge(r.state);
    renderStatus(r.state, r.list || []);
    $("proxies").value = (r.list || []).map((p) => p.raw).join("\n");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await refresh();

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "PROXY_PROGRESS") renderResults(msg.results || []);
    if (msg.type === "PROXY_SWITCHED") {
      const box = $("live-status");
      box.textContent = "Rotated to " + msg.proxy + " (" + msg.reason + ")";
      box.className = "status";
    }
  });

  $("save").addEventListener("click", async () => {
    const text = $("proxies").value;
    const r = await send("PROXY_PARSE_LIST", { text: text });
    if (r.error) {
      $("live-status").textContent = "Parse error: " + r.error;
      $("live-status").className = "status err";
      return;
    }
    await refresh();
    $("live-status").textContent = "Saved " + (r.list ? r.list.length : 0) + " proxies.";
    $("live-status").className = "status ok";
  });

  $("enabled").addEventListener("change", async () => {
    const state = (await send("PROXY_GET_STATE")).state || {};
    const r = await send("PROXY_SET_STATE", {
      enabled: $("enabled").checked,
      mode: $("mode").value,
      index: state.index || 0
    });
    if (r.proxy) {
      $("live-status").textContent = "Applied " + r.proxy.label;
      $("live-status").className = "status ok";
    } else if (r.error) {
      $("live-status").textContent = "Error: " + r.error;
      $("live-status").className = "status err";
    }
    refresh();
  });

  $("mode").addEventListener("change", async () => {
    const state = (await send("PROXY_GET_STATE")).state || {};
    await send("PROXY_SET_STATE", {
      enabled: state.enabled,
      mode: $("mode").value,
      index: state.index || 0
    });
  });

  $("test-all").addEventListener("click", async () => {
    $("results").innerHTML = "";
    $("test-all").disabled = true;
    const r = await send("PROXY_TEST_ALL");
    if (!r.running) {
      renderResults((r.results || []).map((x) => Object.assign({}, x, { index: x.index })));
      $("test-all").disabled = false;
      $("live-status").textContent = "Test finished.";
      $("live-status").className = "status ok";
    }
    setTimeout(() => { $("test-all").disabled = false; }, 15000);
  });

  $("apply").addEventListener("click", async () => {
    const state = (await send("PROXY_GET_STATE")).state || {};
    const r = await send("PROXY_SET_STATE", {
      enabled: true,
      mode: $("mode").value,
      index: state.index || 0
    });
    if (r.proxy) {
      $("live-status").textContent = "Applied " + r.proxy.label;
      $("live-status").className = "status ok";
    } else {
      $("live-status").textContent = "Apply failed: " + (r.error || "?");
      $("live-status").className = "status err";
    }
    refresh();
  });

  $("apply-next").addEventListener("click", async () => {
    const r = await send("PROXY_ROTATE");
    if (r.proxy) {
      $("live-status").textContent = "Next proxy: " + r.proxy.label;
      $("live-status").className = "status ok";
    } else {
      $("live-status").textContent = "Rotate failed: " + (r.error || "no proxies loaded");
      $("live-status").className = "status err";
    }
    refresh();
  });

  $("off").addEventListener("click", async () => {
    const r = await send("PROXY_OFF");
    $("live-status").textContent = r.ok ? "Proxy disabled — system settings restored." : "Off failed: " + (r.error || "?");
    $("live-status").className = r.ok ? "status ok" : "status err";
    refresh();
  });
});