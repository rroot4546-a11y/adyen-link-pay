"use strict";

const list = document.getElementById("list");

function pretty(body) {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch (e) { return body; }
}

function render() {
  chrome.runtime.sendMessage({ type: "GET_RESPONSES" }, (res) => {
    const rows = (res && res.responses) || [];
    list.innerHTML = "";
    if (!rows.length) {
      const d = document.createElement("div");
      d.id = "empty";
      d.textContent = "No Stripe API responses captured yet. Hit one and check back.";
      list.appendChild(d);
      return;
    }
    rows.slice(0, 20).forEach((r) => {
      const item = document.createElement("div");
      item.className = "item";
      const url = document.createElement("div");
      url.className = "url";
      url.textContent = r.url;
      const pre = document.createElement("pre");
      pre.textContent = pretty(r.body);
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        navigator.clipboard.writeText(pretty(r.body));
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      });
      item.appendChild(url);
      item.appendChild(pre);
      item.appendChild(copy);
      list.appendChild(item);
    });
  });
}

document.getElementById("refresh").addEventListener("click", render);
document.getElementById("copyall").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "GET_RESPONSES" }, (res) => {
    const rows = (res && res.responses) || [];
    const all = rows.map((r) => r.url + "\n" + pretty(r.body)).join("\n\n---\n\n");
    if (all) navigator.clipboard.writeText(all);
  });
});

render();