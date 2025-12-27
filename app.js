// app.js (single-file MVP)
// - loads config.json
// - renders wizard with back/forward
// - supports images + tooltips from JSON
// - shows results BEFORE submit
// - submit posts raw JSON to Zapier

const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";

const STORAGE_KEY = "wh_estimator_v1_state";

const $ = (sel) => document.querySelector(sel);

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
  return Math.round(n / step) * step;
}

function safeParseJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function getUTM() {
  const params = new URLSearchParams(location.search);
  const keys = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid","gbraid","wbraid"];
  const utm = {};
  keys.forEach(k => { const v = params.get(k); if (v) utm[k] = v; });
  return utm;
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function validateEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function normalizePhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d;
}

function validateZip(s) {
  return /^\d{5}(-\d{4})?$/.test(String(s || "").trim());
}

function canSubmitNow() {
  const key = "wh_est_last_submit";
  const last = Number(localStorage.getItem(key) || "0");
  const now = Date.now();
  if (now - last < 30_000) return false;
  localStorage.setItem(key, String(now));
  return true;
}

function computePrice(cfg, answers) {
  const p = cfg.pricing;
  const basePrice = p.base_price;

  const type = answers.type || "tank";
  const fuel = answers.fuel || "gas";
  const location = answers.location || "garage";
  const access = answers.access || "easy";
  const urgency = answers.urgency || "week";
  const venting = (fuel === "gas") ? (answers.venting || "standard") : "na";

  let key;
  if (type === "tank" && fuel === "gas") key = "tank_gas";
  else if (type === "tank" && fuel === "electric") key = "tank_electric";
  else if (type === "tankless" && fuel === "gas") key = "tankless_gas";
  else if (type === "tankless" && fuel === "electric") key = "tankless_electric";
  else {
    // If fuel not sure, choose conservative (gas) base for that type and add penalty.
    key = type === "tankless" ? "tankless_gas" : "tank_gas";
  }

  let price = basePrice[key] || 0;

  const mods = p.modifiers;
  price += (mods.location[location] ?? 0);
  price += (mods.access[access] ?? 0);
  price += (mods.urgency[urgency] ?? 0);
  price += (mods.venting[venting] ?? 0);

  if (fuel === "not_sure") price += (mods.fuel_not_sure_penalty ?? 0);

  price = roundTo(price, p.safety.round_to || 25);

  // sanity clamp
  price = Math.max(p.safety.min_reasonable_price || 0, price);
  price = Math.min(p.safety.max_reasonable_price || price, price);

  return {
    display_price: price,
    scenario_key: key,
    derived: { venting_used: venting }
  };
}

function shouldShowQuestion(q, answers) {
  if (!q.depends_on) return true;
  const dep = q.depends_on;
  const actual = answers[dep.question_id];
  return actual === dep.equals;
}

function clearHiddenAnswers(cfg, answers) {
  for (const q of cfg.questions) {
    if (!shouldShowQuestion(q, answers)) {
      if (answers[q.id] !== undefined) delete answers[q.id];
    }
  }
}

