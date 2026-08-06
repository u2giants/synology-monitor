import assert from "node:assert/strict";
import test from "node:test";
import { jobHttp } from "../src/job-client.js";
import type { NasConfig } from "../src/nas-client.js";
import { fakeHttpServer } from "./test-server.js";

test("job client cancellation destroys its underlying request", async () => {
  let disconnected = false;
  const fake = await fakeHttpServer((req) => {
    req.on("close", () => {
      disconnected = true;
    });
  });
  const cfg: NasConfig = {
    name: "fake",
    url: fake.url,
    apiSecret: "test",
    approvalSigningKey: "test",
  };
  const controller = new AbortController();
  const pending = jobHttp(cfg, "GET", "/jobs/inventory", {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /aborted/i);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disconnected, true);
  await fake.close();
});
