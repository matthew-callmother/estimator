"use strict";

const ANGI_CAMPAIGN_ID = "51241322";
const ANGI_PROVIDER_ID = "51269737";
const ANGI_SOURCE = "LeadsIntegration#33";

const BOOKING_HEADERS = [
  "Record_Key", "Booking_ID", "Booking_Date", "Booking_Modified_At", "Booking_Status", "Angi_Lead_ID",
  "Actual_Lead_Fee", "Partner_Job_Type", "Customer_Name", "Street", "City", "State", "ZIP",
  "Booking_Source", "Campaign_ID", "Provider_ID", "Booking_Summary", "Last_Synced_At"
];
const JOB_HEADERS = [
  "Record_Key", "Job_ID", "Booking_ID", "Job_Created_At", "Job_Modified_At", "Job_Status",
  "Customer_ID", "Location_ID", "Job_Type_ID", "ST_Job_Sold_By_ID", "Primary_Estimate_ID",
  "Primary_Estimate_Sold_By_ID", "Seller_ID", "Seller_Source", "Seller_Conflict",
  "Primary_Sold_Estimate_Subtotal", "Completed_On", "Job_Summary", "Last_Synced_At"
];
const ESTIMATE_HEADERS = [
  "Record_Key", "Estimate_ID", "Job_ID", "Booking_ID", "Estimate_Status", "Sold_On",
  "Sold_By_ID", "Subtotal", "Is_Primary_For_Job", "Is_Change_Order", "Estimate_Summary", "Last_Synced_At"
];
const INVOICE_HEADERS = [
  "Record_Key", "Invoice_ID", "Job_ID", "Booking_ID", "Invoice_Created_At",
  "Invoice_Modified_At", "Invoice_Status", "Invoice_Subtotal", "Invoice_Total",
  "Invoice_Paid_On", "Invoice_Summary", "Last_Synced_At"
];
const CALL_HEADERS = [
  "Record_Key", "Lead_Date", "Call_ID", "Booking_ID", "Job_ID", "Is_Booking_Linked", "Source",
  "Campaign", "ST_Campaign_ID", "Landing_Page", "Last_Synced_At"
];

