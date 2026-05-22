# Estimator

This repo now includes a Vercel serverless endpoint at `/api/bookings`.

The estimator submits the final address and contact data to that endpoint, and the endpoint can create a booking in ServiceTitan without exposing ServiceTitan credentials in browser code.

## Vercel setup

Add the environment variables from `.env.example` in your Vercel project settings.

Start with:

- `SERVICETITAN_ENV=integration`
- `SERVICETITAN_DRY_RUN=true`

After the payload looks right in Vercel logs, change dry run to `false`.
