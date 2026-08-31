"use strict";

const { createHash } = require("node:crypto");

const ENVIRONMENTS = {
  integration: {
    authBaseUrl: "https://auth-integration.servicetitan.io",
    apiBaseUrl: "https://api-integration.servicetitan.io"
  },
  production: {
    authBaseUrl: "https://auth.servicetitan.io",
    apiBaseUrl: "https://api.servicetitan.io"
  }
};

let cachedToken = null;

async function fetchAttributedLeads({ fromUtc, toUtc, pageSize = 100, maxPages = 100 }) {
  const environment = getEnvironment();
  const tenantId = requireEnv("SERVICETITAN_TENANT_ID");
  const appKey = requireEnv("SERVICETITAN_APP_KEY");
  let accessToken = await getAccessToken(environment);
  const records = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      fromUtc,
      toUtc,
      page: String(page),
      pageSize: String(pageSize),
      includeTotal: "true"
    });
    const url = `${environment.apiBaseUrl}/marketingads/v2/tenant/${encodeURIComponent(tenantId)}/attributed-leads?${params}`;
    let response = await fetchServiceTitan(url, accessToken, appKey);

    if (response.status === 401) {
      cachedToken = null;
      accessToken = await getAccessToken(environment);
      response = await fetchServiceTitan(url, accessToken, appKey);
    }

    const text = await response.text();
    if (!response.ok) {
      throw serviceTitanError("Attributed Leads request failed", response, text, url);
    }

    const extracted = extractRecords(parseJson(text));
    records.push(...extracted.rows);

    if (!extracted.rows.length || (!extracted.hasMore && extracted.rows.length < pageSize)) {
      break;
    }
  }

  return records;
}

async function fetchEstimates({ fromUtc, toUtc, pageSize = 100, maxPages = 100 }) {
  const environment = getEnvironment();
  const tenantId = requireEnv("SERVICETITAN_TENANT_ID");
  const appKey = requireEnv("SERVICETITAN_APP_KEY");
  let accessToken = await getAccessToken(environment);
  const records = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      createdOnOrAfter: fromUtc,
      createdBefore: toUtc,
      status: "Sold",
      active: "Any",
      page: String(page),
      pageSize: String(pageSize),
      includeTotal: "true"
    });
    const url = `${environment.apiBaseUrl}/sales/v2/tenant/${encodeURIComponent(tenantId)}/estimates?${params}`;
    let response = await fetchServiceTitan(url, accessToken, appKey);

    if (response.status === 401) {
      cachedToken = null;
      accessToken = await getAccessToken(environment);
      response = await fetchServiceTitan(url, accessToken, appKey);
    }

    const text = await response.text();
    if (!response.ok) {
      throw serviceTitanError("Estimates request failed", response, text, url);
    }

    const extracted = extractRecords(parseJson(text));
    records.push(...extracted.rows);

    if (!extracted.rows.length || (!extracted.hasMore && extracted.rows.length < pageSize)) {
      break;
    }
  }

  return records;
}

function enrichAttributedLeads(rows, estimates) {
  const estimatesByJob = new Map();

  for (const estimate of estimates) {
    const jobId = value(estimate.jobId);
    if (!jobId) continue;
    if (!estimatesByJob.has(jobId)) estimatesByJob.set(jobId, []);
    estimatesByJob.get(jobId).push(estimate);
  }

  const jobIds = new Set(rows.map((row) => row.jobId).filter(Boolean));
  const matchedJobIds = new Set();
  let matchedRows = 0;

  const enrichedRows = rows.map((row) => {
    if (!row.jobId) return row;
    const candidates = estimatesByJob.get(row.jobId) || [];
    const estimate = selectSoldEstimate(candidates);
    if (!estimate) return row;

    matchedRows += 1;
    matchedJobIds.add(row.jobId);
    return {
      ...row,
      estimateId: value(estimate.id),
      estimateStatus: statusName(estimate.status),
      estimateTotal: decimalValue(estimate.subtotal)
    };
  });

  return {
    rows: enrichedRows,
    stats: {
      estimatesFetched: estimates.length,
      soldEstimatesFetched: estimates.filter(isSoldEstimate).length,
      jobsWithJobId: jobIds.size,
      matchedJobs: matchedJobIds.size,
      unmatchedJobs: jobIds.size - matchedJobIds.size,
      matchedRows,
      jobsWithMultipleSoldEstimates: [...jobIds].filter((jobId) => (
        estimatesByJob.get(jobId) || []
      ).filter(isSoldEstimate).length > 1).length
    }
  };
}

