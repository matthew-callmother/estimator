"use strict";

const { randomUUID } = require("node:crypto");
const {
  enrichAttributedLeads,
  fetchAttributedLeads,
  fetchEstimates,
  normalizeAttributedLeads
} = require("../lib/servicetitan-marketing");
const { upsertAttributionRows } = require("../lib/google-sheets");
const { upsertAttributionRowsViaAppsScript } = require("../lib/apps-script-sheets");

module.exports = async function handler(req, res) {
  if (!new Set(["GET", "POST"]).has(req.method)) {
    return res.status(405).json({ error: "Use GET or POST for marketing sync requests." });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized marketing sync request." });
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  try {
    const lookbackDays = integerEnv("MARKETING_SYNC_LOOKBACK_DAYS", 45, 1, 365);
    const toUtc = new Date().toISOString();
    const fromUtc = new Date(Date.now() - lookbackDays * 86400000).toISOString();
    const records = await fetchAttributedLeads({
      fromUtc,
      toUtc,
      pageSize: integerEnv("MARKETING_SYNC_PAGE_SIZE", 100, 1, 1000),
      maxPages: integerEnv("MARKETING_SYNC_MAX_PAGES", 100, 1, 500)
    });
    const normalizedRows = normalizeAttributedLeads(records, toUtc);
    const hasJobIds = normalizedRows.some((row) => row.jobId);
    const estimates = hasJobIds ? await fetchEstimates({
      fromUtc,
      toUtc,
      pageSize: integerEnv("MARKETING_SYNC_ESTIMATE_PAGE_SIZE", 100, 1, 1000),
      maxPages: integerEnv("MARKETING_SYNC_ESTIMATE_MAX_PAGES", 100, 1, 500)
    }) : [];
    const enrichment = enrichAttributedLeads(normalizedRows, estimates);
    const rows = enrichment.rows;
    const dryRun = process.env.MARKETING_SYNC_DRY_RUN === "true";

    if (dryRun) {
      console.log("ServiceTitan marketing sync dry run completed", {
        runId,
        fromUtc,
        toUtc,
        fetched: records.length,
        uniqueRecords: rows.length,
        estimateEnrichment: enrichment.stats
      });
      return res.status(200).json({
        ok: true,
        dryRun: true,
        runId,
        window: { fromUtc, toUtc },
        fetched: records.length,
        uniqueRecords: rows.length,
        estimateEnrichment: enrichment.stats,
        preview: rows.slice(0, 3).map(safePreview)
      });
    }

    const completedAt = new Date().toISOString();
    const sheet = await sheetWriter()(rows, {
      runId,
      startedAt,
      completedAt,
      status: "completed",
      fromUtc,
      toUtc,
      fetched: records.length,
      uniqueRecords: rows.length
    });

    console.log("ServiceTitan marketing sync completed", {
      runId,
      fetched: records.length,
      uniqueRecords: rows.length,
      estimateEnrichment: enrichment.stats,
      ...sheet
    });
    return res.status(200).json({
      ok: true,
      dryRun: false,
      runId,
      window: { fromUtc, toUtc },
      fetched: records.length,
      uniqueRecords: rows.length,
      estimateEnrichment: enrichment.stats,
      sheet
    });
  } catch (error) {
    console.error("ServiceTitan marketing sync failed", {
      runId,
      message: error.message,
      diagnostics: error.diagnostics || null
    });
    return res.status(error.statusCode || 500).json({
      error: error.message,
      runId,
      diagnostics: error.diagnostics || undefined
    });
  }
};

function isAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  if (!req.headers) return false;
  return req.headers.authorization === `Bearer ${secret}`
    || req.headers["x-marketing-sync-secret"] === secret;
}

function integerEnv(name, defaultValue, min, max) {
  const parsed = Number(process.env[name] || defaultValue);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function sheetWriter() {
  const configured = String(process.env.MARKETING_SYNC_SHEETS_PROVIDER || "").trim().toLowerCase();
  const provider = configured || (process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL ? "apps_script" : "service_account");

  if (provider === "apps_script") return upsertAttributionRowsViaAppsScript;
  if (provider === "service_account") return upsertAttributionRows;
  throw new Error("MARKETING_SYNC_SHEETS_PROVIDER must be apps_script or service_account.");
}

function safePreview(row) {
  return {
    recordKey: row.recordKey,
    leadDate: row.leadDate,
    classification: row.classification,
    landingPage: row.landingPage,
    campaign: row.campaign,
    source: row.source,
    medium: row.medium,
    hasCallId: Boolean(row.callId),
    hasBookingId: Boolean(row.bookingId),
    hasJobId: Boolean(row.jobId),
    estimateId: row.estimateId,
    estimateStatus: row.estimateStatus,
    estimateSubtotal: row.estimateTotal
  };
}
