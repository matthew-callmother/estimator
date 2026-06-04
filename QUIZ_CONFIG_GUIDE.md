# Quiz Config Guide

This guide is for writing quiz outlines that can be turned into JSON configs for the estimator/quiz app.

## What A Quiz Does

Quizzes show results. That is their core function.

A quiz asks the customer questions, scores their answers, and then shows the result that best matches those answers.

The center of the app is:

```txt
Questions -> Answer Scores -> Result
```

Everything else is optional machinery:

- ZIP code screening checks whether we serve the customer.
- Result gates can collect name, email, and ZIP before revealing the result.
- Lead capture collects contact and address details.
- ServiceTitan submission sends the lead to the booking workflow.
- Pricing turns the quiz into an estimator.
- Permit lookup adds local-code or municipality context.
- Recommendations may eventually connect quiz results to products.

For humans writing quizzes, start with the result you want the customer to see. Then work backwards into the questions and scores.

## The Three Building Blocks

Every quiz starts with three core pieces.

### 1. Results

Results are the possible outcomes a customer can get.

Examples:

- "Tankless may be a good fit"
- "A standard tank is probably better"
- "Either option could work, but we recommend a standard tank"
- "You may need a technician to inspect first"

Good results should feel:

- clear
- honest
- useful
- decisive enough to build trust

Write result copy like you are explaining the recommendation to a real customer.

### 2. Questions

Questions collect the information needed to choose a result.

Core questions affect the customer's result. These should usually be scored.

Helper questions collect information but do not affect the result. These usually should not be scored.

Helper questions include:

- name
- phone
- email
- address
- ZIP code screening
- tracking fields
- technician notes
- operational details

### 3. Scores

Scores are how answer choices push the customer toward a result.

For core quiz questions, every answer should usually add score toward one or more results. If an answer is neutral, give it an explicit score of `0`. That makes it clear the answer was intentionally neutral instead of accidentally unscored.

```json
{
  "value": "not_sure",
  "label": "I'm not sure",
  "scores": {
    "tankless_fit": 0,
    "standard_tank_fit": 0
  },
  "next": "followup_question"
}
```

Some answers can also branch to different follow-up questions. Branching and scoring can happen at the same time.

```json
{
  "value": "no_gas_service",
  "label": "No gas service",
  "scores": {
    "standard_tank_fit": 1,
    "tankless_fit": 0
  },
  "next": "electric_questions"
}
```

## Recommended Writing Process

Use this process before thinking about JSON.

1. Write the quiz goal.
2. Write the possible results.
3. Decide what each result means in plain English.
4. Write the core questions.
5. Score every core answer.
6. Add branches only where a question needs a different follow-up path.
7. Give every result a tie priority and tie-breaker reason.
8. Decide whether the quiz needs optional features like ZIP screening, lead capture, pricing, or permit lookup.
9. Ask ChatGPT to convert the outline into JSON using this guide.
10. Test the JSON with the app before publishing.

## Google Doc Template

Use this structure when writing a quiz in a Google Doc.

```txt
Quiz Name:

Goal:

Features Needed:
- Simple result quiz / ZIP filter / estimate
- Needs lead capture? yes/no
- Needs ServiceTitan? yes/no
- Needs pricing? yes/no
- Needs permit lookup? yes/no

Results:
1. result_id
   Title:
   Message:

2. result_id
   Title:
   Message:

Tie-Breakers:
- For each result, write:
  - Tie priority:
  - Tie-breaker reason:

Questions:
1. Question title
   Subtitle:
   Type: single select / multi select
   Image URL, if any:

   Answer:
   - Label:
   - Tooltip:
   - Image URL, if any:
   - Scores:
   - Next question:

2. Question title
   ...

Lead Capture:
- Name required?
- Phone required?
- Email required?
- Address required?

Out-of-Area Message, if needed:
```

This format is easier for non-engineers to write and easier for ChatGPT to convert.

## Quiz Types

Most quizzes fall into one of three buckets.

### 1. Simple Quiz

A simple quiz asks questions, scores the answers, and shows a result. It does not need pricing, permit lookup, ZIP filtering, or ServiceTitan submission.

Use this for:

- education quizzes
- "which option is right for me?" quizzes
- blog/page engagement quizzes
- quizzes where the user does not need to submit contact info

Typical features:

```json
"features": {
  "pricing": false,
  "permitLookup": false,
  "serviceAreaFilter": false,
  "serviceTitanBooking": false,
  "recommendations": false
}
```

