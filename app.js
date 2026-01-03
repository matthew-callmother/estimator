(function () {
  "use strict";

  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MUNICIPALITIES_URL = "https://matthew-callmother.github.io/estimator/municipalities-dfw.json";
  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_v2_state";

  /* ---------------- Helpers ---------------- */
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
      } else if (v !== null && v !== undefined) el.setAttribute(k, String(v));
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

  /* ---------------- Tooltip ---------------- */
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

      // close on next outside click (don’t instantly close on the same click)
      setTimeout(() => {
        document.addEventListener(
          "click",
          () => {
            bubble.style.display = "none";
          },
          { once: true }
        );
      }, 0);
    });

    bubble.addEventListener("click", (e) => e.stopPropagation());
    return wrap;
  }

  /* ---------------- Municipality lookup ---------------- */
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

    for (const [rowKey, answerKey] of Object.entries(mapping)) {
      state.answers[answerKey] = row ? row[rowKey] : null;
    }

    state.answers.municipality_city = row ? city : (city || null);
    state.answers.municipality_found = !!row;
    state.answers.__permit_done = true; // “exact unlocked” until user changes/back
  }

  /* ---------------- Pricing ---------------- */
  function getDriverAnswer(cfg, answers, driverKey, fallbackId) {
    const drivers = cfg?.pricing?.drivers || {};
    const qid = drivers[driverKey] || fallbackId;
    return answers[qid];
  }

  function computeExact(cfg, answers) {
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

    if (fuel === "gas" || fuel === "not_sure") price += Number(mods.venting?.[vent] ?? 0);
    if (fuel === "not_sure") price += Number(mods.fuel_not_sure_penalty ?? 0);

    // lookup outputs
    price += Number(answers.permit_fee_usd || 0);
    if (answers.expansion_tank_required === true) price += Number(mods.expansion_tank_cost_usd ?? 0);

    const roundTo = p.safety?.round_to || 25;
    price = Math.round(price / roundTo) * roundTo;
    return { display_price: price, scenario_key: key };
  }

  function computeRange(cfg, answers, pricingQuestions) {
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
      .filter((n) => Number.isFinite(n));

    let min = baseCandidates.length ? Math.min(...baseCandidates) : 0;
    let max = baseCandidates.length ? Math.max(...baseCandidates) : 0;

    const idsInWizard = new Set((pricingQuestions || []).map((q) => q.id).filter(Boolean));

    const addDim = (dimKey) => {
      const qid = cfg?.pricing?.drivers?.[dimKey] || dimKey;
      if (!(idsInWizard.has(qid) || idsInWizard.has(dimKey))) return;

      // venting only matters for gas/not_sure
      if (dimKey === "venting" && fuel && fuel !== "gas" && fuel !== "not_sure") return;

      const table = mods?.[dimKey] || {};
      const vals = Object.values(table).map(Number).filter(Number.isFinite);
      if (!vals.length) return;

      const ans = answers[qid] ?? answers[dimKey];
      if (!isEmpty(ans)) {
        const v = Number(table?.[ans] ?? 0);
        min += v;
        max += v;
      } else {
        min += Math.min(...vals);
        max += Math.max(...vals);
      }
    };

    ["location", "access", "urgency", "venting"].forEach(addDim);

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

  /* ---------------- Validation ---------------- */
  function validateField(field, rawValue) {
    const v = rawValue == null ? "" : String(rawValue);

    if (field.required && isEmpty(v)) return { ok: false, msg: "Required" };

    if (!isEmpty(v) && field.type === "phone") {
      if (normalizePhone(v).length < (field.min_digits || 10)) return { ok: false, msg: "Enter a valid phone" };
    }

    if (!isEmpty(v) && field.type === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, msg: "Enter a valid email" };
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

    // loading_lookup/content/summary/submit don't block "Next" by themselves
    return true;
  }

  /* ---------------- Boot ---------------- */
  async function boot() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    try {
      const cfg = await (await fetch(CONFIG_URL, { cache: "no-store" })).json();

      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const state = {
        stepIndex: saved.stepIndex || 0,
        answers: saved.answers || {},
      };

      const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

      const visibleQuestions = () => {
        const all = cfg.questions || [];
        return all.filter((q) => {
          if (!q.depends_on) return true;
          const a = state.answers[q.depends_on.question_id];
          return String(a) === String(q.depends_on.equals);
        });
      };

      const isTransient = (step) => step?.transient === true;

      const clearPermitOutputs = () => {
        // revert to range until permit step reruns
        delete state.answers.__permit_done;
        (cfg.questions || []).forEach((step) => {
          if (step?.type === "loading_lookup" && step?.lookup?.source === "municipalities") {
            (step.writes || []).forEach((k) => delete state.answers[k]);
          }
        });
      };

      const backIndexSkippingTransients = (vq, fromIndex) => {
        let i = fromIndex - 1;
        while (i >= 0 && isTransient(vq[i])) i--;
        return Math.max(i, 0);
      };

      const allPricingQuestionsComplete = (vq) => {
        const pricingQs = (vq || []).filter((q) => q.affects_pricing !== false);
        return pricingQs.every((q) => isQuestionComplete(q, state.answers));
      };

      const hasAnyPricingSignal = (vq) => {
        const pricingQs = (vq || []).filter((q) => q.affects_pricing !== false);
        return pricingQs.some((q) => {
          if (q.type === "single_select") return !isEmpty(state.answers[q.id]);
          if (q.type === "form") return (q.fields || []).some((f) => !isEmpty(state.answers[f.id]));
          return false;
        });
      };

      const hasExactRequirements = () => {
        const req = cfg?.pricing?.exact_requires || [];
        if (!req.length) return true;
        return req.every((fieldId) => !isEmpty(state.answers[fieldId]));
      };

      function computePreview(vq) {
        const any = hasAnyPricingSignal(vq);
        const pricingDone = allPricingQuestionsComplete(vq);
        const exactAllowed = pricingDone && hasExactRequirements() && state.answers.__permit_done === true;

        const pricingQuestions = (vq || []).filter((qq) => qq.affects_pricing !== false);
        const range = computeRange(cfg, state.answers, pricingQuestions);
        const exact = computeExact(cfg, state.answers);

        let label = "Estimated Total";
        let value = "—";
        let sub = "Answer a few questions to see your range.";

        if (any && !exactAllowed) {
          label = "Estimated Range";
          value = `$${money(range.min)}–$${money(range.max)}`;
          sub = pricingDone ? "Add your address to get an exact number." : "Range updates as you answer.";
        }

        if (any && exactAllowed) {
          label = "Exact Total";
          value = `$${money(exact.display_price)}`;
          sub = "Based on your answers + municipality rules.";
        }

        return { label, value, sub };
      }

      async function submitPayload(vq) {
        const pricingQuestions = (vq || []).filter((q) => q.affects_pricing !== false);
        const exact = computeExact(cfg, state.answers);
        const range = computeRange(cfg, state.answers, pricingQuestions);

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

      let renderQueued = false;
      function scheduleRender() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => {
          renderQueued = false;
          render();
        });
      }

      function renderLoading(step, vq) {
        mount.innerHTML = "";

        const duration = Number(step.duration_ms || 1400);
        const start = Date.now();
        const fillId = `loadfill_${step.id}`;

        const pct = vq.length ? Math.round(((state.stepIndex + 1) / vq.length) * 100) : 0;

        const card = mk("div", { class: "card" }, [
          mk("div", { class: "stepHeader" }, [
            mk("div", { class: "progressWrap" }, [
              mk("div", { class: "progressMeta" }, [`Step ${state.stepIndex + 1} of ${vq.length}`]),
              mk("div", { class: "progressBar" }, [mk("div", { class: "progressFill", style: `width:${pct}%` })]),
            ]),
          ]),
          mk("div", { class: "loading" }, [
            mk("div", { class: "loadingInner" }, [
              mk("div", { class: "spinner" }),
              mk("div", { class: "loadingTitle" }, [step.title || "Checking…"]),
              step.subtitle ? mk("div", { class: "loadingSub" }, [step.subtitle]) : null,
              mk("div", { class: "loadBar" }, [mk("div", { id: fillId, class: "loadFill", style: "width:0%" })]),
            ]),
          ]),
        ]);

        mount.appendChild(card);

        const tick = () => {
          const el = document.getElementById(fillId);
          if (!el) return;
          const t = Math.min(1, (Date.now() - start) / duration);
          const eased = 1 - Math.pow(1 - t, 2);
          el.style.width = `${Math.min(92, Math.round(eased * 100))}%`;
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);

        return { start, duration, fillId };
      }

      function render() {
        persist();
        mount.innerHTML = "";

        const vq = visibleQuestions();
        state.stepIndex = Math.max(0, Math.min(state.stepIndex, vq.length - 1));

        const q = vq[state.stepIndex];
        const isLast = state.stepIndex === vq.length - 1;

        const pct = vq.length ? Math.round(((state.stepIndex + 1) / vq.length) * 100) : 0;
        const preview = computePreview(vq);

        const container = mk("div", { class: "card" }, [
          mk("div", { class: "stepHeader" }, [
            mk("div", { class: "progressWrap" }, [
              mk("div", { class: "progressMeta" }, [`Step ${state.stepIndex + 1} of ${vq.length}`]),
              mk("div", { class: "progressBar" }, [mk("div", { class: "progressFill", style: `width:${pct}%` })]),
            ]),
            mk("h2", {}, [q?.title || ""]),
            q?.subtitle ? mk("div", { class: "stepSub" }, [q.subtitle]) : null,
          ]),
          mk("div", { id: "step-content" }),
        ]);

        const content = qs("#step-content", container);

        /* -------- render question -------- */
        if (q?.type === "single_select") {
          const opts = q.options || [];
          const hasImages = opts.some((o) => !!o.image_url);

          const wrap = mk("div", { class: hasImages ? "choicesGrid" : "choicesList" });

          opts.forEach((opt) => {
            const active = String(state.answers[q.id]) === String(opt.value);

            wrap.appendChild(
              mk(
                "div",
                {
                  class: `choice ${active ? "active" : ""} ${opt.image_url ? "hasImg" : ""}`,
                  onClick: () => {
                    state.answers[q.id] = String(opt.value);
                    clearPermitOutputs();
                    scheduleRender();
                  },
                },
                [
                  mk("div", { class: "choiceMain" }, [
                    mk("div", { class: "choiceTop" }, [
                      mk("div", { class: "choiceLabel" }, [opt.label]),
                      opt.tooltip ? tooltip(opt.tooltip) : null,
                    ]),
                    opt.image_url ? mk("img", { class: "oimg", src: opt.image_url, alt: "", loading: "lazy" }) : null,
                  ]),
                ]
              )
            );
          });

          content.appendChild(wrap);
        } else if (q?.type === "form") {
          const fields = q.fields || [];
          fields.forEach((f) => {
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
                  onInput: (e) => {
                    state.answers[f.id] = e.target.value;

                    // address changes => must re-run permit lookup to regain exact
                    if (String(f.id).startsWith("addr_")) clearPermitOutputs();

                    scheduleRender();
                  },
                }),
                !result.ok && !isEmpty(val) ? mk("div", { class: "fieldErr" }, [result.msg]) : null,
              ])
            );
          });
        } else if (q?.type === "content") {
          content.appendChild(mk("div", { class: "contentBlock", html: q.html || "" }));
        } else if (q?.type === "summary") {
          content.appendChild(mk("div", { class: "note" }, ["Review your answers, then continue."]));
        } else if (q?.type === "submit") {
          content.appendChild(mk("div", { class: "note" }, [q.note || "Submit your info to lock in this estimate."]));
        }

        /* -------- nav -------- */
        const canGoBack = state.stepIndex > 0;
        const stepOk = isQuestionComplete(q, state.answers);
        const nextLabel = q?.next_label || (isLast ? (q?.submit_label || "Submit") : "Next");

        container.appendChild(
          mk("div", { class: "nav" }, [
            mk(
              "button",
              {
                class: "btn secondary",
                disabled: !canGoBack,
                onClick: () => {
                  clearPermitOutputs();
                  state.stepIndex = backIndexSkippingTransients(visibleQuestions(), state.stepIndex);
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
                  const vq2 = visibleQuestions();
                  const current = vq2[state.stepIndex];

                  if (current?.type === "submit") {
                    try {
                      await submitPayload(vq2);
                    } catch (e) {
                      console.error(e);
                      alert("Submit failed. Please try again.");
                    }
                    return;
                  }

                  if (state.stepIndex >= vq2.length - 1) return;

                  const next = vq2[state.stepIndex + 1];

                  if (next?.type === "loading_lookup" && next?.transient === true) {
                    // show loading UI, run lookup, then skip over transient step
                    const tracker = renderLoading(next, vq2);

                    // clear & re-earn exact
                    clearPermitOutputs();

                    try {
                      await runLookup(state, next.lookup);
                    } catch (e) {
                      console.warn("Lookup failed:", e);
                      state.answers.municipality_found = false;
                    }

                    const el = document.getElementById(tracker.fillId);
                    if (el) el.style.width = "100%";

                    const elapsed = Date.now() - tracker.start;
                    const remaining = Math.max(0, tracker.duration - elapsed);

                    setTimeout(() => {
                      state.stepIndex = state.stepIndex + 2; // skip transient step
                      scheduleRender();
                    }, remaining + 250);

                    return;
                  }

                  state.stepIndex++;
                  scheduleRender();
                },
              },
              [nextLabel]
            ),
          ])
        );

        /* -------- preview -------- */
        container.appendChild(
          mk("div", { class: "preview" }, [
            mk("div", { class: "previewTop" }, [
              mk("span", {}, [preview.label]),
              tooltip("Sample tooltip. You can style .tip / .tipBubble."),
            ]),
            mk("div", { class: "previewPrice" }, [preview.value]),
            mk("div", { class: "previewSub" }, [preview.sub]),
          ])
        );

        mount.appendChild(container);
      }

      scheduleRender();
    } catch (e) {
      console.error(e);
      const mount = document.getElementById(MOUNT_ID);
      if (mount) mount.innerHTML = "<p>Error loading configuration. Check console.</p>";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
