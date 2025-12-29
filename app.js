(function () {
  "use strict";

  // --- CONFIGURATION ---
  // IMPORTANT: Replace this with your actual Zapier Webhook URL
  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_v1_state";
  const SUBMIT_COOLDOWN_MS = 30_000;

  // --- DOM HELPERS ---
  const mk = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === null || v === undefined) continue;
      else el.setAttribute(k, String(v));
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  };

  const qs = (sel, root = document) => root.querySelector(sel);

  // --- UTILITIES ---
  const safeParseJSON = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
  const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => (Math.random() * 16 | 0).toString(16));
  const money = n => Math.round(n).toLocaleString();
  const roundTo = (n, step) => Math.round(n / step) * step;
  const validateEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
  const validateZip = s => /^\d{5}(-\d{4})?$/.test(String(s || "").trim());
  const normalizePhone = s => {
    const d = String(s || "").replace(/\D/g, "");
    return (d.length === 11 && d.startsWith("1")) ? d.slice(1) : d;
  };

  const getUTM = () => {
    const params = new URLSearchParams(location.search);
    const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "gbraid", "wbraid"];
    const out = {};
    keys.forEach(k => { const v = params.get(k); if (v) out[k] = v; });
    return out;
  };

  // --- CORE LOGIC ---
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
          resolve(created);
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function computePrice(cfg, answers) {
    const p = cfg.pricing || {};
    const basePrice = p.base_price || {};
    const type = answers.type || "tank";
    const fuel = answers.fuel || "gas";
    const location = answers.location || "garage";
    const access = answers.access || "easy";
    const urgency = answers.urgency || "week";
    const venting = (fuel === "gas") ? (answers.venting || "standard") : "na";

    let key = `${type}_${fuel}`;
    if (!basePrice[key]) key = type === "tankless" ? "tankless_gas" : "tank_gas";

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

  function shouldShowQuestion(q, answers) {
    if (!q.depends_on) return true;
    const d = q.depends_on;
    return answers[d.question_id] === d.equals;
  }

  function isAnswered(q, state) {
    if (!q) return false;
    if (q.type === "single_select") return !!state.answers[q.id];
    if (q.type === "details_gate") {
      return String(state.lead.name).trim().length > 0 &&
             normalizePhone(state.lead.phone).length === 10 &&
             validateEmail(state.lead.email) &&
             validateZip(state.lead.zip);
    }
    return true;
  }

  // --- APP BOOT ---
  async function boot() {
    try {
      const mount = await resolveMount();
      mount.innerHTML = `<div class="card"><div id="app">Loading Estimator...</div></div>`;

      const res = await fetch(CONFIG_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("Config load failed");
      const cfg = await res.json();

      const saved = safeParseJSON(localStorage.getItem(STORAGE_KEY), null);
      const state = {
        session_id: saved?.session_id || uuid(),
        stepIndex: saved?.stepIndex || 0,
        answers: saved?.answers || {},
        lead: saved?.lead || { name: "", phone: "", email: "", zip: "" },
        lock_expires_at: saved?.lock_expires_at || null,
        utm: saved?.utm || getUTM(),
        page_url: location.href,
        honeypot: ""
      };

      const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

      async function submit() {
        const status = qs("#status");
        if (!ZAPIER_WEBHOOK_URL || ZAPIER_WEBHOOK_URL.includes("PASTE_YOUR")) {
          status.textContent = "Error: Webhook not configured.";
          return;
        }

        const pricing = computePrice(cfg, state.answers);
        const payload = {
          submitted_at: new Date().toISOString(),
          ...state,
          estimate: { price: pricing.display_price, scenario_key: pricing.scenario_key }
        };

        status.textContent = "Submitting...";
        try {
          const r = await fetch(ZAPIER_WEBHOOK_URL, { method: "POST", body: JSON.stringify(payload) });
          if (r.ok) {
            qs("#app").innerHTML = `<div class="panel"><h2>Sent!</h2><p>We will contact you shortly.</p></div>`;
            localStorage.removeItem(STORAGE_KEY);
          } else {
            status.textContent = "Error sending. Please try again.";
          }
        } catch {
          status.textContent = "Network error.";
        }
      }

      function render() {
        persist();
        const app = qs("#app", mount);
        const vq = (cfg.questions || []).filter(q => shouldShowQuestion(q, state.answers));
        const q = vq[state.stepIndex];
        
        app.innerHTML = "";

        // UI Building
        const stepHeader = mk("div", { class: "stepHeader" }, [
          mk("div", { class: "stepTitle" }, [`Step ${state.stepIndex + 1} of ${vq.length}`]),
          mk("h2", { html: q?.title || "Complete" })
        ]);
        app.appendChild(stepHeader);

        if (q?.type === "single_select") {
          const list = mk("div", { class: "panel" });
          q.options.forEach(opt => {
            const active = state.answers[q.id] === String(opt.value);
            const item = mk("div", { 
              class: `choice ${active ? 'active' : ''}`,
              onClick: () => { state.answers[q.id] = String(opt.value); render(); }
            }, [
              mk("div", { class: "choiceMain" }, [
                mk("span", { class: "choiceLabel" }, [opt.label]),
                opt.image_url ? mk("img", { class: "oimg", src: opt.image_url }) : null
              ])
            ]);
            list.appendChild(item);
          });
          app.appendChild(list);
        } 
        
        else if (q?.type === "details_gate") {
          const form = mk("div", { class: "panel" }, [
            mk("div", { class: "field" }, [ mk("label", { class: "fieldLabel" }, ["Name"]), mk("input", { type: "text", value: state.lead.name, onInput: e => { state.lead.name = e.target.value; render(); } }) ]),
            mk("div", { class: "field" }, [ mk("label", { class: "fieldLabel" }, ["Phone"]), mk("input", { type: "tel", value: state.lead.phone, onInput: e => { state.lead.phone = e.target.value; render(); } }) ]),
            mk("div", { class: "field" }, [ mk("label", { class: "fieldLabel" }, ["Email"]), mk("input", { type: "email", value: state.lead.email, onInput: e => { state.lead.email = e.target.value; render(); } }) ]),
            mk("div", { class: "field" }, [ mk("label", { class: "fieldLabel" }, ["ZIP"]), mk("input", { type: "text", value: state.lead.zip, onInput: e => { state.lead.zip = e.target.value; render(); } }) ])
          ]);
          app.appendChild(form);
        }

        else if (q?.type === "results_preview") {
          const pricing = computePrice(cfg, state.answers);
          app.appendChild(mk("div", { class: "panel" }, [
            mk("div", { class: "resultPrice" }, [`$${money(pricing.display_price)}`]),
            mk("div", { class: "status", id: "status" }, ["Ready to secure this price?"])
          ]));
        }

        // Navigation
        const nav = mk("div", { class: "nav" }, [
          mk("button", { class: "btn secondary", disabled: state.stepIndex === 0, onClick: () => { state.stepIndex--; render(); } }, ["Back"]),
          mk("button", { 
            class: "btn", 
            disabled: !isAnswered(q, state), 
            onClick: () => { if (q.type === "results_preview") submit(); else { state.stepIndex++; render(); } } 
          }, [q?.type === "results_preview" ? "Get Final Quote" : "Next"])
        ]);
        app.appendChild(nav);

        // Preview Footer
        const p = computePrice(cfg, state.answers);
        app.appendChild(mk("div", { class: "preview" }, [
          mk("div", { class: "previewTop" }, ["Current Estimate"]),
          mk("div", { class: "previewPrice" }, [`$${money(p.display_price)}`])
        ]));
      }

      render();
    } catch (err) {
      console.error("Boot Error:", err);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
