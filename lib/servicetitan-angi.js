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
  "Primary_Estimate_Sold_By_ID", "Sold_By_ID", "Sold_By_Source", "Sold_By_Conflict",
  "Primary_Sold_Estimate_Subtotal", "Completed_On", "Job_Summary", "Last_Synced_At"
];
const OPPORTUNITY_HEADERS = [
  "Record_Key", "Booking_ID", "Angi_Lead_ID", "Booking_Date", "Booking_Status",
  "First_Visit_Job_ID", "First_Visit_Appointment_ID", "First_Visit_Start",
  "First_Visit_Status", "Is_Ran", "Attribution_Status", "First_Visit_Technician_Count",
  "First_Visit_Technician_IDs_JSON", "First_Visit_Technician_Names_JSON",
  "Single_Technician_ID", "Single_Technician_Name", "Has_Sold_Estimate",
  "Primary_Sold_Estimate_ID", "Primary_Sold_Estimate_Subtotal", "Primary_Sold_On",
  "Linked_Job_Count", "Actual_Lead_Fee", "Partner_Job_Type", "Last_Synced_At"
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
      || field("Lead Description").replace(/^(?:null|standard)\s*-\s*/i, "")
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

function buildAngiRows({ bookings, jobs, invoices, estimates, attributions, appointments = [], assignments = [] }, syncedAt) {
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
  const appointmentsByJob = groupBy(appointments, (appointment) => appointment.jobId);
  const assignmentsByAppointment = groupBy(assignments, (assignment) => assignment.appointmentId);
  const appointmentsByBooking = new Map(angiBookings.map((booking) => [String(booking.id),
    (jobsByBooking.get(String(booking.id)) || [])
      .flatMap((job) => appointmentsByJob.get(String(job.id)) || [])
  ]));
  const angiAppointments = [...appointmentsByBooking.values()].flat();
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
  const opportunityRows = angiBookings.map((booking) => {
    const linkedJobs = jobsByBooking.get(String(booking.id)) || [];
    const firstVisit = (appointmentsByBooking.get(String(booking.id)) || [])
      .filter((appointment) => isWorkedAppointment(appointment, syncedAt))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)
        || String(a.id).localeCompare(String(b.id)))[0];
    const technicians = firstVisit ? [...new Map(
      (assignmentsByAppointment.get(String(firstVisit.id)) || [])
        .filter((assignment) => assignment.active !== false
          && String(assignment.jobId) === String(firstVisit.jobId)
          && ["done", "working"].includes(status(assignment.status))
          && identifier(assignment.technicianId))
        .map((assignment) => [identifier(assignment.technicianId), assignment])
    ).values()].sort((a, b) => identifier(a.technicianId).localeCompare(identifier(b.technicianId))) : [];
    const primarySold = linkedJobs.map((job) => primaryByJob.get(String(job.id))).filter(Boolean)
      .sort((a, b) => money(b.subtotal) - money(a.subtotal)
        || String(a.id).localeCompare(String(b.id)))[0];
    const parsed = parseBookingSummary(booking.summary);
    const attributionStatus = !firstVisit ? "no_worked_appointment"
      : !technicians.length ? "no_worked_assignment"
        : technicians.length === 1 ? "single_technician" : "multiple_technicians";
    return [
      `booking:${booking.id}`, booking.id, parsed.leadId, booking.createdOn || "",
      status(booking.status), firstVisit && firstVisit.jobId || "", firstVisit && firstVisit.id || "",
      firstVisit && firstVisit.start || "", firstVisit ? status(firstVisit.status) : "",
      Boolean(firstVisit), attributionStatus, technicians.length,
      JSON.stringify(technicians.map((assignment) => identifier(assignment.technicianId))),
      JSON.stringify(technicians.map((assignment) => String(assignment.technicianName || ""))),
      technicians.length === 1 ? identifier(technicians[0].technicianId) : "",
      technicians.length === 1 ? String(technicians[0].technicianName || "") : "",
      Boolean(primarySold), primarySold && primarySold.id || "",
      primarySold ? amountOrBlank(primarySold.subtotal) : "",
      primarySold && primarySold.soldOn || "", linkedJobs.length,
      parsed.leadFee, parsed.partnerJobType, syncedAt
    ];
  });
  const unworkedLinkedAppointments = opportunityRows
    .filter((row) => row[20] > 0 && !row[9])
    .flatMap((row) => appointmentsByBooking.get(String(row[1])) || []);
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
    opportunityRows: uniqueRows(opportunityRows),
    estimateRows: uniqueRows(estimateRows),
    invoiceRows: uniqueRows(invoiceRows),
    callRows: uniqueRows(callRows),
    stats: {
      bookingsFetched: bookings.length, angiBookings: angiBookings.length,
      appointmentsFetched: appointments.length, assignmentsFetched: assignments.length,
      feesParsed: bookingRows.filter((row) => row[6] !== "").length,
      angiJobs: jobRows.length, soldEstimates: estimateRows.length, invoices: invoiceRows.length,
      bookingsWithJobs: angiBookings.filter((booking) => jobsByBooking.has(String(booking.id))).length,
      bookingsWithInvoices: angiBookings.filter((booking) =>
        (jobsByBooking.get(String(booking.id)) || []).some((job) => invoicesByJob.has(String(job.id)))).length,
      jobsWithSoldBy: jobRows.filter((row) => row[12]).length,
      jobsWithSoldEstimate: jobRows.filter((row) => row[10]).length,
      soldJobsWithSoldBy: jobRows.filter((row) => row[10] && row[12]).length,
      soldJobsWithJobSoldBy: jobRows.filter((row) => row[10] && row[9]).length,
      soldJobsWithEstimateSoldBy: jobRows.filter((row) => row[10] && row[11]).length,
      soldByConflicts: jobRows.filter((row) => row[14]).length,
      distinctSoldByIds: new Set(jobRows.map((row) => row[12]).filter(Boolean)).size,
      linkedBookingsWithoutAppointments: opportunityRows.filter((row) =>
        row[20] > 0 && !(appointmentsByBooking.get(String(row[1])) || []).length).length,
      linkedBookingsWithUnworkedAppointments: opportunityRows.filter((row) =>
        row[20] > 0 && !row[9]
        && (appointmentsByBooking.get(String(row[1])) || []).length > 0).length,
      linkedAppointmentStatuses: angiAppointments.reduce((counts, appointment) => {
        const key = status(appointment.status) || "unknown";
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
      unworkedLinkedAppointmentStatuses: unworkedLinkedAppointments.reduce((counts, appointment) => {
        const key = status(appointment.status) || "unknown";
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
      workedFirstVisits: opportunityRows.filter((row) => row[9]).length,
      firstVisitsWithTechnicians: opportunityRows.filter((row) => row[11] > 0).length,
      firstVisitsWithTechnicianNames: opportunityRows.filter((row) =>
        row[11] > 0 && JSON.parse(row[13]).every(Boolean)).length,
      distinctFirstVisitTechnicians: new Set(opportunityRows.flatMap((row) => JSON.parse(row[12]))).size,
      multiTechnicianFirstVisits: opportunityRows.filter((row) => row[11] > 1).length,
      maxFirstVisitTechnicians: Math.max(0, ...opportunityRows.map((row) => row[11])),
      workedFirstVisitsWithSoldEstimates: opportunityRows.filter((row) => row[9] && row[16]).length,
      callOnlyAttributions: callRows.filter((row) => row[5] === false).length
    }
  };
}

function isWorkedAppointment(appointment, syncedAt) {
  const started = Date.parse(appointment.start);
  return appointment.active !== false && appointment.unused !== true
    && ["done", "working"].includes(status(appointment.status))
    && Number.isFinite(started) && started <= Date.parse(syncedAt);
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
    appointments: [`${base}/jpm/v2/tenant/${tenant}/appointments`, { createdOnOrAfter: fromUtc, createdBefore: toUtc }],
    assignments: [`${base}/dispatch/v2/tenant/${tenant}/appointment-assignments`, { modifiedOnOrAfter: fromUtc }],
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
  BOOKING_HEADERS, JOB_HEADERS, OPPORTUNITY_HEADERS, ESTIMATE_HEADERS, INVOICE_HEADERS, CALL_HEADERS,
  buildAngiRows, fetchAngiData, isAngiBooking, parseBookingSummary
};