Simple does not mean unweighted. Many simple quizzes should use weighted results, especially when the quiz uses `multi_select` questions or when several answers should influence the final recommendation.

### 2. ZIP Code Filter Quiz

A ZIP code filter quiz asks questions, collects a light result gate, shows the quiz result to everyone, and then only asks in-area users for booking/contact details.

Use this for:

- lead capture quizzes
- service availability quizzes
- quizzes that should only create ServiceTitan leads inside approved ZIP codes

Typical features:

```json
"features": {
  "pricing": false,
  "permitLookup": false,
  "serviceAreaFilter": true,
  "serviceTitanBooking": true,
  "recommendations": false
}
```

Best current funnel:

```txt
Quiz questions
-> result gate: name + email + ZIP
-> show result to everyone
-> if in area: phone + service address
-> ServiceTitan
-> if out of area: useful result + out-of-area guidance
```

The quiz should collect `addr_zip` in the result gate. The app checks the shared `service-area.json` list. If the ZIP is not approved, the user still sees their result, but the app does not ask for phone/address and does not send the lead to ServiceTitan.

### 3. Estimate Quiz

An estimate quiz asks questions, calculates pricing, may run permit/local-code logic, and submits a lead package to ServiceTitan.

Use this for:

- water heater estimates
- service estimates
- quote calculators
- flows where the price range is the main user value

Typical features:

```json
"features": {
  "pricing": true,
  "permitLookup": true,
  "serviceAreaFilter": false,
  "serviceTitanBooking": true,
  "recommendations": false
}
```

Estimate quizzes need more careful configuration because answer choices may affect score, price, permit requirements, result language, and the final ServiceTitan summary.

## Results And Scoring

Most quiz results should be scored. Core answer choices add points toward one or more results, and the app shows the highest-scoring result.

Example answer score:

```json
{
  "value": "unlimited_hot_water",
  "label": "Unlimited hot water",
  "scores": {
    "tankless_fit": 2,
    "standard_tank_fit": 0
  }
}
```

Another answer might add points in the other direction:

```json
{
  "value": "lowest_upfront_cost",
  "label": "Lowest upfront cost",
  "scores": {
    "tankless_fit": 0,
    "standard_tank_fit": 2
  }
}
```

To send the user to the highest-scoring result, put this on the final scoring question:

```json
{
  "id": "current_setup",
  "type": "single_select",
  "title": "What do you currently have?",
  "result_strategy": "highest_score",
  "next": "$winning_result",
  "options": []
}
```

### Result Definitions

Results live in the top-level `results` list.

```json
"results": [
  {
    "id": "tankless_fit",
    "title": "Tankless may be a good fit",
    "message": "Based on your answers, a tankless water heater may fit your goals.",
    "next_label": "Request Follow-Up",
    "next": "lead_capture"
  },
  {
    "id": "standard_tank_fit",
    "title": "A standard tank may be the better fit",
    "message": "Based on your answers, a standard tank may be simpler and more cost-effective.",
    "next_label": "Request Follow-Up",
    "next": "lead_capture"
  }
]
```

### Tied Results

If two or more results have the same highest score, the app treats that as a tie.

Tie-breaking belongs on the result itself.

Every result should include:

- `tie_priority`: required authoring field. Higher wins when tied.
- `tie_breaker_reason`: required authoring field. Customer-facing explanation shown when this result wins because of a tie.

```json
"results": [
  {
    "id": "tankless_fit",
    "title": "Tankless may be a good fit",
    "message": "Based on your answers, tankless may match your priorities.",
    "tie_priority": 10,
    "tie_breaker_reason": "Both could work, but we recommend tankless when long-term performance and unlimited hot water matter more than upfront cost."
  },
  {
    "id": "standard_tank_fit",
    "title": "A standard tank may be the better fit",
    "message": "Based on your answers, a standard tank may be simpler.",
    "tie_priority": 20,
    "tie_breaker_reason": "Both could work, but we recommend a standard tank because it usually has the lower upfront cost."
  }
]
```

When scores tie, the app chooses the tied result with the highest `tie_priority`. If tied results have the same priority, the app falls back to the first tied result listed in `results`.

### Scoring Guidelines

Keep scoring simple:

- use `0`, `1`, `2`, or `3` for most answers
- score every core answer
- use explicit `0` for neutral answers
- use branches when an answer needs a different follow-up path
- give every result a `tie_priority` instead of trying to make ties mathematically impossible

