"use strict";

async function run() {
  const url = requireEnv("SYNC_TEST_URL");
  const authorization = requireEnv("SYNC_TEST_AUTH");
  const bypass = requireEnv("SYNC_TEST_BYPASS");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authorization}`,
      "x-vercel-protection-bypass": bypass
    },
    signal: AbortSignal.timeout(120000)
  });
  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 2000) };
  }

  console.log(JSON.stringify({ status: response.status, body }, null, 2));
  if (!response.ok) process.exitCode = 1;
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

run().catch((error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
