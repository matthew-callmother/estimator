"use strict";

const ENDPOINTS = {
  bookings: { api: "crm/v2", path: "bookings" },
  providerBookings: { api: "crm/v2", path: "booking-provider/85648468/bookings" },
  leads: { api: "crm/v2", path: "leads" },
  attributedLeads: { api: "marketingads/v2", path: "attributed-leads", marketingDates: true },
  webBookingAttributions: { api: "marketingads/v2", path: "web-booking-attributions", marketingDates: true },
  jobs: { api: "jpm/v2", path: "jobs" },
  appointments: { api: "jpm/v2", path: "appointments" },
  assignments: { api: "dispatch/v2", path: "appointment-assignments", modifiedDates: true },
  invoices: { api: "accounting/v2", path: "invoices" },
  estimates: { api: "sales/v2", path: "estimates" },
  campaigns: { api: "marketing/v2", path: "campaigns", undated: true }
};

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET." });
  if (process.env.VERCEL_ENV !== "preview") return res.status(404).json({ error: "Not found." });

  const environment = process.env.SERVICETITAN_ENV === "integration"
    ? "https://api-integration.servicetitan.io"
    : "https://api.servicetitan.io";
  const authBase = process.env.SERVICETITAN_ENV === "integration"
    ? "https://auth-integration.servicetitan.io"
    : "https://auth.servicetitan.io";
  const tenant = process.env.SERVICETITAN_TENANT_ID;
  const appKey = process.env.SERVICETITAN_APP_KEY;

  try {
    const tokenResponse = await fetch(`${authBase}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.SERVICETITAN_CLIENT_ID || "",
        client_secret: process.env.SERVICETITAN_CLIENT_SECRET || ""
      })
    });
    if (!tokenResponse.ok) {
      return res.status(502).json({ error: "ServiceTitan authentication failed.", status: tokenResponse.status });
    }
    const { access_token: accessToken, scope } = await tokenResponse.json();
    const fromUtc = new Date(Date.now() - 90 * 86400000).toISOString();
    const results = {};
    const sampledRows = {};

    for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
      const params = new URLSearchParams({
        page: "1",
        pageSize: "100",
        ...(endpoint.marketingDates
          ? { fromUtc, toUtc: new Date().toISOString() }
          : endpoint.undated ? {} : endpoint.modifiedDates
            ? { modifiedOnOrAfter: fromUtc } : { createdOnOrAfter: fromUtc })
      });
      const url = `${environment}/${endpoint.api}/tenant/${encodeURIComponent(tenant)}/${endpoint.path}?${params}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, "ST-App-Key": appKey, Accept: "application/json" }
      });
      const responseText = await response.text();
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = {};
      }
      const rows = Array.isArray(payload.data) ? payload.data : [];
      sampledRows[name] = rows;
      results[name] = {
        status: response.status,
        error: response.ok ? null : {
          code: String(payload.type || payload.code || payload.error || "").slice(0, 160),
          title: String(payload.title || "").slice(0, 160),
          message: String(payload.message || payload.detail || responseText || "").slice(0, 300)
        },
        count: rows.length,
        totalCount: payload.totalCount ?? null,
        hasMore: payload.hasMore ?? null,
        keys: rows.length ? Object.keys(rows[0]) : [],
        nestedKeys: rows.length ? Object.fromEntries(Object.entries(rows[0])
          .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
          .map(([key, value]) => [key, Object.keys(value)])) : {},
        angiMentions: rows.filter((row) => /\bangi\b/i.test(JSON.stringify(row))).length,
        summaryFields: rows.length ? Object.keys(rows[0]).filter((key) => /summary|description|campaign|source|provider/i.test(key)) : []
      };
    }

    const angiAttributions = sampledRows.attributedLeads.filter(isAngi);
    const angiCampaignIds = new Set(angiAttributions
      .map((row) => String(row.attribution?.stCampaignId || ""))
      .filter(Boolean));
    const angiBookings = sampledRows.bookings.filter((row) =>
      isAngi(row) || angiCampaignIds.has(String(row.campaignId || "")));
    const angiJobs = sampledRows.jobs.filter((row) =>
      isAngi(row) || angiCampaignIds.has(String(row.campaignId || "")));
    const diagnostics = {
      angiCampaigns: sampledRows.campaigns.filter(isAngi).slice(0, 10)
        .map((row) => ({ id: row.id, name: row.name, active: row.active })),
      angiAttributionSample: angiAttributions.slice(0, 8).map((row) => ({
        leadType: row.leadType,
        source: row.attribution?.utmSource,
        medium: row.attribution?.utmMedium,
        campaign: row.attribution?.utmCampaign,
        originalCampaign: row.attribution?.originalCampaign,
        stCampaignId: row.attribution?.stCampaignId,
        hasCall: Boolean(row.call?.id),
        hasBooking: Boolean(row.booking?.id),
        hasJob: Boolean(row.job?.id),
        hasLeadForm: Boolean(row.leadForm?.leadNumber)
      })),
      bookingSources: topCounts(sampledRows.bookings, (row) => row.source),
      bookingProviders: topCounts(sampledRows.bookings, (row) => row.bookingProviderId),
      leadCaptureSources: topCounts(sampledRows.leads, (row) => row.captureSource),
      angiBookingSample: angiBookings.slice(0, 5).map((row) => ({
        source: row.source,
        campaignId: row.campaignId,
        bookingProviderId: row.bookingProviderId,
        jobTypeId: row.jobTypeId,
        status: row.status,
        hasJob: Boolean(row.jobId),
        summaryExcerpt: redact(row.summary)
      })),
      integrationBookingSample: sampledRows.bookings
        .filter((row) => String(row.source || "").startsWith("LeadsIntegration#"))
        .slice(0, 5).map((row) => ({
          source: row.source,
          campaignId: row.campaignId,
          bookingProviderId: row.bookingProviderId,
          jobTypeId: row.jobTypeId,
          status: row.status,
          hasJob: Boolean(row.jobId),
          summaryExcerpt: redact(row.summary),
          feeLines: feeLines(row.summary)
        })),
      angiJobSample: angiJobs.slice(0, 5).map((row) => ({
        campaignId: row.campaignId,
        jobTypeId: row.jobTypeId,
        status: row.jobStatus,
        hasBooking: Boolean(row.bookingId),
        hasInvoice: Boolean(row.invoiceId),
        summaryExcerpt: redact(row.summary)
      })),
      sellerSignals: {
        jobsWithSoldById: sampledRows.jobs.filter((row) => row.soldById).length,
        estimateSoldByTypes: topCounts(sampledRows.estimates, (row) => typeof row.soldBy),
        estimateSoldBySamples: sampledRows.estimates.filter((row) => row.soldBy)
          .slice(0, 5).map((row) => row.soldBy)
      },
      linkedBookingProbe: []
    };

    for (const job of angiJobs.filter((row) => row.bookingId).slice(0, 2)) {
      const url = `${environment}/crm/v2/tenant/${encodeURIComponent(tenant)}/bookings/${encodeURIComponent(job.bookingId)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, "ST-App-Key": appKey, Accept: "application/json" }
      });
      const payload = await response.json().catch(() => ({}));
      const booking = payload.data || payload;
      diagnostics.linkedBookingProbe.push({
        status: response.status,
        keys: response.ok ? Object.keys(booking) : [],
        source: booking.source,
        campaignId: booking.campaignId,
        bookingProviderId: booking.bookingProviderId,
        jobTypeId: booking.jobTypeId,
        summaryExcerpt: redact(booking.summary),
        feeLines: feeLines(booking.summary)
      });
    }

    diagnostics.appointmentProbe = [];
    const appointmentJobs = [...new Map([...angiJobs, ...sampledRows.jobs]
      .filter((job) => job.firstAppointmentId)
      .map((job) => [String(job.id), job])).values()].slice(0, 4);
    for (const job of appointmentJobs) {
      const paths = {
        first: `jpm/v2/tenant/${encodeURIComponent(tenant)}/appointments/${encodeURIComponent(job.firstAppointmentId)}`,
        all: `jpm/v2/tenant/${encodeURIComponent(tenant)}/appointments?jobId=${encodeURIComponent(job.id)}&page=1&pageSize=100`,
        assignments: `dispatch/v2/tenant/${encodeURIComponent(tenant)}/appointment-assignments?jobId=${encodeURIComponent(job.id)}&page=1&pageSize=100`
      };
      const sample = { angi: angiJobs.includes(job), jobId: job.id, firstAppointmentId: job.firstAppointmentId };
      for (const [name, path] of Object.entries(paths)) {
        const response = await fetch(`${environment}/${path}`, {
          headers: { Authorization: `Bearer ${accessToken}`, "ST-App-Key": appKey, Accept: "application/json" }
        });
        const payload = await response.json().catch(() => ({}));
        const rows = Array.isArray(payload.data) ? payload.data : response.ok ? [payload] : [];
        sample[name] = {
          status: response.status,
          error: response.ok ? null : String(payload.title || payload.message || "").slice(0, 160),
          count: rows.length,
          hasMore: payload.hasMore ?? null,
          keys: rows[0] ? Object.keys(rows[0]) : [],
          items: rows.slice(0, 5).map((row) => ({
            id: row.id, jobId: row.jobId, jobAppointmentId: row.jobAppointmentId,
            technicianId: row.technicianId, status: row.status,
            start: row.start, end: row.end, active: row.active, unused: row.unused,
            assignedOn: row.assignedOn
          }))
        };
      }
      diagnostics.appointmentProbe.push(sample);
    }

    return res.status(200).json({
      fromUtc,
      clientIdLastSix: String(process.env.SERVICETITAN_CLIENT_ID || "").trim().slice(-6),
      scopes: String(scope || "").split(/\s+/).filter(Boolean),
      results,
      diagnostics
    });
  } catch (error) {
    return res.status(502).json({ error: "Angi probe failed.", detail: error.message });
  }
};

function isAngi(row) {
  return /\bangi\b/i.test(JSON.stringify(row));
}

function topCounts(rows, select) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = String(select(row) ?? "").trim() || "[blank]";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts].sort((left, right) => right[1] - left[1]).slice(0, 10)
    .map(([value, count]) => ({ value, count }));
}

function redact(input) {
  return String(input || "").slice(0, 700)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, "[phone]")
    .replace(/\b\d{1,6}\s+[A-Za-z0-9 .'-]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court)\b/gi, "[address]");
}

function feeLines(input) {
  return String(input || "").split(/\\n|\n|<br\s*\/?\s*>/i)
    .filter((line) => /\bfee\b|\bcost\b|\bcharge\b/i.test(line))
    .slice(0, 4).map(redact);
}

