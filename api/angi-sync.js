"use strict";

const { randomUUID } = require("node:crypto");
const { BOOKING_HEADERS, CALL_HEADERS, buildAngiRows, fetchAngiData } = require("../lib/servicetitan-angi");

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
    const { bookingRows, callRows, stats } = buildAngiRows(records, toUtc);
    const dryRun = process.env.ANGI_SYNC_DRY_RUN !== "false";
    if (dryRun) {
      return res.status(200).json({
        ok: true, dryRun, runId, window: { fromUtc, toUtc }, stats,
        preview: {
          bookings: bookingRows.slice(0, 3).map((row) => ({
            recordKey: row[0], hasFee: row[5] !== "", partnerJobType: row[6],
            jobCount: row[15] ? row[15].split(" | ").length : 0,
            soldEstimateSubtotal: row[19], invoiceTotal: row[22]
          })),
          callOnlyCount: callRows.length
        }
      });
    }
    const result = await writeToAppsScript({ runId, fromUtc, toUtc, bookingRows, callRows, stats });
    return res.status(200).json({ ok: true, dryRun, runId, stats, sheet: result });
  } catch (error) {
    console.error("Angi sync failed", { runId, message: error.message });
    return res.status(502).json({ error: error.message, runId });
  }
};

async function writeToAppsScript({ runId, fromUtc, toUtc, bookingRows, callRows, stats }) {
  const url = String(process.env.ANGI_APPS_SCRIPT_WEBHOOK_URL || "").trim();
  const secret = String(process.env.ANGI_APPS_SCRIPT_WEBHOOK_SECRET || "").trim();
  if (!url || !secret) throw new Error("Angi Apps Script webhook URL and secret are required for live writes.");
  const response = await fetch(url, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1, secret,
      bookings: { sheetName: "Angi_API_Bookings", headers: BOOKING_HEADERS, rows: bookingRows },
      calls: { sheetName: "Angi_API_Calls", headers: CALL_HEADERS, rows: callRows },
      run: { sheetName: "Angi_API_Sync_Runs", values: [runId, fromUtc, toUtc, stats.angiBookings, stats.feesParsed, stats.bookingsWithJobs, stats.bookingsWithInvoices, stats.callOnlyAttributions, new Date().toISOString()] }
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

