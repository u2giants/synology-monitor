import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeActiveAlert } from "./active-alerts";
test("stall, clear and same-ID recurrence stays visible without reload", () => {
  const alert = { id: "stable", status: "active", created_at: "2026-11-05T00:00:00Z" };
  let active = mergeActiveAlert([], alert);
  assert.equal(active.length, 1);
  active = mergeActiveAlert(active, { ...alert, status: "resolved" });
  assert.equal(active.length, 0);
  active = mergeActiveAlert(active, { ...alert, created_at: "2026-11-05T03:00:00Z" });
  assert.equal(active.length, 1);
  active = mergeActiveAlert(active, alert);
  assert.equal(active.length, 1);
});
test("active alerts remain newest first and inactive updates remove them", () => {
  const old = { id: "old", status: "active", created_at: "2026-11-05T00:00:00Z" };
  const recent = { id: "recent", status: "active", created_at: "2026-11-05T02:00:00Z" };
  assert.deepEqual(mergeActiveAlert([recent], old).map(a => a.id), ["recent", "old"]);
  assert.deepEqual(mergeActiveAlert([old], { ...old, status: "acknowledged" }), []);
});
