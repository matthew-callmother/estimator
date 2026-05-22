let cachedToken = null;

const ENVIRONMENTS = {
  integration: {
    authBaseUrl: "https://auth-integration.servicetitan.io",
    apiBaseUrl: "https://api-integration.servicetitan.io"
  },
  production: {
    authBaseUrl: "https://auth.servicetitan.io",
    apiBaseUrl: "https://api.servicetitan.io"
  }
};

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST for booking requests." });
  }

  try {
    const form = readBody(req);
    const validationError = validateBooking(form);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const booking = buildServiceTitanBooking(form);

    if (process.env.SERVICETITAN_DRY_RUN === "true") {
      console.log("ServiceTitan booking dry run", JSON.stringify(booking));
      return res.status(200).json({
        ok: true,
        dryRun: true,
        message: "Booking accepted. Dry run is enabled, so nothing was sent to ServiceTitan."
      });
    }

    const result = await createServiceTitanBooking(booking);

    return res.status(200).json({
      ok: true,
      bookingId: result.id ?? result.bookingId ?? null
    });
  } catch (error) {
    console.error("Booking submission failed", error);
    return res.status(500).json({
      error: "We received the request, but could not send it to ServiceTitan."
    });
  }
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.BOOKING_ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

function validateBooking(form) {
  if (!form.name || String(form.name).trim().length < 2) {
    return "Please include the customer's name.";
  }

  if (!form.phone && !form.email) {
    return "Please include a phone number or email.";
  }

  if (!form.address && !form.street) {
    return "Please include the service address.";
  }

  return null;
}

function buildServiceTitanBooking(form) {
  const notes = [
    form.notes,
    form.priceRange ? `Estimated price range: ${form.priceRange}` : null,
    form.preferredTime ? `Preferred time: ${form.preferredTime}` : null,
    form.questionId ? `Submitted from question: ${form.questionId}` : null,
    form.answers ? `Questionnaire answers: ${JSON.stringify(form.answers)}` : null
  ].filter(Boolean).join("\n");

  return removeEmptyValues({
    name: String(form.name).trim(),
    summary: form.service || "Website booking request",
    phone: cleanString(form.phone),
    email: cleanString(form.email),
    address: normalizeAddress(form),
    notes,
    businessUnitId: numberOrUndefined(form.businessUnitId || process.env.SERVICETITAN_BUSINESS_UNIT_ID),
    jobTypeId: numberOrUndefined(form.jobTypeId || process.env.SERVICETITAN_JOB_TYPE_ID),
    campaignId: numberOrUndefined(form.campaignId || process.env.SERVICETITAN_CAMPAIGN_ID),
    source: form.source || "Website"
  });
}

function normalizeAddress(form) {
  if (form.address) return cleanString(form.address);

  const street = [form.street, form.unit].map(cleanString).filter(Boolean).join(" ");
  const cityStateZip = [form.city, form.state, form.zip].map(cleanString).filter(Boolean).join(", ");

  return [street, cityStateZip].filter(Boolean).join(", ");
}

function cleanString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function removeEmptyValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
  );
}

async function createServiceTitanBooking(booking) {
  const env = getEnvironment();
  const tenantId = requireEnv("SERVICETITAN_TENANT_ID");
  const appKey = requireEnv("SERVICETITAN_APP_KEY");
  const token = await getAccessToken(env);
  const path = getBookingsPath(tenantId);

  const response = await fetch(`${env.apiBaseUrl}/crm/v2/${path}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "ST-App-Key": appKey
    },
    body: JSON.stringify(booking)
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`ServiceTitan returned ${response.status}: ${text}`);
  }

  return data;
}

function getBookingsPath(tenantId) {
  const mode = process.env.SERVICETITAN_BOOKING_PATH_MODE || "tenant";

  if (mode === "booking_provider") {
    return `tenant/${tenantId}/${requireEnv("SERVICETITAN_BOOKING_PROVIDER")}`;
  }

  return `tenant/${tenantId}`;
}

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: requireEnv("SERVICETITAN_CLIENT_ID"),
    client_secret: requireEnv("SERVICETITAN_CLIENT_SECRET")
  });

  const response = await fetch(`${env.authBaseUrl}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`ServiceTitan token request failed: ${response.status}`);
  }

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + ((data.expires_in || 900) * 1000)
  };

  return cachedToken.accessToken;
}

function getEnvironment() {
  const name = process.env.SERVICETITAN_ENV || "integration";
  const env = ENVIRONMENTS[name];

  if (!env) {
    throw new Error(`Unknown SERVICETITAN_ENV: ${name}`);
  }

  return env;
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}
