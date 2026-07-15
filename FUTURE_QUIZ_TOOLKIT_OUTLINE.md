# Future Quiz Toolkit Outline

This note is a starting point for future conversations about turning the current water heater estimator into a more reusable quiz/estimator toolkit. It is intentionally planning-level only.

## Current App Shape

The current estimator combines several responsibilities:

- loading a config file
- rendering quiz questions and answers
- tracking answers and navigation
- calculating progress
- showing a price preview
- doing permit/local lookup behavior
- collecting lead/contact details
- submitting a lead package to Vercel
- mapping that lead package into a ServiceTitan booking

This is workable for one estimator, but it becomes harder to reuse as we add more estimators, products, permit logic, or recommendation behavior.

## Principle

Separate generic quiz mechanics from business-specific estimator behavior.

The quiz engine should know how to move through questions, store answers, validate steps, and display screens. It should not need to know what a water heater is, how ServiceTitan works, or how permit rules are priced.

## Proposed Layers

### 1. Config Loader

Responsible for:

- loading the JSON config
- applying safe defaults
- validating required config fields
- exposing normalized quiz data to the app

The config should define content and branching, not contain confidential integration settings.

### 2. Quiz Runtime

Responsible for:

- current step
- selected answer
- completed answers
- back/next behavior
- branching rules
- step completion
- final state

This should be reusable for any estimator-style quiz.

### 3. Progress Calculator

Responsible for:

- calculating progress independently from the renderer
- supporting branched question paths
- using longest-path logic unless we later choose a different UX
- updating progress only when a question is completed

This keeps progress logic out of the visual rendering code.

### 4. Pricing / Result Engine

Responsible for computed outputs such as:

- exact total
- generated customer-facing price range
- price display state
- included line items
- required add-ons
- optional add-ons
- warnings or assumptions

For pricing, `exact` should be treated as the real estimate value. The displayed low/high range is a range-generation strategy. This lets the same quiz engine price water heaters, drain cleaning, or other services without knowing the service category.

Near-term functions:

- `calculatePrice()`: reads selected answers and returns the real exact estimate plus line items.
- `generatePriceRange()`: creates the customer-facing low/high range from the exact estimate unless a config explicitly says otherwise.
- `getPriceDisplayState()`: decides whether the customer should see an empty state, estimated range, or exact total.

The renderer should display pricing results, not calculate them directly.

### 5. Permit / Local Rules Resolver

Responsible for:

- city or municipality lookup
- permit requirements
- local code rules
- conditional follow-up questions
- required equipment or install notes

This should eventually be able to read from a permit table or CMS-backed source.

### 6. Recommendation Engine

Future responsibility:

- recommend specific products
- pull product data from Webflow CMS or another public data source
- attach product-specific line items
- explain why a product was recommended

This should stay separate from the core quiz runtime.

### 7. Renderer / UI Components

Responsible for:

- question screen
- answer choices
- discrete slider inputs
- question images
- answer thumbnails
- progress bar
- price preview
- review screen
- lead form
- success/failure messaging

The renderer should receive state and computed results, then display them. It should avoid owning business rules.

### 8. Lead Package Builder

Responsible for turning quiz state into a generic lead package:

- customer/contact info
- address
- selected answers
- computed estimate
- permit result
- page URL
- timestamp
- estimator metadata

This should still avoid ServiceTitan-specific secrets or credentials.

### 9. Submission Adapter

Responsible for sending the generic lead package somewhere.

Current destination:

- Vercel `/api/bookings`
- ServiceTitan booking creation

Possible future destinations:

- ServiceTitan lead
- email notification
- CRM webhook
- database
- Google Sheet
- analytics event

## Possible Future File Structure

```txt
app.js
estimator.css
configs/
  water-heater.json
  tankless.json
  solar-water-heater.json
core/
  config.js
  state.js
  navigation.js
  progress.js
  renderer.js
features/
  pricing.js
  permits.js
  recommendations.js
  leadPackage.js
integrations/
  submitLead.js
api/
  bookings.js
```

This is not a required structure. It is a discussion anchor.

## Near-Term Refactor Candidates

These are the most likely pieces to extract first, because they are already easy to blur together:

- progress calculation out of rendering
- pricing calculation, range generation, and price display-state logic out of rendering
- permit lookup into its own module
- lead package creation into its own module
- ServiceTitan mapping kept inside Vercel/server code

## Design Guardrails

- Keep configs simple for non-developers to understand.
- Do not add abstractions until they remove real complexity.
- Keep confidential values in Vercel, not browser config.
- Let configs control content, labels, branching, and safe metadata.
- Let feature modules calculate results.
- Let the renderer display state, not invent business rules.

## Open Questions

- Should each estimator have only one pricing engine, or should pricing be declared in config?
- How much product recommendation logic should live in Webflow CMS versus app code?
- Should permit rules be static JSON, CMS-driven, or API-driven?
- Should progress always use longest-path logic, or should certain quizzes define custom progress behavior?
- Should the final review screen be generic, or should each estimator define its own review sections?
- What lead destinations besides ServiceTitan will matter later?