async function main() {
  // Basic HTML shell injection (so you can literally drop app.js + config.json into GH Pages)
  document.body.innerHTML = `
    <main class="card">
      <header class="header">
        <h1>Water Heater Estimate</h1>
        <p class="sub">Answer a few install questions so the number is credible.</p>
      </header>
      <div id="app"></div>
      <footer class="footer"><small id="footnote"></small></footer>
    </main>
  `;

  injectStyles();

  const cfg = await fetch("./config.json", { cache: "no-store" }).then(r => r.json());
  $("#footnote").textContent = cfg.result_copy?.disclaimer || "";

  const saved = safeParseJSON(localStorage.getItem(STORAGE_KEY), null);

  const state = {
    session_id: saved?.session_id || uuid(),
    stepIndex: saved?.stepIndex || 0,
    answers: saved?.answers || {},
    lead: saved?.lead || { name:"", phone:"", email:"", zip:"" },
    lock_expires_at: saved?.lock_expires_at || null,
    utm: saved?.utm || getUTM(),
    page_url: location.href,
    honeypot: saved?.honeypot || ""
  };

  function visibleQuestions() {
    clearHiddenAnswers(cfg, state.answers);
    return cfg.questions.filter(q => shouldShowQuestion(q, state.answers));
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function setStepById(id) {
    const vq = visibleQuestions();
    const idx = vq.findIndex(q => q.id === id);
    if (idx >= 0) state.stepIndex = idx;
  }

  function currentQuestion() {
    const vq = visibleQuestions();
    state.stepIndex = Math.min(Math.max(state.stepIndex, 0), vq.length - 1);
    return vq[state.stepIndex];
  }

  function stepCounts() {
    const vq = visibleQuestions();
    const total = vq.filter(q => q.type !== "results_preview").length; // results is still a step but not “work”
    const current = Math.min(state.stepIndex + 1, total);
    return { current, total, vq };
  }

  function isAnswered(q) {
    if (q.type === "single_select") return !!state.answers[q.id];
    if (q.type === "details_gate") {
      const nameOk = String(state.lead.name || "").trim().length > 0;
      const phoneOk = normalizePhone(state.lead.phone).length === 10;
      const emailOk = validateEmail(state.lead.email);
      const zipOk = validateZip(state.lead.zip);
      return nameOk && phoneOk && emailOk && zipOk;
    }
    if (q.type === "results_preview") return true;
    return true;
  }

  function render() {
    persist();

    const q = currentQuestion();
    const { current, total, vq } = stepCounts();

    const app = $("#app");
    app.innerHTML = "";

    const header = el("div", { class: "stepHeader" }, [
      el("div", { class: "stepTitle" }, [`Step ${current} of ${total} — ${q.title}`]),
      el("div", { class: "stepHint" }, ["You can go back and revise anything."])
    ]);
    app.appendChild(header);

    if (q.subtitle) app.appendChild(el("p", { class: "subtitle" }, [q.subtitle]));

    if (q.tooltip) {
      const tipBtn = el("button", { class: "tipBtn", onClick: () => openTooltip(q.title, q.tooltip) }, ["?"]);
      app.appendChild(el("div", { class: "tipRow" }, [tipBtn, el("span", { class: "tipLabel" }, ["Why this matters"])]));
    }

    if (q.image_url) {
      app.appendChild(el("img", { class: "qimg", src: q.image_url, loading: "lazy", alt: "" }));
    }

    let body;
    if (q.type === "single_select") body = renderSingleSelect(q);
    else if (q.type === "details_gate") body = renderDetailsGate(cfg);
    else if (q.type === "results_preview") body = renderResultsPreview(cfg);
    else body = el("div", {}, ["Unsupported question type."]);
    app.appendChild(body);

    // bottom nav
    const backDisabled = state.stepIndex === 0;
    const nextLabel =
      q.type === "details_gate" ? "See my results" :
      q.type === "results_preview" ? "Submit" :
      "Next";

    const nav = el("div", { class: "nav" }, [
      el("button", { class: "btn secondary", disabled: backDisabled, onClick: () => { state.stepIndex--; render(); } }, ["Back"]),
      el("button", {
        class: "btn",
        disabled: !isAnswered(q),
        onClick: async () => {
          if (q.type === "results_preview") {
            await submit(cfg);
            return;
          }
          state.stepIndex++;
          render();
        }
      }, [nextLabel])
    ]);
    app.appendChild(nav);

    // tiny progress preview to reinforce “earned”
    const pricing = computePrice(cfg, state.answers);
    app.appendChild(el("div", { class: "preview" }, [
      el("div", { class: "previewTop" }, ["Current estimate (updates as you answer)"]),
      el("div", { class: "previewPrice" }, [`$${money(pricing.display_price)}`])
    ]));
  }

  function renderSingleSelect(q) {
    const wrap = el("div", { class: "panel" });
    const current = state.answers[q.id];

    q.options.forEach(opt => {
      const active = current === opt.value;
      const img = opt.image_url ? el("img", { class: "oimg", src: opt.image_url, loading: "lazy", alt: "" }) : null;

      const card = el("label", { class: `choice ${active ? "active" : ""}` }, [
        el("input", {
          type: "radio",
          name: q.id,
          value: opt.value,
          checked: active ? "checked" : null,
          onChange: () => {
            state.answers[q.id] = opt.value;
            // special normalization: if electric, venting should clear
            if (q.id === "fuel" && opt.value !== "gas") delete state.answers["venting"];
            render();
          }
        }),
        el("div", { class: "choiceMain" }, [
          el("div", { class: "choiceLabel" }, [opt.label]),
          img ? el("div", { class: "choiceImg" }, [img]) : el("div", { class: "choiceImg placeholder" }, [""])
        ])
      ]);

      wrap.appendChild(card);
    });

    return wrap;
  }

  function renderDetailsGate(cfg) {
    const wrap = el("div", { class: "panel" });

    const lockHours = cfg.meta?.lock_hours ?? 72;

    wrap.appendChild(el("p", { class: "sub2" }, [
      `We’ll lock this estimate for ${lockHours} hours. You can still go back and change answers before submitting.`
    ]));

    wrap.appendChild(field("Name", "name", "text", "Jane Homeowner", (v) => { state.lead.name = v; render(); }));
    wrap.appendChild(field("Phone", "phone", "tel", "214-555-0123", (v) => { state.lead.phone = v; render(); }));
    wrap.appendChild(field("Email", "email", "email", "jane@email.com", (v) => { state.lead.email = v; render(); }));
    wrap.appendChild(field("ZIP", "zip", "text", "750xx", (v) => { state.lead.zip = v; render(); }));

    // Honeypot (hidden)
    const hp = el("div", { class: "hp" }, [
      el("label", {}, ["Company (leave blank)"]),
      el("input", { type: "text", value: state.honeypot, onInput: (e) => { state.honeypot = e.target.value; } })
    ]);
    wrap.appendChild(hp);

    // Set lock timestamp when details become valid (local only)
    if (isAnswered({ type: "details_gate" })) {
      const now = Date.now();
      state.lock_expires_at = new Date(now + lockHours * 60 * 60 * 1000).toISOString();
    }

    // inline validation hints (minimal)
    const errs = [];
    if (state.lead.name && String(state.lead.name).trim().length === 0) errs.push("Name required.");
    const p = normalizePhone(state.lead.phone);
    if (state.lead.phone && p.length !== 10) errs.push("Phone must be 10 digits.");
    if (state.lead.email && !validateEmail(state.lead.email)) errs.push("Email looks invalid.");
    if (state.lead.zip && !validateZip(state.lead.zip)) errs.push("ZIP looks invalid.");

    if (errs.length) wrap.appendChild(el("div", { class: "errorBox" }, [errs.join(" ")]));
    return wrap;
  }

  function renderResultsPreview(cfg) {
    const wrap = el("div", { class: "panel" });
    const pricing = computePrice(cfg, state.answers);

    wrap.appendChild(el("div", { class: "resultPrice" }, [`$${money(pricing.display_price)}`]));

    if (state.lock_expires_at) {
      wrap.appendChild(el("div", { class: "resultMeta" }, [
        `Locked until: ${new Date(state.lock_expires_at).toLocaleString()}`
      ]));
    }

    wrap.appendChild(el("h3", {}, ["Your selections"]));
    wrap.appendChild(renderSummary(cfg));

    wrap.appendChild(el("h3", {}, ["What this typically includes"]));
    wrap.appendChild(el("ul", {}, (cfg.result_copy?.includes || []).map(x => el("li", {}, [x]))));

    wrap.appendChild(el("h3", {}, ["What could change it"]));
    wrap.appendChild(el("ul", {}, (cfg.result_copy?.could_change || []).map(x => el("li", {}, [x]))));

    wrap.appendChild(el("div", { class: "status", id: "status" }, ["Ready to submit."]));
    return wrap;
  }

  function renderSummary(cfg) {
    // show answered question labels (single_select only)
    const vq = visibleQuestions().filter(q => q.type === "single_select");
    const rows = vq.map(q => {
      const val = state.answers[q.id];
      const label = (q.options || []).find(o => o.value === val)?.label || val || "";
      return el("div", { class: "sumRow" }, [
        el("div", { class: "sumKey" }, [q.title]),
        el("div", { class: "sumVal" }, [label])
      ]);
    });
    return el("div", { class: "summary" }, rows);
  }

  async function submit(cfg) {
    const status = $("#status");
    if (!status) return;

    if (!canSubmitNow()) {
      status.textContent = "Please wait a moment before submitting again.";
      return;
    }
    if (state.honeypot && state.honeypot.trim().length > 0) {
      status.textContent = "Submission blocked.";
      return;
    }
    if (!ZAPIER_WEBHOOK_URL || ZAPIER_WEBHOOK_URL.includes("PASTE_YOUR_ZAPIER")) {
      status.textContent = "Missing Zapier webhook URL in app.js.";
      return;
    }
    if (!navigator.onLine) {
      status.textContent = "You appear to be offline. Please reconnect and try again.";
      return;
    }

    const pricing = computePrice(cfg, state.answers);

    const payload = {
      submitted_at: new Date().toISOString(),
      session_id: state.session_id,
      page_url: state.page_url,
      utm: state.utm,

      answers: { ...state.answers },
      estimate: {
        price: pricing.display_price,
        scenario_key: pricing.scenario_key,
        derived: pricing.derived
      },

      lead: {
        name: String(state.lead.name || "").trim(),
        phone: normalizePhone(state.lead.phone),
        email: String(state.lead.email || "").trim(),
        zip: String(state.lead.zip || "").trim()
      },

      lock_expires_at: state.lock_expires_at,

      meta: {
        user_agent: navigator.userAgent,
        locale: navigator.language
      }
    };

    status.textContent = "Sending…";

    try {
      const res = await fetch(ZAPIER_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        status.textContent = `Error sending (${res.status}). Please try again.`;
        return;
      }

      // Success view (simple)
      const app = $("#app");
      app.innerHTML = "";
      app.appendChild(el("div", { class: "panel" }, [
        el("h2", {}, ["Submitted"]),
        el("p", { class: "sub2" }, ["We got your estimate request and will follow up shortly."]),
        el("pre", { class: "pre" }, [JSON.stringify(payload, null, 2)])
      ]));

      // optional: clear state after success (comment out if you want persistence)
      // localStorage.removeItem(STORAGE_KEY);

    } catch {
      status.textContent = "Network error. Please try again.";
    }
  }

  function field(label, key, type, placeholder, onChange) {
    const input = el("input", {
      type,
      value: state.lead[key] || "",
      placeholder,
      onInput: (e) => onChange(e.target.value)
    });

    return el("div", { class: "field" }, [
      el("label", { class: "fieldLabel" }, [label]),
      input
    ]);
  }

  function openTooltip(title, text) {
    const overlay = el("div", { class: "overlay", onClick: (e) => { if (e.target === overlay) overlay.remove(); } });
    const modal = el("div", { class: "modal" }, [
      el("div", { class: "modalHead" }, [
        el("div", { class: "modalTitle" }, [title]),
        el("button", { class: "modalClose", onClick: () => overlay.remove() }, ["×"])
      ]),
      el("div", { class: "modalBody" }, [text])
    ]);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const esc = (ev) => { if (ev.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc);
  }

  function injectStyles() {
    const css = `
      :root { font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; }
      body { margin:0; padding:24px; background:#f6f6f7; }
      .card { max-width:760px; margin:0 auto; background:#fff; border-radius:16px; padding:18px; box-shadow:0 8px 30px rgba(0,0,0,.08); }
      .header h1 { margin:0 0 6px; font-size:22px; }
      .sub { margin:0; color:#555; }
      .subtitle { color:#555; margin:10px 0 0; }
      .stepHeader { display:flex; justify-content:space-between; gap:12px; margin:14px 0 6px; }
      .stepTitle { font-weight:700; }
      .stepHint { color:#666; font-size:13px; }
      .tipRow { display:flex; align-items:center; gap:10px; margin:10px 0; }
      .tipBtn { width:34px; height:34px; border-radius:10px; border:1px solid #111; background:#fff; font-weight:800; cursor:pointer; }
      .tipLabel { color:#666; font-size:13px; }
      .qimg { width:100%; border-radius:12px; border:1px solid #eee; margin:10px 0; }
      .panel { padding:12px; border:1px solid #eee; border-radius:12px; }
      .choice { display:block; padding:12px; border:1px solid #e8e8e8; border-radius:12px; margin:10px 0; cursor:pointer; }
      .choice.active { border-color:#111; }
      .choice input { margin-right:10px; }
      .choiceMain { display:flex; justify-content:space-between; align-items:center; gap:12px; }
      .choiceLabel { font-weight:650; }
      .choiceImg { width:84px; height:52px; border-radius:10px; border:1px solid #eee; overflow:hidden; background:#fafafa; }
      .choiceImg.placeholder { border-style:dashed; }
      .oimg { width:100%; height:100%; object-fit:cover; display:block; }
      .nav { display:flex; justify-content:space-between; gap:10px; margin-top:14px; }
      .btn { padding:12px 14px; border-radius:12px; border:1px solid #111; background:#111; color:#fff; cursor:pointer; font-weight:700; }
      .btn.secondary { background:#fff; color:#111; }
      .btn:disabled { opacity:.4; cursor:not-allowed; }
      .preview { margin-top:12px; padding:12px; border-radius:12px; background:#fafafa; border:1px solid #eee; }
      .previewTop { font-size:12px; color:#666; }
      .previewPrice { font-size:22px; font-weight:800; margin-top:4px; }
      .field { margin:10px 0; }
      .fieldLabel { display:block; font-size:13px; color:#333; margin-bottom:6px; font-weight:650; }
      input { width:100%; padding:12px; border-radius:12px; border:1px solid #ddd; }
      .hp { position:absolute; left:-9999px; top:-9999px; }
      .errorBox { margin-top:10px; padding:10px; border-radius:12px; background:#fff6f6; border:1px solid #ffd3d3; color:#8a1f1f; }
      .resultPrice { font-size:30px; font-weight:900; margin-bottom:6px; }
      .resultMeta { color:#555; margin-bottom:12px; }
      .summary { border:1px solid #eee; border-radius:12px; overflow:hidden; }
      .sumRow { display:flex; justify-content:space-between; gap:12px; padding:10px 12px; border-top:1px solid #eee; }
      .sumRow:first-child { border-top:none; }
      .sumKey { color:#555; font-size:13px; }
      .sumVal { font-weight:750; font-size:13px; }
      .status { margin-top:12px; color:#333; min-height:18px; }
      .footer { margin-top:14px; color:#666; }
      .overlay { position:fixed; inset:0; background:rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center; padding:16px; z-index:9999; }
      .modal { width:min(520px, 100%); background:#fff; border-radius:16px; border:1px solid #eee; box-shadow:0 18px 60px rgba(0,0,0,.25); }
      .modalHead { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #eee; }
      .modalTitle { font-weight:800; }
      .modalClose { border:0; background:transparent; font-size:22px; cursor:pointer; }
      .modalBody { padding:14px; color:#333; line-height:1.4; }
      .pre { white-space:pre-wrap; word-break:break-word; background:#fafafa; border:1px solid #eee; padding:12px; border-radius:12px; }
      h3 { margin:14px 0 8px; }
      ul { margin:0 0 10px 18px; }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  // start on first visible question (in case saved step is invalid)
  const vq = visibleQuestions();
  if (!vq[state.stepIndex]) state.stepIndex = 0;

  render();
}

main().catch(err => {
  document.body.innerHTML = `<pre style="padding:16px">Error loading estimator: ${String(err)}</pre>`;
});
