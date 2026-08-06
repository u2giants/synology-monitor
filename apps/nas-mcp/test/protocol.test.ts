import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { createNasMcpServer } from "../src/index.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("Step 4 shared protocol contract remains complete and versioned", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/protocol-conformance-contract.json", import.meta.url), "utf8"));
  assert.equal(fixture.wireRevision, "2026-07-28");
  assert.equal(fixture.cases.length, 21);
  assert.equal(new Set(fixture.cases.map((item: { id: string }) => item.id)).size, 21);
});

test("MCP20260728-014 health is public-shaped and redacts secrets", async () => {
  const server = createNasMcpServer({ testMode: true });
  const response = await server.getApp().request("http://localhost/health", {
    headers: {
      host: "localhost",
      "mcp-session-id": "stale-secret",
      authorization: "Bearer secret",
    },
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.doesNotMatch(raw, /stale-secret|Bearer|apiSecret|signing/i);
});

test("MCP20260728-008 bogus legacy session header is harmless to independent health requests", async () => {
  const app = createNasMcpServer({ testMode: true }).getApp();
  const one = await app.request("http://localhost/health", {
    headers: { host: "localhost", "mcp-session-id": "bogus-a" },
  });
  const two = await app.request("http://localhost/health", {
    headers: { host: "localhost", "mcp-session-id": "bogus-b" },
  });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
});

test("HTTP MCP route returns exact missing and invalid bearer challenges", async () => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_PORT: String(port),
      MCP_BEARER_TOKEN: "right",
      MCP_ALLOWED_HOSTS: "localhost",
      NAS_EDGE1_API_URL: "http://127.0.0.1:1",
      NAS_EDGE1_API_SECRET: "fake",
      NAS_EDGE1_API_SIGNING_KEY: "fake",
      NAS_EDGE2_API_URL: "http://127.0.0.1:1",
      NAS_EDGE2_API_SECRET: "fake",
      NAS_EDGE2_API_SIGNING_KEY: "fake",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test MCP server did not start")), 5_000);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("listening on port")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`test MCP server exited ${code}`));
      });
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    for (const [authorization, expected] of [
      [undefined, 'Bearer realm="nas-mcp"'],
      ["Bearer wrong", 'Bearer realm="nas-mcp", error="invalid_token"'],
    ] as const) {
      const headers: Record<string, string> = {
        host: "localhost",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (authorization) headers.authorization = authorization;
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), expected);
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
