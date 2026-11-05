import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_IDS, checkSearchEmbeddings } from "./search-embedding-watchdog.mjs";
const env = { POPDAM_SUPABASE_URL: "https://pop.invalid", POPDAM_SUPABASE_SERVICE_ROLE_KEY: "fixture-source", NEXT_PUBLIC_SUPABASE_URL: "https://monitor.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture-monitor" };
function mock() {
  const alerts = new Map(); let rows = [{ corpus: "dam", pending: 2, errored: 1, stale: true }, { corpus: "popsg", pending: 0, errored: 0, stale: false }];
  let failed = false; let writes = 0;
  return { alerts, get writes() { return writes; }, set rows(value) { rows = value; }, set failed(value) { failed = value; },
    fetch: async (url, options) => {
      if (url.includes("pop.invalid")) return new Response(JSON.stringify(rows), { status: failed ? 503 : 200 });
      const id = new URL(url).searchParams.get("id")?.slice(3);
      if (!options.method) return new Response(JSON.stringify(alerts.has(id) ? [alerts.get(id)] : []));
      const body = JSON.parse(options.body); writes++;
      if (options.method === "POST") alerts.set(body.id, body);
      else alerts.set(id, { ...alerts.get(id), ...body });
      return new Response(null, { status: 204 });
    } };
}
test("stalled alert appears once and clears after progress", async () => {
  const m = mock(); await checkSearchEmbeddings(env, m.fetch);
  assert.equal(m.alerts.get(ALERT_IDS.dam).status, "active"); assert.equal(m.writes, 1);
  await checkSearchEmbeddings(env, m.fetch); assert.equal(m.writes, 1);
  m.rows = [{ corpus: "dam", pending: 1, errored: 1, stale: false }, { corpus: "popsg", pending: 0, errored: 0, stale: false }];
  await checkSearchEmbeddings(env, m.fetch); assert.equal(m.alerts.get(ALERT_IDS.dam).status, "resolved");
});
test("outage preserves stall and raises unavailable, healthy response clears both", async () => {
  const m = mock(); await checkSearchEmbeddings(env, m.fetch); m.failed = true;
  await checkSearchEmbeddings(env, m.fetch);
  assert.equal(m.alerts.get(ALERT_IDS.dam).status, "active"); assert.equal(m.alerts.get(ALERT_IDS.unavailable).status, "active");
  m.failed = false; m.rows = [{ corpus: "dam", pending: 0, errored: 1, stale: false }, { corpus: "popsg", pending: 0, errored: 0, stale: false }];
  await checkSearchEmbeddings(env, m.fetch);
  assert.equal(m.alerts.get(ALERT_IDS.dam).status, "resolved"); assert.equal(m.alerts.get(ALERT_IDS.unavailable).status, "resolved");
});
test("malformed counts never clear an existing stall", async () => {
  const m = mock(); await checkSearchEmbeddings(env, m.fetch); m.rows = [{ corpus: "dam", pending: null, errored: 0, stale: false }];
  await checkSearchEmbeddings(env, m.fetch); assert.equal(m.alerts.get(ALERT_IDS.dam).status, "active");
});
test("unconfigured integration performs no requests", async () => {
  assert.deepEqual(await checkSearchEmbeddings({}, () => { throw new Error("unexpected request"); }), { enabled: false });
});
