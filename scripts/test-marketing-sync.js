"use strict";

const assert = require("node:assert/strict");
const handler = require("../api/marketing-sync");
const {
  buildRecordKey,
  enrichAttributedLeads,
  normalizeAttributedLead,
  normalizeUrl,
  selectSoldEstimate
} = require("../lib/servicetitan-marketing");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function run() {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const sample = {
    dateTime: "2026-08-28T00:46:41.165Z",
    leadType: 1,
    call: { id: 89934156 },
    job: { id: 89937352 },
    attribution: {
      landingPageUrl: "sewer.callmother.com/?utm_source=test",
      utmCampaign: "Test Campaign",
      utmSource: "Google",
      utmMedium: "CPC"
    }
  };

  try {
    process.env.NODE_ENV = "test";
    process.env.SERVICETITAN_ENV = "production";
    process.env.SERVICETITAN_CLIENT_ID = "client-test";
    process.env.SERVICETITAN_CLIENT_SECRET = "secret-test";
    process.env.SERVICETITAN_APP_KEY = "ak1-test";
    process.env.SERVICETITAN_TENANT_ID = "tenant-test";
    process.env.MARKETING_SYNC_DRY_RUN = "true";
    process.env.MARKETING_SYNC_LOOKBACK_DAYS = "30";

    let attributedRequests = 0;
    let estimateRequests = 0;
    global.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/connect/token")) {
        return mockResponse(200, { access_token: "token-test", expires_in: 900 });
      }
      if (requestUrl.includes("/sales/v2/") && requestUrl.includes("/estimates?")) {
        estimateRequests += 1;
        assert.equal(new URL(requestUrl).searchParams.get("status"), "Sold");
        return mockResponse(200, {
          data: [
            {
              id: 300,
              jobId: 89937352,
              status: { value: 1, name: "Open" },
              subtotal: 900,
              modifiedOn: "2026-08-28T01:00:00.000Z",
              active: true
            },
            {
              id: 301,
              jobId: 89937352,
              status: { value: 2, name: "Sold" },
              subtotal: 1250.5,
              soldOn: "2026-08-28T01:30:00.000Z",
              modifiedOn: "2026-08-28T01:30:00.000Z",
              active: true
            }
          ],
          hasMore: false
        });
      }
      attributedRequests += 1;
      return mockResponse(200, { data: [sample], hasMore: false });
    };

    const res = response();
    await handler({ method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.fetched, 1);
    assert.equal(res.body.uniqueRecords, 1);
    assert.equal(res.body.preview[0].recordKey, "call:89934156");
    assert.equal(res.body.preview[0].landingPage, "https://sewer.callmother.com/");
    assert.equal(res.body.preview[0].estimateId, "301");
    assert.equal(res.body.preview[0].estimateStatus, "Sold");
    assert.equal(res.body.preview[0].estimateSubtotal, 1250.5);
    assert.equal(res.body.estimateEnrichment.matchedJobs, 1);
    assert.equal(res.body.estimateEnrichment.soldEstimatesFetched, 1);
    assert.equal(attributedRequests, 1);
    assert.equal(estimateRequests, 1);

    const normalized = normalizeAttributedLead(sample, "2026-08-28T02:00:00.000Z");
    assert.equal(normalized.jobId, "89937352");
    assert.equal(normalized.classification, "Phone call");
    assert.equal(buildRecordKey(sample), "call:89934156");
    assert.equal(normalizeUrl("www.callmother.com/contact/?x=1"), "https://www.callmother.com/contact");

    const openEstimate = { id: 10, status: { name: "Open" }, modifiedOn: "2026-08-28T03:00:00.000Z" };
    const olderSoldEstimate = { id: 11, status: { name: "Sold" }, subtotal: 2000, soldOn: "2026-08-28T01:00:00.000Z" };
    const newerSoldEstimate = { id: 12, status: { name: "Sold" }, subtotal: 1500, soldOn: "2026-08-28T02:00:00.000Z" };
    assert.equal(selectSoldEstimate([openEstimate]), null);
    assert.equal(selectSoldEstimate([openEstimate, olderSoldEstimate, newerSoldEstimate]).id, 11);

    const noSoldEstimate = enrichAttributedLeads([
      { ...normalized, jobId: "89937352" }
    ], [{ ...openEstimate, jobId: 89937352, subtotal: 900 }]);
    assert.equal(noSoldEstimate.rows[0].estimateId, "");
    assert.equal(noSoldEstimate.stats.matchedJobs, 0);

    process.env.NODE_ENV = "production";
    process.env.CRON_SECRET = "cron-test";
    const unauthorized = response();
    await handler({ method: "GET", headers: {} }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);

    console.log("Marketing sync tests passed.");
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
