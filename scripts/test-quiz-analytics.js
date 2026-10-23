const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function sourceSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Missing analytics source: ${startMarker}`);
  return source.slice(start, end);
}

function createEmitter() {
  const dispatched = [];
  const context = {
    window: { dispatchEvent: (event) => dispatched.push(event) },
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    }
  };
  // The app is an unbundled browser IIFE; load only its self-contained event builder.
  const script = [
    sourceSection("  const ANALYTICS_FIELDS =", "\n\n  /* ---------------- Helpers"),
    sourceSection("  function emitQuizEvent(", "\n  function getConfigUrl()"),
    "globalThis.emitQuizEvent = emitQuizEvent;"
  ].join("\n");
  vm.runInNewContext(script, context);
  return { emit: context.emitQuizEvent, dataLayer: () => context.window.dataLayer, dispatched };
}

test("quiz events keep only approved, reportable fields", () => {
  const { emit, dataLayer, dispatched } = createEmitter();
  emit("estimator_answer", {
    estimator_id: "tankless-or-not",
    step_id: "demand",
    question_id: "people",
    answer_id: "three_four",
    answer_label: "3-4 people",
    name: "Jane Doe",
    email: "jane@example.com",
    zip: "75225",
    answers: { contact_email: "jane@example.com" },
    pageUrl: "https://example.com/?email=jane@example.com"
  });

  const event = JSON.parse(JSON.stringify(dataLayer()[0]));
  assert.deepEqual(event, {
    event: "estimator_answer",
    estimator_id: "tankless-or-not",
    step_id: "demand",
    question_id: "people",
    answer_id: "three_four",
    answer_label: "3-4 people"
  });
  assert.equal(dispatched[0].detail, dataLayer()[0]);
});

test("numeric slider values survive while invalid values do not", () => {
  const { emit, dataLayer } = createEmitter();
  emit("estimator_answer", { answer_value: 75, status_code: Infinity, answer_label: "x".repeat(120) });
  const event = JSON.parse(JSON.stringify(dataLayer()[0]));
  assert.equal(event.answer_value, 75);
  assert.equal(event.answer_label.length, 100);
  assert.equal(Object.hasOwn(event, "status_code"), false);
});

