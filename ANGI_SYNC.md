# Angi ServiceTitan Sync

The read-only preview endpoint is `/api/angi-sync`. It fetches the last 45 days of
ServiceTitan bookings, jobs, appointments, appointment assignments, invoices,
sold estimates, and attributed calls.
`ANGI_SYNC_DRY_RUN` defaults to enabled, so it returns counts and non-PII examples
without writing a Sheet. The endpoint requires `CRON_SECRET`, except for GET on
a protected Vercel Preview deployment while dry-run is enabled.

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

## Connect the daily writer

1. The separate [Mother Angi Operations Sync Apps Script project](https://script.google.com/u/1/home/projects/1oswKjFfdmXz2g_cksjVmA8WPs559QmkDntaoJhA34A_4ZBUpi00LqMoq/edit)
   has the `google-apps-script/angi-sync.js` writer deployed as a web app,
   executing as the work account. Its `ANGI_SYNC_WEBHOOK_SECRET` script property
   matches the Vercel secret. An authenticated empty payload created and verified
   all seven `Angi_Live_*` tabs without changing older tabs.
2. The Vercel `estimator` project has `ANGI_APPS_SCRIPT_WEBHOOK_URL` and
   `ANGI_APPS_SCRIPT_WEBHOOK_SECRET` for Preview and Production. Both environments
   still have `ANGI_SYNC_DRY_RUN=true`. Redeploy after changing variables.
3. To test one real write, set `ANGI_SYNC_DRY_RUN=false` for Preview only,
   redeploy, and invoke `/api/angi-sync` with `Authorization: Bearer <CRON_SECRET>`.
   Confirm the seven tabs and inserted/updated counts, including
   `Angi_Live_Opportunities`. Keep Production in dry-run mode until that write
   is verified. Only then enable Production writes and add a daily Vercel cron.

The sync fails instead of publishing partial data if any ServiceTitan endpoint
exceeds `ANGI_SYNC_MAX_PAGES` (default 50). Optional bounds are
`ANGI_SYNC_LOOKBACK_DAYS` (default 45) and `ANGI_SYNC_PAGE_SIZE` (default 100).
Do not run the 12-calendar-month backfill or enable a daily cron yet. First,
validate first-visit assignment coverage on sold and unsold Angi jobs. A 45-day
preview dry run found 492 Angi bookings, 161 linked jobs, 104 first worked visits,
104 visits with one named technician across 11 technicians, and 29 first worked
visits with a sold estimate. The other 57 linked bookings had appointments but
none with `Done` or `Working` status: 46 `Canceled`, 9 `Scheduled`, and 2 `Hold`.
`Hold` remains excluded until its meaning is confirmed for this business. The
current fetch filters
every entity by creation date;
an older booking with a later job, estimate, or invoice can fall outside the
window. Incremental refresh of those older linked records and a bounded
backfill strategy must be implemented and tested before nightly reporting is
considered complete.
