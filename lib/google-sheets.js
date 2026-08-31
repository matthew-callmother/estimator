"use strict";

const { createSign } = require("node:crypto");

const SHEETS_API = "https://sheets.googleapis.com/v4";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const ATTRIBUTION_HEADERS = [
  "Record Key",
  "Lead Date",
  "Lead Type",
  "Classification",
  "Landing Page",
  "Referrer URL",
  "Landing Page Raw",
  "Campaign",
  "Source",
  "Medium",
  "Ad Group ID",
  "Keyword ID",
  "Click ID",
  "GBRAID",
  "WBRAID",
  "Call ID",
  "Booking ID",
  "Job ID",
  "Lead Form Number",
  "ServiceTitan Campaign ID",
  "Original Campaign",
  "Job Status",
  "Estimate ID",
  "Estimate Status",
  "Estimate Subtotal",
  "Job Revenue",
  "Last Synced At"
];

const SYNC_HEADERS = [
  "Run ID",
  "Started At",
  "Completed At",
  "Status",
  "From UTC",
  "To UTC",
  "Fetched",
  "Unique Records",
  "Inserted",
  "Updated",
  "Unchanged"
];

let cachedToken = null;

async function upsertAttributionRows(rows, run) {
  const spreadsheetId = requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const attributionSheet = process.env.MARKETING_SYNC_SHEET_NAME || "Attributed Leads";
  const runsSheet = process.env.MARKETING_SYNC_RUNS_SHEET_NAME || "Sync Runs";
  await ensureSheets(spreadsheetId, [
    { title: attributionSheet, headers: ATTRIBUTION_HEADERS },
    { title: runsSheet, headers: SYNC_HEADERS }
  ]);

  const existing = await getValues(spreadsheetId, `${quoteSheet(attributionSheet)}!A1:AA`);
  verifyHeaders(existing[0] || [], ATTRIBUTION_HEADERS, attributionSheet);
  const existingByKey = new Map();

  for (let index = 1; index < existing.length; index += 1) {
    const key = String(existing[index][0] || "").trim();
    if (key) existingByKey.set(key, { rowNumber: index + 1, values: existing[index] });
  }

  const updates = [];
  const inserts = [];
  let unchanged = 0;

  for (const row of rows) {
    const values = rowValues(row);
    const found = existingByKey.get(row.recordKey);
    if (!found) {
      inserts.push(values);
    } else if (!rowsEqual(found.values, values)) {
      updates.push({
        range: `${quoteSheet(attributionSheet)}!A${found.rowNumber}:AA${found.rowNumber}`,
        values: [values]
      });
    } else {
      unchanged += 1;
    }
  }

  for (const chunk of chunks(updates, 250)) {
    await sheetsRequest(`${SHEETS_API}/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: "POST",
      body: { valueInputOption: "RAW", data: chunk }
    });
  }

  for (const chunk of chunks(inserts, 500)) {
    await sheetsRequest(
      `${SHEETS_API}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${quoteSheet(attributionSheet)}!A:AA`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: { values: chunk } }
    );
  }

  const result = { inserted: inserts.length, updated: updates.length, unchanged };
  await appendSyncRun(spreadsheetId, runsSheet, { ...run, ...result });
  return result;
}

async function appendSyncRun(spreadsheetId, sheetName, run) {
  const values = [syncRowValues(run)];
  await sheetsRequest(
    `${SHEETS_API}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${quoteSheet(sheetName)}!A:K`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values } }
  );
}

async function ensureSheets(spreadsheetId, definitions) {
  const metadata = await sheetsRequest(`${SHEETS_API}/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
  const existing = new Map(metadata.sheets.map((sheet) => [sheet.properties.title, sheet.properties]));
  const requests = [];

  for (const definition of definitions) {
    if (!existing.has(definition.title)) {
      requests.push({
        addSheet: {
          properties: {
            title: definition.title,
            gridProperties: { rowCount: 1000, columnCount: Math.max(26, definition.headers.length), frozenRowCount: 1 }
          }
        }
      });
    }
  }

  if (requests.length) {
    await sheetsRequest(`${SHEETS_API}/spreadsheets/${spreadsheetId}:batchUpdate`, { method: "POST", body: { requests } });
  }

  const refreshed = requests.length
    ? await sheetsRequest(`${SHEETS_API}/spreadsheets/${spreadsheetId}?fields=sheets.properties`)
    : metadata;
  const properties = new Map(refreshed.sheets.map((sheet) => [sheet.properties.title, sheet.properties]));

  for (const definition of definitions) {
    const current = await getValues(spreadsheetId, `${quoteSheet(definition.title)}!1:1`);
    if (!current.length || !current[0].some(Boolean)) {
      await updateValues(spreadsheetId, `${quoteSheet(definition.title)}!A1`, [definition.headers]);
      await formatHeader(spreadsheetId, properties.get(definition.title).sheetId, definition.headers.length);
    } else {
      verifyHeaders(current[0], definition.headers, definition.title);
    }
  }
}

async function formatHeader(spreadsheetId, sheetId, columnCount) {
  await sheetsRequest(`${SHEETS_API}/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount"
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.92, green: 0.92, blue: 0.94 },
                textFormat: { bold: true },
                wrapStrategy: "WRAP"
              }
            },
            fields: "userEnteredFormat"
          }
        },
        {
          setBasicFilter: {
            filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: columnCount } }
          }
        }
      ]
    }
  });
}

async function getValues(spreadsheetId, range) {
  const payload = await sheetsRequest(
    `${SHEETS_API}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`
  );
  return payload.values || [];
}

async function updateValues(spreadsheetId, range, values) {
  return sheetsRequest(
    `${SHEETS_API}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: "PUT", body: { values } }
  );
}

async function sheetsRequest(url, options = {}) {
  const token = await getGoogleAccessToken();
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();

  if (!response.ok) {
    const error = new Error(`Google Sheets request failed with status ${response.status}.`);
    error.statusCode = 502;
    error.diagnostics = {
      status: response.status,
      statusText: response.statusText,
      response: safeJson(text)
    };
    throw error;
  }
  return safeJson(text);
}

async function getGoogleAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.accessToken;

  const email = requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = normalizePrivateKey(requireEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"));
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({
    iss: email,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600
  });
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const text = await response.text();

  if (!response.ok) {
    const error = new Error(`Google service-account token request failed with status ${response.status}.`);
    error.statusCode = 502;
    error.diagnostics = { status: response.status, statusText: response.statusText, response: safeJson(text) };
    throw error;
  }

  const payload = safeJson(text);
  cachedToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000
  };
  return cachedToken.accessToken;
}

