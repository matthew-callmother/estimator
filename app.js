(function () {
  "use strict";

  const SCRIPT_DATA = document.currentScript?.dataset || {};
  const DEFAULT_BOOKING_ENDPOINT = "https://estimator-sage-xi.vercel.app/api/bookings";
  const DEFAULT_CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const DEFAULT_MUNICIPALITIES_URL = "https://matthew-callmother.github.io/estimator/municipalities-dfw.json";
  const DEFAULT_SERVICE_AREA_URL = "https://matthew-callmother.github.io/estimator/service-area.json";

  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_routing_state";
  const PROGRESS_COUNTED_TYPES = new Set(["single_select", "multi_select", "form", "summary"]);
  const CANONICAL_LEAD_FIELD_IDS = new Set([
    "contact_name",
    "contact_phone",
    "contact_email",
    "addr_street",
    "addr_unit",
    "addr_city",
    "addr_state",
    "addr_zip",
    "addr_country"
  ]);
  const INTERNAL_ANSWER_IDS = new Set([
    "permit_fee_usd",
    "expansion_tank_required",
    "municipality_city",
    "municipality_found"
  ]);

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

  function getServiceAreaUrl() {
    return window.WH_ESTIMATOR_SERVICE_AREA_URL || SCRIPT_DATA.serviceAreaUrl || DEFAULT_SERVICE_AREA_URL;
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
    const showBubble = () => {
      bubble.style.display = "block";
    };
    const hideBubble = () => {
      bubble.style.display = "none";
    };

    wrap.addEventListener("mouseenter", showBubble);
    wrap.addEventListener("mouseleave", hideBubble);
    tip.addEventListener("focus", showBubble);
    tip.addEventListener("blur", hideBubble);

    tip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      bubble.style.display = bubble.style.display === "none" ? "block" : "none";

      setTimeout(() => {
        document.addEventListener(
          "click",
          () => {
            hideBubble();
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

  function getOptionDescription(opt) {
    return opt?.description || opt?.subtitle || opt?.helper_text || opt?.helperText || "";
  }

  function getOptionTooltip(opt) {
    return opt?.tooltip || opt?.help || "";
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
        address_submitted_sig: null,
        selected_result_id: null,
        selected_result_source: null,
        service_area_status: null,
        service_area_sig: null
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

  function resetEstimatorState(cfg, state) {
    const fresh = defaultState();
    fresh.currentId = cfg.start || (cfg.questions?.[0]?.id ?? null);

    state.currentId = fresh.currentId;
    state.answers = fresh.answers;
    state.history = fresh.history;
    state.meta = fresh.meta;

    localStorage.removeItem(getStorageKey(cfg));
    localStorage.removeItem(STORAGE_KEY);
  }

  function hasQuizProgress(cfg, state) {
    const startId = cfg.start || (cfg.questions?.[0]?.id ?? null);
    const hasAnswers = Object.values(state.answers || {}).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      return !isEmpty(value);
    });

    return Boolean(
      hasAnswers ||
      (state.history || []).length ||
      (state.currentId && state.currentId !== startId)
    );
  }

  /* ---------------- Config helpers ---------------- */
  function indexQuestions(cfg) {
    const map = new Map();
    (cfg.questions || []).forEach((q) => map.set(q.id, q));
    (cfg.results || []).forEach((r) => map.set(r.id, { type: "result", ...r }));
    return map;
  }

  function getQuestion(qmap, id) {
    return qmap.get(id) || null;
  }

  function getOption(q, value) {
    return (q?.options || []).find((o) => String(o.value) === String(value)) || null;
  }

  function getOptions(q, values) {
    const selected = Array.isArray(values) ? values : [];
    return selected
      .map((value) => getOption(q, value))
      .filter(Boolean);
  }

  function getFeatures(cfg) {
    const configured = cfg?.features || {};
    const questions = cfg?.questions || [];
    const hasPermitStep = questions.some((q) => q.type === "loading_lookup");
    const hasSubmitStep = questions.some((q) => q.type === "submit");
    const serviceArea = cfg?.serviceArea || {};
    const hasServiceAreaRules = Boolean((serviceArea.allowedZips || []).length || (serviceArea.allowedZipPrefixes || []).length);

    return {
      pricing: configured.pricing === undefined ? Boolean(cfg?.pricing) : Boolean(configured.pricing),
      permitLookup: configured.permitLookup === undefined ? hasPermitStep : Boolean(configured.permitLookup),
      serviceAreaFilter: configured.serviceAreaFilter === undefined ? hasServiceAreaRules : Boolean(configured.serviceAreaFilter),
      serviceTitanBooking: configured.serviceTitanBooking === undefined ? hasSubmitStep : Boolean(configured.serviceTitanBooking),
      recommendations: Boolean(configured.recommendations)
    };
  }

  function normalizeZip(value) {
    const match = String(value || "").match(/\d{5}/);
    return match ? match[0] : "";
  }

  function getServiceAreaConfig(cfg, sharedServiceArea) {
    return { ...(sharedServiceArea || {}), ...(cfg.serviceArea || {}) };
  }

  function getServiceAreaStatus(cfg, answers, features, sharedServiceArea) {
    if (!features.serviceAreaFilter) return { checked: false, eligible: true };

    const serviceArea = getServiceAreaConfig(cfg, sharedServiceArea);
    const allowedZips = (serviceArea.allowedZips || []).map(normalizeZip).filter(Boolean);
    const allowedZipPrefixes = (serviceArea.allowedZipPrefixes || []).map((prefix) => String(prefix || "").trim()).filter(Boolean);

    if (!allowedZips.length && !allowedZipPrefixes.length) {
      return {
        checked: true,
        eligible: false,
        zip: normalizeZip(answers.addr_zip),
        reason: "service_area_rules_missing",
        title: serviceArea.outOfAreaTitle || "We could not verify your service area",
        message: serviceArea.outOfAreaMessage || "Please try again or contact us directly."
      };
    }

    const zip = normalizeZip(answers.addr_zip);
    if (!zip) return { checked: true, eligible: false, zip };

    const eligible = allowedZips.includes(zip) || allowedZipPrefixes.some((prefix) => zip.startsWith(prefix));
    return {
      checked: true,
      eligible,
      zip,
      title: serviceArea.outOfAreaTitle || "Unfortunately, we are not in your service area yet",
      message: serviceArea.outOfAreaMessage || "We are expanding soon. Please check back later."
    };
  }

  function resetServiceAreaStatus(state) {
    state.meta.service_area_status = null;
    state.meta.service_area_sig = null;
  }

  function getStoredServiceAreaStatus(state) {
    const zip = normalizeZip(state.answers?.addr_zip);
    const status = state.meta?.service_area_status || null;
    const sig = state.meta?.service_area_sig || null;
    if (!zip || !status || sig !== zip) return null;
    return status;
  }

  let SERVICE_AREA_CACHE = null;
  async function loadServiceAreaIfNeeded(features) {
    if (!features.serviceAreaFilter) return null;
    if (SERVICE_AREA_CACHE) return SERVICE_AREA_CACHE;
    try {
      SERVICE_AREA_CACHE = await fetchJSON(getServiceAreaUrl());
    } catch (e) {
      console.warn("Service area failed to load:", e);
      SERVICE_AREA_CACHE = {
        outOfAreaTitle: "We could not verify your service area",
        outOfAreaMessage: "Please try again or contact us directly."
      };
    }
    return SERVICE_AREA_CACHE;
  }

  function buildReadableAnswers(cfg, qmap, answers) {
    const readable = [];

    for (const q of (cfg.questions || [])) {
      if (q.type === "single_select") {
        const value = answers[q.id];
        if (isEmpty(value)) continue;
        const opt = getOption(q, value);
        readable.push({
          questionId: q.id,
          question: q.title || q.id,
          value,
          answer: opt?.label || value
        });
      }

      if (q.type === "multi_select") {
        const values = Array.isArray(answers[q.id]) ? answers[q.id] : [];
        if (!values.length) continue;
        const labels = values.map((value) => getOption(q, value)?.label || value);
        readable.push({
          questionId: q.id,
          question: q.title || q.id,
          value: values,
          answer: labels.join(", ")
        });
      }

      if (q.type === "form") {
        for (const field of (q.fields || [])) {
          if (CANONICAL_LEAD_FIELD_IDS.has(field.id)) continue;
          if (INTERNAL_ANSWER_IDS.has(field.id)) continue;
          const value = answers[field.id];
          if (isEmpty(value)) continue;
          readable.push({
            questionId: field.id,
            question: field.label || field.id,
            value,
            answer: value
          });
        }
      }
    }

    for (const [id, value] of Object.entries(answers || {})) {
      if (isEmpty(value) || CANONICAL_LEAD_FIELD_IDS.has(id) || INTERNAL_ANSWER_IDS.has(id)) continue;
      const known = readable.some((item) => item.questionId === id);
      if (!known && !getQuestion(qmap, id)) {
        readable.push({ questionId: id, question: id, value, answer: value });
      }
    }

    return readable;
  }

  function uniqueValues(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function getAllNextQuestionIds(q, cfg) {
    if (!q) return [];

    const optionNextIds = (q.type === "single_select" || q.type === "multi_select")
      ? (q.options || []).map((opt) => opt.next)
      : [];
    const availabilityNextIds = q.type === "result" && q.availability
      ? Object.values(q.availability).map((availability) => availability?.next)
      : [];

    const nextIds = [...optionNextIds, q.next, ...availabilityNextIds].flatMap((nextId) => {
      if (nextId === "$winning_result") return (cfg.results || []).map((result) => result.id);
      return nextId;
    });

    return uniqueValues(nextIds);
  }

  function getResultById(cfg, id) {
    return (cfg.results || []).find((result) => String(result.id) === String(id)) || null;
  }

  function getResultScores(cfg, answers) {
    const scores = {};

    for (const result of (cfg.results || [])) {
      if (result?.id) scores[result.id] = 0;
    }

    for (const q of (cfg.questions || [])) {
      const values = q.type === "multi_select"
        ? (Array.isArray(answers[q.id]) ? answers[q.id] : [])
        : [answers[q.id]];

      for (const opt of getOptions(q, values)) {
        for (const [resultId, points] of Object.entries(opt.scores || {})) {
          scores[resultId] = (Number(scores[resultId]) || 0) + (Number(points) || 0);
        }
      }
    }

    return scores;
  }

  function getWinningResultId(cfg, answers) {
    return getWinningResultOutcome(cfg, answers).winnerId;
  }

  function getWinningResultOutcome(cfg, answers) {
    const scores = getResultScores(cfg, answers);
    const results = cfg.results || [];
    let winningScore = -Infinity;
    const tiedResultIds = [];

    for (const result of results) {
      const score = Number(scores[result.id]) || 0;
      if (score > winningScore) {
        winningScore = score;
        tiedResultIds.length = 0;
        tiedResultIds.push(result.id);
      } else if (score === winningScore) {
        tiedResultIds.push(result.id);
      }
    }

    const isTie = tiedResultIds.length > 1;
    const tiedResults = tiedResultIds
      .map((id) => getResultById(cfg, id))
      .filter(Boolean);
    const tieWinner = isTie
      ? tiedResults.reduce((best, result) => {
        const bestPriority = Number(best?.tie_priority ?? best?.tiePriority ?? 0) || 0;
        const resultPriority = Number(result?.tie_priority ?? result?.tiePriority ?? 0) || 0;
        return resultPriority > bestPriority ? result : best;
      }, tiedResults[0] || null)
      : null;
    const winnerId = tieWinner?.id || tiedResultIds[0] || null;
    const tieBreakerReason = isTie
      ? tieWinner?.tie_breaker_reason || tieWinner?.tieBreakerReason || null
      : null;

    return { winnerId, scores, isTie, tiedResultIds, tieBreakerReason };
  }

  function isProgressCountedQuestion(q) {
    return !!q && PROGRESS_COUNTED_TYPES.has(q.type);
  }

  function longestCountedPathFrom(qmap, cfg, id, seen = new Set()) {
    const q = getQuestion(qmap, id);
    if (!q || seen.has(id)) return 0;

    const nextSeen = new Set(seen);
    nextSeen.add(id);

    const ownStep = isProgressCountedQuestion(q) ? 1 : 0;
    const nextIds = getAllNextQuestionIds(q, cfg);
    const longestNext = nextIds.reduce(
      (longest, nextId) => Math.max(longest, longestCountedPathFrom(qmap, cfg, nextId, nextSeen)),
      0
    );

    return ownStep + longestNext;
  }

  function calculateProgress(qmap, cfg, state) {
    const q = getQuestion(qmap, state.currentId);
    const completedHistory = (state.history || []).reduce((count, id) => {
      return count + (isProgressCountedQuestion(getQuestion(qmap, id)) ? 1 : 0);
    }, 0);

    if (q?.type === "result") {
      const total = Math.max(completedHistory, 1);
      return { completed: total, currentStep: total, total, percent: 100 };
    }

    const completed = completedHistory;
    const remaining = longestCountedPathFrom(qmap, cfg, state.currentId);

    const total = Math.max(completed + remaining, completed, 1);
    const currentStep = isProgressCountedQuestion(q)
      ? Math.min(completed + 1, total)
      : Math.min(Math.max(completed, 1), total);
    const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));

    return { completed, currentStep, total, percent };
  }

  function renderProgress(progress, previousPercent) {
    const progressScale = Math.max(0, Math.min(1, progress.percent / 100));
    const previousScale = Number.isFinite(previousPercent)
      ? Math.max(0, Math.min(1, previousPercent / 100))
      : progressScale;
    return mk("div", { class: "quiz_progress-wrap" }, [
      mk("div", { class: "quiz_form-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": progress.percent }, [
        mk("div", { class: "quiz_form-progress-indicator", "data-progress-scale": progressScale, style: `transform:scaleX(${previousScale})` })
      ]),
      mk("div", { class: "quiz_progress-meta" }, [`Step ${progress.currentStep} of ${progress.total}`])
    ]);
  }

  /* ---------------- Pricing ---------------- */
  function sumPricing(cfg, qmap, state) {
    let low = 0, high = 0, exact = 0;
    const selectedOptionPricing = [];

    for (const q of (cfg.questions || [])) {
      if (q.type !== "single_select" && q.type !== "multi_select") continue;
      const values = q.type === "multi_select"
        ? (Array.isArray(state.answers[q.id]) ? state.answers[q.id] : [])
        : [state.answers[q.id]];

      for (const v of values) {
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

    if (q.type === "multi_select") {
      const values = Array.isArray(answers[q.id]) ? answers[q.id] : [];
      const min = Number(q.min_selected ?? q.minSelected ?? 1) || 1;
      return values.length >= min;
    }

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

    const features = getFeatures(cfg);
    const state = loadEstimatorState(cfg);

    if (!state.currentId) state.currentId = cfg.start || (cfg.questions?.[0]?.id ?? null);
    if (!state.currentId) {
      mount.innerHTML = "<p>No questions configured.</p>";
      return;
    }

    let renderQueued = false;
    let lastRenderedStepId = null;
    let lastRenderedProgressPercent = null;
    const scheduleRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        render();
      });
    };

    function animateProgressBar(progress) {
      const bar = mount.querySelector(".quiz_form-progress-indicator");
      if (!bar) return;

      const targetScale = bar.dataset.progressScale || String(Math.max(0, Math.min(1, progress.percent / 100)));
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          bar.style.transform = `scaleX(${targetScale})`;
        });
      });
      lastRenderedProgressPercent = progress.percent;
    }

    async function updateServiceAreaStatus() {
      const sharedServiceArea = await loadServiceAreaIfNeeded(features);
      const status = getServiceAreaStatus(cfg, state.answers, features, sharedServiceArea);
      state.meta.service_area_status = status;
      state.meta.service_area_sig = normalizeZip(state.answers.addr_zip);
      saveState(state, cfg);
      return status;
    }

    function getResultAvailabilityBlock(result) {
      if (!result?.availability) return null;

      const status = getStoredServiceAreaStatus(state);
      if (!status?.checked) return result.availability.default || null;

      return status.eligible
        ? result.availability.in_area || result.availability.inArea || result.availability.default || null
        : result.availability.out_of_area || result.availability.outOfArea || result.availability.default || null;
    }

    function getEffectiveNextId(q) {
      if (q?.type === "result") {
        const availability = getResultAvailabilityBlock(q);
        if (availability && Object.prototype.hasOwnProperty.call(availability, "next")) {
          return availability.next || null;
        }
      }

      return q?.next || null;
    }

    function getEffectiveNextLabel(q, fallback) {
      if (q?.type === "result") {
        const availability = getResultAvailabilityBlock(q);
        return availability?.next_label || availability?.nextLabel || q.next_label || fallback;
      }

      return q?.next_label || fallback;
    }

    function formatResultText(text, result) {
      if (!text) return "";

      const status = getStoredServiceAreaStatus(state);
      const tokens = {
        selected_result_title: result?.title || "",
        selected_result_message: result?.message || "",
        addr_zip: state.answers.addr_zip || "",
        service_area_zip: status?.zip || ""
      };

      return String(text).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => tokens[key] || "");
    }

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

    function setChoiceActive(optionEl, inputEl, active) {
      optionEl.classList.toggle("is-input-active", active);
      optionEl.classList.toggle("active", active);
      optionEl.setAttribute("aria-checked", active ? "true" : "false");
      if (inputEl) inputEl.checked = active;
    }

    function renderSingleSelect(q, content, ui) {
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
        const optionTooltip = getOptionTooltip(opt);
        const optionDescription = getOptionDescription(opt);
        let optionEl;
        let inputEl;
        const selectOption = (event) => {
          event?.preventDefault();

          state.answers[q.id] = String(opt.value);
          wrap.querySelectorAll(".quiz-option").forEach((el) => {
            setChoiceActive(el, el.querySelector("input"), false);
          });
          setChoiceActive(optionEl, inputEl, true);
          saveState(state, cfg);
          ui?.updateNextDisabled();
          ui?.updatePreview();
        };

        inputEl = mk("input", {
          class: "wh_choice-native-radio",
          type: "radio",
          name: `wh_${q.id}`,
          value: opt.value,
          checked: active,
          onChange: () => {}
        });

        optionEl = mk("div", {
          class: `quiz-option choice ${active ? "is-input-active active" : ""} ${optionImageUrl ? "has-image" : ""}`,
          role: "radio",
          "aria-checked": active ? "true" : "false",
          onClick: selectOption
        }, [
          mk("label", { class: "wh_choice-radio" }, [
            inputEl,
            mk("span", { class: "wh_choice-radio-button", "aria-hidden": "true" }),
            mk("div", { class: "wh_choice-content" }, [
              mk("div", { class: "quiz_option-label" }, [opt.label, optionTooltip ? tooltip(optionTooltip) : null]),
              optionDescription ? mk("div", { class: "quiz_option-description" }, [optionDescription]) : null
            ]),
            optionImageUrl ? mk("div", { class: "quiz_option-img-wrapper" }, [
              mk("img", { class: "quiz_option-img", src: optionImageUrl, alt: "", loading: "lazy" })
            ]) : null
          ])
        ]);

        wrap.appendChild(optionEl);
      });

      content.appendChild(wrap);
    }

    function renderMultiSelect(q, content, ui) {
      const opts = q.options || [];
      const selectedValues = Array.isArray(state.answers[q.id]) ? state.answers[q.id] : [];
      const max = Number(q.max_selected ?? q.maxSelected ?? 0) || 0;
      const hasImages = opts.some((o) => !!o.image_url);
      const wrap = mk("div", {
        class: `quiz-options-wrapper${hasImages ? " has-images" : ""}`,
        role: "group",
        "aria-label": q.title || "Choose options"
      });

      opts.forEach((opt) => {
        const active = selectedValues.some((value) => String(value) === String(opt.value));
        const optionImageUrl = opt.image_url || "";
        const optionTooltip = getOptionTooltip(opt);
        const optionDescription = getOptionDescription(opt);
        let optionEl;
        let inputEl;
        const toggleOption = (event) => {
          event?.preventDefault();

          const currentValues = Array.isArray(state.answers[q.id]) ? [...state.answers[q.id]] : [];
          const existingIndex = currentValues.findIndex((value) => String(value) === String(opt.value));
          let nextActive = existingIndex < 0;

          if (existingIndex >= 0) {
            currentValues.splice(existingIndex, 1);
          } else if (!max || currentValues.length < max) {
            currentValues.push(String(opt.value));
          } else {
            nextActive = false;
            return;
          }

          state.answers[q.id] = currentValues;
          setChoiceActive(optionEl, inputEl, nextActive);
          saveState(state, cfg);
          ui?.updateNextDisabled();
          ui?.updatePreview();
        };

        inputEl = mk("input", {
          class: "wh_choice-native-radio",
          type: "checkbox",
          name: `wh_${q.id}`,
          value: opt.value,
          checked: active,
          onChange: () => {}
        });

        optionEl = mk("div", {
          class: `quiz-option choice ${active ? "is-input-active active" : ""} ${optionImageUrl ? "has-image" : ""}`,
          role: "checkbox",
          "aria-checked": active ? "true" : "false",
          onClick: toggleOption
        }, [
          mk("label", { class: "wh_choice-radio" }, [
            inputEl,
            mk("span", { class: "wh_choice-radio-button", "aria-hidden": "true" }),
            mk("div", { class: "wh_choice-content" }, [
              mk("div", { class: "quiz_option-label" }, [opt.label, optionTooltip ? tooltip(optionTooltip) : null]),
              optionDescription ? mk("div", { class: "quiz_option-description" }, [optionDescription]) : null
            ]),
            optionImageUrl ? mk("div", { class: "quiz_option-img-wrapper" }, [
              mk("img", { class: "quiz_option-img", src: optionImageUrl, alt: "", loading: "lazy" })
            ]) : null
          ])
        ]);

        wrap.appendChild(optionEl);
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
            if (f.id === "addr_zip") resetServiceAreaStatus(state);
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

    function renderResult(q, content) {
      const scores = getResultScores(cfg, state.answers);
      const outcome = getWinningResultOutcome(cfg, state.answers);
      const isScoredTieResult = state.meta.selected_result_source === "highest_score" && outcome.isTie && outcome.winnerId === q.id;
      const showScores = q.show_scores === true || q.showScores === true;
      const availability = getResultAvailabilityBlock(q);
      const message = isScoredTieResult && outcome.tieBreakerReason
        ? outcome.tieBreakerReason
        : q.message || q.subtitle || "";
      const availabilityMessage = availability?.message || "";
      const availabilityAdvice = availability?.advice || "";

      content.appendChild(mk("div", { class: "quiz_result-content" }, [
        message ? mk("div", { class: "quiz_result-message" }, [formatResultText(message, q)]) : null,
        q.html ? mk("div", { class: "contentBlock", html: q.html }) : null,
        availabilityMessage || availabilityAdvice ? mk("div", { class: "quiz_result-availability note" }, [
          availabilityMessage ? mk("div", { class: "quiz_result-availability-message" }, [formatResultText(availabilityMessage, q)]) : null,
          availabilityAdvice ? mk("div", { class: "quiz_result-availability-advice" }, [formatResultText(availabilityAdvice, q)]) : null
        ]) : null,
        showScores ? mk("div", { class: "note quiz_result-scores" }, [
          (cfg.results || []).map((result) => `${result.title || result.id}: ${Number(scores[result.id]) || 0}`).join("\n")
        ]) : null
      ]));
    }


    function renderLoadingStep(q, submittedId) {
      mount.innerHTML = "";

      const duration = Number(q.duration_ms || 1600);
      const start = Date.now();
      const fillId = `loadfill_${q.id}`;

      const progressState = submittedId
        ? { ...state, currentId: q.id, history: [...state.history, submittedId] }
        : state;
      const progress = calculateProgress(qmap, cfg, progressState);

      const card = mk("div", { class: "quiz_form-component" }, [
        mk("div", { class: "quiz_main-content" }, [
          renderProgress(progress, lastRenderedProgressPercent),
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
      animateProgressBar(progress);

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

      if (current.submit_on_next === true) {
        return await submitPayload();
      }

      if (current.id === cfg.address_gate_id) {
        state.meta.address_submitted_sig = computeAddressSig(cfg, state.answers);
      }

      let nextId = getEffectiveNextId(current);

      if (current.type === "single_select") {
        const v = state.answers[current.id];
        const opt = getOption(current, v);
        if (opt?.next) nextId = opt.next;
      }

      if (current.type === "multi_select") {
        const values = Array.isArray(state.answers[current.id]) ? state.answers[current.id] : [];
        const selectedOptions = getOptions(current, values);
        if (!nextId) {
          const optionNext = selectedOptions.find((opt) => opt.next)?.next;
          if (optionNext) nextId = optionNext;
        }
      }

      const shouldScoreResult = current.result_strategy === "highest_score" || current.resultStrategy === "highest_score";

      if (shouldScoreResult) {
        state.meta.selected_result_id = getWinningResultId(cfg, state.answers);
        state.meta.selected_result_source = "highest_score";
      }

      if (current.result_gate === true || current.resultGate === true || current.reveals_result === true || current.revealsResult === true) {
        await updateServiceAreaStatus();
      }

      const revealsWinningResult = nextId === "$winning_result" || nextId === "$selected_result";
      if (revealsWinningResult) {
        if (!state.meta.selected_result_id) {
          state.meta.selected_result_id = getWinningResultId(cfg, state.answers);
          state.meta.selected_result_source = "highest_score";
        }
        nextId = state.meta.selected_result_id;
      }

      if (getResultById(cfg, nextId) && !revealsWinningResult && !shouldScoreResult) {
        state.meta.selected_result_id = nextId;
        state.meta.selected_result_source = "direct";
      }

      if (!nextId) return;

      const nextQ = getQuestion(qmap, nextId);
      if (nextQ?.type === "loading_lookup" && !features.permitLookup) {
        const afterId = nextQ.next || null;
        if (afterId) {
          state.history.push(state.currentId);
          state.currentId = afterId;
        }
        saveState(state, cfg);
        scheduleRender();
        return;
      }

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

    function handleStartOver() {
      const confirmed = window.confirm("Start this quiz over? Your answers will be cleared.");
      if (!confirmed) return;

      resetEstimatorState(cfg, state);
      saveState(state, cfg);
      scheduleRender();
    }

    function buildBookingPayload(pr, serviceAreaStatus) {
      const estimatorId = cfg.estimatorId || cfg.meta?.estimatorId || "water-heater";
      const serviceName = cfg.serviceName || cfg.meta?.serviceName || "Water heater estimate request";
      const resultOutcome = getWinningResultOutcome(cfg, state.answers);
      const selectedResultId = state.meta.selected_result_id || resultOutcome.winnerId;
      const selectedResult = getResultById(cfg, selectedResultId);
      const selectedResultUsesScoring = state.meta.selected_result_source === "highest_score" || (!state.meta.selected_result_id && Boolean(resultOutcome.winnerId));
      const payload = {
        estimatorId,
        quizId: estimatorId,
        quizName: cfg.quizName || cfg.title || serviceName,
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
        questionId: state.currentId,
        answers: state.answers,
        readableAnswers: buildReadableAnswers(cfg, qmap, state.answers),
        selectedResult: selectedResult ? {
          id: selectedResult.id,
          title: selectedResult.title || selectedResult.id,
          message: selectedResult.message || "",
          isTie: selectedResultUsesScoring ? resultOutcome.isTie : false,
          tiedResultIds: selectedResultUsesScoring ? resultOutcome.tiedResultIds : [],
          tieBreakerReason: selectedResultUsesScoring ? resultOutcome.tieBreakerReason : null,
          scores: selectedResultUsesScoring ? resultOutcome.scores : {}
        } : null,
        serviceArea: serviceAreaStatus || getServiceAreaStatus(cfg, state.answers, features, SERVICE_AREA_CACHE),
        pageUrl: location.href,
        submittedAt: new Date().toISOString()
      };

      if (features.pricing && pr) {
        payload.priceRange = `$${money(pr.low)}-$${money(pr.high)}`;
        payload.exactTotal = pr.exact;
        payload.pricing = { low: pr.low, high: pr.high, exact: pr.exact, items: pr.items };
      }

      if (features.permitLookup) {
        payload.permit = {
          done: state.meta.permit_done,
          city: state.answers.municipality_city,
          found: state.answers.municipality_found,
          fee: state.answers.permit_fee_usd,
          expansionTankRequired: state.answers.expansion_tank_required
        };
      }

      return payload;
    }

    function showSubmitMessage(el, type, text) {
      if (!el) return;
      el.style.display = "block";
      el.className = `note submitMessage ${type}`;
      el.textContent = text;
    }

    async function submitPayload() {
      const sharedServiceArea = await loadServiceAreaIfNeeded(features);
      const serviceAreaStatus = getServiceAreaStatus(cfg, state.answers, features, sharedServiceArea);
      const pr = features.pricing ? sumPricing(cfg, qmap, state) : null;
      const payload = buildBookingPayload(pr, serviceAreaStatus);

      if (serviceAreaStatus.checked && !serviceAreaStatus.eligible) {
        return {
          ok: true,
          skippedBackend: true,
          outOfArea: true,
          message: `${serviceAreaStatus.title}. ${serviceAreaStatus.message}`
        };
      }

      if (!features.serviceTitanBooking) {
        return {
          ok: true,
          skippedBackend: true,
          message: "Submission captured locally. ServiceTitan booking is disabled for this quiz."
        };
      }

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
      const isNewStep = q.id !== lastRenderedStepId;
    
      // refresh-on-loading: skip
      if (q.type === "loading_lookup") {
        state.currentId = q.next || state.currentId;
        saveState(state, cfg);
        scheduleRender();
        return;
      }
    
      mount.innerHTML = "";
    
      const progress = calculateProgress(qmap, cfg, state);
    
      const pr = features.pricing ? sumPricing(cfg, qmap, state) : null;
      const preview = features.pricing ? computePreviewLabel(pr) : null;
    
      const content = mk("div", { id: "step-content", class: `quiz_step-content quiz_step-content--${q.type}` });
    
      const canGoBack = state.history.length > 0;
      const isSubmitAction = q.type === "submit" || q.submit_on_next === true;
      const effectiveNextId = getEffectiveNextId(q);
      const hasNextAction = !(q.type === "result" && !effectiveNextId);
      const nextLabel = getEffectiveNextLabel(q, isSubmitAction ? (q.submit_label || "Submit") : "Next");
    
      const submitMessage = mk("div", { class: "note submitMessage", style: "display:none" }, [""]);
      const backBtn = canGoBack
        ? mk("button", { class: "quiz_back-button", type: "button", onClick: handleBack }, ["Back"])
        : null;
      const startOverBtn = hasQuizProgress(cfg, state)
        ? mk("button", { class: "quiz_start-over-button", type: "button", onClick: handleStartOver }, ["Start over"])
        : null;
      const nextBtn = hasNextAction ? mk("button", {
        class: "quiz_next-button",
        type: "button",
        disabled: !isQuestionComplete(q, state.answers),
        onClick: async () => {
          nextBtn.disabled = true;
          const originalLabel = nextBtn.textContent;
          if (isSubmitAction) {
            nextBtn.textContent = "Submitting...";
            showSubmitMessage(submitMessage, "pending", q.pending_label || "Submitting...");
          }

          try {
            const result = await handleNext(q);
            if (isSubmitAction) {
              const successMessage = result?.outOfArea
                ? (result.message || "Unfortunately, we are not in your service area yet.")
                : result?.dryRun
                  ? "Test submission received. Dry run is on, so nothing was sent to ServiceTitan."
                  : result?.skippedBackend
                    ? (result.message || "Submission complete.")
                    : "Submitted. We'll reach out shortly.";
              showSubmitMessage(
                submitMessage,
                "success",
                successMessage
              );
              nextBtn.textContent = "Submitted";
              return;
            }
          } catch (error) {
            console.error(error);
            if (isSubmitAction) {
              showSubmitMessage(submitMessage, "error", error?.message || "We couldn't submit this request. Please try again.");
            } else {
              alert(error?.message || "We couldn't submit this request. Please try again.");
            }
            nextBtn.disabled = !isQuestionComplete(q, state.answers);
            nextBtn.textContent = originalLabel;
          }
        }
      }, [nextLabel]) : null;
    
      const nav = mk("div", { class: "quiz_nav-actions" }, [backBtn, startOverBtn, nextBtn]);
    
      // preview nodes (so we don't querySelector before they exist)
      const previewLabelEl = features.pricing ? mk("span", {}, [preview.label]) : null;
      const previewPriceEl = features.pricing ? mk("div", { class: "quiz_price-preview-value previewPrice" }, [preview.value]) : null;
      const previewSubEl = features.pricing ? mk("div", { class: "quiz_price-preview-sub previewSub" }, [preview.sub]) : null;
      const previewTop = features.pricing ? mk("div", { class: "quiz_price-preview-top previewTop" }, [
        previewLabelEl,
        preview.disclaimer ? tooltip(preview.disclaimer) : null
      ]) : null;
    
      const previewEl = features.pricing ? mk("div", { class: "quiz_price-preview preview" }, [previewTop, previewPriceEl, previewSubEl]) : null;
    
      const ui = {
        updateNextDisabled: () => {
          if (nextBtn) nextBtn.disabled = !isQuestionComplete(q, state.answers);
        },
        updatePreview: () => {
          if (!features.pricing) return;
          const pr2 = sumPricing(cfg, qmap, state);
          const p2 = computePreviewLabel(pr2);
          previewLabelEl.textContent = p2.label;
          previewPriceEl.textContent = p2.value;
          previewSubEl.textContent = p2.sub;
        }
      };
    
      // body
      if (q.type === "single_select") renderSingleSelect(q, content, ui);
      else if (q.type === "multi_select") renderMultiSelect(q, content, ui);
      else if (q.type === "form") renderForm(q, content, ui);
      else if (q.type === "result") renderResult(q, content);
      else if (q.type === "summary") content.appendChild(mk("div", { class: "note" }, ["Review your answers, then continue."]));
      else if (q.type === "submit") content.appendChild(mk("div", { class: "note" }, [q.note || "Submit when you are ready."]));
      else if (q.type === "content") content.appendChild(mk("div", { class: "contentBlock", html: q.html || "" }));

      const questionHeader = mk("div", { class: "quiz-question-content" }, [
        mk("div", { class: "quiz_heading-tooltip-icon-wrapper" }, [
          mk("div", { class: "quiz_question-title" }, [q.title || ""]),
          (q.tip || q.help || q.tooltip) ? tooltip(q.tip || q.help || q.tooltip) : null
        ]),
        q.subtitle ? mk("div", { class: "quiz_question-subtitle" }, [q.subtitle]) : null,
        renderQuestionImage(q)
      ]);

      const step = mk("div", { class: `quiz_changable-content quiz-step-${q.type}${isNewStep ? " is-entering" : ""}` }, [
        questionHeader,
        content,
        submitMessage,
        previewEl,
        nav
      ]);

      const container = mk("div", { class: "quiz_form-component" }, [
        mk("div", { class: "quiz_main-content" }, [
          renderProgress(progress, lastRenderedProgressPercent),
          step
        ])
      ]);
      mount.appendChild(container);
      animateProgressBar(progress);
      lastRenderedStepId = q.id;
    }


    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

