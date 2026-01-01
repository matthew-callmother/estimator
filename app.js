(function () {
  "use strict";

  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_v2_state";

  // ---------- Helpers ----------
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
  const money = (n) => Math.round(n).toLocaleString();
  const normalizePhone = (s) => String(s || "").replace(/\D/g, "");
  const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";

  // ---------- Tooltip (sample, tweak via CSS) ----------
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

  // ---------- Pricing ----------
  function getDriverAnswer(cfg, answers, driverKey, fallbackId) {
    const drivers = cfg?.pricing?.drivers || {};
    const qid = drivers[driverKey] || fallbackId;
    return answers[qid];
  }

  function computePrice(cfg, answers) {
    const p = cfg.pricing || {};
    const base = p.base_price || {};

    const type = getDriverAnswer(cfg, answers, "type", "type") || "tank";
    const fuel = getDriverAnswer(cfg, answers, "fuel", "fuel") || "gas";

    let key = `${type}_${fuel}`;
    if (!base[key]) key = "tank_gas";

    let price = Number(base[key] || 0);

    const mods = p.modifiers || {};
    const loc = getDriverAnswer(cfg, answers, "location", "location");
    const acc = getDriverAnswer(cfg, answers, "access", "access");
    const urg = getDriverAnswer(cfg, answers, "urgency", "urgency");

    price += Number(mods.location?.[loc] ?? 0);
    price += Number(mods.access?.[acc] ?? 0);
    price += Number(mods.urgency?.[urg] ?? 0);

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
        if (fuel && kFuel !== fuel) return false;
        return true;
      })
      .map(([, v]) => Number(v))
      .filter((v) => Number.isFinite(v));

    const baseMin = baseCandidates.length ? Math.min(...baseCandidates) : 0;
    const baseMax = baseCandidates.length ? Math.max(...baseCandidates) : 0;

    const driverIdsInWizard = new Set((pricingQuestions || []).map((q) => q.id).filter(Boolean));

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

    let min = baseMin;
    let max = baseMax;

    ["location", "access", "urgency"].forEach((dim) => {
      const qid = cfg?.pricing?.drivers?.[dim] || dim;
      // only consider dims that appear as wizard questions (so range doesn’t blow up unexpectedly)
      if (driverIdsInWizard.has(qid) || driverIdsInWizard.has(dim)) {
        const r = dimRange(dim);
        min += r.min;
        max += r.max;
      }
    });

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
      // simple check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, msg: "Enter a valid email" };
    }

    if (!isEmpty(v) && field.pattern) {
      try {
        const re = new RegExp(field.pattern);
        if (!re.test(v)) return { ok: false, msg: field.pattern_msg || "Invalid format" };
      } catch (_) {
        // ignore bad pattern
      }
    }

    if (!isEmpty(v) && field.min_len && v.trim().length < field.min_len) {
      return { ok: false, msg: `Min ${field.min_len} characters` };
    }

    return { ok: true, msg: "" };
  }

  function isQuestionComplete(q, answers) {
    if (!q) return true;

    if (q.type === "single_select") {
      return !isEmpty(answers[q.id]);
    }

    if (q.type === "form") {
      const fields = q.fields || [];
      for (const f of fields) {
        const r = validateField(f, answers[f.id]);
        if (!r.ok) return false;
      }
      return true;
    }

    if (q.type === "summary" || q.type === "content") return true;

    if (q.type === "submit") {
      // typically submit is enabled if all required fields in wizard are done;
      // we still treat submit step itself as complete
      return true;
    }

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

      function allPricingQuestionsComplete(vq) {
        const pricingQs = (vq || []).filter((q) => q.affects_pricing !== false);
        return pricingQs.every((q) => isQuestionComplete(q, state.answers));
      }

      function hasAnyPricingSignal(vq) {
        const pricingQs = (vq || []).filter((q) => q.affects_pricing !== false);
        // “don’t start with any amount”
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
        if (state.stepIndex < 0) state.stepIndex = 0;
        if (state.stepIndex > vq.length - 1) state.stepIndex = vq.length - 1;

        const q = vq[state.stepIndex];
        const isLast = state.stepIndex === vq.length - 1;

        // progress bar
        const pct = vq.length ? Math.round(((state.stepIndex + 1) / vq.length) * 100) : 0;

        // pricing display: — until any pricing signal; range until all pricing questions complete;
        // exact only when pricing complete AND exact_requires satisfied (e.g., address fields)
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
          previewSub = "Based on your answers.";
        }

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

        // --- Render by type ---
        if (q?.type === "single_select") {
          (q.options || []).forEach((opt) => {
            const active = String(state.answers[q.id]) === String(opt.value);
            content.appendChild(
              mk(
                "div",
                {
                  class: `choice ${active ? "active" : ""}`,
                  onClick: () => {
                    state.answers[q.id] = String(opt.value);
                    render();
                  },
                },
                [
                  mk("div", { class: "choiceMain" }, [
                    mk("span", { class: "choiceLabel" }, [opt.label]),
                    opt.tooltip ? tooltip(opt.tooltip) : null,
                    opt.image_url ? mk("img", { class: "oimg", src: opt.image_url, alt: "" }) : null,
                  ]),
                ]
              )
            );
          });
        } else if (q?.type === "form") {
          const fields = q.fields || [];
          fields.forEach((f) => {
            const val = state.answers[f.id] || "";
            const result = validateField(f, val);

            content.appendChild(
              mk("div", { class: "field" }, [
                mk("label", { class: "fieldLabel" }, [
                  f.label || f.id,
                  f.help ? tooltip(f.help) : null,
                ]),
                mk("input", {
                  type: f.input_type || "text",
                  value: val,
                  placeholder: f.placeholder || "",
                  autocomplete: f.autocomplete || "",
                  onInput: (e) => {
                    state.answers[f.id] = e.target.value;
                  },
                  onBlur: () => render(),
                }),
                (!result.ok && !isEmpty(val)) ? mk("div", { class: "fieldErr" }, [result.msg]) : null,
              ])
            );
          });
        } else if (q?.type === "content") {
          content.appendChild(mk("div", { class: "contentBlock", html: q.html || "" }));
        } else if (q?.type === "summary") {
          const block = mk("div", { class: "summary" });
          (vq || []).forEach((qq) => {
            if (qq.type === "submit") return;
            if (qq.type === "summary" || qq.type === "content") return;

            if (qq.type === "single_select") {
              const ans = state.answers[qq.id];
              if (isEmpty(ans)) return;
              const opt = (qq.options || []).find((o) => String(o.value) === String(ans));
              block.appendChild(
                mk("div", { class: "summaryRow" }, [
                  mk("div", { class: "summaryK" }, [qq.title || qq.id]),
                  mk("div", { class: "summaryV" }, [opt ? opt.label : String(ans)]),
                ])
              );
            }

            if (qq.type === "form") {
              (qq.fields || []).forEach((f) => {
                const ans = state.answers[f.id];
                if (isEmpty(ans)) return;
                block.appendChild(
                  mk("div", { class: "summaryRow" }, [
                    mk("div", { class: "summaryK" }, [f.label || f.id]),
                    mk("div", { class: "summaryV" }, [String(ans)]),
                  ])
                );
              });
            }
          });

          content.appendChild(block);
        } else if (q?.type === "submit") {
          content.appendChild(
            mk("div", { class: "note" }, [
              q.note || "Submit your info to lock in this estimate for 72 hours.",
            ])
          );
        } else {
          content.appendChild(mk("div", { class: "note" }, ["Unsupported question type."]));
        }

        // --- Nav ---
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
                  state.stepIndex--;
                  render();
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
                  // If this step is a submit step, submit (even if not the last; config controls flow)
                  if (q?.type === "submit") {
                    try {
                      await submitPayload(vq);
                    } catch (e) {
                      console.error(e);
                      alert("Submit failed. Please try again.");
                    }
                    return;
                  }
                  if (!isLast) {
                    state.stepIndex++;
                    render();
                  }
                },
              },
              [nextLabel]
            ),
          ])
        );

        // --- Live Preview ---
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
