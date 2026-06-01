(function () {
  "use strict";

  const SCRIPT_DATA = document.currentScript?.dataset || {};
  const DEFAULT_BOOKING_ENDPOINT = "https://estimator-sage-xi.vercel.app/api/bookings";
  const DEFAULT_CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const DEFAULT_MUNICIPALITIES_URL = "https://matthew-callmother.github.io/estimator/municipalities-dfw.json";

  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_routing_state";
  const PROGRESS_COUNTED_TYPES = new Set(["single_select", "form", "summary"]);

  /* ---------------- Helpers ---------------- */
  const qs = (sel, root = document) => root.querySelector(sel);
  const money = (n) => Math.round(Number(n) || 0).toLocaleString();
  const normalizePhone = (s) => String(s || "").replace(/\D/g, "");
  const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";
  const safeStr = (v) => String(v == null ? "" : v).trim();

  function getConfigUrl() {
    return window.WH_ESTIMATOR_CONFIG_URL || SCRIPT_DATA.configUrl || DEFAULT_CONFIG_URL;
  }

  function getMunicipalitiesUrl() {
    return window.WH_ESTIMATOR_MUNICIPALITIES_URL || SCRIPT_DATA.municipalitiesUrl || DEFAULT_MUNICIPALITIES_URL;
  }

  function getBookingEndpoint() {
    return window.WH_ESTIMATOR_BOOKING_ENDPOINT || SCRIPT_DATA.bookingEndpoint || DEFAULT_BOOKING_ENDPOINT;
  }

  function getStorageKey(cfg) {
    const estimatorId = cfg?.estimatorId || cfg?.meta?.estimatorId || "default";
    return `${STORAGE_KEY}:${estimatorId}`;
  }

  // mk() ignores null/undefined/false and flattens arrays
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

    const flat = [];
    const push = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(push);
      else flat.push(c);
    };
    push(children);

    for (const c of flat) {
      if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    return el;
  };

  /* ---------------- Tooltip ---------------- */
  function tooltip(text) {
    if (!text) return null;

    const tip = mk("span", { class: "tip", role: "button", tabindex: 0, "aria-label": "More information" }, ["?"]);
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

    tip.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      tip.click();
    });

    bubble.addEventListener("click", (e) => e.stopPropagation());
    return wrap;
  }

  /* ---------------- Data Loading ---------------- */
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return await res.json();
  }

  let MUNICACHE = null;
  async function loadMunicipalities() {
    if (MUNICACHE) return MUNICACHE;
    MUNICACHE = await fetchJSON(getMunicipalitiesUrl());
    return MUNICACHE;
  }

  function normalizeCityName(raw, muni) {
    const s = safeStr(raw);
    if (!s) return "";
    const aliased = muni?.aliases?.[s] || s;
    return aliased.replace(/,\s*TX$/i, "").trim();
  }

  function computeAddressSig(cfg, answers) {
    const req = cfg?.pricing?.exact_requires || ["addr_street", "addr_city", "addr_state", "addr_zip"];
    const parts = req.map((k) => safeStr(answers[k]).toLowerCase());
    return parts.join("|");
  }

  /* ---------------- State ---------------- */
  function defaultState() {
    return {
      currentId: null,
      answers: {},
      history: [],
      meta: {
        permit_done: false,
        permit_sig: null,
        address_submitted_sig: null
      }
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        meta: { ...defaultState().meta, ...(parsed.meta || {}) }
      };
    } catch {
      return defaultState();
    }
  }

  function loadEstimatorState(cfg) {
    try {
      const raw = localStorage.getItem(getStorageKey(cfg));
      if (!raw) return loadState();
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        meta: { ...defaultState().meta, ...(parsed.meta || {}) }
      };
    } catch {
      return defaultState();
    }
  }

  function saveState(state, cfg) {
    localStorage.setItem(getStorageKey(cfg), JSON.stringify(state));
  }

  /* ---------------- Config helpers ---------------- */
  function indexQuestions(cfg) {
    const map = new Map();
    (cfg.questions || []).forEach((q) => map.set(q.id, q));
    return map;
  }

  function getQuestion(qmap, id) {
    return qmap.get(id) || null;
  }

  function getOption(q, value) {
    return (q?.options || []).find((o) => String(o.value) === String(value)) || null;
  }

  function uniqueValues(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function getAllNextQuestionIds(q) {
    if (!q) return [];

    const optionNextIds = q.type === "single_select"
      ? (q.options || []).map((opt) => opt.next)
      : [];

    return uniqueValues([...optionNextIds, q.next]);
  }

  function isProgressCountedQuestion(q) {
    return !!q && PROGRESS_COUNTED_TYPES.has(q.type);
  }

  function longestCountedPathFrom(qmap, id, seen = new Set()) {
    const q = getQuestion(qmap, id);
    if (!q || seen.has(id)) return 0;

    const nextSeen = new Set(seen);
    nextSeen.add(id);

    const ownStep = isProgressCountedQuestion(q) ? 1 : 0;
    const nextIds = getAllNextQuestionIds(q);
    const longestNext = nextIds.reduce(
      (longest, nextId) => Math.max(longest, longestCountedPathFrom(qmap, nextId, nextSeen)),
      0
    );

    return ownStep + longestNext;
  }

  function calculateProgress(qmap, state) {
    const q = getQuestion(qmap, state.currentId);
    const completedHistory = (state.history || []).reduce((count, id) => {
      return count + (isProgressCountedQuestion(getQuestion(qmap, id)) ? 1 : 0);
    }, 0);

    const completed = completedHistory;
    const remaining = longestCountedPathFrom(qmap, state.currentId);

    const total = Math.max(completed + remaining, completed, 1);
    const currentStep = isProgressCountedQuestion(q)
      ? Math.min(completed + 1, total)
      : Math.min(Math.max(completed, 1), total);
    const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));

    return { completed, currentStep, total, percent };
  }

  function renderProgress(progress) {
    return mk("div", { class: "quiz_progress-wrap" }, [
      mk("div", { class: "quiz_form-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": progress.percent }, [
        mk("div", { class: "quiz_form-progress-indicator", style: `width:${progress.percent}%` })
      ]),
      mk("div", { class: "quiz_progress-meta" }, [`Step ${progress.currentStep} of ${progress.total}`])
    ]);
  }

  /* ---------------- Pricing ---------------- */
  function sumPricing(cfg, qmap, state) {
    let low = 0, high = 0, exact = 0;
    const selectedOptionPricing = [];

    for (const q of (cfg.questions || [])) {
      if (q.type !== "single_select") continue;
      const v = state.answers[q.id];
      if (isEmpty(v)) continue;

      const opt = getOption(q, v);
      if (!opt || (!opt.pricing && !opt.price)) continue; // FIX: allow either key

      const p = opt.pricing || opt.price || {};
      const l = Number(p.low ?? 0) || 0;
      const h = Number(p.high ?? l) || 0;
      const e = Number(p.exact ?? h) || 0;

      low += l;
      high += h;
      exact += e;

      selectedOptionPricing.push({ qid: q.id, value: v, low: l, high: h, exact: e });
    }

    if (state.meta.permit_done && state.meta.permit_sig === computeAddressSig(cfg, state.answers)) {
      const fee = Number(state.answers.permit_fee_usd || 0) || 0;
      low += fee; high += fee; exact += fee;

      if (state.answers.expansion_tank_required === true) {
        const addon = Number(cfg?.pricing?.lookup_addons?.expansion_tank_required || 0) || 0;
        low += addon; high += addon; exact += addon;
      }
    }

    const roundTo = Number(cfg?.pricing?.safety?.round_to || 25) || 25;
    const round = (n) => Math.round(n / roundTo) * roundTo;

    return { low: round(low), high: round(high), exact: round(exact), items: selectedOptionPricing };
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

    if (!isEmpty(v) && field.pattern) {
      const re = new RegExp(field.pattern);
      if (!re.test(v)) return { ok: false, msg: field.pattern_msg || "Invalid format" };
    }

    return { ok: true, msg: "" };
  }

  function isQuestionComplete(q, answers) {
    if (!q) return true;

    if (q.type === "single_select") return !isEmpty(answers[q.id]);

    if (q.type === "form") {
      for (const f of q.fields || []) {
        const r = validateField(f, answers[f.id]);
        if (!r.ok) return false;
      }
      return true;
    }

    return true;
  }

  /* ---------------- Address invalidation ---------------- */
  function invalidatePermit(cfg, state) {
    state.meta.permit_done = false;
    state.meta.permit_sig = null;
    state.meta.address_submitted_sig = null;

    ["permit_fee_usd", "expansion_tank_required", "municipality_city", "municipality_found"].forEach((k) => delete state.answers[k]);
  }

  /* ---------------- Lookup runner ---------------- */
  async function runPermitLookup(cfg, state, lookupQuestion) {
    const muni = await loadMunicipalities();
    const city = normalizeCityName(state.answers.addr_city, muni);
    const row = muni?.cities?.[city] || null;

    const mapping = lookupQuestion?.lookup?.write_to || {};
    for (const [rowKey, answerKey] of Object.entries(mapping)) {
      state.answers[answerKey] = row ? row[rowKey] : null;
    }
    state.answers.municipality_city = row ? city : city || null;
    state.answers.municipality_found = !!row;

    state.meta.permit_done = true;
    state.meta.permit_sig = computeAddressSig(cfg, state.answers);
  }

  /* ---------------- Rendering ---------------- */
  async function boot() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    mount.classList.add("wh-estimator");

    let cfg, qmap;
    try {
      cfg = await fetchJSON(getConfigUrl());
      qmap = indexQuestions(cfg);
    } catch (e) {
      console.error(e);
      mount.innerHTML = "<p>Error loading configuration. Check console.</p>";
      return;
    }

    const state = loadEstimatorState(cfg);

    if (!state.currentId) state.currentId = cfg.start || (cfg.questions?.[0]?.id ?? null);
    if (!state.currentId) {
      mount.innerHTML = "<p>No questions configured.</p>";
      return;
    }

    let renderQueued = false;
    const scheduleRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        render();
      });
    };

    function computePreviewLabel(pr) {
      const disclaimer = cfg?.result_copy?.disclaimer || "";

      const addrSig = computeAddressSig(cfg, state.answers);
      const afterAddressSubmit = state.meta.address_submitted_sig && state.meta.address_submitted_sig === addrSig;

      const exactReady =
        afterAddressSubmit &&
        state.meta.permit_done &&
        state.meta.permit_sig === addrSig;

      const isOnAddressGate = state.currentId === cfg.address_gate_id;

      if (exactReady && !isOnAddressGate) {
        return { mode: "exact", label: "Exact Total", value: `$${money(pr.exact)}`, sub: "Exact price shown after address verification.", disclaimer };
      }

      if (pr.low === 0 && pr.high === 0) {
        return { mode: "empty", label: "Estimated Range", value: "-", sub: "Answer a few questions to see your range.", disclaimer };
      }

      return { mode: "range", label: "Estimated Range", value: `$${money(pr.low)}-$${money(pr.high)}`, sub: "Range updates as you go. Add your address to get an exact number.", disclaimer };
    }

    function renderSingleSelect(q, content) {
      const opts = q.options || [];
      const hasImages = opts.some((o) => !!o.image_url);
      const wrap = mk("div", {
        class: `quiz-options-wrapper${hasImages ? " has-images" : ""}`,
        role: "radiogroup",
        "aria-label": q.title || "Choose an option"
      });

      opts.forEach((opt) => {
        const active = String(state.answers[q.id]) === String(opt.value);
        const optionImageUrl = opt.image_url || "";
        const selectOption = () => {
          state.answers[q.id] = String(opt.value);
          saveState(state, cfg);
          scheduleRender();
        };

        wrap.appendChild(
          mk(
            "div",
            {
              class: `quiz-option choice ${active ? "is-input-active active" : ""} ${optionImageUrl ? "has-image" : ""}`,
              onClick: selectOption
            },
            [
              mk("label", { class: "wh_choice-radio" }, [
                mk("input", {
                  class: "wh_choice-native-radio",
                  type: "radio",
                  name: `wh_${q.id}`,
                  value: opt.value,
                  checked: active,
                  onChange: selectOption
                }),
                mk("span", { class: "wh_choice-radio-button", "aria-hidden": "true" }),
                mk("div", { class: "wh_choice-content" }, [
                  mk("div", { class: "quiz_option-label" }, [opt.label]),
                  opt.tooltip ? mk("div", { class: "quiz_option-description" }, [opt.tooltip]) : null
                ]),
                optionImageUrl ? mk("div", { class: "quiz_option-img-wrapper" }, [
                  mk("img", { class: "quiz_option-img", src: optionImageUrl, alt: "", loading: "lazy" })
                ]) : null
              ])
            ]
          )
        );
      });

      content.appendChild(wrap);
    }

    // IMPORTANT: no scheduleRender() on input (keeps Android keyboard open)
    function renderForm(q, content, ui) {
      const formWrap = mk("div", { class: "form-field-wrapper" });

      (q.fields || []).forEach((f) => {
        const val = state.answers[f.id] || "";
        const errEl = mk("div", { class: "fieldErr", style: "display:none" }, [""]);

        const inputEl = mk("input", {
          class: "quiz_text-input-field w-input",
          type: f.input_type || "text",
          value: val,
          placeholder: f.placeholder || "",
          autocomplete: f.autocomplete || "",
          onInput: (e) => {
            state.answers[f.id] = e.target.value;

            if (String(f.id).startsWith("addr_")) invalidatePermit(cfg, state);
            saveState(state, cfg);

            const r = validateField(f, state.answers[f.id]);
            if (!r.ok && !isEmpty(state.answers[f.id])) {
              errEl.style.display = "block";
              errEl.textContent = r.msg;
            } else {
              errEl.style.display = "none";
              errEl.textContent = "";
            }

            if (ui?.updateNextDisabled) ui.updateNextDisabled();
            if (ui?.updatePreview) ui.updatePreview();
          }
        });

        formWrap.appendChild(mk("label", { class: "quiz_text-field" }, [f.label || f.id, f.help ? tooltip(f.help) : null]));
        formWrap.appendChild(inputEl);
        formWrap.appendChild(errEl);
      });

      content.appendChild(formWrap);
    }

    function renderQuestionImage(q) {
      if (!q?.image_url) return null;

      return mk("div", { class: "quiz_question-image-wrapper" }, [
        mk("img", { class: "quiz_question-image", src: q.image_url, alt: "", loading: "lazy" })
      ]);
    }


    function renderLoadingStep(q, submittedId) {
      mount.innerHTML = "";

      const duration = Number(q.duration_ms || 1600);
      const start = Date.now();
      const fillId = `loadfill_${q.id}`;

      const progressState = submittedId
        ? { ...state, currentId: q.id, history: [...state.history, submittedId] }
        : state;
      const progress = calculateProgress(qmap, progressState);

      const card = mk("div", { class: "quiz_form-component" }, [
        mk("div", { class: "quiz_main-content" }, [
          renderProgress(progress),
          mk("div", { class: "quiz_changable-content" }, [
            mk("div", { class: "loading" }, [
              mk("div", { class: "loadingInner" }, [
                mk("div", { class: "spinner" }),
                mk("div", { class: "loadingTitle" }, [q.title || "Checking..."]),
                q.subtitle ? mk("div", { class: "loadingSub" }, [q.subtitle]) : null,
                mk("div", { class: "loadBar" }, [mk("div", { id: fillId, class: "loadFill", style: "width:0%" })])
              ])
            ])
          ])
        ])
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

    async function handleNext(q) {
      const current = q;

      if (current.type === "submit") {
        return await submitPayload();
      }

      if (!isQuestionComplete(current, state.answers)) return;

      if (current.id === cfg.address_gate_id) {
        state.meta.address_submitted_sig = computeAddressSig(cfg, state.answers);
      }

      let nextId = current.next || null;

      if (current.type === "single_select") {
        const v = state.answers[current.id];
        const opt = getOption(current, v);
        if (opt?.next) nextId = opt.next;
      }

      if (!nextId) return;

      const nextQ = getQuestion(qmap, nextId);
      if (nextQ?.type === "loading_lookup") {
        const tracker = renderLoadingStep(nextQ, state.currentId);

        try {
          await runPermitLookup(cfg, state, nextQ);
        } catch (e) {
          console.warn("Lookup failed:", e);
          state.meta.permit_done = false;
          state.meta.permit_sig = null;
          state.answers.municipality_found = false;
        }

        const fill = document.getElementById(tracker.fillId);
        if (fill) fill.style.width = "100%";

        const elapsed = Date.now() - tracker.start;
        const remaining = Math.max(0, tracker.duration - elapsed);

        setTimeout(() => {
          const afterId = nextQ.next || null;
          if (afterId) {
            state.history.push(state.currentId);
            state.currentId = afterId;
          }
          saveState(state, cfg);
          scheduleRender();
        }, remaining + 200);

        return;
      }

      state.history.push(state.currentId);
      state.currentId = nextId;

      saveState(state, cfg);
      scheduleRender();
    }

    function handleBack() {
      if (!state.history.length) return;
      state.currentId = state.history.pop();
      saveState(state, cfg);
      scheduleRender();
    }

    function buildBookingPayload(pr) {
      const estimatorId = cfg.estimatorId || cfg.meta?.estimatorId || "water-heater";
      const serviceName = cfg.serviceName || cfg.meta?.serviceName || "Water heater estimate request";

      return {
        estimatorId,
        serviceName,
        name: state.answers.contact_name,
        phone: state.answers.contact_phone,
        email: state.answers.contact_email,
        street: state.answers.addr_street,
        unit: state.answers.addr_unit,
        city: state.answers.addr_city,
        state: state.answers.addr_state,
        zip: state.answers.addr_zip,
        country: state.answers.addr_country || cfg.defaultCountry || "United States",
        source: cfg.source,
        campaign: cfg.campaign,
        campaignLabel: cfg.campaign,
        campaignId: cfg.campaignId,
        jobTypeId: cfg.jobTypeId,
        service: serviceName,
        priceRange: `$${money(pr.low)}-$${money(pr.high)}`,
        exactTotal: pr.exact,
        pricing: { low: pr.low, high: pr.high, exact: pr.exact },
        questionId: state.currentId,
        answers: state.answers,
        permit: {
          done: state.meta.permit_done,
          city: state.answers.municipality_city,
          found: state.answers.municipality_found,
          fee: state.answers.permit_fee_usd,
          expansionTankRequired: state.answers.expansion_tank_required
        },
        pageUrl: location.href,
        submittedAt: new Date().toISOString(),
        notes: [
          state.meta.permit_done ? "Permit lookup completed." : "Permit lookup not completed.",
          `Estimator exact total: $${money(pr.exact)}`
        ].join(" ")
      };
    }

    function showSubmitMessage(el, type, text) {
      if (!el) return;
      el.style.display = "block";
      el.className = `note submitMessage ${type}`;
      el.textContent = text;
    }

    async function submitPayload() {
      const pr = sumPricing(cfg, qmap, state);
      const payload = buildBookingPayload(pr);

      const response = await fetch(getBookingEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let message = `Booking request failed with status ${response.status}`;
        try {
          const data = await response.json();
          if (data?.error) message = data.error;
        } catch {
          // Keep the generic status message when the endpoint did not return JSON.
        }
        throw new Error(message);
      }

      return await response.json().catch(() => ({ ok: true }));
    }

    function render() {
      saveState(state, cfg);
    
      const q = getQuestion(qmap, state.currentId);
      if (!q) {
        mount.innerHTML = "<p>Missing question in config.</p>";
        return;
      }
    
      // refresh-on-loading: skip
      if (q.type === "loading_lookup") {
        state.currentId = q.next || state.currentId;
        saveState(state, cfg);
        scheduleRender();
        return;
      }
    
      mount.innerHTML = "";
    
      const progress = calculateProgress(qmap, state);
    
      const pr = sumPricing(cfg, qmap, state);
      const preview = computePreviewLabel(pr);
    
      const content = mk("div", { id: "step-content", class: "quiz_step-content" });
    
      const canGoBack = state.history.length > 0;
      const nextLabel = q.next_label || (q.type === "submit" ? (q.submit_label || "Submit") : "Next");
    
      const submitMessage = mk("div", { class: "note submitMessage", style: "display:none" }, [""]);
      const backBtn = canGoBack
        ? mk("button", { class: "quiz_back-button", type: "button", onClick: handleBack }, ["Back"])
        : null;
      const nextBtn = mk("button", {
        class: "quiz_next-button",
        type: "button",
        disabled: !isQuestionComplete(q, state.answers),
        onClick: async () => {
          nextBtn.disabled = true;
          const originalLabel = nextBtn.textContent;
          if (q.type === "submit") {
            nextBtn.textContent = "Submitting...";
            showSubmitMessage(submitMessage, "pending", "Sending your estimate...");
          }

          try {
            const result = await handleNext(q);
            if (q.type === "submit") {
              showSubmitMessage(
                submitMessage,
                "success",
                result?.dryRun
                  ? "Test submission received. Dry run is on, so nothing was sent to ServiceTitan."
                  : "Submitted. We'll reach out shortly."
              );
              nextBtn.textContent = "Submitted";
              return;
            }
          } catch (error) {
            console.error(error);
            if (q.type === "submit") {
              showSubmitMessage(submitMessage, "error", error?.message || "We couldn't submit this estimate. Please try again.");
            } else {
              alert(error?.message || "We couldn't submit this estimate. Please try again.");
            }
            nextBtn.disabled = !isQuestionComplete(q, state.answers);
            nextBtn.textContent = originalLabel;
          }
        }
      }, [nextLabel]);
    
      const nav = mk("div", { class: "quiz_nav-actions" }, [backBtn, nextBtn]);
    
      // preview nodes (so we don't querySelector before they exist)
      const previewLabelEl = mk("span", {}, [preview.label]);
      const previewPriceEl = mk("div", { class: "quiz_price-preview-value previewPrice" }, [preview.value]);
      const previewSubEl = mk("div", { class: "quiz_price-preview-sub previewSub" }, [preview.sub]);
      const previewTop = mk("div", { class: "quiz_price-preview-top previewTop" }, [
        previewLabelEl,
        preview.disclaimer ? tooltip(preview.disclaimer) : null
      ]);
    
      const previewEl = mk("div", { class: "quiz_price-preview preview" }, [previewTop, previewPriceEl, previewSubEl]);
    
      const ui = {
        updateNextDisabled: () => { nextBtn.disabled = !isQuestionComplete(q, state.answers); },
        updatePreview: () => {
          const pr2 = sumPricing(cfg, qmap, state);
          const p2 = computePreviewLabel(pr2);
          previewLabelEl.textContent = p2.label;
          previewPriceEl.textContent = p2.value;
          previewSubEl.textContent = p2.sub;
        }
      };
    
      // body
      if (q.type === "single_select") renderSingleSelect(q, content);
      else if (q.type === "form") renderForm(q, content, ui);
      else if (q.type === "summary") content.appendChild(mk("div", { class: "note" }, ["Review your answers, then continue."]));
      else if (q.type === "submit") content.appendChild(mk("div", { class: "note" }, [q.note || "Submit to lock in this estimate."]));
      else if (q.type === "content") content.appendChild(mk("div", { class: "contentBlock", html: q.html || "" }));

      const questionHeader = mk("div", { class: "quiz-question-content" }, [
        mk("div", { class: "quiz_heading-tooltip-icon-wrapper" }, [
          mk("div", { class: "quiz_question-title" }, [q.title || ""]),
          (q.tip || q.help || q.tooltip) ? tooltip(q.tip || q.help || q.tooltip) : null
        ]),
        q.subtitle ? mk("div", { class: "quiz_question-subtitle" }, [q.subtitle]) : null,
        renderQuestionImage(q)
      ]);

      const step = mk("div", { class: `quiz_changable-content quiz-step-${q.type}` }, [
        questionHeader,
        content,
        submitMessage,
        previewEl,
        nav
      ]);

      const container = mk("div", { class: "quiz_form-component" }, [
        mk("div", { class: "quiz_main-content" }, [
          renderProgress(progress),
          step
        ])
      ]);
      mount.appendChild(container);
    }


    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

