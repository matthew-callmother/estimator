const ANGI_RUN_HEADERS = [
  "Run_ID", "From_UTC", "To_UTC", "Angi_Bookings", "Fees_Parsed", "Angi_Jobs",
  "Sold_Estimates", "Invoices", "Bookings_With_Jobs", "Bookings_With_Invoices",
  "Jobs_With_Sold_By", "Call_Only_Attributions", "Worked_First_Visits",
  "First_Visits_With_Technicians", "Multi_Technician_First_Visits", "Completed_At"
];
const ANGI_ALLOWED_TABS = [
  "Angi_Live_Bookings", "Angi_Live_Jobs", "Angi_Live_Opportunities", "Angi_Live_Estimates", "Angi_Live_Invoices",
  "Angi_Live_Calls", "Angi_Live_Sync_Runs"
];
const ANGI_SPREADSHEET_ID = "1VRqenGE0QEvBEtfdl6GZZuKYJOl9TTkSjk14PSBV4wI";

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(30000)) throw new Error("Another Angi sync is still writing.");
    const payload = JSON.parse(event && event.postData ? event.postData.contents : "{}");
    const properties = PropertiesService.getScriptProperties();
    const expectedSecret = properties.getProperty("ANGI_SYNC_WEBHOOK_SECRET");
    if (!expectedSecret || payload.secret !== expectedSecret) throw new Error("Unauthorized Angi sync request.");
    if (payload.version !== 3) throw new Error("Unsupported Angi sync payload.");
    const spreadsheet = SpreadsheetApp.openById(ANGI_SPREADSHEET_ID);
    const bookings = requiredSection(payload.bookings, "Angi_Live_Bookings");
    const jobs = requiredSection(payload.jobs, "Angi_Live_Jobs");
    const opportunities = requiredSection(payload.opportunities, "Angi_Live_Opportunities");
    const estimates = requiredSection(payload.estimates, "Angi_Live_Estimates");
    const invoices = requiredSection(payload.invoices, "Angi_Live_Invoices");
    const calls = requiredSection(payload.calls, "Angi_Live_Calls");
    const run = payload.run;
    if (!run || run.sheetName !== "Angi_Live_Sync_Runs" || !Array.isArray(run.values)) {
      throw new Error("Missing Angi sync run.");
    }
    if (run.values.length !== ANGI_RUN_HEADERS.length) throw new Error("Invalid Angi sync run width.");
    const bookingSheet = ensureAngiSheet(spreadsheet, bookings.sheetName, bookings.headers);
    const jobSheet = ensureAngiSheet(spreadsheet, jobs.sheetName, jobs.headers);
    const opportunitySheet = ensureAngiSheet(spreadsheet, opportunities.sheetName, opportunities.headers);
    const estimateSheet = ensureAngiSheet(spreadsheet, estimates.sheetName, estimates.headers);
    const invoiceSheet = ensureAngiSheet(spreadsheet, invoices.sheetName, invoices.headers);
    const callSheet = ensureAngiSheet(spreadsheet, calls.sheetName, calls.headers);
    const runSheet = ensureAngiSheet(spreadsheet, run.sheetName, ANGI_RUN_HEADERS);
    const result = {
      bookings: upsertAngiRows(bookingSheet, bookings.headers, bookings.rows),
      jobs: upsertAngiRows(jobSheet, jobs.headers, jobs.rows),
      opportunities: upsertAngiRows(opportunitySheet, opportunities.headers, opportunities.rows),
      estimates: upsertAngiRows(estimateSheet, estimates.headers, estimates.rows),
      invoices: upsertAngiRows(invoiceSheet, invoices.headers, invoices.rows),
      calls: upsertAngiRows(callSheet, calls.headers, calls.rows)
    };
    runSheet.appendRow(run.values.map(safeCell));
    SpreadsheetApp.flush();
    return angiJson({ ok: true, result });
  } catch (error) {
    return angiJson({ ok: false, error: error && error.message || "Angi Sheet write failed." });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function requiredSection(section, name) {
  if (!section || section.sheetName !== name || !Array.isArray(section.headers)
    || !Array.isArray(section.rows) || !section.headers.length) {
    throw new Error(`Invalid ${name} section.`);
  }
  return section;
}

function ensureAngiSheet(spreadsheet, name, headers) {
  if (!ANGI_ALLOWED_TABS.includes(name)) throw new Error(`Angi sync cannot write ${name}.`);
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const current = sheet.getLastRow()
    ? sheet.getRange(1, 1, 1, headers.length).getValues()[0] : [];
  if (!current.some(Boolean)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#e9eef2");
  } else if (!angiRowsEqual(current, headers, headers.length)) {
    throw new Error(`${name} has unexpected headers. Refusing to overwrite it.`);
  }
  return sheet;
}

function upsertAngiRows(sheet, headers, incoming) {
  const width = headers.length;
  const current = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues() : [];
  const index = new Map();
  current.forEach((row, position) => {
    if (row[0]) index.set(String(row[0]), position);
  });
  const changed = [];
  let inserted = 0;
  let updated = 0;
  for (const incomingRow of incoming) {
    if (!Array.isArray(incomingRow) || incomingRow.length !== width || !incomingRow[0]) {
      throw new Error(`Invalid row for ${sheet.getName()}.`);
    }
    const row = incomingRow.map(safeCell);
    const key = String(row[0]);
    const position = index.get(key);
    if (position === undefined) {
      index.set(key, current.length);
      current.push(row);
      changed.push(current.length - 1);
      inserted += 1;
    } else if (!angiRowsEqual(current[position], row, width)) {
      current[position] = row;
      changed.push(position);
      updated += 1;
    }
  }
  if (current.length + 1 > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), current.length + 1 - sheet.getMaxRows());
  }
  changed.sort((a, b) => a - b);
  for (let cursor = 0; cursor < changed.length;) {
    const start = changed[cursor];
    let end = start;
    while (cursor + 1 < changed.length && changed[cursor + 1] === end + 1) {
      cursor += 1;
      end += 1;
    }
    sheet.getRange(start + 2, 1, end - start + 1, width)
      .setValues(current.slice(start, end + 1));
    cursor += 1;
  }
  return { inserted, updated, unchanged: incoming.length - inserted - updated };
}

function safeCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return value;
  const text = value.slice(0, 45000);
  return /^[=+@-]/.test(text) ? `'${text}` : text;
}

function angiRowsEqual(left, right, width) {
  for (let column = 0; column < width; column += 1) {
    if (String(left[column] ?? "") !== String(right[column] ?? "")) return false;
  }
  return true;
}

function angiJson(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

if (typeof module !== "undefined") {
  module.exports = { requiredSection, safeCell, upsertAngiRows };
}