function parseBookingSummary(summary) {
  const lines = String(summary || "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/\\n/g, "\n").split(/\r?\n/);
  const field = (label) => {
    const line = lines.find((entry) => new RegExp(`^\\s*\\*?\\s*${label}\\s*:`, "i").test(entry));
    return line ? line.replace(new RegExp(`^\\s*\\*?\\s*${label}\\s*:\\s*`, "i"), "").trim() : "";
  };
  const feeText = field("Lead Fee");
  const fee = /^\$?\s*\d[\d,]*(?:\.\d{1,2})?$/.test(feeText)
    ? Number(feeText.replace(/[$,\s]/g, "")) : "";
  return {
    leadId: field("Lead Id"),
    leadFee: fee,
    partnerJobType: field("Partner Job type")
  };
}

function isAngiBooking(booking) {
  return String(booking.campaignId || "") === ANGI_CAMPAIGN_ID
    && String(booking.bookingProviderId || "") === ANGI_PROVIDER_ID
    && String(booking.source || "") === ANGI_SOURCE;
}

function isAngiAttribution(record) {
  const attribution = record.attribution || {};
  return String(attribution.stCampaignId || "") === ANGI_CAMPAIGN_ID
    || /^(angi|angie's list|angis list)$/i.test(String(attribution.utmSource || "").trim())
    || /^angi$/i.test(String(attribution.utmCampaign || attribution.originalCampaign || "").trim());
}

function buildAngiRows({ bookings, jobs, invoices, estimates, attributions }, syncedAt) {
  const angiBookings = bookings.filter(isAngiBooking);
  const bookingById = new Map(angiBookings.map((booking) => [String(booking.id), booking]));
  const bookingByJobId = new Map(angiBookings.filter((booking) => booking.jobId)
    .map((booking) => [String(booking.jobId), booking]));
  const bookingForJob = (job) => bookingById.get(String(job.bookingId || ""))
    || bookingByJobId.get(String(job.id));
  const angiJobs = jobs.filter((job) => bookingForJob(job));
  const jobsByBooking = groupBy(angiJobs, (job) => bookingForJob(job).id);
  const angiJobIds = new Set(angiJobs.map((job) => String(job.id)));
  const invoicesByJob = groupBy(invoices, (invoice) => invoice.job && invoice.job.id || invoice.jobId);
  const soldByJob = groupBy(estimates.filter((estimate) => status(estimate.status) === "sold"), (estimate) => estimate.jobId);
  const primaryByJob = new Map(angiJobs.map((job) => [String(job.id),
    (soldByJob.get(String(job.id)) || []).slice()
      .sort((a, b) => money(b.subtotal) - money(a.subtotal) || String(a.id).localeCompare(String(b.id)))[0]
  ]));
  const bookingRows = angiBookings.map((booking) => {
    const parsed = parseBookingSummary(booking.summary);
    const address = booking.address || {};
    return [
      `booking:${booking.id}`, booking.id, booking.createdOn || "", booking.modifiedOn || "",
      status(booking.status), parsed.leadId,
      parsed.leadFee, parsed.partnerJobType, booking.name || "", address.street || "",
      address.city || "", address.state || "", address.zip || "", booking.source || "",
      booking.campaignId || "", booking.bookingProviderId || "", booking.summary || "", syncedAt
    ];
  });
  const jobRows = angiJobs.map((job) => {
    const primary = primaryByJob.get(String(job.id));
    const jobSeller = identifier(job.soldById);
    const estimateSeller = identifier(primary && primary.soldBy);
    return [
      `job:${job.id}`, job.id, bookingForJob(job).id, job.createdOn || "", job.modifiedOn || "",
      status(job.jobStatus), job.customerId || "", job.locationId || "", job.jobTypeId || "",
      jobSeller, primary && primary.id || "", estimateSeller, jobSeller || estimateSeller,
      jobSeller ? "job_sold_by" : estimateSeller ? "estimate_sold_by" : "unresolved",
      Boolean(jobSeller && estimateSeller && jobSeller !== estimateSeller),
      primary ? amountOrBlank(primary.subtotal) : "", job.completedOn || "", job.summary || "", syncedAt
    ];
  });
  const estimateRows = angiJobs.flatMap((job) => (soldByJob.get(String(job.id)) || []).map((estimate) => [
    `estimate:${estimate.id}`, estimate.id, job.id, bookingForJob(job).id, status(estimate.status),
    estimate.soldOn || "", identifier(estimate.soldBy), amountOrBlank(estimate.subtotal),
    String(estimate.id) === String(primaryByJob.get(String(job.id)).id),
    estimate.isChangeOrder === true, estimate.summary || "", syncedAt
  ]));
  const invoiceRows = angiJobs.flatMap((job) => (invoicesByJob.get(String(job.id)) || []).map((invoice) => [
    `invoice:${invoice.id}`, invoice.id, job.id, bookingForJob(job).id, invoice.createdOn || "",
    invoice.modifiedOn || "", status(invoice.status), amountOrBlank(invoice.subTotal),
    amountOrBlank(invoice.total),
    invoice.paidOn || "", invoice.summary || "", syncedAt
  ]));
  const callRows = attributions.filter(isAngiAttribution)
    .filter((record) => record.call && record.call.id)
    .map((record) => {
      const attribution = record.attribution || {};
      const linked = Boolean((record.booking && bookingById.has(String(record.booking.id)))
        || (record.job && angiJobIds.has(String(record.job.id))));
      return [
        `call:${record.call.id}`, record.dateTime || "", record.call.id,
        record.booking && record.booking.id || "", record.job && record.job.id || "",
        linked, attribution.utmSource || "", attribution.utmCampaign || attribution.originalCampaign || "",
        attribution.stCampaignId || "", attribution.landingPageUrl || "", syncedAt
      ];
    });
  return {
    bookingRows: uniqueRows(bookingRows),
    jobRows: uniqueRows(jobRows),
    estimateRows: uniqueRows(estimateRows),
    invoiceRows: uniqueRows(invoiceRows),
    callRows: uniqueRows(callRows),
    stats: {
      bookingsFetched: bookings.length, angiBookings: angiBookings.length,
      feesParsed: bookingRows.filter((row) => row[6] !== "").length,
      angiJobs: jobRows.length, soldEstimates: estimateRows.length, invoices: invoiceRows.length,
      bookingsWithJobs: angiBookings.filter((booking) => jobsByBooking.has(String(booking.id))).length,
      bookingsWithInvoices: angiBookings.filter((booking) =>
        (jobsByBooking.get(String(booking.id)) || []).some((job) => invoicesByJob.has(String(job.id)))).length,
      jobsWithSeller: jobRows.filter((row) => row[12]).length,
      callOnlyAttributions: callRows.filter((row) => row[5] === false).length
    }
  };
}

function groupBy(rows, select) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(select(row) || "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function uniqueRows(rows) {
  return [...new Map(rows.map((row) => [row[0], row])).values()];
}

function status(input) {
  return String(input && typeof input === "object" ? input.name || input.value || "" : input || "").toLowerCase();
}

function identifier(input) {
  return String(input && typeof input === "object" ? input.id || "" : input || "");
}

function money(input) {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

function amountOrBlank(input) {
  if (input === null || input === undefined || input === "") return "";
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : "";
}

async function fetchAngiData({ fromUtc, toUtc, pageSize = 100, maxPages = 50 }) {
  const environment = process.env.SERVICETITAN_ENV === "integration" ? "-integration" : "";
  const tokenResponse = await fetch(`https://auth${environment}.servicetitan.io/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: requireEnv("SERVICETITAN_CLIENT_ID"),
      client_secret: requireEnv("SERVICETITAN_CLIENT_SECRET")
    })
  });
  if (!tokenResponse.ok) throw new Error(`ServiceTitan authentication failed (${tokenResponse.status}).`);
  const { access_token: token } = await tokenResponse.json();
  const base = `https://api${environment}.servicetitan.io`;
  const tenant = encodeURIComponent(requireEnv("SERVICETITAN_TENANT_ID"));
  const appKey = requireEnv("SERVICETITAN_APP_KEY");
  const endpoints = {
    bookings: [`${base}/crm/v2/tenant/${tenant}/bookings`, { createdOnOrAfter: fromUtc, createdBefore: toUtc }],
    jobs: [`${base}/jpm/v2/tenant/${tenant}/jobs`, { createdOnOrAfter: fromUtc, createdBefore: toUtc }],
    invoices: [`${base}/accounting/v2/tenant/${tenant}/invoices`, { createdOnOrAfter: fromUtc, createdBefore: toUtc }],
    estimates: [`${base}/sales/v2/tenant/${tenant}/estimates`, { createdOnOrAfter: fromUtc, createdBefore: toUtc, status: "Sold", active: "Any" }],
    attributions: [`${base}/marketingads/v2/tenant/${tenant}/attributed-leads`, { fromUtc, toUtc }]
  };
  const entries = await Promise.all(Object.entries(endpoints).map(async ([name, [url, filters]]) => {
    const rows = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const params = new URLSearchParams({ ...filters, page: String(page), pageSize: String(pageSize) });
      const response = await fetch(`${url}?${params}`, {
        headers: { Authorization: `Bearer ${token}`, "ST-App-Key": appKey, Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`ServiceTitan ${name} request failed (${response.status}).`);
      const payload = await response.json();
      const batch = Array.isArray(payload.data) ? payload.data : [];
      rows.push(...batch);
      const more = payload.hasMore === true || (payload.hasMore == null && batch.length === pageSize);
      if (!more) return [name, rows];
    }
    throw new Error(`ServiceTitan ${name} exceeded ${maxPages} pages; refusing a partial sync.`);
  }));
  return Object.fromEntries(entries);
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

module.exports = {
  BOOKING_HEADERS, JOB_HEADERS, ESTIMATE_HEADERS, INVOICE_HEADERS, CALL_HEADERS,
  buildAngiRows, fetchAngiData, isAngiBooking, parseBookingSummary
};

