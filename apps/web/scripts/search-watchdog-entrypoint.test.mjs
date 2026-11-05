import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function run(issue, watchdog) {
  const fixture = mkdtempSync(join(tmpdir(), "search-entrypoint-"));
  const bin = join(fixture, "bin"); mkdirSync(bin);
  try {
    const script = readFileSync(new URL("../docker-entrypoint.sh", import.meta.url), "utf8").replace("cd /app/apps/web", `cd '${fixture}'`);
    writeFileSync(join(fixture, "entrypoint.sh"), script);
    writeFileSync(join(bin, "npx"), '#!/bin/sh\nif [ "$RUN_SEARCH_EMBEDDING_WATCHDOG" = "true" ] || [ "$RUN_ISSUE_WORKER" = "true" ]; then exec sleep 30; fi\nprintf "web-only"\n', { mode: 0o700 });
    writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "$*" >> events\nexit 0\n', { mode: 0o700 });
    const result = spawnSync("sh", [join(fixture, "entrypoint.sh")], { encoding: "utf8", timeout: 7000,
      env: { ...process.env, PATH: bin + ":" + process.env.PATH, RUN_ISSUE_WORKER: issue, RUN_SEARCH_EMBEDDING_WATCHDOG: watchdog } });
    let events = ""; try { events = readFileSync(join(fixture, "events"), "utf8"); } catch {}
    return { ...result, events };
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}
test("both optional workers disabled preserves web-only startup", () => {
  const result = run("false", "false"); assert.equal(result.status, 0); assert.equal(result.stdout, "web-only"); assert.equal(result.events, "");
});
test("watchdog starts without AI worker; dead watchdog fails container for restart", () => {
  const result = run("false", "true"); assert.equal(result.status, 1); assert.match(result.events, /search-embedding-watchdog-worker/); assert.doesNotMatch(result.events, /scripts\/issue-worker/);
});
test("existing AI worker remains supervised when separately enabled", () => {
  const result = run("true", "false"); assert.equal(result.status, 1); assert.match(result.events, /scripts\/issue-worker/); assert.doesNotMatch(result.events, /search-embedding-watchdog-worker/);
});
