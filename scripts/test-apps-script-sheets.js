"use strict";

const assert = require("node:assert/strict");
const { upsertAttributionRowsViaAppsScript } = require("../lib/apps-script-sheets");
const { ATTRIBUTION_HEADERS, SYNC_HEADERS, rowValues, syncRowValues } = require("../lib/google-sheets");
const { upsertRows } = require("../google-apps-script/marketing-sync");

async function run() {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  try {
    process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL = "https://script.google.com/macros/s/test/exec";
    process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_SECRET = "webhook-test";
    process.env.GOOGLE_APPS_SCRIPT_MAX_ATTEMPTS = "1";
    process.env.MARKETING_SYNC_SHEET_NAME = "Attributed Leads";
    process.env.MARKETING_SYNC_RUNS_SHEET_NAME = "Sync Runs";
    let sent;

    global.fetch = async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return mockResponse(200, { ok: true, result: { inserted: 1, updated: 0, unchanged: 0 } });
    };

    const row = sampleRow("call:123");
    const result = await upsertAttributionRowsViaAppsScript([row], sampleRun());
    assert.deepEqual(result, { inserted: 1, updated: 0, unchanged: 0 });
    assert.equal(sent.url, process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL);
    assert.equal(sent.body.secret, "webhook-test");
    assert.deepEqual(sent.body.attribution.headers, ATTRIBUTION_HEADERS);
    assert.equal(sent.body.attribution.rows[0][0], "call:123");
    assert.equal(sent.body.attribution.rows[0][1], "2026-08-28T00:00:00Z");
    assert.equal(sent.body.attribution.rows[0][26], "2026-08-28T01:00:00Z");
    assert.deepEqual(sent.body.syncRun.headers, SYNC_HEADERS);
    assert.equal(syncRowValues(sampleRun())[1], "2026-08-28T01:00:00Z");

    const sheet = fakeSheet([
      ATTRIBUTION_HEADERS,
      rowValues(sampleRow("call:123"))
    ]);
    const unchanged = upsertRows(sheet, ATTRIBUTION_HEADERS, [rowValues(sampleRow("call:123"))]);
    assert.deepEqual(unchanged, { inserted: 0, updated: 0, unchanged: 1 });

    const changedRow = sampleRow("call:123");
    changedRow.jobId = "456";
    const changed = upsertRows(sheet, ATTRIBUTION_HEADERS, [rowValues(changedRow), rowValues(sampleRow("call:789"))]);
    assert.deepEqual(changed, { inserted: 1, updated: 1, unchanged: 0 });
    assert.equal(sheet.rows[1][17], "456");
    assert.equal(sheet.rows[2][0], "call:789");

    console.log("Apps Script Sheets tests passed.");
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
}

function sampleRow(recordKey) {
  return {
    recordKey,
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
    callId: recordKey.replace("call:", ""),
    bookingId: "",
    jobId: "",
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
}

function sampleRun() {
  return {
    runId: "run-test",
    startedAt: "2026-08-28T01:00:00.000Z",
    completedAt: "2026-08-28T01:00:01.000Z",
    status: "completed",
    fromUtc: "2026-07-01T00:00:00.000Z",
    toUtc: "2026-08-28T01:00:00.000Z",
    fetched: 1,
    uniqueRecords: 1
  };
}

function fakeSheet(rows) {
  return {
    rows,
    getLastRow() { return this.rows.length; },
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues: () => this.rows.slice(row - 1, row - 1 + rowCount).map((entry) => entry.slice(column - 1, column - 1 + columnCount)),
        setValues: (input) => {
          input.forEach((entry, index) => {
            this.rows[row - 1 + index] = entry.slice();
          });
        }
      };
    }
  };
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

