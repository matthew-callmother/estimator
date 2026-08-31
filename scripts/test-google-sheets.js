"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { ATTRIBUTION_HEADERS, SYNC_HEADERS, upsertAttributionRows } = require("../lib/google-sheets");

async function run() {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls = [];
  const oldRow = Array(ATTRIBUTION_HEADERS.length).fill("");
  oldRow[0] = "call:100";
  oldRow[1] = "2026-08-28T00:00:00.000Z";
  oldRow[15] = "100";

  try {
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID = "sheet-test";
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "sync@example.iam.gserviceaccount.com";
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
    process.env.MARKETING_SYNC_SHEET_NAME = "Attributed Leads";
    process.env.MARKETING_SYNC_RUNS_SHEET_NAME = "Sync Runs";

    global.fetch = async (url, options = {}) => {
      const decoded = decodeURIComponent(String(url));
      const body = options.body instanceof URLSearchParams
        ? Object.fromEntries(options.body)
        : options.body ? JSON.parse(options.body) : null;
      calls.push({ url: decoded, method: options.method || "GET", body });

      if (decoded === "https://oauth2.googleapis.com/token") {
        return mockResponse(200, { access_token: "google-token", expires_in: 3600 });
      }
      if (decoded.includes("fields=sheets.properties")) {
        return mockResponse(200, {
          sheets: [
            { properties: { sheetId: 1, title: "Attributed Leads" } },
            { properties: { sheetId: 2, title: "Sync Runs" } }
          ]
        });
      }
      if (decoded.includes("'Attributed Leads'!1:1")) return mockResponse(200, { values: [ATTRIBUTION_HEADERS] });
      if (decoded.includes("'Sync Runs'!1:1")) return mockResponse(200, { values: [SYNC_HEADERS] });
      if (decoded.includes("'Attributed Leads'!A1:AA")) return mockResponse(200, { values: [ATTRIBUTION_HEADERS, oldRow] });
      return mockResponse(200, {});
    };

    const shared = {
      leadDate: "2026-08-28T00:00:00.000Z",
      leadType: "1",
      classification: "Phone call",
      landingPage: "https://www.callmother.com/",
      landingPageRaw: "www.callmother.com",
      campaign: "Google Organic",
      source: "Google",
      medium: "Organic",
      adGroupId: "",
      keywordId: "",
      referrerUrl: "https://www.google.com/",
      clickId: "",
      gbraid: "",
      wbraid: "",
      bookingId: "",
      leadFormNumber: "",
      serviceTitanCampaignId: "",
      originalCampaign: "",
      jobStatus: "",
      estimateId: "",
      estimateStatus: "",
      estimateTotal: "",
      jobRevenue: "",
      lastSyncedAt: "2026-08-28T01:00:00.000Z"
    };
    const result = await upsertAttributionRows([
      { ...shared, recordKey: "call:100", callId: "100", jobId: "200" },
      { ...shared, recordKey: "call:101", callId: "101", jobId: "" }
    ], {
      runId: "run-test",
      startedAt: "2026-08-28T01:00:00.000Z",
      completedAt: "2026-08-28T01:00:01.000Z",
      status: "completed",
      fromUtc: "2026-07-01T00:00:00.000Z",
      toUtc: "2026-08-28T01:00:00.000Z",
      fetched: 2,
      uniqueRecords: 2
    });

    assert.deepEqual(result, { inserted: 1, updated: 1, unchanged: 0 });
    const batch = calls.find((call) => call.url.endsWith("/values:batchUpdate"));
    assert.equal(batch.body.data[0].range, "'Attributed Leads'!A2:AA2");
    assert.equal(batch.body.data[0].values[0][17], "200");
    const appends = calls.filter((call) => call.url.includes(":append"));
    assert.equal(appends.length, 2);
    assert.equal(appends[0].body.values[0][0], "call:101");
    assert.equal(appends[1].body.values[0][0], "run-test");

    console.log("Google Sheets sync tests passed.");
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
}

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(body)
  };
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
