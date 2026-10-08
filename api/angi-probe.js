"use strict";

const ENDPOINTS = {
  bookings: "crm/v2",
  jobs: "jpm/v2",
  invoices: "accounting/v2",
  estimates: "sales/v2"
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
    const { access_token: accessToken } = await tokenResponse.json();
    const fromUtc = new Date(Date.now() - 90 * 86400000).toISOString();
    const results = {};

    for (const [name, api] of Object.entries(ENDPOINTS)) {
      const params = new URLSearchParams({
        page: "1",
        pageSize: "100",
        createdOnOrAfter: fromUtc
      });
      const url = `${environment}/${api}/tenant/${encodeURIComponent(tenant)}/${name}?${params}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, "ST-App-Key": appKey, Accept: "application/json" }
      });
      const payload = await response.json().catch(() => ({}));
      const rows = Array.isArray(payload.data) ? payload.data : [];
      results[name] = {
        status: response.status,
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

    return res.status(200).json({ fromUtc, results });
  } catch (error) {
    return res.status(502).json({ error: "Angi probe failed.", detail: error.message });
  }
};

