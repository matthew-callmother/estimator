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

const SERVICETITAN_DEFAULTS = {
  source: "Website Estimator",
  bookingProvider: "85648468",
  businessUnitId: 1357,
  campaign: "Website Water Heater Estimator",
  customerType: "Residential",
  phoneContactType: "MobilePhone"
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
    const recordOnly = isRecordOnlyLead(form);
    const validationError = recordOnly ? validateLead(form) : validateBooking(form);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (recordOnly) {
      const lead = await sendLeadWebhook(form, {
        leadStage: form.leadStage || "result_gate",
        serviceTitanStatus: "not_requested"
      });

      return res.status(200).json({
        ok: true,
        recordedOnly: true,
        lead
      });
    }

    const booking = buildServiceTitanBooking(form);

    if (process.env.SERVICETITAN_DRY_RUN === "true") {
      const lead = await sendLeadWebhook(form, {
        leadStage: form.leadStage || "booking_submit",
        serviceTitanStatus: "dry_run"
      });

      return res.status(200).json({
        ok: true,
        dryRun: true,
        message: "Booking accepted. Dry run is enabled, so nothing was sent to ServiceTitan.",
        booking,
        lead
      });
    }

    let result;
    try {
      result = await createServiceTitanBooking(booking);
    } catch (error) {
      await sendLeadWebhook(form, {
        leadStage: "booking_failed",
        serviceTitanStatus: "failed",
        serviceTitanError: error.message,
        serviceTitanCode: error.publicCode || "servicetitan_booking_failed"
      });
      throw error;
    }

    const bookingId = result.id ?? result.bookingId ?? null;
    const lead = await sendLeadWebhook(form, {
      leadStage: form.leadStage || "booking_submit",
      serviceTitanStatus: "created",
      serviceTitanBookingId: bookingId
    });

    return res.status(200).json({
      ok: true,
      bookingId,
      lead
    });
  } catch (error) {
    console.error("Booking submission failed", {
      message: error.message,
      code: error.publicCode || "servicetitan_booking_failed",
      statusCode: error.statusCode || 500,
      diagnostics: error.diagnostics || null
    });
    return res.status(error.statusCode || 500).json({
      error: error.statusCode
        ? error.message
        : "We received the request, but could not send it to ServiceTitan.",
      code: error.publicCode || "servicetitan_booking_failed",
      diagnostics: error.diagnostics || null
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

function isRecordOnlyLead(form) {
  return form.bookingAction === "record_only" || form.leadStage === "result_gate" || form.leadStage === "partial";
}

function validateLead(form) {
  if (!form.name || String(form.name).trim().length < 2) {
    return "Please include the customer's name.";
  }

  if (!form.phone && !form.email) {
    return "Please include a phone number or email.";
  }

  if (!form.zip) {
    return "Please include the ZIP code.";
  }

  return null;
}

function validateBooking(form) {
  const leadValidation = validateLead(form);
  if (leadValidation) return leadValidation;

  if (!form.street || !form.city || !form.state || !form.zip) {
    return "Please include the complete service address.";
  }

  return null;
}

function buildServiceTitanBooking(form) {
  const businessUnitId = numberOrUndefined(process.env.SERVICETITAN_BUSINESS_UNIT_ID || SERVICETITAN_DEFAULTS.businessUnitId);
  const jobTypeId = numberOrUndefined(form.jobTypeId || process.env.SERVICETITAN_JOB_TYPE_ID);
  const campaignId = numberOrUndefined(form.campaignId || process.env.SERVICETITAN_CAMPAIGN_ID);
  const campaignLabel = cleanString(form.campaignLabel || form.campaign || process.env.SERVICETITAN_CAMPAIGN || SERVICETITAN_DEFAULTS.campaign);
  const source = cleanString(form.source || process.env.SERVICETITAN_SOURCE || SERVICETITAN_DEFAULTS.source);
  const submittedAt = new Date().toISOString();
  const summary = buildSummary({ ...form, campaignLabel }, submittedAt);

  return removeEmptyValues({
    source,
    name: String(form.name).trim(),
    address: {
      street: cleanString(form.street),
      unit: cleanString(form.unit),
      city: cleanString(form.city),
      state: cleanString(form.state),
      zip: cleanString(form.zip),
      country: formatCountry(cleanString(form.country) || "United States")
    },
    contacts: buildContacts(form),
    customerType: process.env.SERVICETITAN_CUSTOMER_TYPE || SERVICETITAN_DEFAULTS.customerType,
    start: submittedAt,
    summary,
    campaignId,
    businessUnitId,
    jobTypeId,
    priority: undefined,
    isFirstTimeClient: true,
    isSendConfirmationEmail: false,
    externalId: `wh-booking-${randomUUID()}`
  });
}

function buildContacts(form) {
  return [
    cleanString(form.phone) ? {
      type: process.env.SERVICETITAN_PHONE_CONTACT_TYPE || SERVICETITAN_DEFAULTS.phoneContactType,
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
  const sections = [
    summarySection("Quiz Submitted", [
      form.quizName || form.serviceName || form.service || "Website booking request",
      form.quizId || form.estimatorId ? `Quiz ID: ${form.quizId || form.estimatorId}` : null,
      form.campaignLabel ? `Campaign: ${form.campaignLabel}` : null
    ]),
    summarySection("Customer", [
      form.name ? `Name: ${form.name}` : null,
      form.phone ? `Phone: ${form.phone}` : null,
      form.email ? `Email: ${form.email}` : null
    ]),
    summarySection("Service Address", [
      form.street ? `Street: ${form.street}` : null,
      form.unit ? `Unit: ${form.unit}` : null,
      form.city || form.state || form.zip ? `City/State/ZIP: ${[form.city, form.state, form.zip].filter(Boolean).join(", ")}` : null,
      form.country ? `Country: ${form.country}` : null
    ]),
    summarySection("Quiz Answers", formatReadableAnswers(form)),
    summarySection("Pricing", [
      form.priceRange ? `Estimated price range: ${form.priceRange}` : null,
      form.exactTotal !== undefined ? `Exact total: $${form.exactTotal}` : null
    ]),
    summarySection("Permit", formatPermit(form.permit)),
    summarySection("Recommendation", formatRecommendation(form.recommendation || form.selectedResult)),
    summarySection("Page / Tracking", [
      form.pageUrl ? `Page URL: ${form.pageUrl}` : null,
      form.submittedAt ? `Browser submitted at: ${form.submittedAt}` : null,
      `Server submitted at: ${submittedAt}`
    ]),
    form.notes ? summarySection("Notes", [form.notes]) : null
  ];

  return sections.filter(Boolean).join("\n\n");
}

async function sendLeadWebhook(form, context = {}) {
  const webhookUrl = cleanString(process.env.LEAD_WEBHOOK_URL || process.env.ZAPIER_LEAD_WEBHOOK_URL);
  if (!webhookUrl) return { configured: false, recorded: false };

  const payload = buildLeadWebhookPayload(form, context);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.warn("Lead webhook failed", {
        status: response.status,
        statusText: response.statusText,
        leadStage: payload.leadStage,
        quizId: payload.quizId
      });
      return { configured: true, recorded: false, status: response.status };
    }

    return { configured: true, recorded: true, status: response.status };
  } catch (error) {
    console.warn("Lead webhook failed", {
      message: error.message,
      leadStage: payload.leadStage,
      quizId: payload.quizId
    });
    return { configured: true, recorded: false, error: error.message };
  }
}

function buildLeadWebhookPayload(form, context = {}) {
  const recommendation = form.recommendation || form.selectedResult || {};
  const serviceArea = form.serviceArea || {};
  const readableAnswers = formatReadableAnswers(form);

  return removeEmptyValues({
    serverReceivedAt: new Date().toISOString(),
    browserSubmittedAt: form.submittedAt,
    leadStage: context.leadStage || form.leadStage || "unknown",
    quizName: form.quizName || form.serviceName || form.service,
    quizId: form.quizId || form.estimatorId,
    serviceName: form.serviceName || form.service,
    campaign: form.campaignLabel || form.campaign,
    source: form.source,
    serviceAreaChecked: serviceArea.checked,
    serviceAreaEligible: serviceArea.eligible,
    serviceAreaZip: serviceArea.zip || form.zip,
    serviceAreaTitle: serviceArea.title,
    serviceAreaMessage: serviceArea.message,
    name: form.name,
    email: form.email,
    phone: form.phone,
    street: form.street,
    unit: form.unit,
    city: form.city,
    state: form.state,
    zip: form.zip,
    country: form.country,
    resultId: recommendation.id,
    resultTitle: recommendation.title,
    tieDetected: recommendation.isTie,
    tiedResultIds: Array.isArray(recommendation.tiedResultIds) ? recommendation.tiedResultIds.join(", ") : undefined,
    tieBreakerReason: recommendation.tieBreakerReason,
    pageUrl: form.pageUrl,
    priceRange: form.priceRange,
    exactTotal: form.exactTotal,
    answers: readableAnswers.map((item) => `${item.question}: ${item.answer}`).join("\n"),
    serviceTitanStatus: context.serviceTitanStatus,
    serviceTitanBookingId: context.serviceTitanBookingId,
    serviceTitanError: context.serviceTitanError,
    serviceTitanCode: context.serviceTitanCode,
    rawPayload: JSON.stringify(form)
  });
}

function summarySection(title, lines) {
  const cleanLines = (lines || []).filter(Boolean);
  if (!cleanLines.length) return null;
  return [`${title}:`, ...cleanLines].join("\n");
}

function formatReadableAnswers(form) {
  if (Array.isArray(form.readableAnswers) && form.readableAnswers.length) {
    return form.readableAnswers.map((item) => {
      const question = cleanString(item.question) || cleanString(item.questionId) || "Question";
      const answer = cleanString(item.answer) || cleanString(item.value) || "";
      return answer ? `${question}: ${answer}` : question;
    });
  }

  if (!form.answers || typeof form.answers !== "object") return [];
  return Object.entries(form.answers).map(([key, value]) => `${key}: ${formatSummaryValue(value)}`);
}

function formatPermit(permit) {
  if (!permit || typeof permit !== "object") return [];

  return [
    permit.done !== undefined ? `Lookup completed: ${permit.done ? "Yes" : "No"}` : null,
    permit.city ? `Municipality: ${permit.city}` : null,
    permit.found !== undefined ? `Municipality found: ${permit.found ? "Yes" : "No"}` : null,
    permit.fee !== undefined && permit.fee !== null ? `Permit fee: $${permit.fee}` : null,
    permit.expansionTankRequired !== undefined ? `Expansion tank required: ${permit.expansionTankRequired ? "Yes" : "No"}` : null
  ].filter(Boolean);
}

function formatRecommendation(recommendation) {
  if (!recommendation) return [];
  if (typeof recommendation === "string") return [recommendation];
  if (Array.isArray(recommendation)) return recommendation.map(formatSummaryValue);
  if (typeof recommendation === "object") {
    if (recommendation.title || recommendation.message || recommendation.id) {
      return [
        recommendation.title ? `Result: ${recommendation.title}` : null,
        recommendation.id ? `Result ID: ${recommendation.id}` : null,
        recommendation.isTie ? `Tie detected: ${formatSummaryValue(recommendation.tiedResultIds || [])}` : null,
        recommendation.tieBreakerReason ? `Tie-breaker reason: ${recommendation.tieBreakerReason}` : null,
        recommendation.message ? `Message: ${recommendation.message}` : null
      ].filter(Boolean);
    }
    return Object.entries(recommendation).map(([key, value]) => `${key}: ${formatSummaryValue(value)}`);
  }
  return [formatSummaryValue(recommendation)];
}

function formatSummaryValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

function formatCountry(value) {
  const country = cleanString(value);
  if (!country) return "USA";
  if (/^(united states|us|u\.s\.|u\.s\.a\.|usa)$/i.test(country)) return "USA";
  return country;
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
  const endpointInfo = getBookingsEndpoint(env);
  const url = endpointInfo.url;

  const response = await fetch(url, {
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
    error.diagnostics = {
      service: "ServiceTitan bookings",
      status: response.status,
      statusText: response.statusText,
      endpoint: redactServiceTitanUrl(url),
      endpointTemplate: endpointInfo.template,
      response: parseDiagnosticResponse(text),
      requestShape: {
        hasName: Boolean(booking.name),
        hasAddress: Boolean(booking.address),
        contacts: Array.isArray(booking.contacts) ? booking.contacts.map((contact) => contact.type) : [],
        hasBusinessUnitId: Boolean(booking.businessUnitId),
        hasJobTypeId: Boolean(booking.jobTypeId),
        hasCampaignId: Boolean(booking.campaignId),
        hasExternalId: Boolean(booking.externalId)
      }
    };
    throw error;
  }

  return data;
}

function getBookingsEndpoint(env) {
  const tenantId = cleanString(requireEnv("SERVICETITAN_TENANT_ID"));
  const bookingProvider = cleanString(process.env.SERVICETITAN_BOOKING_PROVIDER || SERVICETITAN_DEFAULTS.bookingProvider);
  return {
    template: "/crm/v2/tenant/{tenant}/booking-provider/{booking_provider}/bookings",
    url: `${env.apiBaseUrl}/crm/v2/tenant/${encodeURIComponent(tenantId)}/booking-provider/${encodeURIComponent(bookingProvider)}/bookings`
  };
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
    client_id: requireEnv("SERVICETITAN_CLIENT_ID").trim(),
    client_secret: requireEnv("SERVICETITAN_CLIENT_SECRET").trim()
  });

  const url = `${env.authBaseUrl}/connect/token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  const text = await response.text();
  const data = parseJsonResponse(text);

  if (!response.ok) {
    const error = new Error(`ServiceTitan token request failed with status ${response.status}.`);
    error.statusCode = 502;
    error.publicCode = "servicetitan_token_failed";
    error.diagnostics = {
      service: "ServiceTitan OAuth",
      status: response.status,
      statusText: response.statusText,
      endpoint: redactServiceTitanUrl(url),
      response: parseDiagnosticResponse(text),
      environment: process.env.SERVICETITAN_ENV || "integration",
      credentialShape: {
        hasClientId: Boolean(process.env.SERVICETITAN_CLIENT_ID),
        clientIdLength: String(process.env.SERVICETITAN_CLIENT_ID || "").length,
        clientIdTrimmedLength: String(process.env.SERVICETITAN_CLIENT_ID || "").trim().length,
        clientIdHasOuterWhitespace: hasOuterWhitespace(process.env.SERVICETITAN_CLIENT_ID),
        hasClientSecret: Boolean(process.env.SERVICETITAN_CLIENT_SECRET),
        clientSecretLength: String(process.env.SERVICETITAN_CLIENT_SECRET || "").length,
        clientSecretTrimmedLength: String(process.env.SERVICETITAN_CLIENT_SECRET || "").trim().length,
        clientSecretHasOuterWhitespace: hasOuterWhitespace(process.env.SERVICETITAN_CLIENT_SECRET)
      }
    };
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
    error.diagnostics = {
      missing: name,
      configured: {
        SERVICETITAN_ENV: Boolean(process.env.SERVICETITAN_ENV),
        SERVICETITAN_CLIENT_ID: Boolean(process.env.SERVICETITAN_CLIENT_ID),
        SERVICETITAN_CLIENT_SECRET: Boolean(process.env.SERVICETITAN_CLIENT_SECRET),
        SERVICETITAN_APP_KEY: Boolean(process.env.SERVICETITAN_APP_KEY),
        SERVICETITAN_TENANT_ID: Boolean(process.env.SERVICETITAN_TENANT_ID),
        SERVICETITAN_BOOKING_PROVIDER: Boolean(process.env.SERVICETITAN_BOOKING_PROVIDER)
      }
    };
    throw error;
  }

  return value;
}

function hasOuterWhitespace(value) {
  if (value === undefined || value === null) return false;
  return String(value) !== String(value).trim();
}

function parseDiagnosticResponse(text) {
  if (!text) return null;

  const parsed = parseJsonResponse(text);
  if (Object.keys(parsed).length) return sanitizeDiagnostic(parsed);

  return sanitizeDiagnostic(text);
}

function sanitizeDiagnostic(value) {
  if (typeof value === "string") {
    return value
      .replace(/client_secret=[^&\s]+/gi, "client_secret=[redacted]")
      .replace(/access_token[\"']?\s*[:=]\s*[\"']?[^\"'\s,}]+/gi, "access_token:[redacted]");
  }

  if (Array.isArray(value)) return value.map(sanitizeDiagnostic);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (/secret|token|password|authorization/i.test(key)) {
          return [key, "[redacted]"];
        }
        return [key, sanitizeDiagnostic(entry)];
      })
    );
  }

  return value;
}

function redactServiceTitanUrl(url) {
  return String(url).replace(/tenant\/\d+/i, "tenant/[tenant]");
}
