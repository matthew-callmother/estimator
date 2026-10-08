"use strict";

const ENDPOINTS = {
  bookings: { api: "crm/v2", path: "bookings" },
  providerBookings: { api: "crm/v2", path: "booking-provider/85648468/bookings" },
  leads: { api: "crm/v2", path: "leads" },
  attributedLeads: { api: "marketingads/v2", path: "attributed-leads", marketingDates: true },
  webBookingAttributions: { api: "marketingads/v2", path: "web-booking-attributions", marketingDates: true },
  jobs: { api: "jpm/v2", path: "jobs" },
  invoices: { api: "accounting/v2", path: "invoices" },
  estimates: { api: "sales/v2", path: "estimates" }
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

    for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
      const params = new URLSearchParams({
        page: "1",
        pageSize: "100",
        ...(endpoint.marketingDates
          ? { fromUtc, toUtc: new Date().toISOString() }
          : { createdOnOrAfter: fromUtc })
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

    return res.status(200).json({
      fromUtc,
      clientIdLastSix: String(process.env.SERVICETITAN_CLIENT_ID || "").trim().slice(-6),
      scopes: String(scope || "").split(/\s+/).filter(Boolean),
      results
    });
  } catch (error) {
    return res.status(502).json({ error: "Angi probe failed.", detail: error.message });
  }
};

