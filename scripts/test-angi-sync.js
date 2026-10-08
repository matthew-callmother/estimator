"use strict";

const assert = require("node:assert/strict");
const {
  BOOKING_HEADERS, CALL_HEADERS, buildAngiRows, isAngiBooking, parseBookingSummary
} = require("../lib/servicetitan-angi");
const { safeCell, upsertAngiRows } = require("../google-apps-script/angi-sync");

const summary = [
  "* Partner Job type: 40115 Water Heater - Repair or Service",
  "* Lead Fee: $71.87",
  "* Lead Id: 639225753"
].join("\n");
assert.deepEqual(parseBookingSummary(summary), {
  leadId: "639225753", leadFee: 71.87,
  partnerJobType: "40115 Water Heater - Repair or Service"
});
assert.equal(parseBookingSummary("* Lead Fee: unclear").leadFee, "");
assert.equal(parseBookingSummary("* Lead Fee: $0.00").leadFee, 0);

const booking = {
  id: 10, createdOn: "2026-10-01T12:00:00Z", status: "Booked",
  source: "LeadsIntegration#33", campaignId: 51241322, bookingProviderId: 51269737,
  summary, name: "Example Customer", address: { zip: "75062" }
};
assert.equal(isAngiBooking(booking), true);
assert.equal(isAngiBooking({ ...booking, bookingProviderId: 85648468 }), false);
const records = {
  bookings: [booking, { ...booking, id: 11, campaignId: 123 }],
  jobs: [{ id: 20, bookingId: 10, jobStatus: "Completed", summary: "Installed heater" }],
  invoices: [{ id: 30, job: { id: 20 }, subTotal: 1100, total: 1190, paidOn: "2026-10-02" }],
  estimates: [
    { id: 40, jobId: 20, status: { name: "Sold" }, subtotal: 1000 },
    { id: 41, jobId: 20, status: { name: "Sold" }, subtotal: 1050 },
    { id: 42, jobId: 20, status: { name: "Open" }, subtotal: 2000 }
  ],
  attributions: [
    { dateTime: "2026-10-01", call: { id: 50 }, job: { id: 20 }, attribution: { utmSource: "Angie's List" } },
    { dateTime: "2026-10-01", call: { id: 51 }, attribution: { utmCampaign: "Angi" } },
    { dateTime: "2026-10-01", call: { id: 52 }, attribution: { utmCampaign: "Google" } }
  ]
};
const result = buildAngiRows(records, "2026-10-08T00:00:00Z");
assert.equal(result.bookingRows.length, 1);
assert.equal(result.bookingRows[0].length, BOOKING_HEADERS.length);
assert.equal(result.bookingRows[0][5], 71.87);
assert.equal(result.bookingRows[0][19], 1050);
assert.equal(result.bookingRows[0][21], 1100);
assert.equal(result.bookingRows[0][22], 1190);
assert.equal(result.callRows.length, 2);
assert.equal(result.callRows[0].length, CALL_HEADERS.length);
assert.equal(result.callRows[0][5], true);
assert.equal(result.callRows[1][5], false);
assert.equal(result.stats.callOnlyAttributions, 1);
assert.equal(safeCell("=IMPORTXML(\"example\")"), "'=IMPORTXML(\"example\")");

const written = [];
const sheet = {
  getLastRow: () => 1,
  getMaxRows: () => 1000,
  getName: () => "Angi_API_Calls",
  getRange: (row, column, height, width) => ({
    setValues: (rows) => written.push({ row, column, height, width, rows })
  })
};
assert.deepEqual(upsertAngiRows(sheet, CALL_HEADERS, result.callRows), {
  inserted: 2, updated: 0, unchanged: 0
});
assert.equal(written.length, 1);
assert.equal(written[0].height, 2);
console.log("Angi parser and joins passed.");

