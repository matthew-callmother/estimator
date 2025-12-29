(function () {
  "use strict";

  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_v1_state";

  // --- Helpers ---
  const mk = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== null && v !== undefined) el.setAttribute(k, String(v));
    }
    for (const c of children) {
      if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  };

  const qs = (sel, root = document) => root.querySelector(sel);
  const money = n => Math.round(n).toLocaleString();
  const normalizePhone = s => String(s||"").replace(/\D/g,"");

  // --- Pricing Logic ---
  function computePrice(cfg, answers) {
    const p = cfg.pricing || {};
    const base = p.base_price || {};
    const type = answers.type || "tank";
    const fuel = answers.fuel || "gas";
    
    let key = `${type}_${fuel}`;
    if (!base[key]) key = "tank_gas"; // Fallback

    let price = base[key] || 0;
    const mods = p.modifiers || {};
    price += (mods.location?.[answers.location] ?? 0);
    price += (mods.access?.[answers.access] ?? 0);
    price += (mods.urgency?.[answers.urgency] ?? 0);
    
    const roundTo = p.safety?.round_to || 25;
    price = Math.round(price / roundTo) * roundTo;
    return { display_price: price, scenario_key: key };
  }

  // --- Boot ---
  async function boot() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    try {
      const res = await fetch(CONFIG_URL, { cache: "no-store" });
      const cfg = await res.json();

      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const state = {
        stepIndex: saved.stepIndex || 0,
        answers: saved.answers || {},
        lead: saved.lead || { name: "", phone: "", email: "", zip: "" }
      };

      const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

      function render() {
        persist();
        mount.innerHTML = "";
        const vq = (cfg.questions || []).filter(q => {
          if (!q.depends_on) return true;
          return state.answers[q.depends_on.question_id] === q.depends_on.equals;
        });

        const q = vq[state.stepIndex];
        const isLast = state.stepIndex === vq.length - 1;
        const pricing = computePrice(cfg, state.answers);

        const container = mk("div", { class: "card" }, [
          mk("div", { class: "stepHeader" }, [
            mk("div", { class: "stepTitle" }, [`Step ${state.stepIndex + 1} of ${vq.length}`]),
            mk("h2", {}, [q?.title || "Summary"])
          ]),
          mk("div", { id: "step-content" })
        ]);

        const content = qs("#step-content", container);

        // Render logic for different question types
        if (q?.type === "single_select") {
          q.options.forEach(opt => {
            const active = state.answers[q.id] === String(opt.value);
            content.appendChild(mk("div", { 
              class: `choice ${active ? "active" : ""}`,
              onClick: () => { state.answers[q.id] = String(opt.value); render(); }
            }, [
              mk("div", { class: "choiceMain" }, [
                mk("span", { class: "choiceLabel" }, [opt.label]),
                opt.image_url ? mk("img", { class: "oimg", src: opt.image_url }) : null
              ])
            ]));
          });
        } 
        else if (q?.type === "details_gate") {
          ["name", "phone", "email", "zip"].forEach(field => {
            content.appendChild(mk("div", { class: "field" }, [
              mk("label", { class: "fieldLabel" }, [field.toUpperCase()]),
              mk("input", { 
                type: field === "phone" ? "tel" : "text", 
                value: state.lead[field],
                onInput: e => { state.lead[field] = e.target.value; }
              })
            ]));
          });
        }

        // Navigation
        container.appendChild(mk("div", { class: "nav" }, [
          mk("button", { 
            class: "btn secondary", 
            disabled: state.stepIndex === 0,
            onClick: () => { state.stepIndex--; render(); }
          }, ["Back"]),
          mk("button", { 
            class: "btn", 
            onClick: async () => {
              if (isLast) {
                // Submit logic here (Zapier)
                alert("Submit logic triggered!"); 
              } else {
                state.stepIndex++; 
                render();
              }
            }
          }, [isLast ? "Get My Estimate" : "Next"])
        ]));

        // Live Preview
        container.appendChild(mk("div", { class: "preview" }, [
          mk("div", { class: "previewTop" }, ["Estimated Total"]),
          mk("div", { class: "previewPrice" }, [`$${money(pricing.display_price)}`])
        ]));

        mount.appendChild(container);
      }

      render();
    } catch (e) {
      mount.innerHTML = `<p>Error loading configuration. Check console.</p>`;
      console.error(e);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