If the scoring needs a spreadsheet to understand, the quiz is probably overcomplicated.

## Question Types

### Single Select

Use `single_select` when the customer picks one answer from a list.

Use it when answers are mutually exclusive, like:

- tank vs. tankless
- garage vs. attic
- yes vs. no
- 1-2 people vs. 3-4 people vs. 5+ people

```json
{
  "id": "home_size",
  "type": "single_select",
  "title": "How many people live in your home?",
  "subtitle": "This helps estimate hot water demand.",
  "options": [
    {
      "value": "one_two",
      "label": "1-2 people",
      "scores": {
        "standard_tank_fit": 1,
        "tankless_fit": 0
      },
      "next": "current_setup"
    }
  ]
}
```

### Multi Select

Use `multi_select` when the customer can pick more than one answer.

Use it when multiple things can be true at once, like:

- priorities
- symptoms
- add-ons
- preferences

```json
{
  "id": "priorities",
  "type": "multi_select",
  "title": "What's most important to you?",
  "subtitle": "Choose up to 2.",
  "min_selected": 1,
  "max_selected": 2,
  "options": [
    {
      "value": "lower_upfront_cost",
      "label": "Lower upfront cost",
      "tooltip": "You want the simplest option with the lowest install cost.",
      "scores": {
        "standard_tank_fit": 2,
        "tankless_fit": 0
      }
    },
    {
      "value": "long_term_savings",
      "label": "Long-term savings",
      "tooltip": "You care more about efficiency over time.",
      "scores": {
        "standard_tank_fit": 0,
        "tankless_fit": 2
      }
    }
  ],
  "next": "home_size"
}
```

For multi-select questions, prefer putting `next` on the question itself, not on each answer. That keeps the path clear after the user chooses several options.

### Form

Use `form` to collect ZIP code, contact info, address, or other typed answers.

Form fields are usually helper data, not scoring data.

```json
{
  "id": "zip_screen",
  "type": "form",
  "title": "What's your ZIP code?",
  "subtitle": "We will check whether this quiz is available in your area.",
  "fields": [
    {
      "id": "addr_zip",
      "label": "ZIP code",
      "input_type": "text",
      "required": true,
      "placeholder": "75034",
      "autocomplete": "postal-code",
      "pattern": "^\\d{5}(-\\d{4})?$",
      "pattern_msg": "Use a 5-digit ZIP"
    }
  ],
  "next_label": "Check Area",
  "next": "lead_capture"
}
```

Common field settings:

- `id`: where this answer is stored
- `label`: visible field label
- `input_type`: usually `text`, `tel`, `email`, or `textarea`
- `required`: `true` or `false`
- `placeholder`: lighter sample text
- `autocomplete`: browser autofill hint
- `pattern`: optional validation rule
- `pattern_msg`: error message when the pattern fails

## Flow And Branching

Every question can point to the next question.

```json
{
  "value": "not_sure",
  "label": "I'm not sure",
  "scores": {
    "tankless_fit": 0,
    "standard_tank_fit": 0
  },
  "next": "followup_question"
}
```

Rules:

- every `next` value must match another question `id`, a result `id`, or `$winning_result`
- every question `id` must be unique
- every result `id` must be unique
- `start` must match the first question's `id`
- keep IDs lowercase and predictable

## Images

Question images are optional. A question image appears near the top of the question, usually under the title/subtitle and above the answer choices.

```json
"image_url": "https://example.com/question-image.jpg"
```

Use question images when the whole question needs visual context.

Answer images are also optional. An answer image appears inside that specific answer choice.

```json
{
  "value": "tankless",
  "label": "Tankless",
  "image_url": "https://example.com/tankless.jpg",
  "next": "zip_screen"
}
```

Use answer images when the choices themselves are visual, like tank vs. tankless, attic vs. garage, or product options.

If a question or answer does not have an `image_url`, the app should not show an image placeholder.

## Tooltips

Tooltips are optional helper text for answer choices. They help explain an answer without making the quiz feel too wordy.

```json
{
  "value": "hybrid",
  "label": "Hybrid water heater",
  "tooltip": "A heat pump water heater that uses electricity more efficiently.",
  "scores": {
    "tankless_fit": 1,
    "standard_tank_fit": 0
  },
  "next": "zip_screen"
}
```

Use tooltips for:

- technical terms
- "I don't know" guidance
- code or permit-related notes
- brief explanations of why an answer matters

