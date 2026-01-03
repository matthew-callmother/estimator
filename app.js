(function () {
  "use strict";

  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MUNICIPALITIES_URL = "https://matthew-callmother.github.io/estimator/municipalities-dfw.json";
  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_v2_state";

  // ---------- Helpers ----------
  const mk = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function")
        el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v === "boolean") {
        if (k in el) el[k] = v;
        if (v) el.setAttribute(k, "");
        else el.removeAttribute(k);
      } else if (v !== null && v !== undefined) el.setAttribute(k, String(v));
    }
    for (const c of children)
      if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return el;
  };

  const qs = (sel, root = document) => root.querySelector(sel);
  const money = (n) => Math.round(Number(n) || 0).toLocaleString();
  const normalizePhone = (s) => String(s || "").replace(/\D/g, "");
  const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";

  // ---------- Tooltip ----------
  function tooltip(text) {
    if (!text) return null;
    const tip = mk("span", { class: "tip" }, ["?"]);
    const bubble = mk("div", { class: "tipBubble", html: text });
    bubble.style.display = "none";
    const wrap = mk("span", { class: "tipWrap" }, [tip, bubble]);
    tip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      bubble.style.display = bubble.style.display === "none" ? "block" : "none";
    });
    document.addEventListener("click", () => (bubble.style.display = "none"));
    return wrap;
  }

  // ---------- Municipality lookup ----------
  let MUNICACHE = null;

  async function loadMunicipalities() {
    if (MUNICACHE) return MUNICACHE;
    const res = await fetch(MUNICIPALITIES_URL, { cache: "no-store" });
    MUNICACHE = await res.json();
    return MUNICACHE;
  }

  function normalizeCityName(raw, muni) {
    const s = String(raw || "").trim();
    if (!s) return "";
    const aliased = muni?.aliases?.[s] || s;
    return aliased.replace(/,\s*TX$/i, "").trim();
  }

  async function runLookup(state, lookupSpec) {
    if (!lookupSpec) return;
    if (lookupSpec.source !== "municipalities") return;

    const muni = await loadMunicipalities();
    const matchField = lookupSpec.match_on || "addr_city";
    const cityRaw = state.answers[matchField];
    const city = normalizeCityName(cityRaw, muni);

    const row = muni?.cities?.[city] || null;
    const mapping = lookupSpec.write_to || {};

    for (const [rowKey, answerKey] of Object.entries(mapping))
      state.answers[answerKey] = row ? row[rowKey] : null;

    state.answers.municipality_city = row ? city : city || null;
    state.answers.municipality_found = !!row;
    state.answers.__permit_done = true;
  }

  // ---------- Pricing ----------
  function getDriverAnswer(cfg, answers, driverKey, fallbackId) {
    const drivers = cfg?.pricing?.drivers || {};
    const qid = drivers[driverKey] || fallbackId;
    return answers[qid];
  }

  function computePrice(cfg, answers) {
    const p = cfg.pricing || {};
    const base = p.base_price || {};
    const mods = p.modifiers || {};

    const type = getDriverAnswer(cfg, answers, "type", "type") || "tank";
    const fuel = getDriverAnswer(cfg, answers, "fuel", "fuel") || "gas";
    let key = `${type}_${fuel}`;
    if (!base[key]) key = "tank_gas";

    let price = Number(base[key] || 0);
    price += Number(mods.location?.[answers.location] ?? 0);
    price += Number(mods.access?.[answers.access] ?? 0);
    price += Number(mods.urgency?.[answers.urgency] ?? 0);
    if (fuel === "gas" || fuel === "not_sure")
      price += Number(mods.venting?.[answers.venting] ?? 0);
    if (fuel === "not_sure") price += Number(mods.fuel_not_sure_penalty ?? 0);
    price += Number(answers.permit_fee_usd || 0);
    if (answers.expansion_tank_required)
      price += Number(mods.expansion_tank_cost_usd ?? 0);

    const roundTo = p.safety?.round_to || 25;
    price = Math.round(price / roundTo) * roundTo;
    return { display_price: price, scenario_key: key };
  }

  function computePriceRange(cfg, answers, pricingQs) {
    const p = cfg.pricing || {};
    const base = p.base_price || {};
    const mods = p.modifiers || {};
    const type = getDriverAnswer(cfg, answers, "type", "type");
    const fuel = getDriverAnswer(cfg, answers, "fuel", "fuel");

    const baseVals = Object.entries(base)
      .filter(([k]) => {
        const [kt, kf] = k.split("_");
        if (type && kt !== type) return false;
        if (fuel && fuel !== "not_sure" && kf !== fuel) return false;
        return true;
      })
      .map(([, v]) => Number(v));

    let min = baseVals.length ? Math.min(...baseVals) : 0;
    let max = baseVals.length ? Math.max(...baseVals) : 0;

    const dims = ["location", "access", "urgency", "venting"];
    for (const d of dims) {
      const m = mods[d] || {};
      const vals = Object.values(m).map(Number);
      if (!vals.length) continue;
      if (!isEmpty(answers[d])) {
        const v = Number(m[answers[d]] ?? 0);
        min += v;
        max += v;
      } else {
        min += Math.min(...vals);
        max += Math.max(...vals);
      }
    }

    if (fuel === "not_sure") {
      const pad = Number(mods.fuel_not_sure_penalty ?? 0);
      min += pad;
      max += pad;
    }

    const roundTo = p.safety?.round_to || 25;
    min = Math.round(min / roundTo) * roundTo;
    max = Math.round(max / roundTo) * roundTo;
    return { min, max };
  }

  // ---------- Validation ----------
  function validateField(f, rawValue) {
    const v = String(rawValue ?? "");
    if (f.required && isEmpty(v)) return { ok: false, msg: "Required" };
    if (f.type === "phone" && normalizePhone(v).length < 10)
      return { ok: false, msg: "Enter a valid phone" };
    if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
      return { ok: false, msg: "Enter a valid email" };
    return { ok: true, msg: "" };
  }

  function isQuestionComplete(q, a) {
    if (!q) return true;
    if (q.type === "single_select") return !isEmpty(a[q.id]);
    if (q.type === "form")
      return (q.fields || []).every((f) => validateField(f, a[f.id]).ok);
    return true;
  }

  // ---------- Boot ----------
  async function boot() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    try {
      const cfg = await (await fetch(CONFIG_URL, { cache: "no-store" })).json();
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.stepIndex ??= 0;
      state.answers ??= {};

      const persist = () =>
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      const scheduleRender = (() => {
        let queued = false;
        return () => {
          if (queued) return;
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            render();
          });
        };
      })();

      const clearPermitOutputs = () => {
        (cfg.questions || []).forEach((s) => {
          if (s.type === "loading_lookup")
            (s.writes || []).forEach((k) => delete state.answers[k]);
        });
        delete state.answers.__permit_done;
      };

      const visibleQuestions = () =>
        (cfg.questions || []).filter((q) => {
          if (!q.depends_on) return true;
          return (
            state.answers[q.depends_on.question_id] === q.depends_on.equals
          );
        });

      function computePreview(vq) {
        const any = vq.some((q) => !isEmpty(state.answers[q.id]));
        const pricingDone = vq.every((q) => isQuestionComplete(q, state.answers));
        const exactAllowed =
          pricingDone &&
          state.answers.__permit_done === true &&
          (cfg.pricing?.exact_requires || []).every(
            (r) => !isEmpty(state.answers[r])
          );

        const range = computePriceRange(cfg, state.answers, vq);
        const exact = computePrice(cfg, state.answers);

        if (!any)
          return {
            label: "Estimated Total",
            value: "—",
            sub: "Answer a few questions to see your range.",
          };
        if (!exactAllowed)
          return {
            label: "Estimated Range",
            value: `$${money(range.min)}–$${money(range.max)}`,
            sub: "Add your address to get an exact number.",
          };
        return {
          label: "Exact Total",
          value: `$${money(exact.display_price)}`,
          sub: "Based on your answers.",
        };
      }

      async function submitPayload(vq) {
        const exact = computePrice(cfg, state.answers);
        const range = computePriceRange(cfg, state.answers, vq);
        const payload = {
          answers: state.answers,
          pricing: { exact, range },
          meta: { url: location.href, ts: new Date().toISOString() },
        };
        if (!ZAPIER_WEBHOOK_URL.includes("http")) {
          alert("Submitted (dev mode). Add Zapier URL.");
          return;
        }
        await fetch(ZAPIER_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        alert("Submitted! We'll reach out shortly.");
      }

      function render() {
        persist();
        mount.innerHTML = "";
        const vq = visibleQuestions();
        const q = vq[state.stepIndex];
        const pct = ((state.stepIndex + 1) / vq.length) * 100;
        const preview = computePreview(vq);

        const card = mk("div", { class: "card" }, [
          mk("div", { class: "stepHeader" }, [
            mk("div", { class: "progressWrap" }, [
              mk("div", { class: "progressMeta" }, [
                `Step ${state.stepIndex + 1} of ${vq.length}`,
              ]),
              mk("div", { class: "progressBar" }, [
                mk("div", {
                  class: "progressFill",
                  style: `width:${pct}%`,
                }),
              ]),
            ]),
            mk("h2", {}, [q?.title || ""]),
            q?.subtitle ? mk("div", { class: "stepSub" }, [q.subtitle]) : null,
          ]),
          mk("div", { id: "step-content" }),
        ]);

        const content = qs("#step-content", card);
        // --- render question types ---
        if (q.type === "single_select") {
          const opts = q.options || [];
          const grid = mk("div", {
            class: opts.some((o) => o.image_url)
              ? "choicesGrid"
              : "choicesList",
          });
          for (const opt of opts) {
            const active = String(state.answers[q.id]) === String(opt.value);
            const el = mk(
              "div",
              {
                class: `choice ${active ? "active" : ""} ${
                  opt.image_url ? "hasImg" : ""
                }`,
                onClick: () => {
                  state.answers[q.id] = opt.value;
                  clearPermitOutputs();
                  scheduleRender();
                },
              },
              [
                mk("div", { class: "choiceMain" }, [
                  mk("div", { class: "choiceLabel" }, [opt.label]),
                  opt.tooltip ? tooltip(opt.tooltip) : null,
                  opt.image_url
                    ? mk("img", {
                        class: "oimg",
                        src: opt.image_url,
                        alt: "",
                      })
                    : null,
                ]),
              ]
            );
            grid.appendChild(el);
          }
          content.appendChild(grid);
        } else if (q.type === "form") {
          for (const f of q.fields || []) {
            const val = state.answers[f.id] || "";
            const result = validateField(f, val);
            content.appendChild(
              mk("div", { class: "field" }, [
                mk("label", { class: "fieldLabel" }, [
                  f.label,
                  f.help ? tooltip(f.help) : null,
                ]),
                mk("input", {
                  type: f.input_type || "text",
                  value: val,
                  placeholder: f.placeholder || "",
                  onInput: (e) => {
                    state.answers[f.id] = e.target.value;
                    if (f.id.startsWith("addr_")) clearPermitOutputs();
                    scheduleRender();
                  },
                }),
                !result.ok && !isEmpty(val)
                  ? mk("div", { class: "fieldErr" }, [result.msg])
                  : null,
              ])
            );
          }
        }

        // --- nav buttons ---
        const canBack = state.stepIndex > 0;
        const stepOk = isQuestionComplete(q, state.answers);
        const isLast = state.stepIndex === vq.length - 1;
        card.appendChild(
          mk("div", { class: "nav" }, [
            mk(
              "button",
              {
                class: "btn secondary",
                disabled: !canBack,
                onClick: () => {
                  clearPermitOutputs();
                  state.stepIndex = Math.max(0, state.stepIndex - 1);
                  scheduleRender();
                },
              },
              ["Back"]
            ),
            mk(
              "button",
              {
                class: "btn",
                disabled: !stepOk,
                onClick: async () => {
                  if (q.type === "submit") {
                    await submitPayload(vq);
                    return;
                  }
                  state.stepIndex++;
                  scheduleRender();
                },
              },
              [isLast ? "Submit" : "Next"]
            ),
          ])
        );

        // --- live preview ---
        card.appendChild(
          mk("div", { class: "preview" }, [
            mk("div", { class: "previewTop" }, [
              mk("span", {}, [preview.label]),
            ]),
            mk("div", { class: "previewPrice" }, [preview.value]),
            mk("div", { class: "previewSub" }, [preview.sub]),
          ])
        );

        mount.appendChild(card);
      }

      scheduleRender();
    } catch (e) {
      console.error(e);
      mount.innerHTML = "<p>Error loading configuration.</p>";
    }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
