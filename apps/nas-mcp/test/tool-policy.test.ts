import assert from "node:assert/strict";
import test from "node:test";
import { findToolByName } from "../src/nas-tools.js";
import { runPredefinedTool } from "../src/index.js";
import { fakeHttpServer } from "./test-server.js";

function setNas(index: 1 | 2, url: string): void {
  process.env[`NAS_EDGE${index}_API_URL`] = url;
  process.env[`NAS_EDGE${index}_API_SECRET`] = `secret-${index}`;
  process.env[`NAS_EDGE${index}_API_SIGNING_KEY`] = `signing-${index}`;
}

test("NAS-003 target both starts both NAS requests concurrently", async () => {
  let arrivals = 0;
  const waiters: Array<() => void> = [];
  const handler = (_req: unknown, res: { end: (body: string) => void }) => {
    arrivals += 1;
    waiters.push(() => res.end(JSON.stringify({ stdout: "ok", stderr: "", exit_code: 0 })));
    if (arrivals === 2) waiters.splice(0).forEach((done) => done());
  };
  const a = await fakeHttpServer(handler);
  const b = await fakeHttpServer(handler);
  setNas(1, a.url);
  setNas(2, b.url);
  const tool = findToolByName("check_disk_space");
  assert.ok(tool);
  const result = await Promise.race([runPredefinedTool(tool, { target: "both" }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("requests were serial")), 500))]);
  assert.match(result.content[0].text, /edgesynology1[\s\S]*edgesynology2/);
  await a.close();
  await b.close();
});

test("NAS-007 write operation previews, confirms, and carries approval token", async () => {
  let execs = 0;
  let approval = "";
  const fake = await fakeHttpServer((req, res, body) => {
    if (req.url === "/preview") {
      res.end(JSON.stringify({ tier: 2, blocked: false, summary: "allowed" }));
      return;
    }
    execs += 1;
    approval = String(JSON.parse(body).approval_token ?? "");
    res.end(JSON.stringify({ stdout: "ok", stderr: "", exit_code: 0 }));
  });
  setNas(1, fake.url);
  delete process.env.NAS_EDGE2_API_URL;
  const tool = findToolByName("restart_monitor_agent");
  assert.ok(tool);
  const preview = await runPredefinedTool(tool, { target: "edgesynology1" });
  assert.match(preview.content[0].text, /requires your approval/);
  assert.equal(execs, 0);
  const executed = await runPredefinedTool(tool, {
    target: "edgesynology1",
    confirmed: true,
  });
  assert.match(executed.content[0].text, /ok/);
  assert.equal(execs, 1);
  assert.ok(approval.length > 20);
  await fake.close();
});
