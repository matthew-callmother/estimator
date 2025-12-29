// app.js — one-shot MVP (script-embed safe)
// - mounts into <div id="wh-estimator"></div> (does NOT overwrite Webflow page)
// - loads config.json from GitHub Pages (absolute URL)
// - back/forward navigation, images + tooltips from JSON
// - details gate -> results preview (before submit) -> submit posts JSON to Zapier

const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";

// Change only if your repo path differs:
const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
const MOUNT_ID = "wh-estimator";

const STORAGE_KEY = "wh_estimator_v1_state";

let ROOT = document;
const $ = (sel) => ROOT.querySelector(sel);

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === null || v === undefined) continue;
    else n.setAttribute(k, String(v));
  }
  for (const c of children) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}

function money(n) {
  const x = Math.round(n);
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function roundTo(n, step) {
  return Math.round(n / step)
