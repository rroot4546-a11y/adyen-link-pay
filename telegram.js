"use strict";

const TG_KEY = "nonoTg";

const TG_FORBIDDEN = [
  /^https?:\/\/([a-z0-9-]+\.)*adyen\.(com|link)\//i,
  /checkoutshopper-live/i,
  /checkoutshopper\.adyen\.com/i
];

const DEFAULT_ALLOW = ["localhost", "127.0.0.1", "sandbox", "test", "dev", "stage"];

async function getTg() {
  const r = await chrome.storage.local.get(TG_KEY);
  return r[TG_KEY] || {
    enabled: false,
    token: "",
    chatId: "",
    allow: DEFAULT_ALLOW.slice()
  };
}

async function setTg(cfg) {
  await chrome.storage.local.set({ [TG_KEY]: cfg });
}

function urlAllowed(url) {
  for (const re of TG_FORBIDDEN) {
    if (re.test(String(url || ""))) {
      return { ok: false, reason: "forbidden live domain" };
    }
  }
  return { ok: true, reason: "ok" };
}

function hitsAllowList(cfg) {
  const raw = Array.isArray(cfg.allow) ? cfg.allow : DEFAULT_ALLOW.slice();
  return [].concat(raw).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

function originPermitted(url, cfg) {
  const u = String(url || "").toLowerCase();
  const allow = hitsAllowList(cfg);
  for (const pat of allow) {
    if (u.includes(pat)) return true;
  }
  return false;
}

async function tgSend(text) {
  const cfg = await getTg();
  if (!cfg.enabled || !cfg.token || !cfg.chatId) {
    return { ok: false, error: "telegram not configured" };
  }
  try {
    const res = await fetch("https://api.telegram.org/bot" + cfg.token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: String(text || "").slice(0, 3800),
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    const j = await res.json().catch(() => ({}));
    if (j && j.ok) return { ok: true };
    return { ok: false, error: (j && j.description) || ("HTTP " + res.status) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}