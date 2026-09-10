"use strict";

const TG_KEY = "nonoTg";

const TG_FORBIDDEN = [
  /^https?:\/\/([a-z0-9-]+\.)*adyen\.(com|link)\//i,
  /checkoutshopper-live/i,
  /checkoutshopper\.adyen\.com/i
];

const DEFAULT_ALLOW = [
  "localhost",
  "127.0.0.1",
  "sandbox",
  "test",
  "dev",
  "stage",
  "staging",
  "qa",
  "demo",
  "mock",
  "sim",
  "lab"
];

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
    return { ok: false, error: "telegram not configured (missing token or chat id)" };
  }
  try {
    const base = "https://api.telegram.org/bot" + cfg.token + "/sendMessage";
    const payload = {
      chat_id: cfg.chatId,
      text: String(text || "").slice(0, 3800),
      disable_web_page_preview: true
    };
    const trySend = async (pm) => {
      const body = Object.assign({}, payload, pm ? { parse_mode: pm } : {});
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      return { res: res, j: j };
    };
    let out = await trySend("HTML");
    if (!(out.j && out.j.ok) && /parse|entities/i.test(String((out.j && out.j.description) || ""))) {
      out = await trySend(null);
    }
    if (out.j && out.j.ok) return { ok: true };
    const desc = (out.j && out.j.description) || ("HTTP " + out.res.status);
    let hint = "";
    if (/unauthorized/i.test(desc)) hint = " — token invalid/revoked";
    else if (/chat not found/i.test(desc)) hint = " — start a chat with the bot first (press Start)";
    else if (/forbidden/i.test(desc)) hint = " — bot blocked, or wrong chat id";
    return { ok: false, error: desc + hint };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}