Avoid using tooltips for required information. If the user must read it, put it in the main label or subtitle instead.

## Optional Features

### Result Gate

Use a result gate when the quiz should collect basic lead information before revealing the result.

Recommended universal result gate fields:

- `contact_name`
- `contact_email`
- `addr_zip`

Example:

```json
{
  "id": "result_gate",
  "type": "form",
  "title": "Where should we send your result?",
  "subtitle": "Enter your name, email, and ZIP code to see your recommendation.",
  "result_gate": true,
  "fields": [
    { "id": "contact_name", "label": "Name", "input_type": "text", "required": true },
    { "id": "contact_email", "label": "Email", "input_type": "email", "required": true, "type": "email" },
    { "id": "addr_zip", "label": "ZIP code", "input_type": "text", "required": true }
  ],
  "next_label": "See My Result",
  "next": "$winning_result"
}
```

The scoring question before this gate should calculate the winning result but route to the gate:

```json
{
  "id": "final_scoring_question",
  "type": "single_select",
  "result_strategy": "highest_score",
  "next": "result_gate",
  "options": []
}
```

### Result Availability

Result availability changes the action after the result, not the result itself.

Answers decide the result. ZIP decides what we can do with that result.

```json
{
  "id": "hydro_jetting_fit",
  "title": "Hydro Jetting Is Right For You",
  "message": "Based on your answers, hydro jetting is probably the right direction.",
  "tie_priority": 20,
  "tie_breaker_reason": "Both could work, but we recommend hydro jetting when symptoms suggest a deeper blockage.",
  "availability": {
    "in_area": {
      "message": "Mother serves your ZIP code and can help with this.",
      "next_label": "Get Help With This",
      "next": "booking_capture"
    },
    "out_of_area": {
      "message": "Mother is not serving your ZIP code yet, so we cannot book this through our team right now.",
      "advice": "Your result is still useful. Ask a local plumber whether they include a camera inspection before hydro jetting.",
      "next": null
    }
  }
}
```

### Service Area

For normal quizzes, do not put ZIP lists inside the quiz config. Turn on:

```json
"serviceAreaFilter": true
```

The app will load the shared `service-area.json` file and check the submitted `addr_zip`.

The shared service-area file controls:

- approved ZIP codes
- approved ZIP prefixes
- out-of-area title
- out-of-area message

Only add a `serviceArea` object inside a quiz config if that quiz needs custom out-of-area copy or special rules.

### Booking Capture

For quizzes that submit to ServiceTitan, collect phone and service address after an in-area result CTA.

```json
{
  "id": "booking_capture",
  "type": "form",
  "title": "Want help with this?",
  "subtitle": "You're in our service area. Share your phone and service address so we can follow up.",
  "fields": [
    { "id": "contact_phone", "label": "Phone", "input_type": "tel", "required": true, "type": "phone", "min_digits": 10 },
    { "id": "addr_street", "label": "Street", "input_type": "text", "required": true },
    { "id": "addr_unit", "label": "Unit", "input_type": "text", "required": false },
    { "id": "addr_city", "label": "City", "input_type": "text", "required": true },
    { "id": "addr_state", "label": "State", "input_type": "text", "required": true }
  ],
  "next_label": "Submit Quiz",
  "submit_label": "Submit Quiz",
  "pending_label": "Submitting...",
  "submit_on_next": true
}
```

Canonical lead fields:

- `contact_name`
- `contact_phone`
- `contact_email`
- `addr_street`
- `addr_unit`
- `addr_city`
- `addr_state`
- `addr_zip`
- `addr_country`

`contact_name`, `contact_email`, and `addr_zip` can be collected earlier in the result gate. The app still includes them in the final lead package.

Use `submit_on_next: true` on the final form when you want the button to submit the lead instead of navigating to a separate review step.

### Pricing

Pricing is only used when:

```json
"pricing": true
```

Pricing configs can include base prices and answer-level adjustments. Basic quizzes should leave pricing off.

When pricing is enabled, pricing data is included in the customer-facing estimate and in the ServiceTitan lead summary.

### Permit Lookup

Permit lookup is only used when:

```json
"permitLookup": true
```

This is for advanced estimator flows that need city/local-code information. Basic quizzes should leave permit lookup off.

### ServiceTitan

When `serviceTitanBooking` is enabled and the ZIP is in the service area, the app sends a normalized lead package to Vercel.

The ServiceTitan summary is plain text and includes sections like:

