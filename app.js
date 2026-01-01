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
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v === "boolean") {
        if (k in el) el[k] = v;
        if (v) el.setAttribute(k, "");
        else el.removeAttribute(k);
      } else if (v !== null && v !== undefined) {
        el.setAttribute(k, String(v));
      }
    }

    for (const c of children) {
      if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
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

    if (lookupSpec.source === "municipalities") {
      const muni = await loadMunicipalities();
      const matchField = lookupSpec.match_on || "addr_city";
      const cityRaw = state.answers[matchField];
      const city = normalizeCityName(cityRaw, muni);

      const row = muni?.cities?.[city] || null;
      const mapping = lookupSpec.write_to || {};

      for (const [rowKey, answerKey] of Object.entries(mapping)) {
        state.answers[answerKey] = row ? row[rowKey] : null;
      }

      state.answers.municipality_city = row ? city : (city || null);
      state.answers.municipality_found = !!row;
    }
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

    const loc = getDriverAnswer(cfg, answers, "location", "location");
    const acc = getDriverAnswer(cfg, answers, "access", "access");
    const urg = getDriverAnswer(cfg, answers, "urgency", "urgency");
    const vent = getDriverAnswer(cfg, answers, "venting", "venting");

    price += Number(mods.location?.[loc] ?? 0);
    price += Number(mods.access?.[acc] ?? 0);
    price += Number(mods.urgency?.[urg] ?? 0);

    if (fuel === "gas" || fuel === "not_sure") {
      price += Number(mods.venting?.[vent] ?? 0);
    }

    if (fuel === "not_sure") {
      price += Number(mods.fuel_not_sure_penalty ?? 0);
    }

    // municipality adjustments (populated by lookup)
    price += Number(answers.permit_fee_usd || 0);

    if (answers.expansion_tank_required === true) {
      price += Number(mods.expansion_tank_cost_usd ?? 0);
    }

    const roundTo = p.safety?.round_to || 25;
    price = Math.round(price / roundTo) * roundTo;

    return { display_price: price, scenario_key: key };
  }

  function computePriceRange(cfg, answers, pricingQuestions) {
    const p = cfg.pricing || {};
    const base = p.base_price || {};
    const mods = p.modifiers || {};

    const type = getDriverAnswer(cfg, answers, "type", "type") || null;
    const fuel = getDriverAnswer(cfg, answers, "fuel", "fuel") || null;

    const baseCandidates = Object.entries(base)
      .filter(([k]) => {
        const [kType, kFuel] = String(k).split("_");
        if (type && kType !== type) return false;
        if (fuel && fuel !== "not_sure" && kFuel !== fuel) return false;
        return true;
      })
      .map(([, v]) => Number(v))
      .filter((v) => Number.isFinite(v));

    let min = baseCandidates.length ? Math.min(...baseCandidates) : 0;
    let max = baseCandidates.length ? Math.max(...baseCandidates) : 0;

    const ids = new Set((pricingQuestions || []).map((q) => q.id).filter(Boolean));

    const dimRange = (dimKey) => {
      const m = mods?.[dimKey] || {};
      const qid = cfg?.pricing?.drivers?.[dimKey] || dimKey;
      const ans = answers[qid];

      if (!isEmpty(ans)) {
        const v = Number(m?.[ans] ?? 0);
        return { min: v, max: v };
      }
      const vals = Object.values(m).map(Number).filter((n) => Number.isFinite(n));
      if (!vals.length) return { min: 0, max: 0 };
      return { min: Math.min(...vals), max: Math.max(...vals) };
    };

    const dims = ["location", "access", "urgency", "venting"];
    for (const dim of dims) {
      const qid = cfg?.pricing?.drivers?.[dim] || dim;

      if (dim === "venting" && fuel && fuel !== "gas" && fuel !== "not_sure") continue;

      if (ids.has(qid) || ids.has(dim)) {
        const r = dimRange(dim);
        min += r.min;
        max += r.max;
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
  function validateField(field, rawValue) {
    const v = rawValue == null ? "" : String(rawValue);

    if (field.required && isEmpty(v)) return { ok: false, msg: "Required" };

    if (!isEmpty(v) && field.type === "phone") {
      if (normalizePhone(v).length < (field.min_digits || 10)) return { ok: false, msg: "Enter a valid phone" };
    }

    if (!isEmpty(v) && field.type === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, msg: "Enter a valid email" };
    }

    if (!isEmpty(v) && field.pattern) {
      try {
        const re = new RegExp(field.pattern);
        if (!re.test(v)) return { ok: false, msg: field.pattern_msg || "Invalid format" };
      } catch (_) {}
    }

    if (!isEmpty(v) && field.min_len && v.trim().length < field.min_len) {
      return { ok: false, msg: `Min ${field.min_len} characters` };
    }

    return { ok: true, msg: "" };
  }

  function isQuestionComplete(q, answers) {
    if (!q) return true;

    if (q.type === "single_select") return !isEmpty(answers[q.id]);

    if (q.type === "form") {
      for (const f of (q.fields || [])) {
        const r = validateField(f, answers[f.id]);
        if (!r.ok) return false;
      }
      return true;
    }

    if (q.type === "content" || q.type === "summary" || q.type === "submit" || q.type === "loading_lookup") return true;
    return true;
  }

  // ---------- Boot ----------
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
      };

      const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

      function visibleQuestions() {
        const all = cfg.questions || [];
        return all.filter((q) => {
          if (!q.depends_on) return true;
          const a = state.answers[q.depends_on.question_id];
          return String(a) === String(q.depends_on.equals);
        });
      }

      function isTransientStep(step) {
        return step?.transient === true;
      }

      function clearLookupState(vq) {
        for (const step of (vq || [])) {
          if (step?.type === "loading_lookup") {
            delete state.answers[`__ran_${step.id}`];
            for (const k of (step.writes || [])) delete state.answers[k];
          }
        }
      }

      function backIndexSkippingTransients(vq, fromIndex) {
        let i = fromIndex - 1;
        while (i >= 0 && isTransientStep(vq[i])) i--;
        return Math.max(i, 0);
      }

      function allPricingQuestionsComplete(vq) {
        const pricingQs = (vq || []).filter((q) => q.affects_pricing !== false);
        return pricingQs.every((q) => isQuestionComplete(q, state.answers));
      }

      function hasAnyPricingSignal(vq) {
        const pricingQs = (vq || []).filter((q) => q.affects_pricing !== false);
        return pricingQs.some((q) => {
          if (q.type === "single_select") return !isEmpty(state.answers[q.id]);
          if (q.type === "form") return (q.fields || []).some((f) => !isEmpty(state.answers[f.id]));
          return false;
        });
      }

      function hasExactRequirements() {
        const req = cfg?.pricing?.exact_requires || [];
        if (!req.length) return true;
        return req.every((fieldId) => !isEmpty(state.answers[fieldId]));
      }

      async function submitPayload(vq) {
        const exact = computePrice(cfg, state.answers);
        const range = computePriceRange(cfg, state.answers, (vq || []).filter((q) => q.affects_pricing !== false));

        const payload = {
          answers: state.answers,
          pricing: { exact, range },
          meta: { url: location.href, ts: new Date().toISOString() },
        };

        if (!ZAPIER_WEBHOOK_URL || String(ZAPIER_WEBHOOK_URL).includes("PASTE_YOUR_")) {
          alert("Submitted (dev mode). Add your Zapier URL to send.");
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
        state.stepIndex = Math.max(0, Math.min(state.stepIndex, vq.length - 1));

        const q = vq[state.stepIndex];
        const isLast = state.stepIndex === vq.length - 1;

        const pct = vq.length ? Math.round(((state.stepIndex + 1) / vq.length) * 100) : 0;

        const any = hasAnyPricingSignal(vq);
        const pricingDone = allPricingQuestionsComplete(vq);
        const exactAllowed = pricingDone && hasExactRequirements();

        const exact = computePrice(cfg, state.answers);
        const range = computePriceRange(cfg, state.answers, (vq || []).filter((qq) => qq.affects_pricing !== false));

        let previewLabel = "Estimated Total";
        let previewValue = "—";
        let previewSub = "Answer a few questions to see your range.";

        if (any && !exactAllowed) {
          previewLabel = "Estimated Range";
          previewValue = `$${money(range.min)}–$${money(range.max)}`;
          previewSub = pricingDone ? "Add your address to get an exact number." : "Range updates as you answer.";
        }

        if (any && exactAllowed) {
          previewLabel = "Exact Total";
          previewValue = `$${money(exact.display_price)}`;
          previewSub = "Based on your answers + municipality rules.";
        }

        const container = mk("div", { class: "card" }, [
          mk("div", { class: "stepHeader" }, [
            mk("div", { class: "progressWrap" }, [
              mk("div", { class: "progressMeta" }, [`Step ${state.stepIndex + 1} of ${vq.length}`]),
              mk("div", { class: "progressBar" }, [
                mk("div", { class: "progressFill", style: `width:${pct}%` }),
              ]),
            ]),
            mk("h2", {}, [q?.title || ""]),
            q?.subtitle ? mk("div", { class: "stepSub" }, [q.subtitle]) : null,
          ]),
          mk("div", { id: "step-content" }),
        ]);

        const content = qs("#step-content", container);

        // ---- render question ----
        if (q?.type === "single_select") {
          for (const opt of (q.options || [])) {
            const active = String(state.answers[q.id]) === String(opt.value);
            content.appendChild(
              mk("div", {
                class: `choice ${active ? "active" : ""}`,
                onClick: () => {
                  state.answers[q.id] = String(opt.value);
                  render();
                },
              }, [
                mk("div", { class: "choiceMain" }, [
                  mk("span", { class: "choiceLabel" }, [opt.label]),
                  opt.tooltip ? tooltip(opt.tooltip) : null,
                  opt.image_url ? mk("img", { class: "oimg", src: opt.image_url, alt: "" }) : null,
                ]),
              ])
            );
          }
        } else if (q?.type === "form") {
          for (const f of (q.fields || [])) {
            const val = state.answers[f.id] || "";
            const result = validateField(f, val);

            content.appendChild(
              mk("div", { class: "field" }, [
                mk("label", { class: "fieldLabel" }, [f.label || f.id, f.help ? tooltip(f.help) : null]),
                mk("input", {
                  type: f.input_type || "text",
                  value: val,
                  placeholder: f.placeholder || "",
                  autocomplete: f.autocomplete || "",
                  onInput: (e) => { state.answers[f.id] = e.target.value; },
                  onBlur: () => render(),
                }),
                (!result.ok && !isEmpty(val)) ? mk("div", { class: "fieldErr" }, [result.msg]) : null,
              ])
            );
          }
        } else if (q?.type === "content") {
          content.appendChild(mk("div", { class: "contentBlock", html: q.html || "" }));
        } else if (q?.type === "summary") {
          const block = mk("div", { class: "summary" });

          for (const qq of (vq || [])) {
            if (qq.type === "submit" || qq.type === "summary" || qq.type === "content" || qq.type === "loading_lookup") continue;

            if (qq.type === "single_select") {
              const ans = state.answers[qq.id];
              if (isEmpty(ans)) continue;
              const opt = (qq.options || []).find((o) => String(o.value) === String(ans));
              block.appendChild(
                mk("div", { class: "summaryRow" }, [
                  mk("div", { class: "summaryK" }, [qq.title || qq.id]),
                  mk("div", { class: "summaryV" }, [opt ? opt.label : String(ans)]),
                ])
              );
            } else if (qq.type === "form") {
              for (const f of (qq.fields || [])) {
                const ans = state.answers[f.id];
                if (isEmpty(ans)) continue;
                block.appendChild(
                  mk("div", { class: "summaryRow" }, [
                    mk("div", { class: "summaryK" }, [f.label || f.id]),
                    mk("div", { class: "summaryV" }, [String(ans)]),
                  ])
                );
              }
            }
          }

          if (!isEmpty(state.answers.municipality_city)) {
            block.appendChild(
              mk("div", { class: "summaryRow" }, [
                mk("div", { class: "summaryK" }, ["Municipality"]),
                mk("div", { class: "summaryV" }, [String(state.answers.municipality_city)]),
              ])
            );
          }

          if (!isEmpty(state.answers.permit_fee_usd)) {
            block.appendChild(
              mk("div", { class: "summaryRow" }, [
                mk("div", { class: "summaryK" }, ["Permit fee"]),
                mk("div", { class: "summaryV" }, [`$${money(state.answers.permit_fee_usd)}`]),
              ])
            );
          }

          if (state.answers.expansion_tank_required === true) {
            block.appendChild(
              mk("div", { class: "summaryRow" }, [
                mk("div", { class: "summaryK" }, ["Expansion tank"]),
                mk("div", { class: "summaryV" }, ["Required"]),
              ])
            );
          }

          content.appendChild(block);
        } else if (q?.type === "submit") {
          content.appendChild(mk("div", { class: "note" }, [q.note || "Submit your info to lock in this estimate."]));
        } else {
          content.appendChild(mk("div", { class: "note" }, ["Unsupported question type."]));
        }

        // ---- nav ----
        const canGoBack = state.stepIndex > 0;
        const stepOk = isQuestionComplete(q, state.answers);
        const nextLabel = q?.next_label || (isLast ? (q?.submit_label || "Submit") : "Next");

        container.appendChild(
          mk("div", { class: "nav" }, [
            mk("button", {
              class: "btn secondary",
              disabled: !canGoBack,
              onClick: () => {
                const prev = backIndexSkippingTransients(vq, state.stepIndex);
                if (prev < state.stepIndex - 1) clearLookupState(vq);
                state.stepIndex = prev;
                render();
              },
            }, ["Back"]),

            mk("button", {
              class: "btn",
              disabled: !stepOk,
              onClick: async () => {
                if (q?.type === "submit") {
                  try { await submitPayload(vq); }
                  catch (e) { console.error(e); alert("Submit failed. Please try again."); }
                  return;
                }

                if (isLast) return;

                const next = vq[state.stepIndex + 1];

                // transient loading_lookup runs BETWEEN steps (never becomes a "back" destination)
                if (next?.type === "loading_lookup" && next?.transient === true) {
                  mount.innerHTML = "";

                  const duration = Number(next.duration_ms || 1400);
                  const start = Date.now();
                  const fillId = `loadfill_${next.id}`;

                  const card = mk("div", { class: "card" }, [
                    mk("div", { class: "stepHeader" }, [
                      mk("div", { class: "progressWrap" }, [
                        mk("div", { class: "progressMeta" }, [`Step ${state.stepIndex + 2} of ${vq.length}`]),
                        mk("div", { class: "progressBar" }, [
                          mk("div", {
                            class: "progressFill",
                            style: `width:${Math.round(((state.stepIndex + 2) / vq.length) * 100)}%`,
                          }),
                        ]),
                      ]),
                      mk("h2", {}, [next.title || "Checking…"]),
                      next.subtitle ? mk("div", { class: "stepSub" }, [next.subtitle]) : null,
                    ]),
                    mk("div", { class: "loading" }, [
                      mk("div", { class: "loadingInner" }, [
                        mk("div", { class: "spinner" }),
                        mk("div", { class: "loadBar" }, [
                          mk("div", { id: fillId, class: "loadFill", style: "width:0%" }),
                        ]),
                      ]),
                    ]),
                  ]);

                  mount.appendChild(card);

                  // force requery each time user goes forward from address
                  delete state.answers[`__ran_${next.id}`];
                  for (const k of (next.writes || [])) delete state.answers[k];

                  const tick = () => {
                    const el = document.getElementById(fillId);
                    if (!el) return;
                    const t = Math.min(1, (Date.now() - start) / duration);
                    const eased = 1 - Math.pow(1 - t, 2);
                    el.style.width = `${Math.min(92, Math.round(eased * 100))}%`;
                    if (t < 1) requestAnimationFrame(tick);
                  };
                  requestAnimationFrame(tick);

                  (async () => {
                    try { await runLookup(state, next.lookup); }
                    catch (e) { console.warn("Lookup failed:", e); state.answers.municipality_found = false; }

                    const el = document.getElementById(fillId);
                    if (el) el.style.width = "100%";

                    const elapsed = Date.now() - start;
                    const remaining = Math.max(0, duration - elapsed);

                    setTimeout(() => {
                      state.stepIndex = state.stepIndex + 2; // skip over transient step
                      persist();
                      render();
                    }, remaining + 250);
                  })();

                  return;
                }

                state.stepIndex++;
                render();
              },
            }, [nextLabel]),
          ])
        );

        // ---- preview ----
        container.appendChild(
          mk("div", { class: "preview" }, [
            mk("div", { class: "previewTop" }, [
              mk("span", {}, [previewLabel]),
              tooltip("Sample tooltip text. Click “?” to toggle. Style .tip / .tipBubble."),
            ]),
            mk("div", { class: "previewPrice" }, [previewValue]),
            mk("div", { class: "previewSub" }, [previewSub]),
          ])
        );

        mount.appendChild(container);
      }

      render();
    } catch (e) {
      const mount = document.getElementById(MOUNT_ID);
      if (mount) mount.innerHTML = `<p>Error loading configuration. Check console.</p>`;
      console.error(e);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
