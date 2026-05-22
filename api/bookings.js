const { randomUUID } = require("crypto");

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
      return res.status(200).json({
        ok: true,
        dryRun: true,
        message: "Booking accepted. Dry run is enabled, so nothing was sent to ServiceTitan.",
        booking
      });
    }

    const result = await createServiceTitanBooking(booking);

    return res.status(200).json({
      ok: true,
      bookingId: result.id ?? result.bookingId ?? null
    });
  } catch (error) {
    console.error("Booking submission failed", error);
    return res.status(error.statusCode || 500).json({
      error: error.statusCode
        ? error.message
        : "We received the request, but could not send it to ServiceTitan.",
      code: error.publicCode || "servicetitan_booking_failed"
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
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      const error = new Error("Request body must be valid JSON.");
      error.statusCode = 400;
      throw error;
    }
  }
  return req.body;
}

function validateBooking(form) {
  if (!form.name || String(form.name).trim().length < 2) {
    return "Please include the customer's name.";
  }

  if (!form.phone && !form.email) {
    return "Please include a phone number or email.";
  }

  if (!form.street || !form.city || !form.state || !form.zip) {
    return "Please include the complete service address.";
  }

  return null;
}

function buildServiceTitanBooking(form) {
  const businessUnitId = numberOrUndefined(process.env.SERVICETITAN_BUSINESS_UNIT_ID || 1357);
  const jobTypeId = numberOrUndefined(form.jobTypeId || process.env.SERVICETITAN_JOB_TYPE_ID);
  const campaign = cleanString(form.campaign || process.env.SERVICETITAN_CAMPAIGN);
  const source = cleanString(form.source || process.env.SERVICETITAN_SOURCE || "Website Estimator");
  const bookingProvider = cleanString(process.env.SERVICETITAN_BOOKING_PROVIDER);
  const submittedAt = new Date().toISOString();
  const summary = buildSummary(form, submittedAt);

  return removeEmptyValues({
    bookingProvider,
    source,
    name: String(form.name).trim(),
    address: {
      street: cleanString(form.street),
      unit: cleanString(form.unit),
      city: cleanString(form.city),
      state: cleanString(form.state),
      zip: cleanString(form.zip),
      country: cleanString(form.country) || "United States"
    },
    contacts: buildContacts(form),
    customerType: process.env.SERVICETITAN_CUSTOMER_TYPE || "Residential",
    start: submittedAt,
    summary,
    campaign,
    businessUnitId,
    jobTypeId,
    priority: undefined,
    isFirstTimeClient: true,
    sendConfirmationEmail: false,
    externalId: `wh-booking-${randomUUID()}`
  });
}

function buildContacts(form) {
  return [
    cleanString(form.phone) ? {
      type: process.env.SERVICETITAN_PHONE_CONTACT_TYPE || "MobilePhone",
      value: cleanString(form.phone),
      memo: "Estimator phone"
    } : null,
    cleanString(form.email) ? {
      type: "Email",
      value: cleanString(form.email),
      memo: "Estimator email"
    } : null
  ].filter(Boolean);
}

function buildSummary(form, submittedAt) {
  const lines = [
    form.serviceName || form.service || "Website booking request",
    form.estimatorId ? `Estimator: ${form.estimatorId}` : null,
    form.priceRange ? `Estimated price range: ${form.priceRange}` : null,
    form.exactTotal !== undefined ? `Estimator exact total: $${form.exactTotal}` : null,
    form.permit ? `Permit: ${JSON.stringify(form.permit)}` : null,
    form.pageUrl ? `Page URL: ${form.pageUrl}` : null,
    form.submittedAt ? `Browser submitted at: ${form.submittedAt}` : null,
    `Server submitted at: ${submittedAt}`,
    form.notes,
    form.answers ? `Questionnaire answers: ${JSON.stringify(form.answers)}` : null
  ];

  return lines.filter(Boolean).join("\n");
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
  const appKey = requireEnv("SERVICETITAN_APP_KEY");
  const token = await getAccessToken(env);
  const path = getBookingsPath();

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
  const data = parseJsonResponse(text);

  if (!response.ok) {
    const error = new Error(`ServiceTitan booking request failed with status ${response.status}.`);
    error.statusCode = 502;
    error.publicCode = "servicetitan_booking_rejected";
    error.details = text;
    throw error;
  }

  return data;
}

function getBookingsPath() {
  const mode = process.env.SERVICETITAN_BOOKING_PATH_MODE || "tenant";

  if (mode === "booking_provider") {
    return requireEnv("SERVICETITAN_BOOKING_PROVIDER");
  }

  return `tenant/${requireEnv("SERVICETITAN_TENANT_ID")}`;
}

function parseJsonResponse(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
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
    const error = new Error(`ServiceTitan token request failed with status ${response.status}.`);
    error.statusCode = 502;
    error.publicCode = "servicetitan_token_failed";
    throw error;
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
    const error = new Error(`Missing environment variable: ${name}`);
    error.statusCode = 500;
    error.publicCode = "missing_env";
    throw error;
  }

  return value;
}
