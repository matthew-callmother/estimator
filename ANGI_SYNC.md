# Angi ServiceTitan Sync

The `/api/angi-sync` endpoint fetches the configured lookback window of
ServiceTitan bookings, jobs, appointments, appointment assignments, invoices,
sold estimates, and attributed calls.
`ANGI_SYNC_DRY_RUN` defaults to enabled, so it returns counts and non-PII examples
without writing a Sheet. The endpoint requires `CRON_SECRET`, except for GET on
a protected Vercel Preview deployment while dry-run is enabled.
The production cron is scheduled daily at 10:17 UTC. It must have
`ANGI_SYNC_DRY_RUN=false`, `ANGI_SYNC_LOOKBACK_DAYS=365`,
`ANGI_SYNC_PAGE_SIZE=500`, and `ANGI_SYNC_MAX_PAGES=100` in Production.

The only destination is the existing [Mother Angi Operations Database](https://docs.google.com/spreadsheets/d/1VRqenGE0QEvBEtfdl6GZZuKYJOl9TTkSjk14PSBV4wI/edit).
The v3 writer touches only `Angi_Live_Bookings`, `Angi_Live_Jobs`,
`Angi_Live_Opportunities`, `Angi_Live_Estimates`, `Angi_Live_Invoices`,
`Angi_Live_Calls`, and `Angi_Live_Sync_Runs`; the workbook's original and
older `Angi_API_*` tabs are not modified. A tab with an unexpected header
layout causes the write to fail rather than silently overwriting it.

- `Angi_Live_Bookings`: one row per Angi integration booking. `Actual_Lead_Fee`
  and `Partner_Job_Type` come from labeled lines in the booking summary. Sum
  lead fees here, not on joined job or invoice rows.
- `Angi_Live_Jobs`: one row per linked job, joined by `job.bookingId` or the
  booking's `jobId`. `Sold_By_ID` uses `job.soldById` first, then the largest
  sold estimate's `soldBy`. `Sold_By_Source` and `Sold_By_Conflict` make that
  outcome attribution auditable. This is **not** the person who ran the initial
  sales visit and must not be used as the close-rate denominator. This row
  holds the primary sold estimate subtotal for convenient one-row-per-job
  reporting.
- `Angi_Live_Opportunities`: one row per Angi booking, including bookings with
  no job. It uses the earliest active, used, already-started appointment with
  `Done` or `Working` status across linked jobs. Only active `Done` or `Working`
  assignment records on that appointment identify who ran it. Technician IDs
  and names are JSON arrays; the singular ID and name columns are filled only
  when exactly one technician was on the first worked visit. `Is_Ran` and
  `Attribution_Status` expose missing visits or assignments. `Has_Sold_Estimate`
  is true when any linked job has a sold estimate; the primary estimate is the
  largest sold subtotal. Do not sum sold subtotals or lead fees from this tab
  together with their source tabs.
- `Angi_Live_Estimates`: one row per sold estimate. Only
  `Is_Primary_For_Job = TRUE` identifies the largest sold estimate for a job;
  summing every estimate row can double-count a sale.
- `Angi_Live_Invoices`: one row per linked invoice. `Invoice_Total` is billed,
  not collected revenue. Join through `Job_ID` and `Booking_ID`.
- `Angi_Live_Calls`: attributed Angi calls. `Is_Booking_Linked` tells the
  dashboard whether a call is already represented by a booking row. Count
  call-only leads only where this value is `FALSE`.
- `Angi_Live_Sync_Runs`: one audit row for each successful write.

All tables use stable `Record_Key` values for upsert. The appointment-assignment
API supplies both `technicianId` and `technicianName`, so no manual salesperson
roster is needed for the first-visit field. `Sold_By_ID` remains a separate sale
credit signal. Canceled, unused, future, and unassigned appointments are not
counted as attributed first visits; later installation visits do not replace
the first worked visit. For a visit with multiple technicians, retain every
assignment and decide team-credit rules in the dashboard rather than guessing
a primary salesperson. Do not publish a salesperson close rate until `Hold`
handling and the dashboard's denominator are reviewed.
For the current single-technician cohort, the proposed per-technician metric is
distinct `Booking_ID` values with `Is_Ran = TRUE` and `Has_Sold_Estimate = TRUE`
divided by distinct `Booking_ID` values with `Is_Ran = TRUE`, grouped by
`Single_Technician_ID`. Do not use `Sold_By_ID` as that denominator.

## Daily writer

1. The separate [Mother Angi Operations Sync Apps Script project](https://script.google.com/u/1/home/projects/1oswKjFfdmXz2g_cksjVmA8WPs559QmkDntaoJhA34A_4ZBUpi00LqMoq/edit)
   has the `google-apps-script/angi-sync.js` writer deployed as a web app,
   executing as the work account. Its `ANGI_SYNC_WEBHOOK_SECRET` script property
   matches the Vercel secret. The writer created all seven `Angi_Live_*` tabs
   without changing older tabs.
2. The Vercel `estimator` project has `ANGI_APPS_SCRIPT_WEBHOOK_URL` and
   `ANGI_APPS_SCRIPT_WEBHOOK_SECRET` for Preview and Production. A live Preview
   sync on October 9, 2026 wrote 1,743 Angi bookings, 513 linked jobs, 156 sold
   estimates, 518 invoices, and 1,873 attributed calls from the last 365 days.
3. The daily cron calls `GET /api/angi-sync` with the Vercel `CRON_SECRET` bearer
   token. Successful writes appear in `Angi_Live_Sync_Runs`; Vercel function
   logs contain failures. Only production deployments register the cron.

The sync fails instead of publishing partial data if any ServiceTitan endpoint
exceeds `ANGI_SYNC_MAX_PAGES`. The 365-day window is rolling, not an exact
calendar-year extract. Stable keys upsert current rows without duplication.
The current fetch filters most entities by creation date; a booking older than
the rolling window with a later job, estimate, or invoice can be missed. The
dashboard should show the latest successful run timestamp, and historical
reporting beyond the rolling year needs a separate refresh strategy.

