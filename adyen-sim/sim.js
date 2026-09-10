const http = require("http");
const fs = require("fs");
const path = require("path");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "sim-config.json"), "utf8"));
const CHECKOUT_PAGE = fs.readFileSync(path.join(__dirname, "pages", "checkout.html"), "utf8");

const attempts = [];

function luhnOK(num) {
  const d = String(num).replace(/\D/g, "");
  if (d.length < 12) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function psp() {
  return "TEST_REF" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 9e5);
}

function verdict(card) {
  const num = String(card.number || "").replace(/\D/g, "");
  const v = cfg.verdicts;

  for (const [prefix, data] of Object.entries(v.challengeMode || {})) {}

  for (const prefix of v.challengePrefixes) {
    if (num.startsWith(prefix)) {
      return {
        resultCode: "ChallengeShopper",
        pspReference: psp(),
        action: { type: "threeDS2", paymentMethodType: "scheme", paymentData: psp() }
      };
    }
  }
  for (const [prefix, data] of Object.entries(v.refusedPrefixes)) {
    if (num.startsWith(prefix)) {
      return {
        resultCode: "Refused",
        refusalReason: data.reason,
        refusalReasonCode: data.refusalCode,
        pspReference: psp()
      };
    }
  }
  if (!luhnOK(num)) {
    return {
      resultCode: "Refused",
      refusalReason: v.invalidReason,
      refusalReasonCode: v.invalidCode,
      pspReference: psp()
    };
  }
  for (const prefix of v.authorisedPrefixes) {
    if (num.startsWith(prefix)) {
      return { resultCode: "Authorised", pspReference: psp() };
    }
  }
  return cfg.defaultAuthorised
    ? { resultCode: "Authorised", pspReference: psp() }
    : { resultCode: "Refused", refusalReason: v.invalidReason, refusalReasonCode: v.invalidCode, pspReference: psp() };
}

function record(req, body, res) {
  const ua = req.headers["user-agent"] || "";
  const origin = req.headers["origin"] || "";
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null;
  const ip = xff || (req.socket.remoteAddress || "").replace(/^::ffff:/, "") || "?";
  const entry = {
    at: new Date().toISOString(),
    cardNumber: body.paymentMethod ? body.paymentMethod.number || "" : "",
    expiryMonth: body.paymentMethod ? body.paymentMethod.expiryMonth || "" : "",
    expiryYear: body.paymentMethod ? body.paymentMethod.expiryYear || "" : "",
    cvc: body.paymentMethod ? body.paymentMethod.cvc || "" : "",
    holder: body.paymentMethod ? body.paymentMethod.holderName || "" : "",
    amount: body.amount ? body.amount.value : null,
    currency: body.amount ? body.amount.currency : null,
    ip: ip,
    ua: ua.slice(0, 120),
    origin: origin,
    verdict: res.resultCode,
    refusalReason: res.refusalReason || "",
    pspReference: res.pspReference || ""
  };
  attempts.unshift(entry);
  if (attempts.length > cfg.maxAttemptsKeep) attempts.pop();
  return entry;
}

