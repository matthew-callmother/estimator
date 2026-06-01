# Todo

- Pull `campaignId` from the page's UTM campaign value and map it into the ServiceTitan booking payload. Do not expose ServiceTitan secrets in browser code.
- Fix the price range generator so estimate ranges are accurate and easy to reason about.
- Fix the final review screen before submission.
- Update the permitting architecture and config so permit rules are easier to maintain per estimator/market.
- Route out-of-area quiz leads to email/list software instead of ServiceTitan.
- Add CMS-backed product and recommendation lookup for quizzes that recommend a specific product.
- Add product/line-item pricing output for recommended products and required add-ons.
- Add service-area management beyond config-based ZIP lists.
- Add generic non-pricing result screens for quizzes that do not produce estimates.
- Keep ServiceTitan lead summaries in reusable plain-text sections as modules append data.
