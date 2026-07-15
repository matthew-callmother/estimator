# Estimator

This repo now includes a Vercel serverless endpoint at `/api/bookings`.

The estimator submits the final address and contact data to that endpoint, and the endpoint can create a booking in ServiceTitan without exposing ServiceTitan credentials in browser code.

## Vercel setup

Add the environment variables from `.env.example` in your Vercel project settings.

Start with:

- `SERVICETITAN_ENV=integration`
- `SERVICETITAN_DRY_RUN=true`

After the payload looks right in Vercel logs, change dry run to `false`.

If the estimator script is hosted on the same Vercel project, submissions use `/api/bookings` automatically.

If the estimator script is embedded on Webflow, point the widget at both the estimator config and the Vercel endpoint:

```html
<script
  src="https://matthew-callmother.github.io/estimator/app.js"
  data-config-url="https://matthew-callmother.github.io/estimator/config.json"
  data-booking-endpoint="https://YOUR-VERCEL-PROJECT.vercel.app/api/bookings"
></script>
```

Future estimators can reuse the same `app.js` by changing only `data-config-url`.

You can also set `window.WH_ESTIMATOR_CONFIG_URL`, `window.WH_ESTIMATOR_MUNICIPALITIES_URL`, or `window.WH_ESTIMATOR_BOOKING_ENDPOINT` before loading `app.js`.

## ServiceTitan notes

The endpoint uses ServiceTitan OAuth client credentials and sends bookings to the CRM bookings API.

ServiceTitan's CRM docs note that bookings must be enabled/configured on the account before they appear for CSRs. This endpoint sends bookings through the tenant booking-provider route:

```txt
POST /crm/v2/tenant/{tenant_id}/booking-provider/{booking_provider}/bookings
```

Set `SERVICETITAN_TENANT_ID` to the tenant ID and `SERVICETITAN_BOOKING_PROVIDER` to the booking provider value, such as `85648468`.

The Vercel endpoint builds the ServiceTitan booking payload. It generates a unique `externalId`, maps phone and email into contacts, defaults country to `USA`, sets customer type to `Residential`, uses business unit `1357`, and sends confirmation email as `false`.

## Config notes

Each estimator config can include optional metadata:

```json
{
  "estimatorId": "water-heater",
  "serviceName": "Water heater estimate request",
  "defaultCountry": "United States",
  "campaign": "Website Water Heater Estimator",
  "campaignId": 111222333,
  "jobTypeId": 1234
}
```

Vercel remains the authority for ServiceTitan credentials and protected defaults. Config values are only used for safe lead metadata such as service name, campaign label, campaign ID, source, and job type.

## Pricing model

When `features.pricing` is enabled, answer choices can include pricing:

```json
{
  "label": "Attic",
  "pricing": {
    "exact": 650
  }
}
```

`exact` is the real internal estimate value. The customer-facing low/high range is display strategy, not core math.

Configs can generate the visible range from the exact total:

```json
{
  "pricing": {
    "range": {
      "low_multiplier": 0.9,
      "high_multiplier": 1.08,
      "round_to": 50,
      "force_generated": true
    }
  }
}
```

Existing configs that already provide `low` and `high` still work. By default the app can respect explicit ranges, but `force_generated: true` tells the app to ignore those values for display and generate the range from `exact`.
