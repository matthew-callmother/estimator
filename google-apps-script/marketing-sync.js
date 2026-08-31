const ATTRIBUTION_WIDTH_WITHOUT_SYNC_TIME = 26;

function doPost(event) {
  const lock = LockService.getScriptLock();

  try {
    if (!lock.tryLock(30000)) {
      return jsonResponse({ ok: false, retryable: true, error: "Another sync is still writing." });
    }

    const payload = JSON.parse(event && event.postData ? event.postData.contents : "{}");
    const properties = PropertiesService.getScriptProperties();
    const expectedSecret = properties.getProperty("MARKETING_SYNC_WEBHOOK_SECRET");
    const spreadsheetId = properties.getProperty("MARKETING_SYNC_SPREADSHEET_ID");

    if (!expectedSecret || payload.secret !== expectedSecret) {
      return jsonResponse({ ok: false, retryable: false, error: "Unauthorized sync request." });
    }
    if (!spreadsheetId) {
      return jsonResponse({ ok: false, retryable: false, error: "Missing MARKETING_SYNC_SPREADSHEET_ID script property." });
    }
    if (payload.version !== 1) {
      return jsonResponse({ ok: false, retryable: false, error: "Unsupported payload version." });
    }

    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const attribution = requireSection(payload.attribution, "attribution");
    const syncRun = requireSection(payload.syncRun, "syncRun");
    const sheet = ensureSheet(spreadsheet, attribution.sheetName, attribution.headers);
    const result = upsertRows(sheet, attribution.headers, attribution.rows);
    if (!Array.isArray(syncRun.values)) throw new Error("Missing sync run values.");
    const runsSheet = ensureSheet(spreadsheet, syncRun.sheetName, syncRun.headers);
    const runValues = normalizeRow(syncRun.values, syncRun.headers.length);
    runValues[8] = result.inserted;
    runValues[9] = result.updated;
    runValues[10] = result.unchanged;
    runsSheet.appendRow(runValues);
    SpreadsheetApp.flush();

    return jsonResponse({ ok: true, result });
  } catch (error) {
    return jsonResponse({
      ok: false,
      retryable: true,
      error: error && error.message ? error.message : "Apps Script Sheet write failed."
    });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function requireSection(section, name) {
  if (!section || !Array.isArray(section.headers)) throw new Error(`Missing ${name} section.`);
  return section;
}

function ensureSheet(spreadsheet, name, headers) {
  if (!name || !headers.length) throw new Error("Sheet name and headers are required.");
  let sheet = spreadsheet.getSheetByName(name);

  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const width = headers.length;
  const existing = sheet.getLastRow()
    ? sheet.getRange(1, 1, 1, width).getValues()[0]
    : [];

  if (!existing.some(Boolean)) {
    sheet.getRange(1, 1, 1, width).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, width).setFontWeight("bold").setBackground("#ebebef").setWrap(true);
    if (!sheet.getFilter()) sheet.getRange(1, 1, 1, width).createFilter();
  } else if (!rowsEqual(existing, headers, width)) {
    throw new Error(`Sheet ${name} has an unexpected header row. Refusing to overwrite it.`);
  }

  return sheet;
}

function upsertRows(sheet, headers, incomingRows) {
  if (!Array.isArray(incomingRows)) throw new Error("Attribution rows must be an array.");
  const width = headers.length;
  const current = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues()
    : [];
  const rowIndexByKey = new Map();
  current.forEach((row, index) => {
    const key = String(row[0] || "").trim();
    if (key) rowIndexByKey.set(key, index);
  });
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  incomingRows.forEach((incoming) => {
    const row = normalizeRow(incoming, width);
    const key = String(row[0] || "").trim();
    if (!key) throw new Error("Every attribution row requires a record key.");
    const index = rowIndexByKey.get(key);

    if (index === undefined) {
      rowIndexByKey.set(key, current.length);
      current.push(row);
      inserted += 1;
    } else if (!rowsEqual(current[index], row, Math.min(ATTRIBUTION_WIDTH_WITHOUT_SYNC_TIME, width))) {
      current[index] = row;
      updated += 1;
    } else {
      unchanged += 1;
    }
  });

  if (current.length) sheet.getRange(2, 1, current.length, width).setValues(current);
  return { inserted, updated, unchanged };
}

function normalizeRow(row, width) {
  const normalized = Array.isArray(row) ? row.slice(0, width) : [];
  while (normalized.length < width) normalized.push("");
  return normalized.map((value) => value === null || value === undefined ? "" : value);
}

function rowsEqual(left, right, width) {
  for (let index = 0; index < width; index += 1) {
    if (String(left[index] || "") !== String(right[index] || "")) return false;
  }
  return true;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

if (typeof module !== "undefined") {
  module.exports = { doPost, normalizeRow, rowsEqual, upsertRows };
}