function selectSoldEstimate(estimates) {
  return estimates
    .filter(isSoldEstimate)
    .sort((left, right) => {
      const subtotalDifference = decimalForSort(right.subtotal) - decimalForSort(left.subtotal);
      if (subtotalDifference) return subtotalDifference;
      return estimateTimestamp(right) - estimateTimestamp(left);
    })[0] || null;
}

function isSoldEstimate(estimate) {
  return statusName(estimate.status).toLowerCase() === "sold";
}

function estimateTimestamp(estimate) {
  return Date.parse(estimate.soldOn || estimate.modifiedOn || estimate.createdOn || 0) || 0;
}

function statusName(status) {
  if (isObject(status)) return value(status.name) || value(status.value);
  return value(status);
}

function decimalValue(input) {
  if (input === null || input === undefined || input === "") return "";
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : "";
}

function decimalForSort(input) {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function normalizeAttributedLeads(records, syncedAt = new Date().toISOString()) {
  const normalized = records.map((record) => normalizeAttributedLead(record, syncedAt));
  const byKey = new Map();

  for (const row of normalized) {
    const existing = byKey.get(row.recordKey);
    if (!existing || Date.parse(row.leadDate || 0) >= Date.parse(existing.leadDate || 0)) {
      byKey.set(row.recordKey, row);
    }
  }

  return [...byKey.values()];
}

function normalizeAttributedLead(record, syncedAt = new Date().toISOString()) {
  const attribution = object(record.attribution);
  const call = object(record.call);
  const booking = object(record.booking);
  const job = object(record.job);
  const leadForm = object(record.leadForm);
  const jobId = value(job.id) || value(attribution.overwrittenBookingJobId);
  const landingPageRaw = value(attribution.landingPageUrl);

  return {
    recordKey: buildRecordKey(record),
    leadDate: value(record.dateTime),
    leadType: value(record.leadType),
    classification: classifyLead({ callId: call.id, bookingId: booking.id, jobId, leadNumber: leadForm.leadNumber }),
    landingPage: normalizeUrl(landingPageRaw),
    landingPageRaw,
    campaign: value(attribution.utmCampaign) || value(attribution.originalCampaign),
    source: value(attribution.utmSource),
    medium: value(attribution.utmMedium),
    adGroupId: value(attribution.adGroupId),
    keywordId: value(attribution.keywordId),
    referrerUrl: normalizeUrl(attribution.referrerUrl),
    clickId: value(attribution.clickId),
    gbraid: value(attribution.gbraid),
    wbraid: value(attribution.wbraid),
    callId: value(call.id),
    bookingId: value(booking.id),
    jobId,
    leadFormNumber: value(leadForm.leadNumber),
    serviceTitanCampaignId: value(attribution.stCampaignId),
    originalCampaign: value(attribution.originalCampaign),
    jobStatus: "",
    estimateId: "",
    estimateStatus: "",
    estimateTotal: "",
    jobRevenue: "",
    lastSyncedAt: syncedAt
  };
}

function buildRecordKey(record) {
  const callId = value(record.call && record.call.id);
  const bookingId = value(record.booking && record.booking.id);
  const leadNumber = value(record.leadForm && record.leadForm.leadNumber);
  const jobId = value(record.job && record.job.id) || value(record.attribution && record.attribution.overwrittenBookingJobId);

  if (callId) return `call:${callId}`;
  if (bookingId) return `booking:${bookingId}`;
  if (leadNumber) return `lead-form:${leadNumber}`;
  if (jobId) return `job:${jobId}`;

  const identity = JSON.stringify({
    dateTime: value(record.dateTime),
    leadType: value(record.leadType),
    landingPage: value(record.attribution && record.attribution.landingPageUrl),
    campaign: value(record.attribution && record.attribution.utmCampaign),
    clickId: value(record.attribution && record.attribution.clickId)
  });
  return `fallback:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function classifyLead({ callId, bookingId, jobId, leadNumber }) {
  if (callId && bookingId) return "Phone call with booking";
  if (callId) return "Phone call";
  if (leadNumber) return "Lead form";
  if (jobId) return "Non-call job-linked lead";
  return "Attributed lead";
}

async function getAccessToken(environment) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.accessToken;
  }

  const response = await fetch(`${environment.authBaseUrl}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: requireEnv("SERVICETITAN_CLIENT_ID"),
      client_secret: requireEnv("SERVICETITAN_CLIENT_SECRET")
    })
  });
  const text = await response.text();

  if (!response.ok) {
    throw serviceTitanError("ServiceTitan token request failed", response, text, `${environment.authBaseUrl}/connect/token`);
  }

  const payload = parseJson(text);
  cachedToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 900) * 1000
  };
  return cachedToken.accessToken;
}

