(function () {
  "use strict";

  // ---- Config ----
  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_v3_state";

  // ---- Helpers ----
  const qs = (sel, root = document) => root.querySelector(sel);

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
    for (const c of children) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return el;
  };

  const money = (n) => Math.round(Number(n) || 0).toLocaleString();
  const normPhone = (s) => String(s || "").replace(/\D/g, "");
  const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";

  // ---- Tooltip ----
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

  // ---- Lookup (municipalities) ----
  let MUNI_CACHE = null;

  async function loadMunicipalities(url) {
    if (MUNI_CACHE) return MUNI_CACHE;
    const res = await fetch(url, { cache: "no-store" });
    MUNI_CACHE = await res.json();
    return MUNI_CACHE;
  }

  function safeStr(v) {
    return String(v == null ? "" : v).trim();
  }

  function addressSig(answers) {
    return [
      safeStr(answers.addr_street).toLowerCase(),
      safeStr(answers.addr_city).toLowerCase(),
      safeStr(answers.addr_state).toLowerCase(),
      safeStr(answers.addr_zip).toLowerCase(),
    ].join("|");
  }

  // ---- Validation ----
  function validateField(field, rawValue) {
    const v = rawValue == null ? "" : String(rawValue);

    if (field.required && isEmpty(v)) return { ok: false, msg: "Required" };

    if (!isEmpty(v) && field.type === "phone") {
      if (normPhone(v).length < (field.min_digits || 10)) return { ok: false, msg: "Enter a valid phone" };
    }

    if (!isEmpty(v) && field.type === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, msg: "Enter a valid email" };
    }

    if (!isEmpty(v) && field.pattern) {
      const re = new RegExp(field.pattern);
      if (!re.test(v)) return { ok: false, msg: field.pattern_msg || "Invalid format" };
    }

    return { ok: true, msg: "" };
  }

  function isStepComplete(step, answers) {
    if (!step) return true;

    if (step.type === "single_select") return !isEmpty(answers[step.id]);

    if (step.type === "form") {
      for (const f of step.fields || []) {
        const r = validateField(f, answers[f.id]);
        if (!r.ok) return false;
      }
      return true;
    }

    return true;
  }

  // ---- Routing guards ----
  function isAllowedQuestionId(id, answers) {
    if (id === "tank_fuel") return answers.type === "tank";
    if (id === "tankless_fuel") return answers.type === "tankless";
    return true;
  }

  function pruneState(state) {
    // remove answers that no longer make sense
    if (state.answers.type === "tank") delete state.answers.tankless_fuel;
    if (state.answers.type === "tankless") delete state.answers.tank_fuel;

    // prune history
    state.history = (state.history || []).filter((id) => isAllowedQuestionId(id, state.answers));

    // if current id is not allowed anymore, send them to the start
    if (!isAllowedQuestionId(state.currentId, state.answers)) state.currentId = "type";
  }

  // ---- Pricing (simple: only what the user selected) ----
  function getSelectedOption(step, answers) {
    const val = answers[step.id];
    if (isEmpty(val)) return null;
    return (step.options || []).find((o) => String(o.value) === String(val)) || null;
  }

  function computeRange(cfg, answers) {
    let low = 0;
    let high = 0;

    for (const q of cfg.questions || []) {
      if (q.type !== "single_select") continue;
      const opt = getSelectedOption(q, answers);
      if (!opt || !opt.price) continue;

      low += Number(opt.price.low) || 0;
      high += Number(opt.price.high) || 0;
    }

    const roundTo = Number(cfg?.pricing?.round_to) || 25;
    low = Math.round(low / roundTo) * roundTo;
    high = Math.round(high / roundTo) * roundTo;

    return { low, high };
  }

  function computeExact(cfg, range, answers) {
    // exact is ONLY available after permit lookup completes
    const mode = String(cfg?.pricing?.exact_mode || "mid").toLowerCase();
    let base = 0;

    if (mode === "low") base = range.low;
    else if (mode === "high") base = range.high;
    else base = (range.low + range.high) / 2;

    const permit = Number(answers.permit_fee_usd) || 0;
    const addon = answers.expansion_tank_required === true ? Number(cfg?.lookup?.expansion_tank_addon) || 0 : 0;

    const roundTo = Number(cfg?.pricing?.round_to) || 25;
    let exact = base + permit + addon;
    exact = Math.round(exact / roundTo) * roundTo;

    return exact;
  }

  // ---- Loading screen ----
  function renderLoading(mount, step, pct) {
    mount.innerHTML = "";

    const card = mk("div", { class: "card" }, [
      mk("div", { class: "stepHeader" }, [
        mk("div", { class: "progressWrap" }, [
          mk("div", { class: "progressMeta" }, [pct ? `Progress ${pct}%` : ""]),
          mk("div", { class: "progressBar" }, [mk("div", { class: "progressFill", style: `width:${pct || 0}%` })]),
        ]),
      ]),
      mk("div", { class: "loading" }, [
        mk("div", { class: "loadingInner" }, [
          mk("div", { class: "spinner" }),
          mk("div", { class: "loadingTitle" }, [step.title || "Working…"]),
          step.subtitle ? mk("div", { class: "loadingSub" }, [step.subtitle]) : null,
          mk("div", { class: "loadBar" }, [mk("div", { id: "loadFill", class: "loadFill", style: "width:0%" })]),
        ]),
      ]),
    ]);

    mount.appendChild(card);

    const fill = qs("#loadFill", mount);
    if (fill) fill.style.width = "8%";
  }

  // ---- Main ----
  async function boot() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    const cfg = await (await fetch(CONFIG_URL, { cache: "no-store" })).json();

    const byId = new Map((cfg.questions || []).map((q) => [q.id, q]));
    const getQ = (id) => byId.get(id) || null;

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");

    const state = {
      currentId: saved.currentId || cfg?.meta?.start_id || (cfg.questions?.[0]?.id || null),
      answers: saved.answers || {},
      history: saved.history || [],
      meta: saved.meta || {
        permit_done: false,
        permit_sig: null,
        exact_unlocked: false,
        after_permit: false
      },
    };

    const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    function invalidateAddressDerived() {
      state.meta.permit_done = false;
      state.meta.permit_sig = null;
      state.meta.exact_unlocked = false;
      state.meta.after_permit = false;

      delete state.answers.permit_fee_usd;
      delete state.answers.expansion_tank_required;
    }

    function setAnswer(key, value) {
      const prev = state.answers[key];
      state.answers[key] = value;

      // If address changes, kill exact until they resubmit address again.
      if (String(key).startsWith("addr_") && String(prev || "") !== String(value || "")) {
        invalidateAddressDerived();
      }

      // If they change the branch root, prune branch answers + history.
      if (key === "type" && String(prev || "") !== String(value || "")) {
        delete state.answers.tank_fuel;
        delete state.answers.tankless_fuel;
      }

      pruneState(state);
      persist();
    }

    function goTo(nextId) {
      if (!nextId) return;
      state.currentId = nextId;
      pruneState(state);
      persist();
      render();
    }

    function back() {
      const prev = state.history.pop();
      if (!prev) return;
      state.currentId = prev;
      pruneState(state);
      persist();
      render();
    }

    function nextFrom(step) {
      if (!step) return null;

      if (step.type === "single_select") {
        const opt = getSelectedOption(step, state.answers);
        return (opt && opt.next) || step.next || null;
      }

      return step.next || null;
    }

    function canShowExact(step) {
      if (!state.meta.exact_unlocked || !state.meta.after_permit) return false;
      if (!step) return false;
      if (step.id === "address_gate") return false;
      if (step.id === "permit_check") return false;
      return true;
    }

    async function runPermitLookup() {
      const lookup = cfg.lookup || {};
      const muniUrl = lookup.municipalities_url;
      if (!muniUrl) return;

      const sig = addressSig(state.answers);

      // Always run when they hit Continue on address (i.e., resubmitted),
      // but we still store sig so exact is tied to the submitted address.
      const muni = await loadMunicipalities(muniUrl);

      const matchField = lookup.match_on || "addr_city";
      const cityRaw = safeStr(state.answers[matchField]);
      const cityKey = cityRaw.replace(/,\s*TX$/i, "").trim();

      const row = muni?.cities?.[cityKey] || null;
      const mapping = lookup.write_to || {};

      for (const [rowKey, answerKey] of Object.entries(mapping)) {
        state.answers[answerKey] = row ? row[rowKey] : null;
      }

      state.meta.permit_done = true;
      state.meta.permit_sig = sig;
      state.meta.exact_unlocked = true;
      state.meta.after_permit = true;

      persist();
    }

    async function submit() {
      const range = computeRange(cfg, state.answers);
      const exact = state.meta.exact_unlocked ? computeExact(cfg, range, state.answers) : null;

      const payload = {
        answers: state.answers,
        pricing: { range, exact },
        meta: {
          url: location.href,
          ts: new Date().toISOString(),
          lock_hours: cfg?.meta?.lock_hours || null,
        },
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

    // ---- Render ----
    let renderQueued = false;
    function scheduleRender() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        render();
      });
    }

    function render() {
      persist();
      mount.innerHTML = "";

      const step = getQ(state.currentId);
      if (!step) {
        mount.appendChild(mk("div", { class: "card" }, [mk("div", { class: "note" }, ["Config error: missing step."])]));
        return;
      }

      const range = computeRange(cfg, state.answers);
      const exact = computeExact(cfg, range, state.answers);

      const showExact = canShowExact(step);

      const previewLabel = showExact ? "Exact Price" : "Estimated Range";
      const previewValue = showExact ? `$${money(exact)}` : (range.low || range.high ? `$${money(range.low)}–$${money(range.high)}` : "—");
      const previewSub = showExact ? "Exact price shown after address verification." : "Updates as you answer.";

      const card = mk("div", { class: "card" }, [
        mk("div", { class: "stepHeader" }, [
          mk("h2", {}, [step.title || ""]),
          step.subtitle ? mk("div", { class: "stepSub" }, [step.subtitle]) : null,
        ]),
        mk("div", { id: "step-content" }),
      ]);

      const content = qs("#step-content", card);

      // ---- Step content ----
      if (step.type === "single_select") {
        const opts = step.options || [];
        const hasImages = opts.some((o) => !!o.image_url);

        const wrap = mk("div", { class: hasImages ? "choicesGrid" : "choicesList" });

        opts.forEach((opt) => {
          const active = String(state.answers[step.id]) === String(opt.value);

          wrap.appendChild(
            mk(
              "div",
              {
                class: `choice ${active ? "active" : ""} ${opt.image_url ? "hasImg" : ""}`,
                onClick: () => {
                  setAnswer(step.id, String(opt.value));
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
      } else if (step.type === "form") {
        (step.fields || []).forEach((f) => {
          const val = state.answers[f.id] || "";
          const result = validateField(f, val);

          content.appendChild(
            mk("div", { class: "field" }, [
              mk("label", { class: "fieldLabel" }, [f.label || f.id]),
              mk("input", {
                type: f.input_type || "text",
                value: val,
                placeholder: f.placeholder || "",
                autocomplete: f.autocomplete || "",
                onInput: (e) => {
                  setAnswer(f.id, e.target.value);
                  scheduleRender();
                },
              }),
              !result.ok && !isEmpty(val) ? mk("div", { class: "fieldErr" }, [result.msg]) : null,
            ])
          );
        });
      } else if (step.type === "summary") {
        const disclaimer = cfg?.result_copy?.disclaimer || "";
        content.appendChild(
          mk("div", { class: "note" }, [
            "Review your info, then submit.",
            disclaimer ? mk("div", { class: "small" }, [disclaimer]) : null,
          ].filter(Boolean))
        );
      } else if (step.type === "submit") {
        content.appendChild(mk("div", { class: "note" }, [step.subtitle || "Submit to send."]));
      }

      // ---- Preview ----
      const disclaimer = cfg?.result_copy?.disclaimer || "";
      card.appendChild(
        mk("div", { class: "preview" }, [
          mk("div", { class: "previewTop" }, [
            mk("span", {}, [previewLabel]),
            disclaimer ? tooltip(disclaimer) : null,
          ]),
          mk("div", { class: "previewPrice" }, [previewValue]),
          mk("div", { class: "previewSub" }, [previewSub]),
        ])
      );

      // ---- Nav ----
      const canBack = state.history.length > 0;
      const ok = isStepComplete(step, state.answers);

      const nav = mk("div", { class: "nav" });

      // Back always skips the loading step because loading is never pushed to history.
      nav.appendChild(
        mk(
          "button",
          { class: "btn secondary", disabled: !canBack, onClick: back },
          ["Back"]
        )
      );

      // Next label
      let nextLabel = "Next";
      if (step.type === "submit") nextLabel = step.submit_label || "Submit";
      else if (step.id === "address_gate") nextLabel = "Continue";
      else if (step.type === "summary") nextLabel = "Get My Estimate";

      nav.appendChild(
        mk(
          "button",
          {
            class: "btn",
            disabled: !ok,
            onClick: async () => {
              const s = getQ(state.currentId);
              if (!s) return;

              if (s.type === "submit") {
                try {
                  await submit();
                } catch (e) {
                  console.error(e);
                  alert("Submit failed. Please try again.");
                }
                return;
              }

              // Address step special behavior:
              // - show loading screen
              // - no nav during loading
              // - only appears when user hits Continue on address
              if (s.id === "address_gate") {
                // push address step to history so Back from contact goes here
                state.history.push(s.id);
                persist();

                const loadingStep = getQ(s.next); // permit_check
                if (!loadingStep || loadingStep.type !== "loading_lookup") {
                  // no loading configured, just go next
                  goTo(s.next);
                  return;
                }

                renderLoading(mount, loadingStep);

                const duration = Number(loadingStep.duration_ms || 1400);
                const start = Date.now();

                // start fill animation
                const fill = qs("#loadFill", mount);
                const tick = () => {
                  if (!fill) return;
                  const t = Math.min(1, (Date.now() - start) / duration);
                  const eased = 1 - Math.pow(1 - t, 2);
                  fill.style.width = `${Math.min(92, Math.round(eased * 100))}%`;
                  if (t < 1) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);

                try {
                  await runPermitLookup();
                } catch (e) {
                  console.warn("Lookup failed:", e);
                  // still allow forward, but exact won't be meaningful
                  state.meta.permit_done = false;
                  state.meta.exact_unlocked = false;
                  state.meta.after_permit = false;
                  delete state.answers.permit_fee_usd;
                  delete state.answers.expansion_tank_required;
                  persist();
                }

                // finish and advance after duration
                const elapsed = Date.now() - start;
                const remaining = Math.max(0, duration - elapsed);

                setTimeout(() => {
                  const f = qs("#loadFill", mount);
                  if (f) f.style.width = "100%";
                  goTo(loadingStep.next);
                }, remaining + 200);

                return;
              }

              // Normal step: push current -> go next
              state.history.push(s.id);
              persist();

              const nextId = nextFrom(s);
              goTo(nextId);
            },
          },
          [nextLabel]
        )
      );

      card.appendChild(nav);

      mount.appendChild(card);
    }

    pruneState(state);
    persist();
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