- Quiz Submitted
- Customer
- Service Address
- Quiz Answers
- Pricing, when enabled
- Permit, when enabled
- Recommendation / Result
- Page / Tracking

The quiz answers section uses human-readable question and answer labels, not just raw IDs.

Do not put ServiceTitan secrets, API keys, client IDs, or client secrets in a quiz config.

## JSON Reference

Each quiz is controlled by one JSON config file. The same `app.js` can run many different quizzes by loading a different config.

A typical config starts like this:

```json
{
  "meta": {
    "estimatorId": "sample-basic-quiz",
    "serviceName": "Sample basic quiz",
    "version": "basic-quiz-v1"
  },
  "estimatorId": "sample-basic-quiz",
  "quizName": "Should I Buy a Tankless?",
  "serviceName": "Sample basic quiz",
  "features": {
    "pricing": false,
    "permitLookup": false,
    "serviceAreaFilter": true,
    "serviceTitanBooking": true,
    "recommendations": false
  },
  "start": "first_question_id",
  "questions": [],
  "results": []
}
```

Important fields:

- `estimatorId`: stable internal ID for this quiz. Use lowercase words with hyphens.
- `quizName`: customer-facing quiz name.
- `serviceName`: what this lead is about.
- `features`: turns app modules on or off.
- `start`: the ID of the first question.
- `questions`: the list of question steps.
- `results`: possible quiz outcomes.

## Feature Flags

Use feature flags instead of thinking about "quiz mode" or "estimator mode."

```json
"features": {
  "pricing": false,
  "permitLookup": false,
  "serviceAreaFilter": true,
  "serviceTitanBooking": true,
  "recommendations": false
}
```

Feature meanings:

- `pricing`: shows price preview and includes pricing in the lead summary.
- `permitLookup`: runs the permit/local rules lookup.
- `serviceAreaFilter`: checks the ZIP code against the shared service-area list.
- `serviceTitanBooking`: allows the final lead to be sent to ServiceTitan.
- `recommendations`: reserved for future CMS/product recommendations.

## Current vs. Planned Support

The current app already supports:

- `single_select` questions
- `multi_select` questions
- `form` questions
- ZIP/service-area screening
- optional pricing
- optional permit lookup
- ServiceTitan lead submission
- question and answer images
- answer tooltips
- generic result screens
- weighted result scoring
- tie-breaker results

The following ideas are useful for quiz planning, but should be treated as planned structure until the app is updated to support them directly:

- CMS-backed product recommendations

If a quiz needs one of the planned items, write it clearly in the outline anyway. That makes it easier to implement the missing app support cleanly.

## Common Mistakes

Avoid these:

- starting with questions before defining results
- leaving core answer choices unscored
- using missing scores when the answer should be explicitly neutral with `0`
- putting API secrets in a config file
- using duplicate question IDs
- using duplicate result IDs
- setting `start` to an ID that does not exist
- sending an answer `next` to an ID that does not exist
- forgetting required lead fields on a ServiceTitan quiz
- using invalid JSON, such as comments, trailing commas, or single quotes
- making a basic quiz with pricing or permit lookup turned on by accident

## Before You Hand This To ChatGPT

Check:

- results are written first
- every result has an `id`, `title`, and `message`
- every result has `tie_priority` and `tie_breaker_reason`
- every core answer has `scores`
- neutral core answers use explicit `0`
- every branch has a clear `next`
- helper fields are not scored
- ZIP screening is included if the quiz needs service-area filtering
- lead capture is included if the quiz needs ServiceTitan
- pricing and permit lookup are only enabled when truly needed

## Prompt For ChatGPT

Use this when asking ChatGPT to convert a written quiz into JSON:

```txt
Convert this quiz outline into a JSON config for the estimator/quiz app.

Follow QUIZ_CONFIG_GUIDE.md.
Quizzes show results, and results are scored from the user's answers.
Define the results first, then questions, then answer scores.
Use feature flags, not quiz/estimator mode.
Use lowercase snake_case for question IDs, answer values, and result IDs.
Score every core answer choice.
Use explicit 0 scores for neutral core answers.
Give every result a tie_priority and tie_breaker_reason.
Use canonical lead field IDs for contact and address fields.
Collect addr_zip before lead capture if serviceAreaFilter is enabled.
Use submit_on_next: true on the final lead capture form.
Do not include ServiceTitan secrets or API keys.
Return valid JSON only, with double quotes and no comments.
```