function fetchServiceTitan(url, accessToken, appKey) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ST-App-Key": appKey,
      Accept: "application/json"
    }
  });
}

function getEnvironment() {
  const name = String(process.env.SERVICETITAN_ENV || "").trim().toLowerCase();
  if (!ENVIRONMENTS[name]) {
    throw new Error("SERVICETITAN_ENV must be integration or production.");
  }
  return ENVIRONMENTS[name];
}

function requireEnv(name) {
  const result = String(process.env[name] || "").trim();
  if (!result) throw new Error(`Missing environment variable: ${name}`);
  return result;
}

function extractRecords(payload) {
  if (Array.isArray(payload)) return { rows: payload.filter(isObject), hasMore: false };
  if (!isObject(payload)) return { rows: [], hasMore: false };

  for (const key of ["data", "items", "results", "leads", "attributedLeads"]) {
    if (Array.isArray(payload[key])) {
      return {
        rows: payload[key].filter(isObject),
        hasMore: Boolean(payload.hasMore || payload.has_more)
      };
    }
  }
  return { rows: [payload], hasMore: false };
}

function normalizeUrl(input) {
  let raw = value(input);
  if (!raw) return "";
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/?#]|$)/i.test(raw)) raw = `https://${raw}`;

  try {
    const url = new URL(raw);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
    return `${url.origin}${path}`;
  } catch {
    return raw.split(/[?#]/, 1)[0].replace(/\/$/, "");
  }
}

function serviceTitanError(message, response, text, url) {
  const error = new Error(`${message} with status ${response.status}.`);
  error.statusCode = 502;
  error.diagnostics = {
    status: response.status,
    statusText: response.statusText,
    endpoint: redactTenant(url),
    response: sanitize(parseJson(text) || text)
  };
  return error;
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sanitize(input) {
  if (typeof input === "string") return input.slice(0, 2000);
  if (Array.isArray(input)) return input.slice(0, 10).map(sanitize);
  if (isObject(input)) {
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => [
      key,
      /secret|token|authorization|phone|email|address|name/i.test(key) ? "[redacted]" : sanitize(entry)
    ]));
  }
  return input;
}

function redactTenant(url) {
  return String(url).replace(/tenant\/[^/?]+/i, "tenant/[tenant]");
}

function object(input) {
  return isObject(input) ? input : {};
}

function isObject(input) {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function value(input) {
  return input === null || input === undefined ? "" : String(input).trim();
}

module.exports = {
  buildRecordKey,
  enrichAttributedLeads,
  fetchAttributedLeads,
  fetchEstimates,
  normalizeAttributedLead,
  normalizeAttributedLeads,
  normalizeUrl,
  selectSoldEstimate
};