function rowValues(row) {
  return [
    row.recordKey,
    row.leadDate,
    row.leadType,
    row.classification,
    row.landingPage,
    row.referrerUrl,
    row.landingPageRaw,
    row.campaign,
    row.source,
    row.medium,
    row.adGroupId,
    row.keywordId,
    row.clickId,
    row.gbraid,
    row.wbraid,
    row.callId,
    row.bookingId,
    row.jobId,
    row.leadFormNumber,
    row.serviceTitanCampaignId,
    row.originalCampaign,
    row.jobStatus,
    row.estimateId,
    row.estimateStatus,
    row.estimateTotal,
    row.jobRevenue,
    row.lastSyncedAt
  ].map((entry) => entry === null || entry === undefined ? "" : entry);
}

function syncRowValues(run) {
  return [
    run.runId,
    run.startedAt,
    run.completedAt,
    run.status,
    run.fromUtc,
    run.toUtc,
    run.fetched,
    run.uniqueRecords,
    run.inserted,
    run.updated,
    run.unchanged
  ].map((entry) => entry === null || entry === undefined ? "" : entry);
}

function rowsEqual(existing, next) {
  const width = ATTRIBUTION_HEADERS.length - 1;
  for (let index = 0; index < width; index += 1) {
    if (String(existing[index] || "") !== String(next[index] || "")) return false;
  }
  return true;
}

function verifyHeaders(actual, expected, sheetName) {
  const normalized = actual.slice(0, expected.length).map((entry) => String(entry || "").trim());
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error(`Sheet ${sheetName} has an unexpected header row. Refusing to overwrite it.`);
  }
}

function normalizePrivateKey(input) {
  return input.replace(/^['"]|['"]$/g, "").replace(/\\n/g, "\n");
}

function encode(input) {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function quoteSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function chunks(input, size) {
  const output = [];
  for (let index = 0; index < input.length; index += size) output.push(input.slice(index, index + size));
  return output;
}

function safeJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: String(text).slice(0, 2000) };
  }
}

function requireEnv(name) {
  const result = String(process.env[name] || "").trim();
  if (!result) throw new Error(`Missing environment variable: ${name}`);
  return result;
}

module.exports = {
  ATTRIBUTION_HEADERS,
  SYNC_HEADERS,
  rowValues,
  syncRowValues,
  upsertAttributionRows
};
