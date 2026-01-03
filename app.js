(function () {
  "use strict";

  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MUNICIPALITIES_URL = "https://matthew-callmother.github.io/estimator/municipalities-dfw.json";
  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_v2_state";

  /* ---------------- helpers ---------------- */
  const mk = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v === "boolean") el[k] = v;
      else if (v != null) el.setAttribute(k, v);
    }
    children.forEach(c => c && el.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return el;
  };

  const qs = (s, r = document) => r.querySelector(s);
  const money = n => Math.round(Number(n) || 0).toLocaleString();
  const isEmpty = v => v == null || String(v).trim() === "";

  /* ---------------- tooltip ---------------- */
  function tooltip(text) {
    if (!text) return null;
    const tip = mk("span", { class: "tip" }, ["?"]);
    const bubble = mk("div", { class: "tipBubble", html: text });
    bubble.style.display = "none";

    tip.onclick = e => {
      e.stopPropagation();
      bubble.style.display = bubble.style.display === "none" ? "block" : "none";
      setTimeout(() => {
        document.addEventListener("click", () => (bubble.style.display = "none"), { once: true });
      }, 0);
    };

    return mk("span", { class: "tipWrap" }, [tip, bubble]);
  }

  /* ---------------- municipality ---------------- */
  let MUNICACHE = null;
  async function loadMunicipalities() {
    if (MUNICACHE) return MUNICACHE;
    MUNICACHE = await (await fetch(MUNICIPALITIES_URL, { cache: "no-store" })).json();
    return MUNICACHE;
  }

  async function runLookup(state, lookup) {
    if (!lookup || lookup.source !== "municipalities") return;
    const muni = await loadMunicipalities();
    const city = String(state.answers[lookup.match_on] || "").replace(/,?\s*tx$/i, "").trim();
    const row = muni?.cities?.[city] || null;

    Object.entries(lookup.write_to || {}).forEach(([src, dest]) => {
      state.answers[dest] = row ? row[src] : null;
    });

    state.answers.__permit_done = true;
  }

  /* ---------------- pricing ---------------- */
  function computeExact(cfg, a) {
    const p = cfg.pricing;
    let key = `${a.type || "tank"}_${a.fuel || "gas"}`;
    if (!p.base_price[key]) key = "tank_gas";

    let price = p.base_price[key] || 0;
    ["location", "access", "urgency", "venting"].forEach(k => {
      price += Number(p.modifiers?.[k]?.[a[k]] || 0);
    });

    if (a.fuel === "not_sure") price += Number(p.modifiers?.fuel_not_sure_penalty || 0);
    price += Number(a.permit_fee_usd || 0);
    if (a.expansion_tank_required) price += Number(p.modifiers?.expansion_tank_cost_usd || 0);

    const r = p.safety?.round_to || 25;
    return Math.round(price / r) * r;
  }

  function computeRange(cfg, a) {
    const p = cfg.pricing;
    const bases = Object.values(p.base_price).map(Number);
    let min = Math.min(...bases);
    let max = Math.max(...bases);

    ["location", "access", "urgency", "venting"].forEach(k => {
      const vals = Object.values(p.modifiers?.[k] || {}).map(Number);
      if (!vals.length) return;
      if (!isEmpty(a[k])) min += vals.find(v => v === p.modifiers[k][a[k]]);
      else { min += Math.min(...vals); max += Math.max(...vals); }
    });

    if (a.fuel === "not_sure") {
      min += p.modifiers.fuel_not_sure_penalty || 0;
      max += p.modifiers.fuel_not_sure_penalty || 0;
    }

    const r = p.safety?.round_to || 25;
    return {
      min: Math.round(min / r) * r,
      max: Math.round(max / r) * r
    };
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    const cfg = await (await fetch(CONFIG_URL, { cache: "no-store" })).json();
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.stepIndex ??= 0;
    state.answers ??= {};

    const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    const visibleQs = () =>
      cfg.questions.filter(q => !q.depends_on || state.answers[q.depends_on.question_id] === q.depends_on.equals);

    const scheduleRender = (() => {
      let q = false;
      return () => {
        if (q) return;
        q = true;
        requestAnimationFrame(() => {
          q = false;
          render();
        });
      };
    })();

    function clearPermit() {
      delete state.answers.__permit_done;
      cfg.questions
        .filter(q => q.type === "loading_lookup")
        .forEach(q => (q.writes || []).forEach(k => delete state.answers[k]));
    }

    function render() {
      persist();
      mount.innerHTML = "";
      const vq = visibleQs();
      const q = vq[state.stepIndex];

      const range = computeRange(cfg, state.answers);
      const exactAllowed = state.answers.__permit_done;
      const exact = computeExact(cfg, state.answers);

      const previewVal = exactAllowed
        ? `$${money(exact)}`
        : `$${money(range.min)}–$${money(range.max)}`;

      const card = mk("div", { class: "card" }, [
        mk("div", { class: "stepHeader" }, [
          mk("div", { class: "progressMeta" }, [`Step ${state.stepIndex + 1} of ${vq.length}`]),
          mk("div", { class: "progressBar" }, [
            mk("div", { class: "progressFill", style: `width:${((state.stepIndex + 1) / vq.length) * 100}%` })
          ]),
          mk("h2", {}, [q.title]),
          q.subtitle ? mk("div", { class: "stepSub" }, [q.subtitle]) : null
        ]),
        mk("div", { id: "step-content" })
      ]);

      const content = qs("#step-content", card);

      if (q.type === "single_select") {
        const grid = mk("div", {
          class: q.options.some(o => o.image_url) ? "choicesGrid" : "choicesList"
        });

        q.options.forEach(o => {
          grid.appendChild(
            mk("div", {
              class: `choice ${state.answers[q.id] === o.value ? "active" : ""} ${o.image_url ? "hasImg" : ""}`,
              onClick: () => {
                state.answers[q.id] = o.value;
                clearPermit();
                scheduleRender();
              }
            }, [
              mk("div", { class: "choiceMain" }, [
                mk("div", { class: "choiceLabel" }, [o.label]),
                o.tooltip ? tooltip(o.tooltip) : null,
                o.image_url ? mk("img", { class: "oimg", src: o.image_url }) : null
              ])
            ])
          );
        });

        content.appendChild(grid);
      }

      if (q.type === "form") {
        q.fields.forEach(f => {
          content.appendChild(
            mk("div", { class: "field" }, [
              mk("label", { class: "fieldLabel" }, [f.label, f.help ? tooltip(f.help) : null]),
              mk("input", {
                value: state.answers[f.id] || "",
                onInput: e => {
                  state.answers[f.id] = e.target.value;
                  if (f.id.startsWith("addr_")) clearPermit();
                  scheduleRender();
                }
              })
            ])
          );
        });
      }

      card.appendChild(
        mk("div", { class: "nav" }, [
          mk("button", {
            class: "btn secondary",
            disabled: state.stepIndex === 0,
            onClick: () => {
              clearPermit();
              state.stepIndex--;
              scheduleRender();
            }
          }, ["Back"]),
          mk("button", {
            class: "btn",
            onClick: async () => {
              const next = vq[state.stepIndex + 1];
              if (next?.type === "loading_lookup") {
                await runLookup(state, next.lookup);
                state.stepIndex += 2;
              } else {
                state.stepIndex++;
              }
              scheduleRender();
            }
          }, ["Next"])
        ])
      );

      card.appendChild(
        mk("div", { class: "preview" }, [
          mk("div", { class: "previewTop" }, ["Estimated"]),
          mk("div", { class: "previewPrice" }, [previewVal])
        ])
      );

      mount.appendChild(card);
    }

    scheduleRender();
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", boot)
    : boot();
})();
