import assert from "node:assert/strict";
import test from "node:test";
import { NAS_CLIENT_LIMITS, nasExec, nasPreview, type NasConfig } from "../src/nas-client.js";
import { fakeHttpServer } from "./test-server.js";

const config = (url: string): NasConfig => ({
  name: "fake",
  url,
  apiSecret: "test",
  approvalSigningKey: "test",
});

test("NAS-001 exec timeout is clamped to 25 seconds", async () => {
  let received = 0;
  const fake = await fakeHttpServer((_req, res, body) => {
    received = JSON.parse(body).timeout_ms;
    res.end(JSON.stringify({ stdout: "ok", stderr: "", exit_code: 0 }));
  });
  try {
    await nasExec(config(fake.url), "true", 1, undefined, 999_999);
  } finally {
    await fake.close();
  }
  assert.equal(received, 25_000);
});

test("NAS-002 publishes preview, exec, and HTTP buffer bounds", () => {
  assert.deepEqual(NAS_CLIENT_LIMITS, {
    maxExecTimeoutMs: 25_000,
    previewTimeoutMs: 8_000,
    httpBufferMs: 5_000,
  });
});

test("NAS-004 abort destroys an in-flight NAS request", async () => {
  let disconnected = false;
  const fake = await fakeHttpServer((req) => {
    req.on("close", () => {
      disconnected = true;
    });
  });
  const controller = new AbortController();
  const pending = nasPreview(config(fake.url), "true", {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /aborted/i);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disconnected, true);
  await fake.close();
});
