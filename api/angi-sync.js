"use strict";

const { randomUUID } = require("node:crypto");
const {
  BOOKING_HEADERS, JOB_HEADERS, OPPORTUNITY_HEADERS, ESTIMATE_HEADERS, INVOICE_HEADERS, CALL_HEADERS,
  buildAngiRows, fetchAngiData
} = require("../lib/servicetitan-angi");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Use GET or POST." });
  }
  const secret = String(process.env.CRON_SECRET || "").trim();
  const previewRead = req.method === "GET" && process.env.VERCEL_ENV === "preview"
    && process.env.ANGI_SYNC_DRY_RUN !== "false";
  if (!previewRead && (!secret || !req.headers || req.headers.authorization !== `Bearer ${secret}`)) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const runId = randomUUID();
  const toUtc = new Date().toISOString();
  const fromUtc = new Date(Date.now() - integerEnv("ANGI_SYNC_LOOKBACK_DAYS", 45, 1, 365) * 86400000).toISOString();
  try {
    const records = await fetchAngiData({
      fromUtc, toUtc,
      pageSize: integerEnv("ANGI_SYNC_PAGE_SIZE", 100, 1, 1000),
      maxPages: integerEnv("ANGI_SYNC_MAX_PAGES", 50, 1, 500)
    });
    const { bookingRows, jobRows, opportunityRows, estimateRows, invoiceRows, callRows, stats } = buildAngiRows(records, toUtc);
    const dryRun = process.env.ANGI_SYNC_DRY_RUN !== "false";
    if (dryRun) {
      return res.status(200).json({
        ok: true, dryRun, runId, window: { fromUtc, toUtc }, stats,
        preview: {
          bookings: bookingRows.slice(0, 3).map((row) => ({
            recordKey: row[0], hasFee: row[6] !== "", partnerJobType: row[7]
          })),
          jobs: jobRows.slice(0, 3).map((row) => ({
            recordKey: row[0], bookingId: row[2], hasSoldBy: Boolean(row[12]),
            soldBySource: row[13], soldByConflict: row[14], hasPrimaryEstimate: Boolean(row[10])
          })),
          opportunities: opportunityRows.slice(0, 3).map((row) => ({
            recordKey: row[0], isRan: row[9], attributionStatus: row[10],
            technicianCount: row[11], hasSoldEstimate: row[16]
          })),
          soldEstimateCount: estimateRows.length,
          invoiceCount: invoiceRows.length,
          callOnlyCount: stats.callOnlyAttributions
        }
      });
    }
    const result = await writeToAppsScript({
      runId, fromUtc, toUtc, bookingRows, jobRows, opportunityRows, estimateRows, invoiceRows, callRows, stats
    });
    return res.status(200).json({ ok: true, dryRun, runId, stats, sheet: result });
  } catch (error) {
    console.error("Angi sync failed", { runId, message: error.message });
    return res.status(502).json({ error: error.message, runId });
  }
};

async function writeToAppsScript({
  runId, fromUtc, toUtc, bookingRows, jobRows, opportunityRows, estimateRows, invoiceRows, callRows, stats
}) {
  const url = String(process.env.ANGI_APPS_SCRIPT_WEBHOOK_URL || "").trim();
  const secret = String(process.env.ANGI_APPS_SCRIPT_WEBHOOK_SECRET || "").trim();
  if (!url || !secret) throw new Error("Angi Apps Script webhook URL and secret are required for live writes.");
  const response = await fetch(url, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 3, secret,
      bookings: { sheetName: "Angi_API_Bookings", headers: BOOKING_HEADERS, rows: bookingRows },
      jobs: { sheetName: "Angi_API_Jobs", headers: JOB_HEADERS, rows: jobRows },
      opportunities: { sheetName: "Angi_API_Opportunities", headers: OPPORTUNITY_HEADERS, rows: opportunityRows },
      estimates: { sheetName: "Angi_API_Estimates", headers: ESTIMATE_HEADERS, rows: estimateRows },
      invoices: { sheetName: "Angi_API_Invoices", headers: INVOICE_HEADERS, rows: invoiceRows },
      calls: { sheetName: "Angi_API_Calls", headers: CALL_HEADERS, rows: callRows },
      run: { sheetName: "Angi_API_Sync_Runs", values: [
        runId, fromUtc, toUtc, stats.angiBookings, stats.feesParsed, stats.angiJobs,
        stats.soldEstimates, stats.invoices, stats.bookingsWithJobs, stats.bookingsWithInvoices,
        stats.jobsWithSoldBy, stats.callOnlyAttributions, stats.workedFirstVisits,
        stats.firstVisitsWithTechnicians, stats.multiTechnicianFirstVisits, new Date().toISOString()
      ] }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error || `Angi Apps Script write failed (${response.status}).`);
  }
  return body.result;
}

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

