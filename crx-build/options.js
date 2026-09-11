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
  const ua = await send("UA_GET_STATE");
  if (ua.state) {
    $("ua-enabled").checked = !!ua.state.enabled;
    $("uas").value = (ua.list || []).join("\n");
    setUAStatus(ua.state, ua.list || []);
  }
  const tg = await send("TG_GET");
  if (tg.cfg) {
    $("tg-enabled").checked = !!tg.cfg.enabled;
    $("tg-token").value = "";
    $("tg-token").placeholder = tg.cfg.hasToken
      ? "token saved — leave empty to keep"
      : "123456:ABC...";
    $("tg-chat").value = tg.cfg.chatId || "";
    $("tg-allow").value = (tg.cfg.allow || []).join(",");
  }
}

function setUAStatus(state, list) {
  const box = $("ua-status");
  if (!state.enabled || !list.length) {
    box.className = "status";
    box.textContent = "Rotation OFF. Enable to swap UA before each payment attempt.";
    return;
  }
  const idx = state.index % list.length;
  box.className = "status ok";
  box.textContent = "Active #" + (idx + 1) + "/" + list.length + "\n" + list[idx];
}

function setLabStatus(enabled) {
  const s = $("lab-status");
  s.className = "status " + (enabled ? "err" : "");
  s.textContent = enabled
    ? "Lab mode ON — live-looking URLs allowed. Only for your local simulator."
    : "Lab mode OFF — live Adyen hosts are refused.";
}

document.addEventListener("DOMContentLoaded", async () => {
  await refresh();

  chrome.storage.local.get("nonoLab", (r) => {
    const en = !!(r.nonoLab && r.nonoLab.enabled);
    $("lab-enabled").checked = en;
    setLabStatus(en);
  });
  $("lab-enabled").addEventListener("change", () => {
    const en = $("lab-enabled").checked;
    chrome.storage.local.set({ nonoLab: { enabled: en } }, () => {
      setLabStatus(en);
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "PROXY_PROGRESS") renderResults(msg.results || []);
    if (msg.type === "PROXY_SWITCHED") {
      const box = $("live-status");
      box.textContent = "Rotated to " + msg.proxy + " (" + msg.reason + ")";
      box.className = "status";
    }
  });

  $("ua-save").addEventListener("click", async () => {
    const r = await send("UA_SET_LIST", { text: $("uas").value });
    $("ua-status").textContent = "Saved " + (r.list ? r.list.length : 0) + " User-Agents.";
    $("ua-status").className = "status ok";
    const ua = await send("UA_GET_STATE");
    setUAStatus(ua.state, r.list || ua.list || []);
  });

  $("ua-enabled").addEventListener("change", async () => {
    const st = (await send("UA_GET_STATE")).state || {};
    const r = await send("UA_SET_STATE", { enabled: $("ua-enabled").checked, index: st.index || 0 });
    const list = (await send("UA_GET_STATE")).list || [];
    setUAStatus(r.state || { enabled: $("ua-enabled").checked, index: 0 }, list);
  });

  $("ua-apply").addEventListener("click", async () => {
    const st = (await send("UA_GET_STATE")).state || {};
    const list = (await send("UA_GET_STATE")).list || [];
    const idx = st.index || 0;
    const r = await send("UA_APPLY_INDEX", { index: idx });
    if (r.ok) {
      $("ua-status").textContent = "Applied #" + (idx + 1) + "\n" + (r.label || "");
      $("ua-status").className = "status ok";
    } else {
      $("ua-status").textContent = "Apply failed: " + (r.error || "?");
      $("ua-status").className = "status err";
    }
    setUAStatus({ enabled: true, index: idx }, list);
  });

  $("ua-next").addEventListener("click", async () => {
    const r = await send("UA_NEXT");
    if (r.ok) {
      $("ua-status").textContent = "Rotated to " + r.label;
      $("ua-status").className = "status ok";
      $("ua-enabled").checked = true;
    } else if (r.skipped) {
      $("ua-status").textContent = "Rotation is OFF — enable it first.";
      $("ua-status").className = "status err";
    } else {
      $("ua-status").textContent = "Rotate failed: " + (r.error || "?");
      $("ua-status").className = "status err";
    }
  });

  let tokenDirty = false;
  $("tg-token").addEventListener("input", () => { tokenDirty = true; });

  $("tg-save").addEventListener("click", async () => {
    let token = "";
    if (tokenDirty) token = $("tg-token").value.trim();
    const r = await send("TG_SET", {
      enabled: $("tg-enabled").checked,
      token: token,
      chatId: $("tg-chat").value.trim(),
      allow: $("tg-allow").value.split(",").map((s) => s.trim()).filter(Boolean)
    });
    tokenDirty = false;
    $("tg-status").textContent = r.ok ? "Telegram config saved." : "Save failed: " + (r.error || "?");
    $("tg-status").className = r.ok ? "status ok" : "status err";
    $("tg-token").value = "";
    $("tg-token").placeholder = r.hasToken ? "token saved — leave empty to keep" : "123456:ABC...";
  });

  $("tg-test").addEventListener("click", async () => {
    $("tg-status").textContent = "Sending test message…";
    $("tg-test").disabled = true;
    const r = await send("TG_TEST");
    $("tg-status").textContent = r.ok
      ? "Test sent ✅ — check Telegram."
      : "Test failed: " + (r.error || "?") + " — did you press Start on the bot? Is the chat id right?";
    $("tg-status").className = r.ok ? "status ok" : "status err";
    $("tg-test").disabled = false;
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