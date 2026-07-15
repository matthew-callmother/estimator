(function () {
  "use strict";

  const SCRIPT_DATA = document.currentScript?.dataset || {};
  const DEFAULT_BOOKING_ENDPOINT = "https://estimator-sage-xi.vercel.app/api/bookings";
  const DEFAULT_CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const DEFAULT_MUNICIPALITIES_URL = "https://matthew-callmother.github.io/estimator/municipalities-dfw.json";
  const DEFAULT_SERVICE_AREA_URL = "https://matthew-callmother.github.io/estimator/service-area.json";
  const TIPPY_CSS_URL = "https://unpkg.com/tippy.js@6/dist/tippy.css";
  const POPPER_URL = "https://unpkg.com/@popperjs/core@2/dist/umd/popper.min.js";
  const TIPPY_URL = "https://unpkg.com/tippy.js@6/dist/tippy-bundle.umd.min.js";

  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_routing_state";
  const ATTRIBUTION_STORAGE_KEY = "wh_estimator_attribution";
  const ATTRIBUTION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const STATE_SCHEMA_VERSION = 2;
  const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const PROGRESS_COUNTED_TYPES = new Set(["single_select", "multi_select", "slider", "form", "summary"]);
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
  const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  const CLICK_ID_PARAMS = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid", "ttclid"];

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

  function hashString(value) {
    let hash = 0;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash = Math.imul(31, hash) + text.charCodeAt(i) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  function getConfigSignature(cfg) {
    const signatureShape = {
      estimatorId: cfg?.estimatorId || cfg?.meta?.estimatorId || "default",
      version: cfg?.version || cfg?.meta?.version || "",
      start: cfg?.start || "",
      features: cfg?.features || {},
      questions: (cfg?.questions || []).map((q) => ({
        id: q.id,
        type: q.type,
        next: q.next || null,
        resultGate: q.result_gate || q.resultGate || q.reveals_result || q.revealsResult || false,
        submitOnNext: q.submit_on_next || q.submitOnNext || false,
        options: (q.options || []).map((opt) => ({
          value: opt.value,
          next: opt.next || null
        })),
        fields: (q.fields || []).map((field) => ({
          id: field.id,
          required: Boolean(field.required)
        }))
      })),
      results: (cfg?.results || []).map((result) => ({
        id: result.id,
        next: result.next || null,
        availability: result.availability || null
      }))
    };

    return hashString(JSON.stringify(signatureShape));
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
  let tippyLoadPromise = null;

  function loadStyleOnce(href) {
    const existing = document.querySelector(`link[data-wh-lib-href="${href}"]`);
    if (existing) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.whLibHref = href;
      link.onload = resolve;
      link.onerror = () => reject(new Error(`Failed to load stylesheet: ${href}`));
      document.head.appendChild(link);
    });
  }

  function loadScriptOnce(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve();

    const existing = document.querySelector(`script[data-wh-lib-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") return Promise.resolve();
      return new Promise((resolve, reject) => {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
      });
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.whLibSrc = src;
      script.onload = () => {
        script.dataset.loaded = "true";
        resolve();
      };
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(script);
    });
  }

  function ensureTippy() {
    if (window.tippy) return Promise.resolve(window.tippy);
    if (!tippyLoadPromise) {
      tippyLoadPromise = Promise.all([
        loadStyleOnce(TIPPY_CSS_URL),
        loadScriptOnce(POPPER_URL, "Popper")
      ])
        .then(() => loadScriptOnce(TIPPY_URL, "tippy"))
        .then(() => {
          if (typeof window.tippy !== "function") throw new Error("Tippy did not initialize.");
          return window.tippy;
        });
    }
    return tippyLoadPromise;
  }

  function tooltip(text) {
    if (!text) return null;

    const stopCardClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    return mk("span", { class: "tipWrap" }, [
      mk("span", {
        class: "tip",
        role: "button",
        tabindex: 0,
        "aria-label": "More information",
        "data-tippy-content": text,
        onClick: stopCardClick
      }, ["?"])
    ]);
  }

  function destroyTooltips(root) {
    root.querySelectorAll(".tip[data-tippy-content]").forEach((tip) => {
      if (tip._tippy) tip._tippy.destroy();
    });
  }

  function initializeTooltips(root) {
    const tips = Array.from(root.querySelectorAll(".tip[data-tippy-content]"));
    if (!tips.length) return;

    ensureTippy()
      .then((tippy) => {
        const liveTips = tips.filter((tip) => document.contains(tip));
        if (!liveTips.length) return;

        tippy(liveTips, {
          allowHTML: true,
          appendTo: () => document.body,
          delay: [60, 60],
          hideOnClick: true,
          interactive: false,
          maxWidth: 280,
          placement: "top",
          theme: "wh-estimator",
          trigger: "mouseenter focus click",
          zIndex: 999999
        });
      })
      .catch((error) => console.error(error));
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

  function addCacheBuster(url, key = "wh_v") {
    try {
      const parsed = new URL(url, location.href);
      parsed.searchParams.set(key, Date.now().toString(36));
      return parsed.toString();
    } catch {
      const separator = String(url || "").includes("?") ? "&" : "?";
      return `${url}${separator}${key}=${Date.now().toString(36)}`;
    }
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

  /* ---------------- Attribution ---------------- */
  function readAttributionStore() {
    try {
      const raw = localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const updatedAt = Number(parsed?.updatedAt || 0);
      if (!parsed || !updatedAt || Date.now() - updatedAt > ATTRIBUTION_MAX_AGE_MS) {
        localStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  }

  function saveAttributionStore(store) {
    try {
      localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ ...store, updatedAt: Date.now() }));
    } catch {
      // Attribution is useful but should never block the quiz.
    }
  }

  function getUrlHost(value) {
    try {
      return value ? new URL(value).hostname.replace(/^www\./i, "").toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function getCurrentUrlParams() {
    try {
      return new URL(location.href).searchParams;
    } catch {
      return new URLSearchParams();
    }
  }

  function getParamMap(params, keys) {
    return keys.reduce((out, key) => {
      const value = safeStr(params.get(key));
      if (value) out[key] = value;
      return out;
    }, {});
  }

  function hostMatches(host, patterns) {
    return patterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
  }

  function classifyAttribution({ utms, clickIds, referrerHost }) {
    const source = safeStr(utms.utm_source).toLowerCase();
    const medium = safeStr(utms.utm_medium).toLowerCase().replace(/[-\s]+/g, "_");
    const hasPaidSearchClick = Boolean(clickIds.gclid || clickIds.gbraid || clickIds.wbraid || clickIds.msclkid);
    const hasPaidSocialClick = Boolean(clickIds.fbclid || clickIds.ttclid);
    const paidMediums = new Set(["cpc", "ppc", "paid", "paid_search", "sem"]);
    const socialPaidMediums = new Set(["paid_social", "paidsocial", "social_paid", "paid_social_media"]);
    const searchHosts = ["google.com", "bing.com", "yahoo.com", "duckduckgo.com", "ecosia.org", "ask.com", "aol.com", "baidu.com", "yandex.com"];
    const socialHosts = ["facebook.com", "instagram.com", "tiktok.com", "linkedin.com", "twitter.com", "x.com", "pinterest.com", "reddit.com", "youtube.com"];
    const searchSources = ["google", "bing", "yahoo", "duckduckgo", "ecosia"];
    const socialSources = ["facebook", "instagram", "tiktok", "linkedin", "twitter", "x", "pinterest", "reddit", "youtube"];

    if (hasPaidSearchClick || paidMediums.has(medium) || medium.includes("paid_search")) return "paid_search";
    if (hasPaidSocialClick || socialPaidMediums.has(medium) || (medium.includes("paid") && socialSources.includes(source))) return "paid_social";
    if (medium === "organic" || (!medium && hostMatches(referrerHost, searchHosts)) || (medium === "search" && searchSources.includes(source))) return "organic_search";
    if (medium === "social" || (!medium && hostMatches(referrerHost, socialHosts)) || socialSources.includes(source)) return "organic_social";
    if (safeStr(referrerHost)) return "referral";
    return "direct";
  }

  function buildCurrentAttributionTouch() {
    const params = getCurrentUrlParams();
    const utms = getParamMap(params, UTM_PARAMS);
    const clickIds = getParamMap(params, CLICK_ID_PARAMS);
    const referrer = document.referrer || "";
    const referrerHost = getUrlHost(referrer);
    const currentHost = getUrlHost(location.href);
    const externalReferrer = referrerHost && referrerHost !== currentHost ? referrer : "";
    const externalReferrerHost = externalReferrer ? referrerHost : "";
    const channel = classifyAttribution({ utms, clickIds, referrerHost: externalReferrerHost });

    return {
      channel,
      source: utms.utm_source || externalReferrerHost || (channel === "direct" ? "direct" : ""),
      medium: utms.utm_medium || (channel === "direct" ? "direct" : channel.replace(/^organic_/, "organic_").replace(/^paid_/, "paid_")),
      campaign: utms.utm_campaign || "",
      term: utms.utm_term || "",
      content: utms.utm_content || "",
      utms,
      clickIds,
      referrer: externalReferrer,
      referrerHost: externalReferrerHost,
      pageUrl: location.href,
      landingPageUrl: location.href,
      timestamp: new Date().toISOString()
    };
  }

  function hasMeaningfulAttribution(touch) {
    return Boolean(
      Object.keys(touch.utms || {}).length ||
      Object.keys(touch.clickIds || {}).length ||
      touch.referrerHost
    );
  }

  function getAttribution() {
    const current = buildCurrentAttributionTouch();
    const store = readAttributionStore();
    const meaningful = hasMeaningfulAttribution(current);
    const nextStore = { ...store };

    if (!nextStore.firstTouch) nextStore.firstTouch = current;
    if (!nextStore.lastTouch || meaningful) nextStore.lastTouch = current;
    if (meaningful || !store.firstTouch || !store.lastTouch) saveAttributionStore(nextStore);

    return {
      current,
      firstTouch: nextStore.firstTouch || current,
      lastTouch: nextStore.lastTouch || current
    };
  }

  /* ---------------- State ---------------- */
  function defaultState() {
    return {
      _schemaVersion: STATE_SCHEMA_VERSION,
      _configSignature: null,
      _savedAt: null,
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
        service_area_sig: null,
        cover_seen: false,
        lead_checkpoint_sigs: {}
      }
    };
  }

  function hydrateState(parsed) {
    return {
      ...defaultState(),
      ...parsed,
      answers: parsed?.answers && typeof parsed.answers === "object" ? parsed.answers : {},
      history: Array.isArray(parsed?.history) ? parsed.history : [],
      meta: { ...defaultState().meta, ...(parsed?.meta || {}) }
    };
  }

  function readStoredState(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? hydrateState(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function isStoredStateCompatible(cfg, qmap, state) {
    if (!state) return false;
    if (state._schemaVersion !== STATE_SCHEMA_VERSION) return false;
    if (state._configSignature !== getConfigSignature(cfg)) return false;

    const savedAt = Number(state._savedAt || 0);
    if (!savedAt || Date.now() - savedAt > STATE_MAX_AGE_MS) return false;

    if (state.currentId && !getQuestion(qmap, state.currentId)) return false;
    if ((state.history || []).some((id) => !getQuestion(qmap, id))) return false;

    return true;
  }

  function loadEstimatorState(cfg, qmap) {
    const storageKey = getStorageKey(cfg);
    const state = readStoredState(storageKey);
    if (isStoredStateCompatible(cfg, qmap, state)) return state;

    localStorage.removeItem(storageKey);
    localStorage.removeItem(STORAGE_KEY);
    return defaultState();
  }

  function saveState(state, cfg) {
    state._schemaVersion = STATE_SCHEMA_VERSION;
    state._configSignature = getConfigSignature(cfg);
    state._savedAt = Date.now();
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
    const shared = sharedServiceArea || {};
    const local = cfg.serviceArea || {};
    const merged = { ...shared, ...local };

    if (Array.isArray(shared.allowedZips) && (!Array.isArray(local.allowedZips) || !local.allowedZips.length)) {
      merged.allowedZips = shared.allowedZips;
    }

    if (Array.isArray(shared.allowedZipPrefixes) && (!Array.isArray(local.allowedZipPrefixes) || !local.allowedZipPrefixes.length)) {
      merged.allowedZipPrefixes = shared.allowedZipPrefixes;
    }

    return merged;
  }

  function getServiceAreaStatus(cfg, answers, features, sharedServiceArea) {
    if (!features.serviceAreaFilter) return { checked: false, eligible: true };

    const serviceArea = getServiceAreaConfig(cfg, sharedServiceArea);
    const allowedZips = (serviceArea.allowedZips || []).map(normalizeZip).filter(Boolean);
    const allowedZipPrefixes = (serviceArea.allowedZipPrefixes || []).map((prefix) => String(prefix || "").trim()).filter(Boolean);

    if (!allowedZips.length && !allowedZipPrefixes.length) {
      if (serviceArea.loadFailed) {
        return {
          checked: true,
          eligible: true,
          zip: normalizeZip(answers.addr_zip),
          reason: "service_area_load_failed",
          title: serviceArea.outOfAreaTitle || "We could not verify your service area",
          message: serviceArea.outOfAreaMessage || "Please try again or contact us directly."
        };
      }

      return {
        checked: true,
        eligible: true,
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
  let SERVICE_AREA_PROMISE = null;
  async function loadServiceAreaIfNeeded(features) {
    if (!features.serviceAreaFilter) return null;
    if (SERVICE_AREA_CACHE) return SERVICE_AREA_CACHE;
    if (!SERVICE_AREA_PROMISE) {
      SERVICE_AREA_PROMISE = (async () => {
        try {
          SERVICE_AREA_CACHE = await fetchJSON(addCacheBuster(getServiceAreaUrl(), "wh_service_area_v"));
        } catch (e) {
          console.warn("Service area failed to load:", e);
          SERVICE_AREA_CACHE = {
            loadFailed: true,
            outOfAreaTitle: "We could not verify your service area",
            outOfAreaMessage: "Please try again or contact us directly."
          };
        }
        return SERVICE_AREA_CACHE;
      })();
    }
    return SERVICE_AREA_PROMISE;
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

      if (q.type === "slider") {
        const value = answers[q.id];
        if (isEmpty(value)) continue;
        readable.push({
          questionId: q.id,
          question: q.title || q.id,
          value: normalizeSliderValue(q, value),
          answer: formatSliderValue(q, value)
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

  function getSliderConfig(q) {
    const min = Number(q.min ?? 0) || 0;
    const max = Number(q.max ?? Math.max(min, 100)) || Math.max(min, 100);
    const step = Math.max(Number(q.step ?? 1) || 1, 1);
    const defaultValue = Number(q.default ?? q.default_value ?? q.defaultValue ?? min);

    return {
      min,
      max: Math.max(min, max),
      step,
      defaultValue
    };
  }

  function normalizeSliderValue(q, rawValue) {
    const slider = getSliderConfig(q);
    const raw = Number(rawValue);
    const fallback = Number.isFinite(slider.defaultValue) ? slider.defaultValue : slider.min;
    const value = Number.isFinite(raw) ? raw : fallback;
    const clamped = Math.min(slider.max, Math.max(slider.min, value));
    const stepsFromMin = Math.round((clamped - slider.min) / slider.step);
    const snapped = slider.min + (stepsFromMin * slider.step);

    return Math.min(slider.max, Math.max(slider.min, snapped));
  }

  function formatSliderValue(q, value) {
    const unit = q.unit || q.unit_label || q.unitLabel || "";
    const suffix = unit ? ` ${unit}` : "";
    return `${normalizeSliderValue(q, value)}${suffix}`;
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
  function getPriceConfig(cfg) {
    const pricing = cfg?.pricing || {};
    const range = pricing.range || {};
    const safety = pricing.safety || {};

    return {
      roundTo: Number(range.round_to ?? range.roundTo ?? safety.round_to ?? safety.roundTo ?? 25) || 25,
      lowMultiplier: Number(range.low_multiplier ?? range.lowMultiplier ?? range.lowPercent ?? 0.9) || 0.9,
      highMultiplier: Number(range.high_multiplier ?? range.highMultiplier ?? range.highPercent ?? 1.08) || 1.08,
      preferExplicitRange: range.prefer_explicit !== false && range.preferExplicit !== false,
      forceGeneratedRange: range.force_generated === true || range.forceGenerated === true
    };
  }

  function roundPrice(value, roundTo) {
    const amount = Number(value) || 0;
    const increment = Number(roundTo) || 25;
    return Math.round(amount / increment) * increment;
  }

  function getOptionPrice(opt, answers) {
    const price = opt?.pricing || opt?.price || null;
    if (!price) return null;

    const quantityAnswerId = price.quantity_answer_id || price.quantityAnswerId;
    const quantity = quantityAnswerId ? (Number(answers?.[quantityAnswerId]) || 0) : 1;
    const exactPerUnit = Number(price.exact_per_unit ?? price.exactPerUnit ?? price.per_unit ?? price.perUnit ?? 0) || 0;
    const baseExact = Number(price.base_exact ?? price.baseExact ?? 0) || 0;
    const fixedExact = exactPerUnit ? 0 : (Number(price.exact ?? price.high ?? price.low ?? 0) || 0);
    const hasLow = price.low !== undefined && price.low !== null;
    const hasHigh = price.high !== undefined && price.high !== null;
    const hasLowPerUnit = price.low_per_unit !== undefined || price.lowPerUnit !== undefined;
    const hasHighPerUnit = price.high_per_unit !== undefined || price.highPerUnit !== undefined;
    const exact = baseExact + fixedExact + (quantity * exactPerUnit);
    const low = hasLowPerUnit
      ? (Number(price.base_low ?? price.baseLow ?? 0) || 0) + (quantity * (Number(price.low_per_unit ?? price.lowPerUnit) || 0))
      : hasLow
        ? Number(price.low) || 0
        : null;
    const high = hasHighPerUnit
      ? (Number(price.base_high ?? price.baseHigh ?? 0) || 0) + (quantity * (Number(price.high_per_unit ?? price.highPerUnit) || 0))
      : hasHigh
        ? Number(price.high) || 0
        : null;

    return {
      exact,
      low,
      high,
      quantity,
      hasExplicitRange: hasLow && hasHigh
        || (hasLowPerUnit && hasHighPerUnit)
    };
  }

  function getSliderPrice(q, value) {
    const price = q?.pricing || q?.price || null;
    if (!price) return null;

    const quantity = normalizeSliderValue(q, value);
    const exactPerUnit = Number(price.exact_per_unit ?? price.exactPerUnit ?? price.per_unit ?? price.perUnit ?? 0) || 0;
    const baseExact = Number(price.base_exact ?? price.baseExact ?? 0) || 0;
    const fixedExact = exactPerUnit ? 0 : (Number(price.exact ?? 0) || 0);
    const exact = baseExact + fixedExact + (quantity * exactPerUnit);

    const hasLowPerUnit = price.low_per_unit !== undefined || price.lowPerUnit !== undefined;
    const hasHighPerUnit = price.high_per_unit !== undefined || price.highPerUnit !== undefined;
    const hasLow = price.low !== undefined && price.low !== null;
    const hasHigh = price.high !== undefined && price.high !== null;
    const low = hasLowPerUnit
      ? (Number(price.base_low ?? price.baseLow ?? 0) || 0) + (quantity * (Number(price.low_per_unit ?? price.lowPerUnit) || 0))
      : hasLow
        ? Number(price.low) || 0
        : null;
    const high = hasHighPerUnit
      ? (Number(price.base_high ?? price.baseHigh ?? 0) || 0) + (quantity * (Number(price.high_per_unit ?? price.highPerUnit) || 0))
      : hasHigh
        ? Number(price.high) || 0
        : null;

    return {
      exact,
      low,
      high,
      quantity,
      hasExplicitRange: low !== null && high !== null
    };
  }

  function calculatePrice(cfg, qmap, state) {
    let exact = 0;
    let explicitLow = 0;
    let explicitHigh = 0;
    let hasPricedItems = false;
    let hasMissingRange = false;
    const items = [];

    for (const q of (cfg.questions || [])) {
      if (q.type !== "single_select" && q.type !== "multi_select") continue;
      const values = q.type === "multi_select"
        ? (Array.isArray(state.answers[q.id]) ? state.answers[q.id] : [])
        : [state.answers[q.id]];

      for (const v of values) {
        if (isEmpty(v)) continue;

        const opt = getOption(q, v);
        const price = getOptionPrice(opt, state.answers);
        if (!opt || !price) continue;

        hasPricedItems = true;
        exact += price.exact;

        if (price.hasExplicitRange) {
          explicitLow += price.low;
          explicitHigh += price.high;
        } else {
          hasMissingRange = true;
        }

        items.push({
          qid: q.id,
          questionId: q.id,
          question: q.title || q.id,
          value: v,
          label: opt.label || opt.value || String(v),
          exact: price.exact,
          low: price.low,
          high: price.high,
          quantity: price.quantity,
          hasExplicitRange: price.hasExplicitRange,
          source: "answer"
        });
      }
    }

    for (const q of (cfg.questions || [])) {
      if (q.type !== "slider") continue;
      if (isEmpty(state.answers[q.id])) continue;

      const price = getSliderPrice(q, state.answers[q.id]);
      if (!price) continue;

      hasPricedItems = true;
      exact += price.exact;

      if (price.hasExplicitRange) {
        explicitLow += price.low;
        explicitHigh += price.high;
      } else {
        hasMissingRange = true;
      }

      items.push({
        qid: q.id,
        questionId: q.id,
        question: q.title || q.id,
        value: price.quantity,
        label: formatSliderValue(q, price.quantity),
        exact: price.exact,
        low: price.low,
        high: price.high,
        hasExplicitRange: price.hasExplicitRange,
        source: "slider"
      });
    }

    if (state.meta.permit_done && state.meta.permit_sig === computeAddressSig(cfg, state.answers)) {
      const fee = Number(state.answers.permit_fee_usd || 0) || 0;
      if (fee) {
        exact += fee;
        explicitLow += fee;
        explicitHigh += fee;
        items.push({
          qid: "permit_fee_usd",
          questionId: "permit_fee_usd",
          question: "Permit",
          value: "permit_fee",
          label: "Permit fee",
          exact: fee,
          low: fee,
          high: fee,
          hasExplicitRange: true,
          source: "permit"
        });
      }

      if (state.answers.expansion_tank_required === true) {
        const addon = Number(cfg?.pricing?.lookup_addons?.expansion_tank_required || 0) || 0;
        if (addon) {
          exact += addon;
          explicitLow += addon;
          explicitHigh += addon;
          items.push({
            qid: "expansion_tank_required",
            questionId: "expansion_tank_required",
            question: "Code requirement",
            value: "expansion_tank_required",
            label: "Expansion tank required",
            exact: addon,
            low: addon,
            high: addon,
            hasExplicitRange: true,
            source: "permit"
          });
        }
      }
    }

    return {
      exact,
      explicitLow,
      explicitHigh,
      hasPricedItems,
      hasCompleteExplicitRange: hasPricedItems && !hasMissingRange,
      items
    };
  }

  function generatePriceRange(cfg, price) {
    const priceConfig = getPriceConfig(cfg);
    const exact = roundPrice(price?.exact || 0, priceConfig.roundTo);
    const canUseExplicitRange =
      priceConfig.preferExplicitRange &&
      !priceConfig.forceGeneratedRange &&
      price?.hasCompleteExplicitRange;

    if (!exact) {
      return { low: 0, high: 0, exact, source: "empty" };
    }

    if (canUseExplicitRange) {
      const low = roundPrice(price.explicitLow, priceConfig.roundTo);
      const high = roundPrice(price.explicitHigh, priceConfig.roundTo);
      return {
        low: Math.min(low, high),
        high: Math.max(low, high),
        exact,
        source: "explicit"
      };
    }

    const low = roundPrice(exact * priceConfig.lowMultiplier, priceConfig.roundTo);
    const high = roundPrice(exact * priceConfig.highMultiplier, priceConfig.roundTo);
    return {
      low: Math.min(low, high),
      high: Math.max(low, high),
      exact,
      source: "generated"
    };
  }

  function sumPricing(cfg, qmap, state) {
    const price = calculatePrice(cfg, qmap, state);
    const range = generatePriceRange(cfg, price);

    return {
      low: range.low,
      high: range.high,
      exact: range.exact,
      items: price.items,
      range,
      price
    };
  }

  function getPriceDisplayState(cfg, state, pricing) {
    const disclaimer = cfg?.result_copy?.disclaimer || "";
    const addrSig = computeAddressSig(cfg, state.answers);
    const afterAddressSubmit = state.meta.address_submitted_sig && state.meta.address_submitted_sig === addrSig;
    const exactReady =
      afterAddressSubmit &&
      state.meta.permit_done &&
      state.meta.permit_sig === addrSig;
    const isOnAddressGate = state.currentId === cfg.address_gate_id;

    if (!pricing || (pricing.low === 0 && pricing.high === 0 && pricing.exact === 0)) {
      return {
        mode: "empty",
        label: "Estimated Range",
        value: "-",
        sub: "Answer a few questions to see your range.",
        disclaimer
      };
    }

    if (exactReady && !isOnAddressGate) {
      return {
        mode: "exact",
        label: "Exact Total",
        value: `$${money(pricing.exact)}`,
        sub: "Exact price shown after address verification.",
        disclaimer
      };
    }

    return {
      mode: "range",
      label: "Estimated Range",
      value: `$${money(pricing.low)}-$${money(pricing.high)}`,
      sub: "Range updates as you go. Add your address to get an exact number.",
      disclaimer
    };
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

    if (q.type === "slider") return !isEmpty(answers[q.id]);

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
    loadServiceAreaIfNeeded(features);
    const state = loadEstimatorState(cfg, qmap);

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
      return getPriceDisplayState(cfg, state, pr);
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

    function renderSlider(q, content, ui) {
      const slider = getSliderConfig(q);
      const currentValue = normalizeSliderValue(q, isEmpty(state.answers[q.id]) ? slider.defaultValue : state.answers[q.id]);
      state.answers[q.id] = currentValue;

      const valueEl = mk("div", { class: "quiz_slider-value" }, [formatSliderValue(q, currentValue)]);
      const helpText = q.help || q.description || "";
      const inputEl = mk("input", {
        class: "quiz_slider-input",
        type: "range",
        min: slider.min,
        max: slider.max,
        step: slider.step,
        value: currentValue,
        "aria-label": q.title || q.id,
        onInput: (e) => {
          const nextValue = normalizeSliderValue(q, e.target.value);
          e.target.value = nextValue;
          state.answers[q.id] = nextValue;
          valueEl.textContent = formatSliderValue(q, nextValue);
          saveState(state, cfg);
          ui?.updateNextDisabled();
          ui?.updatePreview();
        }
      });

      const decreaseBtn = mk("button", {
        class: "quiz_slider-stepper",
        type: "button",
        "aria-label": `Decrease ${q.title || q.id}`,
        onClick: () => {
          const nextValue = normalizeSliderValue(q, Number(state.answers[q.id]) - slider.step);
          state.answers[q.id] = nextValue;
          inputEl.value = nextValue;
          valueEl.textContent = formatSliderValue(q, nextValue);
          saveState(state, cfg);
          ui?.updateNextDisabled();
          ui?.updatePreview();
        }
      }, ["-"]);

      const increaseBtn = mk("button", {
        class: "quiz_slider-stepper",
        type: "button",
        "aria-label": `Increase ${q.title || q.id}`,
        onClick: () => {
          const nextValue = normalizeSliderValue(q, Number(state.answers[q.id]) + slider.step);
          state.answers[q.id] = nextValue;
          inputEl.value = nextValue;
          valueEl.textContent = formatSliderValue(q, nextValue);
          saveState(state, cfg);
          ui?.updateNextDisabled();
          ui?.updatePreview();
        }
      }, ["+"]);

      content.appendChild(mk("div", { class: "quiz_slider" }, [
        mk("div", { class: "quiz_slider-top" }, [
          mk("div", { class: "quiz_slider-label" }, [q.label || q.title || "Amount"]),
          valueEl
        ]),
        mk("div", { class: "quiz_slider-control" }, [decreaseBtn, inputEl, increaseBtn]),
        mk("div", { class: "quiz_slider-range" }, [
          mk("span", {}, [formatSliderValue(q, slider.min)]),
          mk("span", {}, [formatSliderValue(q, slider.max)])
        ]),
        helpText ? mk("div", { class: "quiz_slider-help" }, [helpText]) : null
      ]));

      saveState(state, cfg);
      ui?.updateNextDisabled();
      ui?.updatePreview();
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

    function hasCover(cfg) {
      return Boolean(cfg?.cover && (cfg.cover.title || cfg.cover.image_url || cfg.cover.description || cfg.cover.subtitle));
    }

    function shouldShowCover() {
      return hasCover(cfg) && !state.meta.cover_seen && !hasQuizProgress(cfg, state);
    }

    function formatMultilineText(text, className) {
      if (!text) return null;

      return mk("div", { class: className }, String(text).split(/\n{2,}/).map((paragraph) => (
        mk("p", {}, [paragraph.replace(/\s*\n\s*/g, " ").trim()])
      )));
    }

    function renderCover() {
      saveState(state, cfg);
      destroyTooltips(mount);
      mount.innerHTML = "";

      const cover = cfg.cover || {};
      const imageUrl = cover.image_url || cover.imageUrl || "";
      const imageAlt = cover.image_alt || cover.imageAlt || cover.title || cfg.quizName || "Quiz cover image";
      const buttonLabel = cover.button_label || cover.buttonLabel || "Start Quiz";

      const startBtn = mk("button", {
        class: "quiz_next-button quiz_cover-button",
        type: "button",
        onClick: () => {
          state.meta.cover_seen = true;
          saveState(state, cfg);
          lastRenderedStepId = null;
          scheduleRender();
        }
      }, [buttonLabel]);

      const coverContent = mk("div", { class: "quiz_cover-content" }, [
        imageUrl ? mk("div", { class: "quiz_cover-image-wrapper" }, [
          mk("img", { class: "quiz_cover-image", src: imageUrl, alt: imageAlt, loading: "eager" })
        ]) : null,
        mk("div", { class: "quiz_cover-copy" }, [
          cover.title ? mk("div", { class: "quiz_cover-title" }, [cover.title]) : null,
          cover.subtitle ? mk("div", { class: "quiz_cover-subtitle" }, [cover.subtitle]) : null,
          formatMultilineText(cover.description, "quiz_cover-description"),
          mk("div", { class: "quiz_cover-actions" }, [startBtn])
        ])
      ]);

      const container = mk("div", { class: "quiz_form-component quiz_cover-card" }, [
        mk("div", { class: "quiz_main-content quiz_cover-main" }, [coverContent])
      ]);

      mount.appendChild(container);
      lastRenderedStepId = "__cover";
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

    function renderSummary(q, content, pr) {
      const preview = features.pricing && pr ? computePreviewLabel(pr) : null;
      const readableAnswers = buildReadableAnswers(cfg, qmap, state.answers)
        .filter((item) => !INTERNAL_ANSWER_IDS.has(item.questionId));
      const addressParts = [
        state.answers.addr_street,
        state.answers.addr_unit,
        [state.answers.addr_city, state.answers.addr_state, state.answers.addr_zip].filter(Boolean).join(", ")
      ].filter(Boolean);
      const contactParts = [
        state.answers.contact_name,
        state.answers.contact_phone,
        state.answers.contact_email
      ].filter(Boolean);
      const permitRows = features.permitLookup ? [
        ["Municipality", state.answers.municipality_city || "Not found"],
        ["Permit fee", state.answers.permit_fee_usd ? `$${money(state.answers.permit_fee_usd)}` : "Not found"],
        ["Expansion tank", state.answers.expansion_tank_required === true ? "Required" : state.answers.expansion_tank_required === false ? "Not flagged" : "Not checked"]
      ] : [];

      const section = (title, children) => mk("div", { class: "quiz_review-section" }, [
        mk("div", { class: "quiz_review-section-title" }, [title]),
        ...children
      ]);

      const rows = (items) => mk("div", { class: "quiz_review-rows" }, items.map(([label, value]) => (
        mk("div", { class: "quiz_review-row" }, [
          mk("div", { class: "quiz_review-label" }, [label]),
          mk("div", { class: "quiz_review-value" }, [value || "-"])
        ])
      )));

      content.appendChild(mk("div", { class: "quiz_review" }, [
        features.pricing && preview ? section("Estimate", [
          mk("div", { class: "quiz_review-total" }, [preview.value]),
          mk("div", { class: "quiz_review-muted" }, [preview.sub])
        ]) : null,
        addressParts.length ? section("Service Address", [
          mk("div", { class: "quiz_review-text" }, addressParts.map((part) => mk("div", {}, [part])))
        ]) : null,
        contactParts.length ? section("Contact", [
          mk("div", { class: "quiz_review-text" }, contactParts.map((part) => mk("div", {}, [part])))
        ]) : null,
        permitRows.length ? section("Permit & Code Check", [rows(permitRows)]) : null,
        readableAnswers.length ? section("Selections", [
          rows(readableAnswers.map((item) => [item.question, item.answer]))
        ]) : null,
        q.note ? mk("div", { class: "note" }, [q.note]) : null
      ]));
    }


    function renderLoadingStep(q, submittedId) {
      destroyTooltips(mount);
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

      const isResultGate = current.result_gate === true || current.resultGate === true || current.reveals_result === true || current.revealsResult === true;

      if (isResultGate) {
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

      if (isResultGate) {
        const serviceAreaStatus = getStoredServiceAreaStatus(state) || state.meta.service_area_status;
        await sendLeadCheckpoint("result_gate", serviceAreaStatus);
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
        attribution: getAttribution(),
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

    function getLeadCheckpointSig(stage, serviceAreaStatus) {
      return [
        stage,
        safeStr(state.answers.contact_name).toLowerCase(),
        safeStr(state.answers.contact_email).toLowerCase(),
        normalizeZip(state.answers.addr_zip),
        state.meta.selected_result_id || "",
        serviceAreaStatus?.eligible === false ? "out" : "in"
      ].join("|");
    }

    async function sendLeadCheckpoint(stage, serviceAreaStatus) {
      const sig = getLeadCheckpointSig(stage, serviceAreaStatus);
      state.meta.lead_checkpoint_sigs = state.meta.lead_checkpoint_sigs || {};
      if (state.meta.lead_checkpoint_sigs[stage] === sig) return { skippedDuplicate: true };

      const payload = buildBookingPayload(null, serviceAreaStatus);
      payload.leadStage = stage;
      payload.bookingAction = "record_only";

      try {
        const response = await fetch(getBookingEndpoint(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          console.warn(`Lead checkpoint failed with status ${response.status}`);
          return { ok: false, status: response.status };
        }

        state.meta.lead_checkpoint_sigs[stage] = sig;
        saveState(state, cfg);
        return await response.json().catch(() => ({ ok: true }));
      } catch (error) {
        console.warn("Lead checkpoint failed:", error);
        return { ok: false, error: error?.message || "Lead checkpoint failed" };
      }
    }

    async function submitPayload() {
      const sharedServiceArea = await loadServiceAreaIfNeeded(features);
      const serviceAreaStatus = getServiceAreaStatus(cfg, state.answers, features, sharedServiceArea);
      const pr = features.pricing ? sumPricing(cfg, qmap, state) : null;
      const payload = buildBookingPayload(pr, serviceAreaStatus);
      payload.leadStage = "booking_submit";

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

      if (shouldShowCover()) {
        renderCover();
        return;
      }
    
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
    
      destroyTooltips(mount);
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
      else if (q.type === "slider") renderSlider(q, content, ui);
      else if (q.type === "form") renderForm(q, content, ui);
      else if (q.type === "result") renderResult(q, content);
      else if (q.type === "summary") renderSummary(q, content, pr);
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
      initializeTooltips(container);
      lastRenderedStepId = q.id;
    }


    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

