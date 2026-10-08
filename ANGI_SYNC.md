# Angi ServiceTitan Sync

The read-only preview endpoint is `/api/angi-sync`. It fetches the last 45 days of
ServiceTitan bookings, jobs, invoices, sold estimates, and attributed calls.
`ANGI_SYNC_DRY_RUN` defaults to enabled, so it returns counts and non-PII examples
without writing a Sheet. The endpoint requires `CRON_SECRET`, except for GET on
a protected Vercel Preview deployment while dry-run is enabled.

The only destination is the existing [Mother Angi Operations Database](https://docs.google.com/spreadsheets/d/1VRqenGE0QEvBEtfdl6GZZuKYJOl9TTkSjk14PSBV4wI/edit).
The writer touches only `Angi_API_Bookings`, `Angi_API_Calls`, and
`Angi_API_Sync_Runs`; the workbook's original tabs are not modified.

- `Angi_API_Bookings`: one row per Angi integration booking. `Actual_Lead_Fee`
  and `Partner_Job_Type` come from labeled lines in the booking summary. Linked
  jobs are joined by `bookingId`, invoices by `invoice.job.id`, and the largest
  sold estimate per job by `jobId`. Sold estimate subtotal and invoice totals
  remain separate; invoice total is not labeled as collected revenue.
- `Angi_API_Calls`: attributed Angi calls. `Is_Booking_Linked` tells the
  dashboard whether a call is already represented by a booking row. Count
  call-only leads only where this value is `FALSE`.
- `Angi_API_Sync_Runs`: one audit row for each successful write.

## Connect the daily writer

1. Create a **separate** Google Apps Script project (do not paste this into the
   live marketing-sync project). Paste `google-apps-script/angi-sync.js` into
   `Code.gs`. In Project Settings > Script properties, add
   `ANGI_SYNC_WEBHOOK_SECRET` with a new random secret. Deploy as a Web app,
   executing as your account and allowing requests from anyone with the URL.
2. In the Vercel `estimator` project, add `ANGI_APPS_SCRIPT_WEBHOOK_URL` and
   `ANGI_APPS_SCRIPT_WEBHOOK_SECRET` to Production. Keep
   `ANGI_SYNC_DRY_RUN=true` until the webhook is tested. Redeploy after changing
   environment variables.
3. Test one authorized sync while dry-run is enabled. Then set
   `ANGI_SYNC_DRY_RUN=false`, redeploy, and invoke `/api/angi-sync` once with
   `Authorization: Bearer <CRON_SECRET>`. Check the three tabs and the returned
   inserted/updated counts. Only then add a daily Vercel cron for this route.

The sync fails instead of publishing partial data if any ServiceTitan endpoint
exceeds `ANGI_SYNC_MAX_PAGES` (default 50). Optional bounds are
`ANGI_SYNC_LOOKBACK_DAYS` (default 45) and `ANGI_SYNC_PAGE_SIZE` (default 100).
For older history, run a controlled backfill after checking Vercel duration and
ServiceTitan pagination. A booking older than the lookback window is not
refreshed by this daily job.