function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(s);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const ts = new Date().toISOString();

  if (url === "/favicon.ico") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && (url === "/" || url === "/checkout")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(CHECKOUT_PAGE);
    console.log(`[${ts}] GET  /checkout (serve checkout page)`);
    return;
  }

  if (req.method === "GET" && url === "/challenge") {
    const pspQ = (req.url.split("?")[1] || "").split("&").find(p => p.startsWith("psp=")) || "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>3D Secure challenge</title>
<script>
  setTimeout(function () {
    location.href = "/result?psp=${encodeURIComponent(decodeURIComponent(pspQ.replace(/^psp=/, "")))}";
  }, 2500);
</script>
<style>body{font-family:Segoe UI,sans-serif;background:#00112c;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;color:#00112c;border-radius:12px;padding:28px 34px;text-align:center;max-width:340px}
.dot{width:14px;height:14px;border-radius:50%;background:#0abf53;display:inline-block;animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.3}}
</style></head>
<body><div class="card"><div class="dot"></div> <p style="font-weight:600">Verify your identity</p>
<p style="font-size:13px;color:#5b6770">3D Secure challenge (simulated) — completing automatically…</p></div></body></html>`);
    console.log(`[${ts}] GET  /challenge (3ds simulation started)`);
    return;
  }

  if (req.method === "GET" && url === "/result") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Payment result</title>
<style>body{font-family:Segoe UI,sans-serif;background:#e7f9ee;color:#08712f;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;border-radius:12px;padding:26px 34px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.06);max-width:360px}
h1{font-size:18px}code{font-size:12px;color:#5b6770}</style></head>
<body><div class="card"><h1>Authorised ✓</h1><code>3DS flow completed (simulated)</code></div></body></html>`);
    console.log(`[${ts}] GET  /result (3ds completed)`);
    return;
  }

  if (req.method === "GET" && (url === "/hub" || url === "/api/attempts" || url === "/api/clear")) {
    if (url === "/api/clear") { attempts.length = 0; json(res, 200, { ok: true }); return; }
    if (url === "/api/attempts") { json(res, 200, attempts.slice(0, 100)); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Simulator Hub</title>
<style>body{font-family:'Segoe UI',monospace;background:#0b0e13;color:#dde4ee;padding:20px;margin:0}
h1{font-size:16px;color:#00d1b2} table{width:100%;border-collapse:collapse;margin-top:14px;font-size:12px}
th,td{padding:7px 8px;border-bottom:1px solid #1f2a33;text-align:left;white-space:nowrap}
th{color:#6b7b8d;font-size:10px;text-transform:uppercase;letter-spacing:.5px}
.good{color:#7fd4c2} .bad{color:#ff5d5d} .lib{color:#ffd166}
button{background:#23303c;color:#e6e6e6;border:0;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:12px}
</style></head>
<body><h1>ADYEN SIM — ATTEMPT HUB</h1>
<button id="clear">Clear attempts</button>
<table id="t"><thead><tr><th>#</th><th>time</th><th>card</th><th>exp</th><th>cvc</th><th>ip</th><th>origin</th><th>verdict</th><th>reason</th><th>psp</th></tr></thead><tbody></tbody></table>
<script>
const tb=document.querySelector('tbody');
async function load(){
  const a=await fetch('/api/attempts').then(r=>r.json());
  tb.innerHTML='';
  a.forEach((x,i)=>{
    const tr=document.createElement('tr');
    const cls=x.verdict==='Authorised'||x.verdict==='ChallengeShopper'?'good':x.verdict==='Refused'?'bad':'lib';
    tr.innerHTML='<td>'+(i+1)+'</td><td>'+x.at+'</td><td>'+x.cardNumber+'</td><td>'+(x.expiryMonth||'')+'/'+(x.expiryYear||'')+'</td><td>'+x.cvc+'</td><td>'+x.ip+'</td><td class="'+(x.origin?'':'lib')+'">'+(x.origin||'—')+'</td><td class="'+cls+'">'+x.verdict+'</td><td>'+(x.refusalReason||'—')+'</td><td>'+x.pspReference+'</td>';
    tb.appendChild(tr);
  });
}
setInterval(load, 1500); load();
document.getElementById('clear').addEventListener('click',()=>fetch('/api/clear').then(load));
</script></body></html>`);
    console.log(`[${ts}] GET  /hub`);
    return;
  }

  if (req.method === "GET" && url === "/checkoutshopper/v1/sessions") {
    json(res, 200, { id: psp(), sessionData: psp() });
    console.log(`[${ts}] GET  sessions (fake session created)`);
    return;
  }

  if (req.method === "POST" && /\/checkoutshopper\/v1\/payments/.test(url)) {
    let raw = "";
    req.on("data", (c) => raw += c);
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch (e) {}
      const v = verdict(body.paymentMethod || {});
      record(req, body, v);
      console.log(`[${ts}] POST ${url} -> ${v.resultCode} ${v.refusalReason ? "(" + v.refusalReason + ")" : ""} card=${body.paymentMethod ? body.paymentMethod.number : "?"}`);
      setTimeout(() => json(res, 200, v), cfg.processingDelayMs);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(cfg.port, cfg.host, () => {
  console.log("");
  console.log("██ Adyen SIM (lab) ██");
  console.log("  Checkout  : http://" + cfg.host + ":" + cfg.port + "/checkout");
  console.log("  Hub       : http://" + cfg.host + ":" + cfg.port + "/hub");
  console.log("  Verdicts  : authorised=" + cfg.verdicts.authorisedPrefixes.join(","));
  console.log("             challenge=" + cfg.verdicts.challengePrefixes.join(","));
  console.log("             refused   =" + Object.keys(cfg.verdicts.refusedPrefixes).join(","));
  console.log("             invalid if Luhn fails"); 
  console.log("");
});