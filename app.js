(function () {
  "use strict";

  const ZAPIER_WEBHOOK_URL = "PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE";
  const CONFIG_URL = "https://matthew-callmother.github.io/estimator/config.json";
  const MUNICIPALITIES_URL = "https://matthew-callmother.github.io/estimator/municipalities-dfw.json";

  const MOUNT_ID = "wh-estimator";
  const STORAGE_KEY = "wh_estimator_routing_state";

  /* ---------------- Helpers ---------------- */
  const qs = (sel, root = document) => root.querySelector(sel);
  const money = (n) => Math.round(Number(n) || 0).toLocaleString();
  const normalizePhone = (s) => String(s || "").replace(/\D/g, "");
  const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";
  const safeStr = (v) => String(v == null ? "" : v).trim();

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

  /* ---------------- Data Loading ---------------- */
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return await res.json();
  }

  let MUNICACHE = null;
  async function loadMunicipalities() {
    if (MUNICACHE) return MUNICACHE;
    MUNICACHE = await fetchJSON(MUNICIPALITIES_URL);
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

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

    let cfg, qmap;
    try {
      cfg = await fetchJSON(CONFIG_URL);
      qmap = indexQuestions(cfg);
    } catch (e) {
      console.error(e);
      mount.innerHTML = "<p>Error loading configuration. Check console.</p>";
      return;
    }

    const state = loadState();

    if (!state.currentId) state.currentId = cfg.start || (cfg.questions?.[0]?.id ?? null);
    if (!state.currentId) {
      mount.innerHTML = "<p>No questions configured.</p>";
      return;
    }

    const getStepIndex = () => {
      const path = [...state.history, state.currentId];
      return { i: path.length, total: Math.max(path.length, 1) };
    };

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
        return { mode: "empty", label: "Estimated Range", value: "—", sub: "Answer a few questions to see your range.", disclaimer };
      }

      return { mode: "range", label: "Estimated Range", value: `$${money(pr.low)}–$${money(pr.high)}`, sub: "Range updates as you go. Add your address to get an exact number.", disclaimer };
    }

    function renderSingleSelect(q, content) {
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
                saveState(state);
                scheduleRender();
              }
            },
            [
              mk("div", { class: "choiceMain" }, [
                mk("div", { class: "choiceTop" }, [
                  mk("div", { class: "choiceLabel" }, [opt.label]),
                  opt.tooltip ? tooltip(opt.tooltip) : null
                ]),
                opt.image_url ? mk("img", { class: "oimg", src: opt.image_url, alt: "", loading: "lazy" }) : null
              ])
            ]
          )
        );
      });

      content.appendChild(wrap);
    }

    // IMPORTANT: no scheduleRender() on input (keeps Android keyboard open)
        function renderForm(q, content, ui) {
          (q.fields || []).forEach((f) => {
            const val = state.answers[f.id] || "";
            const errEl = mk("div", { class: "fieldErr", style: "display:none" }, [""]);
        
            const inputEl = mk("input", {
              type: f.input_type || "text",
              value: val,
              placeholder: f.placeholder || "",
              autocomplete: f.autocomplete || "",
              onInput: (e) => {
                state.answers[f.id] = e.target.value;
        
                if (String(f.id).startsWith("addr_")) invalidatePermit(cfg, state);
                saveState(state);
        
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
        
            content.appendChild(
              mk("div", { class: "field" }, [
                mk("label", { class: "fieldLabel" }, [f.label || f.id, f.help ? tooltip(f.help) : null]),
                inputEl,
                errEl
              ])
            );
          });
    }


    function renderLoadingStep(q) {
      mount.innerHTML = "";

      const duration = Number(q.duration_ms || 1600);
      const start = Date.now();
      const fillId = `loadfill_${q.id}`;

      const { i, total } = getStepIndex();
      const pct = total ? Math.round((i / total) * 100) : 0;

      const card = mk("div", { class: "card" }, [
        mk("div", { class: "stepHeader" }, [
          mk("div", { class: "progressWrap" }, [
            mk("div", { class: "progressMeta" }, [`Step ${i} of ${total}`]),
            mk("div", { class: "progressBar" }, [mk("div", { class: "progressFill", style: `width:${pct}%` })])
          ])
        ]),
        mk("div", { class: "loading" }, [
          mk("div", { class: "loadingInner" }, [
            mk("div", { class: "spinner" }),
            mk("div", { class: "loadingTitle" }, [q.title || "Checking…"]),
            q.subtitle ? mk("div", { class: "loadingSub" }, [q.subtitle]) : null,
            mk("div", { class: "loadBar" }, [mk("div", { id: fillId, class: "loadFill", style: "width:0%" })])
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
        await submitPayload();
        return;
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
        const tracker = renderLoadingStep(nextQ);

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
          saveState(state);
          scheduleRender();
        }, remaining + 200);

        return;
      }

      state.history.push(state.currentId);
      state.currentId = nextId;

      saveState(state);
      scheduleRender();
    }

    function handleBack() {
      if (!state.history.length) return;
      state.currentId = state.history.pop();
      saveState(state);
      scheduleRender();
    }

    async function submitPayload() {
      const pr = sumPricing(cfg, qmap, state);

      const payload = {
        answers: state.answers,
        meta: {
          url: location.href,
          ts: new Date().toISOString(),
          permit_done: state.meta.permit_done
        },
        pricing: { low: pr.low, high: pr.high, exact: pr.exact }
      };

      if (!ZAPIER_WEBHOOK_URL || String(ZAPIER_WEBHOOK_URL).includes("PASTE_YOUR_")) {
        alert("Submitted (dev mode). Add your Zapier URL to send.");
        return;
      }

      await fetch(ZAPIER_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      alert("Submitted! We'll reach out shortly.");
    }

    function render() {
      saveState(state);
    
      const q = getQuestion(qmap, state.currentId);
      if (!q) {
        mount.innerHTML = "<p>Missing question in config.</p>";
        return;
      }
    
      // refresh-on-loading: skip
      if (q.type === "loading_lookup") {
        state.currentId = q.next || state.currentId;
        saveState(state);
        scheduleRender();
        return;
      }
    
      mount.innerHTML = "";
    
      const { i, total } = getStepIndex();
      const pct = total ? Math.round((i / total) * 100) : 0;
    
      const pr = sumPricing(cfg, qmap, state);
      const preview = computePreviewLabel(pr);
    
      const content = mk("div", { id: "step-content" });
    
      const header = mk("div", { class: "stepHeader" }, [
        mk("div", { class: "progressWrap" }, [
          mk("div", { class: "progressMeta" }, [`Step ${i} of ${total}`]),
          mk("div", { class: "progressBar" }, [mk("div", { class: "progressFill", style: `width:${pct}%` })])
        ]),
        mk("h2", {}, [q.title || ""]),
        q.subtitle ? mk("div", { class: "stepSub" }, [q.subtitle]) : null,
        // question tooltip rendered as a visible box (optional)
        (q.tip || q.help || q.tooltip) ? mk("div", { class: "qTip" }, [q.tip || q.help || q.tooltip]) : null
      ]);
    
      const canGoBack = state.history.length > 0;
      const nextLabel = q.next_label || (q.type === "submit" ? (q.submit_label || "Submit") : "Next");
    
      const backBtn = mk("button", { class: "btn secondary", disabled: !canGoBack, onClick: handleBack }, ["Back"]);
      const nextBtn = mk("button", { class: "btn", disabled: !isQuestionComplete(q, state.answers), onClick: () => handleNext(q) }, [nextLabel]);
    
      const nav = mk("div", { class: "nav" }, [backBtn, nextBtn]);
    
      // preview nodes (so we don't querySelector before they exist)
      const previewLabelEl = mk("span", {}, [preview.label]);
      const previewPriceEl = mk("div", { class: "previewPrice" }, [preview.value]);
      const previewSubEl = mk("div", { class: "previewSub" }, [preview.sub]);
      const previewTop = mk("div", { class: "previewTop" }, [
        previewLabelEl,
        preview.disclaimer ? tooltip(preview.disclaimer) : null
      ]);
    
      const previewEl = mk("div", { class: "preview" }, [previewTop, previewPriceEl, previewSubEl]);
    
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
    
      const container = mk("div", { class: "card" }, [header, content, nav, previewEl]);
      mount.appendChild(container);
    }


    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

