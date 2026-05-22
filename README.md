# Estimator

This repo includes a Vercel serverless endpoint at `/api/bookings`.

The estimator submits the final address and contact data to that endpoint, and the endpoint can create a booking in ServiceTitan without exposing ServiceTitan credentials in browser code.

## Vercel setup

Add the environment variables from `.env.example` in your Vercel project settings.

For the live Mother setup, the important values are:

- `SERVICETITAN_ENV=production`
- `SERVICETITAN_DRY_RUN=false`
- `SERVICETITAN_TENANT_ID=YOUR_TENANT_ID`
- `SERVICETITAN_BOOKING_PROVIDER=85648468`
- `SERVICETITAN_APP_KEY=ak1...`
- `SERVICETITAN_CLIENT_ID=...`
- `SERVICETITAN_CLIENT_SECRET=...`
- `SERVICETITAN_BUSINESS_UNIT_ID=1357`

Start with `SERVICETITAN_DRY_RUN=true` when checking the browser payload. Change it to `false` only when you want the endpoint to call ServiceTitan.

If the estimator script is embedded on Webflow, point the widget at both the estimator config and the Vercel endpoint:

```html
<script
  src="https://matthew-callmother.github.io/estimator/app.js?v=20260522-1"
  data-config-url="https://matthew-callmother.github.io/estimator/config.json"
  data-booking-endpoint="https://estimator-sage-xi.vercel.app/api/bookings"
  defer
></script>
```

Future estimators can reuse the same `app.js` by changing only `data-config-url`.

## ServiceTitan notes

The endpoint uses ServiceTitan OAuth client credentials and sends bookings to the CRM bookings API.

ServiceTitan requires both the access token and `ST-App-Key` on API calls. The Vercel endpoint gets the token server-side, caches it during its lifetime, and sends the app key as a protected server-side header.

Bookings are sent through this route:

```txt
POST /crm/v2/tenant/{tenant_id}/booking-provider/{booking_provider}/bookings
```

With production values, that becomes:

```txt
https://api.servicetitan.io/crm/v2/tenant/{tenant_id}/booking-provider/{booking_provider}/bookings
```

Set `SERVICETITAN_BOOKING_PROVIDER` to the allowed booking provider value, such as `85648468`.

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
