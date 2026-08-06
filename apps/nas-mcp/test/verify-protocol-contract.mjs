import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifestUrl = new URL("./fixtures/protocol-conformance-contract.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(message) {
  throw new Error(`Protocol contract verification failed: ${message}`);
}

if (manifest.contractVersion !== "1.0.0") fail("unexpected contractVersion");
if (manifest.wireRevision !== "2026-07-28") fail("unexpected wireRevision");
if (manifest.digestAlgorithm !== "sha256") fail("unsupported digest algorithm");
if (!Array.isArray(manifest.cases) || manifest.cases.length !== 21) {
  fail("manifest must contain exactly 21 cases");
}

const expectedIds = [
  "MCP20260728-001-discover-supported-revisions",
  "MCP20260728-002-july-request-with-per-request-meta",
  "MCP20260728-003-supported-legacy-client-initializes",
  "MCP20260728-004-unsupported-version-error",
  "MCP20260728-005-july-client-needs-no-initialize",
  "MCP20260728-006-missing-static-bearer-challenge",
  "MCP20260728-007-invalid-static-bearer-challenge",
  "MCP20260728-008-bogus-session-header-is-harmless",
  "MCP20260728-009-deterministic-cacheable-tools-list",
  "MCP20260728-010-result-type-and-server-info",
  "MCP20260728-011-disconnect-stops-or-transfers-work",
  "MCP20260728-012-restart-between-independent-calls",
  "MCP20260728-013-deadline-error-and-work-stopped",
  "MCP20260728-014-health-redacts-sensitive-data",
  "MCP20260728-015-host-origin-validation",
  "MCP20260728-016-legacy-sse-transition",
  "MCP20260728-017-proxy-and-bridge-compatibility",
  "MCP20260728-018-required-method-and-name-headers",
  "MCP20260728-019-subscriptions-listen-and-legacy-get",
  "MCP20260728-020-may-server-not-initialized-hang-regression",
  "MCP20260728-021-cross-repo-contract-digest",
];
const ids = manifest.cases.map((testCase) => testCase.id);
if (new Set(ids).size !== ids.length) fail("case IDs must be unique");
for (const [index, expectedId] of expectedIds.entries()) {
  if (ids[index] !== expectedId) fail(`case ${index + 1} must be ${expectedId}`);
  if (!manifest.cases[index].summary || !manifest.cases[index].assertions?.length) {
    fail(`case ${ids[index]} must define a summary and assertions`);
  }
}

const digestInput = {
  contractVersion: manifest.contractVersion,
  wireRevision: manifest.wireRevision,
  cases: manifest.cases,
};
const actualDigest = createHash("sha256")
  .update(canonicalJson(digestInput))
  .digest("hex");
if (actualDigest !== manifest.expectedDigest) {
  fail(`digest mismatch: expected ${manifest.expectedDigest}, got ${actualDigest}`);
}

console.log(`Protocol contract ${manifest.contractVersion}: 21 cases, sha256:${actualDigest}`);
