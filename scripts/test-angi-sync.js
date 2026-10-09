"use strict";

const assert = require("node:assert/strict");
const {
  BOOKING_HEADERS, JOB_HEADERS, OPPORTUNITY_HEADERS, ESTIMATE_HEADERS, INVOICE_HEADERS, CALL_HEADERS,
  buildAngiRows, isAngiBooking, parseBookingSummary
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
  bookings: [booking, { ...booking, id: 11, campaignId: 123 }, { ...booking, id: 12, jobId: 22 }],
  jobs: [
    { id: 20, bookingId: 10, jobStatus: "Completed", soldById: 900, summary: "Installed heater" },
    { id: 21, bookingId: 10, jobStatus: "Scheduled" },
    { id: 22, jobStatus: "Completed", soldById: 901 },
    { id: 23, bookingId: 11, jobStatus: "Completed" }
  ],
  appointments: [
    { id: 101, jobId: 20, start: "2026-10-01T13:00:00Z", status: "Canceled", active: true, unused: false },
    { id: 102, jobId: 20, start: "2026-10-01T15:00:00Z", status: "Done", active: true, unused: false },
    { id: 103, jobId: 20, start: "2026-10-02T15:00:00Z", status: "Done", active: true, unused: false },
    { id: 104, jobId: 21, start: "2026-10-01T18:00:00Z", status: "Done", active: true, unused: false },
    { id: 105, jobId: 22, start: "2026-10-01T16:00:00Z", status: "Done", active: true, unused: false }
  ],
  assignments: [
    { appointmentId: 101, jobId: 20, technicianId: 999, technicianName: "Canceled Tech", status: "Scheduled", active: true },
    { appointmentId: 102, jobId: 20, technicianId: 900, technicianName: "First Tech", status: "Done", active: true },
    { appointmentId: 102, jobId: 20, technicianId: 901, technicianName: "Second Tech", status: "Done", active: true },
    { appointmentId: 103, jobId: 20, technicianId: 902, technicianName: "Installer", status: "Done", active: true },
    { appointmentId: 105, jobId: 22, technicianId: 903, technicianName: "Third Tech", status: "Done", active: true }
  ],
  invoices: [
    { id: 30, job: { id: 20 }, subTotal: 1100, total: 1190, paidOn: "2026-10-02" },
    { id: 31, jobId: 21, subTotal: 400, total: 450 },
    { id: 32, jobId: 23, subTotal: 100, total: 100 }
  ],
  estimates: [
    { id: 40, jobId: 20, status: { name: "Sold" }, subtotal: 1000, soldBy: 900 },
    { id: 41, jobId: 20, status: { name: "Sold" }, subtotal: 1050, soldBy: 902 },
    { id: 42, jobId: 20, status: { name: "Open" }, subtotal: 2000 }
  ],
  attributions: [
    { dateTime: "2026-10-01", call: { id: 50 }, job: { id: 20 }, attribution: { utmSource: "Angie's List" } },
    { dateTime: "2026-10-01", call: { id: 51 }, attribution: { utmCampaign: "Angi" } },
    { dateTime: "2026-10-01", call: { id: 52 }, attribution: { utmCampaign: "Google" } }
  ]
};
const result = buildAngiRows(records, "2026-10-08T00:00:00Z");
assert.equal(result.bookingRows.length, 2);
assert.equal(result.bookingRows[0].length, BOOKING_HEADERS.length);
assert.equal(result.bookingRows[0][6], 71.87);
assert.equal(result.jobRows.length, 3);
assert.equal(result.jobRows[0].length, JOB_HEADERS.length);
assert.equal(result.jobRows[0][2], 10);
assert.equal(result.jobRows[0][10], 41);
assert.equal(result.jobRows[0][12], "900");
assert.equal(result.jobRows[0][13], "job_sold_by");
assert.equal(result.jobRows[0][14], true);
assert.equal(result.jobRows[0][15], 1050);
assert.equal(result.jobRows[1][13], "unresolved");
assert.equal(result.jobRows[2][2], 12);
assert.equal(result.opportunityRows.length, 2);
assert.equal(result.opportunityRows[0].length, OPPORTUNITY_HEADERS.length);
assert.equal(result.opportunityRows[0][6], 102);
assert.equal(result.opportunityRows[0][9], true);
assert.equal(result.opportunityRows[0][10], "multiple_technicians");
assert.equal(result.opportunityRows[0][11], 2);
assert.deepEqual(JSON.parse(result.opportunityRows[0][12]), ["900", "901"]);
assert.equal(result.opportunityRows[0][14], "");
assert.equal(result.opportunityRows[0][16], true);
assert.equal(result.opportunityRows[0][17], 41);
assert.equal(result.opportunityRows[1][14], "903");
assert.equal(result.opportunityRows[1][16], false);
assert.equal(result.estimateRows.length, 2);
assert.equal(result.estimateRows[0].length, ESTIMATE_HEADERS.length);
assert.equal(result.estimateRows[0][8], false);
assert.equal(result.estimateRows[1][8], true);
assert.equal(result.invoiceRows.length, 2);
assert.equal(result.invoiceRows[0].length, INVOICE_HEADERS.length);
assert.equal(result.invoiceRows[0][7], 1100);
assert.equal(result.invoiceRows[0][8], 1190);
assert.equal(result.invoiceRows[1][3], 10);
assert.equal(result.callRows.length, 2);
assert.equal(result.callRows[0].length, CALL_HEADERS.length);
assert.equal(result.callRows[0][5], true);
assert.equal(result.callRows[1][5], false);
assert.equal(result.stats.callOnlyAttributions, 1);
assert.equal(result.stats.bookingsWithJobs, 2);
assert.equal(result.stats.bookingsWithInvoices, 1);
assert.equal(result.stats.jobsWithSoldBy, 2);
assert.equal(result.stats.jobsWithSoldEstimate, 1);
assert.equal(result.stats.soldJobsWithSoldBy, 1);
assert.equal(result.stats.soldJobsWithJobSoldBy, 1);
assert.equal(result.stats.soldJobsWithEstimateSoldBy, 1);
assert.equal(result.stats.soldByConflicts, 1);
assert.equal(result.stats.distinctSoldByIds, 2);
assert.equal(result.stats.linkedBookingsWithoutAppointments, 0);
assert.equal(result.stats.linkedBookingsWithUnworkedAppointments, 0);
assert.deepEqual(result.stats.linkedAppointmentStatuses, { canceled: 1, done: 4 });
assert.deepEqual(result.stats.unworkedLinkedAppointmentStatuses, {});
assert.equal(result.stats.workedFirstVisits, 2);
assert.equal(result.stats.firstVisitsWithTechnicians, 2);
assert.equal(result.stats.firstVisitsWithTechnicianNames, 2);
assert.equal(result.stats.distinctFirstVisitTechnicians, 3);
assert.equal(result.stats.multiTechnicianFirstVisits, 1);
assert.equal(result.stats.maxFirstVisitTechnicians, 2);
assert.equal(result.stats.workedFirstVisitsWithSoldEstimates, 1);
const fallback = buildAngiRows({
  bookings: [booking], jobs: [{ id: 20, bookingId: 10 }], invoices: [],
  estimates: [{ id: 40, jobId: 20, status: "Sold", subtotal: 0, soldBy: 903 }], attributions: [],
  appointments: [{ id: 106, jobId: 20, start: "2026-10-01T15:00:00Z", status: "Done" }],
  assignments: [{ appointmentId: 106, jobId: 20, technicianId: 903, status: "Scheduled" }]
}, "2026-10-08T00:00:00Z");
assert.equal(fallback.jobRows[0][12], "903");
assert.equal(fallback.jobRows[0][13], "estimate_sold_by");
assert.equal(fallback.jobRows[0][14], false);
assert.equal(fallback.estimateRows[0][7], 0);
assert.equal(fallback.opportunityRows[0][9], true);
assert.equal(fallback.opportunityRows[0][10], "no_worked_assignment");
assert.equal(fallback.opportunityRows[0][16], true);
const missingAmount = buildAngiRows({
  bookings: [booking], jobs: [{ id: 20, bookingId: 10 }],
  invoices: [{ id: 30, jobId: 20, total: null }],
  estimates: [{ id: 40, jobId: 20, status: "Sold", subtotal: "not a number" }],
  attributions: []
}, "2026-10-08T00:00:00Z");
assert.equal(missingAmount.jobRows[0][15], "");
assert.equal(missingAmount.invoiceRows[0][8], "");
assert.equal(missingAmount.opportunityRows[0][10], "no_worked_appointment");
assert.equal(missingAmount.stats.linkedBookingsWithoutAppointments, 1);
const unworked = buildAngiRows({
  bookings: [booking], jobs: [{ id: 20, bookingId: 10 }], invoices: [], estimates: [], attributions: [],
  appointments: [
    { id: 101, jobId: 20, start: "2026-10-01T13:00:00Z", status: "Canceled" },
    { id: 102, jobId: 20, start: "2026-10-09T13:00:00Z", status: "Scheduled" }
  ],
  assignments: [{ appointmentId: 101, jobId: 20, technicianId: 900, status: "Scheduled" }]
}, "2026-10-08T00:00:00Z");
assert.equal(unworked.opportunityRows[0][9], false);
assert.equal(unworked.stats.linkedBookingsWithUnworkedAppointments, 1);
assert.deepEqual(unworked.stats.unworkedLinkedAppointmentStatuses, { canceled: 1, scheduled: 1 });
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

