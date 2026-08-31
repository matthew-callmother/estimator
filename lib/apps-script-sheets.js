"use strict";

const {
  ATTRIBUTION_HEADERS,
  SYNC_HEADERS,
  rowValues,
  syncRowValues
} = require("./google-sheets");

async function upsertAttributionRowsViaAppsScript(rows, run) {
  const url = requireEnv("GOOGLE_APPS_SCRIPT_WEBHOOK_URL");
  const secret = requireEnv("GOOGLE_APPS_SCRIPT_WEBHOOK_SECRET");
  const payload = {
    version: 1,
    secret,
    attribution: {
      sheetName: process.env.MARKETING_SYNC_SHEET_NAME || "Attributed Leads",
      headers: ATTRIBUTION_HEADERS,
      rows: rows.map(rowValues)
    },
    syncRun: {
      sheetName: process.env.MARKETING_SYNC_RUNS_SHEET_NAME || "Sync Runs",
      headers: SYNC_HEADERS,
      values: syncRowValues(run)
    }
  };
  const attempts = integerEnv("GOOGLE_APPS_SCRIPT_MAX_ATTEMPTS", 3, 1, 5);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const text = await response.text();
      const responsePayload = safeJson(text);

      if (!response.ok || responsePayload.ok !== true) {
        const error = webhookError(response, responsePayload);
        if (!isRetryable(response.status, responsePayload) || attempt === attempts) throw error;
        lastError = error;
      } else {
        return responsePayload.result;
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts || error.retryable === false) throw error;
    }

    await sleep(250 * (2 ** (attempt - 1)));
  }

  throw lastError || new Error("Apps Script Sheet write failed.");
}

function webhookError(response, payload) {
  const error = new Error(payload.error || `Apps Script Sheet write failed with status ${response.status}.`);
  error.statusCode = 502;
  error.retryable = isRetryable(response.status, payload);
  error.diagnostics = {
    service: "Google Apps Script",
    status: response.status,
    statusText: response.statusText,
    response: sanitize(payload)
  };
  return error;
}

function isRetryable(status, payload) {
  return status === 429 || status >= 500 || payload.retryable === true;
}

function integerEnv(name, defaultValue, min, max) {
  const parsed = Number(process.env[name] || defaultValue);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function safeJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: String(text).slice(0, 1000) || "Apps Script returned an empty response." };
  }
}

function sanitize(input) {
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    /secret/i.test(key) ? "[redacted]" : value
  ]));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireEnv(name) {
  const result = String(process.env[name] || "").trim();
  if (!result) throw new Error(`Missing environment variable: ${name}`);
  return result;
}

module.exports = { upsertAttributionRowsViaAppsScript };
