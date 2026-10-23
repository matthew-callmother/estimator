# Quiz analytics

`app.js` emits anonymous quiz events to `window.dataLayer`. Google Tag Manager
must forward them to GA4. Quiz configs supply the display order, question text,
branching, and option labels for reports; the event IDs are the join keys.

## Event contract

| Event | Meaning |
| --- | --- |
| `estimator_loaded` | A valid quiz config loaded. Includes `has_cover`. |
| `estimator_cover_view` | The cover appeared. |
| `estimator_start` | A new attempt began, from the cover or first question. |
| `estimator_resume` | Stored progress was reopened. Not a new start. |
| `estimator_step_view` | A customer-facing step appeared. Backtracking can produce another view. |
| `estimator_step_complete` | The step's valid answer was accepted and the quiz advanced, or a submit response succeeded. |
| `estimator_answer` | A fixed option or slider value was committed with Next. Multi-select emits one event per selected option; grouped questions use their item IDs. |
| `estimator_result_view` | A result appeared. |
| `estimator_email_submitted` | The result-gate email form was submitted to the backend. |
| `estimator_lead_checkpoint` | The backend accepted a checkpoint. `backend_status=recorded` means its operational webhook recorded it; `provider_delivered` means a lifecycle provider accepted it; `accepted_unstored` means neither destination confirmed storage. |
| `estimator_lead_checkpoint_error` | The checkpoint request failed or was rejected. |
| `estimator_submit_attempt` | A booking form was submitted. |
| `estimator_booking_created` | The backend returned a ServiceTitan booking ID. |
| `estimator_submit_unconfirmed` | No booking ID was returned: out of area, dry run, booking disabled, or an unconfirmed response. Inspect `backend_status`. |
| `estimator_submit_error` | The booking request failed. |
| `estimator_back`, `estimator_restart` | Navigation actions. |

All events include `estimator_id`, `quiz_name`, and `config_version` when the
config supplies it. Step events include `step_id`, `step_type`, `step_number`,
and `step_total`. Answer events include `question_id` plus `answer_id` and
`answer_label` for fixed choices, or numeric `answer_value` for sliders.

The analytics field allowlist in `app.js` excludes names, email addresses,
phone numbers, ZIPs, addresses, URLs, free-form answers, lead IDs, and booking
IDs. The existing lead/booking payload remains the place for submitted
free-form answers. GA4 is not a raw response store.

## Reporting against a quiz

1. Select a quiz and date range. Read GA4 event counts grouped by `eventName`,
   `estimator_id`, `step_id`, `question_id`, `answer_id`, `answer_label`,
   `result_id`, and `backend_status` as needed.
2. Load that quiz's JSON config. Use top-level `questions` for step order and
   titles. For `question_group`, use `items` to label each `question_id`.
   `results` labels the result IDs. Keep `config_version` in the report so a
   later rewrite does not silently relabel old events.
3. Show load, start, step view, step completion, result view, stored email
   checkpoint (`recorded` or `provider_delivered`), and booking-created counts.
   For each step, completion divided
   by views is a directional completion rate. Use GA4's user/session-based
   funnel exploration when reporting true journey drop-off; raw event counts
   can include backtracking and repeat visits.
4. Show fixed-choice distributions from `estimator_answer`. A changed answer
   can produce a second event, so label these as choices committed, not final
   answers for a unique person. For a branched quiz, compare a step only with
   people who viewed that step.

Register only the GA4 event-scoped custom dimensions needed for the report:
`estimator_id`, `config_version`, `step_id`, `question_id`, `answer_id`,
`answer_label`, `result_id`, and `backend_status`. Register `answer_value` as a
custom metric if numeric slider analysis is needed. GTM should use custom
event triggers for the `estimator_*` events and map the corresponding data
layer variables to GA4 event parameters. Do not mark a booking key event from
`estimator_submit_attempt` or `estimator_submit_unconfirmed`.

## Verification

In GTM Preview and GA4 DebugView, exercise a covered quiz, a coverless quiz,
a grouped question, a result gate, a successful booking, and a failed booking.
Confirm the event order, readable fixed-choice labels, and absence of personal
data. GA4 cannot reconstruct question-level behavior from before these events
were deployed.

