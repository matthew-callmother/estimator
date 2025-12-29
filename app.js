(function () {
  "use strict";

  // Minimal, refactored app.js — fully self-contained, IIFE-scoped
  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_v1_state";
  const SUBMIT_COOLDOWN_MS = 30_000;

  // DOM helpers (scoped)
  const mk = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === null || v === undefined) continue;
      else el.setAttribute(k, String(v));
    }
    for (const c of children) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return el;
  };

  const qs = (sel, root = document) => root.querySelector(sel);

  // Utilities
  const safeParseJSON = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
  const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => (Math.random()*16|0).toString(16));
  const money = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const roundTo = (n, step) => Math.round(n/step)*step;
  const validateEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||"").trim());
  const normalizePhone = s => {
    const d = String(s||"").replace(/\D/g,"");
    if (d.length === 11 && d.startsWith("1")) return d.slice(1);
    return d;
  };
  const validateZip = s => /^\d{5}(-\d{4})?$/.test(String(s||"").trim());
  const getUTM = () => {
    const params = new URLSearchParams(location.search);
    const keys = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid","gbraid","wbraid"];
    const out = {};
    keys.forEach(k => { const v = params.get(k); if (v) out[k] = v; });
    return out;
  };

  // Mount resolution: tries to find existing mount, otherwise waits briefly then appends one
  function resolveMount(timeoutMs = 1500) {
    let mount = document.getElementById(MOUNT_ID);
    if (mount) return Promise.resolve(mount);
    return new Promise(resolve => {
      const start = Date.now();
      const mo = new MutationObserver(() => {
        mount = document.getElementById(MOUNT_ID);
        if (mount) { mo.disconnect(); resolve(mount); }
        else if (Date.now() - start > timeoutMs) {
          mo.disconnect();
          const created = mk("div", { id: MOUNT_ID });
          document.body.appendChild(created);
          console.warn(`Estimator: created fallback #${MOUNT_ID}`);
          resolve(created);
        }
      });
      mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
      // quick fallback attempt
      setTimeout(() => {
        mount = document.getElementById(MOUNT_ID);
        if (mount) { mo.disconnect(); resolve(mount); }
      }, 50);
    });
  }

  // Inject scoped styles
  function injectStyles(mountId = MOUNT_ID) {
    const css = `
#${mountId} { font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; }
#${mountId} .card { max-width:760px; margin:0 auto; background:#fff; border-radius:16px; padding:18px; box-shadow:0 8px 30px rgba(0,0,0,.08); }
#${mountId} .header h1 { margin:0 0 6px; font-size:22px; }
#${mountId} .sub { margin:0; color:#555; }
#${mountId} .panel { padding:12px; border:1px solid #eee; border-radius:12px; }
#${mountId} .choice { display:block; padding:12px; border:1px solid #e8e8e8; border-radius:12px; margin:10px 0; cursor:pointer; }
#${mountId} .choice.active { border-color:#111; }
#${mountId} .choiceMain { display:flex; justify-content:space-between; align-items:center; gap:12px; }
#${mountId} .nav { display:flex; justify-content:space-between; gap:10px; margin-top:14px; }
#${mountId} .btn { padding:12px 14px; border-radius:12px; border:1px solid #111; background:#111; color:#fff; cursor:pointer; font-weight:700; }
#${mountId} .btn.secondary { background:#fff; color:#111; }
#${mountId} .btn:disabled { opacity:.4; cursor:not-allowed; }
#${mountId} .preview { margin-top:12px; padding:12px; border-radius:12px; background:#fafafa; border:1px solid #eee; }
#${mountId} input[type="text"],#${mountId} input[type="tel"],#${mountId} input[type="email"] { width:100%; padding:12px; border-radius:12px; border:1px solid #ddd; }
#${mountId} .hp { position:absolute; left:-9999px; top:-9999px; }
`;
    const s = mk("style", { html: css });
    document.head.appendChild(s);
  }

  // Compute price (kept compatible with original)
  function computePrice(cfg, answers) {
    const p = cfg.pricing || {};
    const basePrice = p.base_price || {};
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
    else key = type === "tankless" ? "tankless_gas" : "tank_gas";

    let price = basePrice[key] || 0;
    const mods = p.modifiers || {};
    price += (mods.location?.[location] ?? 0);
    price += (mods.access?.[access] ?? 0);
    price += (mods.urgency?.[urgency] ?? 0);
    price += (mods.venting?.[venting] ?? 0);
    if (fuel === "not_sure") price += (mods.fuel_not_sure_penalty ?? 0);
    price = roundTo(price, p.safety?.round_to || 25);
    price = Math.max(p.safety?.min_reasonable_price || 0, price);
    price = Math.min(p.safety?.max_reasonable_price || price, price);
    return { display_price: price, scenario_key: key, derived: { venting_used: venting } };
  }

  // Basic field builder
  const Field = (state, label, key, type, placeholder, onChange) => {
    const input = mk("input", {
      type,
      value: state.lead[key] || "",
      placeholder,
      onInput: e => onChange(e.target.value)
    });
    return mk("div", { class: "field" }, [ mk("label", { class: "fieldLabel" }, [label]), input ]);
  };

  // Visibility helpers
  function shouldShowQuestion(q, answers) {
    if (!q.depends_on) return true;
    const d = q.depends_on;
    return answers[d.question_id] === d.equals;
  }
  function clearHiddenAnswers(cfg, answers) {
    for (const q of (cfg.questions||[])) {
      if (!shouldShowQuestion(q, answers)) {
        if (answers[q.id] !== undefined) delete answers[q.id];
      }
    }
  }

  function isAnswered(q, state) {
    if (!q) return false;
    if (q.type === "single_select") {
      const v = state.answers[q.id];
      return v !== undefined && v !== null && String(v).length > 0;
    }
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

  // Render summary
  function renderSummary(cfg, state) {
    const vq = (cfg.questions || []).filter(q => q.type === "single_select" && shouldShowQuestion(q, state.answers));
    const rows = vq.map(q => {
      const val = state.answers[q.id];
      const label = (q.options || []).find(o => String(o.value) === String(val))?.label || val || "";
      return mk("div", { class: "sumRow" }, [ mk("div", { class: "sumKey" }, [q.title]), mk("div", { class: "sumVal" }, [label]) ]);
    });
    return mk("div", { class: "summary" }, rows);
  }

  // Boot
  async function boot() {
    try {
      injectStyles();
      const mount = await resolveMount();
      if (!mount) throw new Error(`Missing mount element #${MOUNT_ID}`);

      // initial shell
      mount.innerHTML = "";
      const card = mk("main", { class: "card" }, [
        mk("header", { class: "header" }, [ mk("h1", {}, ["Water Heater Estimate"]), mk("p", { class: "sub" }, ["Answer a few install questions so the number is credible."]) ]),
        mk("div", { id: "app" }),
        mk("footer", { class: "footer" }, [ mk("small", { id: "footnote" }, [""]) ])
      ]);
      mount.appendChild(card);

      // load config
      const res = await fetch(CONFIG_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`config.json fetch failed: ${res.status} ${res.statusText}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const t = await res.text();
        throw new Error(`config.json not JSON (content-type: ${ct}). First chars: ${t.slice(0,120)}`);
      }
      const cfg = await res.json();

      // load saved state
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

      const foot = qs("#footnote", mount);
      if (foot) foot.textContent = cfg.result_copy?.disclaimer || "";

      function persist() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
      }

      function visibleQuestions() {
        clearHiddenAnswers(cfg, state.answers);
        return (cfg.questions || []).filter(q => shouldShowQuestion(q, state.answers));
      }

      function currentQuestion() {
        const vq = visibleQuestions();
        state.stepIndex = Math.min(Math.max(state.stepIndex, 0), Math.max(vq.length - 1, 0));
        return vq[state.stepIndex];
      }

      function canSubmitNow() {
        const key = "wh_est_last_submit";
        const last = Number(localStorage.getItem(key) || "0");
        const now = Date.now();
        if (now - last < SUBMIT_COOLDOWN_MS) return false;
        localStorage.setItem(key, String(now));
        return true;
      }

      async function submit() {
        const status = qs("#status", mount);
        if (!status) return;
        if (!canSubmitNow()) { status.textContent = "Please wait a moment before submitting again."; return; }
        if (state.honeypot && state.honeypot.trim().length > 0) { status.textContent = "Submission blocked."; return; }
        if (!ZAPIER_WEBHOOK_URL || ZAPIER_WEBHOOK_URL.includes("PASTE_YOUR_ZAPIER")) { status.textContent = "Missing Zapier webhook URL."; return; }
        if (!navigator.onLine) { status.textContent = "You appear to be offline. Please reconnect and try again."; return; }

        const pricing = computePrice(cfg, state.answers);
        const payload = {
          submitted_at: new Date().toISOString(),
          session_id: state.session_id,
          page_url: state.page_url,
          utm: state.utm,
          answers: { ...state.answers },
          estimate: { price: pricing.display_price, scenario_key: pricing.scenario_key, derived: pricing.derived },
          lead: {
            name: String(state.lead.name || "").trim(),
            phone: normalizePhone(state.lead.phone),
            email: String(state.lead.email || "").trim(),
            zip: String(state.lead.zip || "").trim()
          },
          lock_expires_at: state.lock_expires_at,
          meta: { user_agent: navigator.userAgent, locale: navigator.language }
        };

        status.textContent = "Sending…";
        try {
          const r = await fetch(ZAPIER_WEBHOOK_URL, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) });
          if (!r.ok) { status.textContent = `Error sending (${r.status}). Please try again.`; return; }
          const app = qs("#app", mount);
          app.innerHTML = "";
          app.appendChild(mk("div", { class: "panel" }, [ mk("h2", {}, ["Submitted"]), mk("p", { class: "sub" }, ["We got your estimate request and will follow up shortly."]) ]));
        } catch (e) {
          status.textContent = "Network error. Please try again.";
        }
      }

      function render() {
        persist();
        const q = currentQuestion();
        const vq = visibleQuestions();
        const current = Math.min(state.stepIndex + 1, vq.length || 1);
        const total = vq.length || 1;
        const app = qs("#app", mount);
        app.innerHTML = "";

        app.appendChild(mk("div", { class: "stepHeader" }, [
          mk("div", { class: "stepTitle" }, [`Step ${current} of ${total} — ${q?.title || ""}`]),
          mk("div", { class: "stepHint" }, ["You can go back and revise anything."])
        ]));

        if (q?.subtitle) app.appendChild(mk("p", { class: "subtitle" }, [q.subtitle]));
        if (q?.tooltip) {
          const tipBtn = mk("button", { class: "tipBtn", onClick: () => openTooltip(q.title, q.tooltip) }, ["?"]);
          app.appendChild(mk("div", { class: "tipRow" }, [tipBtn, mk("span", { class: "tipLabel" }, ["Why this matters"])]));
        }
        if (q?.image_url) app.appendChild(mk("img", { class: "qimg", src: q.image_url, alt: "", loading: "lazy" }));

        // Body types
        if (q?.type === "single_select") {
          const wrap = mk("div", { class: "panel" });
          const currentVal = state.answers[q.id] !== undefined && state.answers[q.id] !== null ? String(state.answers[q.id]) : "";
          q.options.forEach(opt => {
            const optVal = String(opt.value);
            const active = currentVal === optVal;
            const card = mk("label", {
              class: `choice ${active ? "active" : ""}`,
              onClick: () => {
                state.answers[q.id] = optVal;
                if (q.id === "fuel" && optVal !== "gas") delete state.answers["venting"];
                render();
              }
            });
            const input = mk("input", {
              type: "radio",
              name: q.id,
              value: optVal,
              checked: active ? "checked" : null,
              onChange: (e) => {
                state.answers[q.id] = e.target.value;
                if (q.id === "fuel" && e.target.value !== "gas") delete state.answers["venting"];
                render();
              }
            });
            const img = opt.image_url ? mk("img", { class: "oimg", src: opt.image_url, loading: "lazy", alt: "" }) : null;
            const main = mk("div", { class: "choiceMain" }, [ mk("div", { class: "choiceLabel" }, [opt.label]), img ? mk("div", { class: "choiceImg" }, [img]) : mk("div", { class: "choiceImg placeholder" }, [""]) ]);
            card.appendChild(input);
            card.appendChild(main);
            wrap.appendChild(card);
          });
          app.appendChild(wrap);
        } else if (q?.type === "details_gate") {
          const wrap = mk("div", { class: "panel" });
          const lockHours = cfg.meta?.lock_hours ?? 72;
          wrap.appendChild(mk("p", { class: "sub" }, [`We’ll lock this estimate for ${lockHours} hours. You can still go back and change answers before submitting.`]));
          wrap.appendChild(Field(state, "Name", "name", "text", "Jane Homeowner", v => { state.lead.name = v; render(); }));
          wrap.appendChild(Field(state, "Phone", "phone", "tel", "214-555-0123", v => { state.lead.phone = v; render(); }));
          wrap.appendChild(Field(state, "Email", "email", "email", "jane@email.com", v => { state.lead.email = v; render(); }));
          wrap.appendChild(Field(state, "ZIP", "zip", "text", "750xx", v => { state.lead.zip = v; render(); }));
          wrap.appendChild(mk("div", { class: "hp" }, [ mk("label", {}, ["Company (leave blank)"]), mk("input", { type: "text", value: state.honeypot, onInput: e => { state.honeypot = e.target.value; } }) ]));
          if (isAnswered({ type: "details_gate" }, state)) {
            const now = Date.now();
            state.lock_expires_at = new Date(now + lockHours * 60 * 60 * 1000).toISOString();
          }
          app.appendChild(wrap);
        } else if (q?.type === "results_preview") {
          const wrap = mk("div", { class: "panel" });
          const pricing = computePrice(cfg, state.answers);
          wrap.appendChild(mk("div", { class: "resultPrice" }, [`$${money(pricing.display_price)}`]));
          if (state.lock_expires_at) wrap.appendChild(mk("div", { class: "resultMeta" }, [`Locked until: ${new Date(state.lock_expires_at).toLocaleString()}`]));
          wrap.appendChild(mk("h3", {}, ["Your selections"]));
          wrap.appendChild(renderSummary(cfg, state));
          wrap.appendChild(mk("h3", {}, ["What this typically includes"]));
          wrap.appendChild(mk("ul", {}, (cfg.result_copy?.includes || []).map(x => mk("li", {}, [x]))));
          wrap.appendChild(mk("h3", {}, ["What could change it"]));
          wrap.appendChild(mk("ul", {}, (cfg.result_copy?.could_change || []).map(x => mk("li", {}, [x]))));
          wrap.appendChild(mk("div", { class: "status", id: "status" }, ["Ready to submit."]));
          app.appendChild(wrap);
        } else {
          app.appendChild(mk("div", { class: "panel" }, ["Unsupported question type."]));
        }

        // nav
        const backDisabled = state.stepIndex === 0;
        const nextLabel = q?.type === "details_gate" ? "See my results" : q?.type === "results_preview" ? "Submit" : "Next";
        app.appendChild(mk("div", { class: "nav" }, [
          mk("button", { class: "btn secondary", disabled: backDisabled, onClick: () => { state.stepIndex = Math.max(0, state.stepIndex - 1); render(); } }, ["Back"]),
          mk("button", { class: "btn", disabled: !isAnswered(q, state), onClick: async () => { if (q?.type === "results_preview") { await submit(); return; } state.stepIndex++; render(); } }, [nextLabel])
        ]));

        // preview
        const pricing = computePrice(cfg, state.answers);
        app.appendChild(mk("div", { class: "preview" }, [ mk("div", { class: "previewTop" }, ["Current estimate (updates as you answer)"]), mk("div", { class: "previewPrice" }, [`$${money(pricing.display_price)}`]) ]));
      }

      // tooltip modal
      function openTooltip(title, text) {
        const overlay = mk("div", { class: "overlay", onClick: e => { if (e.target === overlay) overlay.remove(); } });
        const modal = mk("div", { class: "modal" }, [
          mk("div", { class: "modalHead" }, [ mk("div", { class: "modalTitle" }, [title]), mk("button", { class: "modalClose", onClick: () => overlay.remove() }, ["×"]) ]),
          mk("div", { class: "modalBody" }, [text])
        ]);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        const esc = ev => { if (ev.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", esc); } };
        document.addEventListener("keydown", esc);
      }

      // finalize
      const vq = visibleQuestions();
      if (!vq[state.stepIndex]) state.stepIndex = 0;
      render();

    } catch (err) {
      const mount = document.getElementById(MOUNT_ID);
      const msg = `Error loading estimator: ${String(err)}`;
      if (mount) mount.innerHTML = `<pre style="padding:16px;white-space:pre-wrap">${msg}</pre>`;
      else document.body.insertAdjacentHTML("beforeend", `<pre style="padding:16px;white-space:pre-wrap">${msg}</pre>`);
      console.error(err);
    }
  }

  // start after DOM ready
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})();
