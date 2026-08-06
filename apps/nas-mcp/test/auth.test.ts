import assert from "node:assert/strict";
import test from "node:test";
import { authenticateBearer, createNasMcpServer, validateRuntimeConfig } from "../src/index.js";

test("production configuration fails closed", () => {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("NAS_EDGE") || key.startsWith("MCP_")) delete process.env[key];
  assert.throws(() => validateRuntimeConfig(), /MCP_BEARER_TOKEN.*NAS_EDGE1_API_URL.*NAS_EDGE2_API_SIGNING_KEY/);
  process.env = saved;
});

test("explicit test mode permits isolated construction without secrets", async () => {
  const server = createNasMcpServer({ testMode: true });
  const response = await server.getApp().request("http://localhost/health", { headers: { host: "localhost" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, "nas-mcp");
});

test("missing and invalid bearer challenges are exact", () => {
  for (const [value, expected] of [
    [undefined, 'Bearer realm="nas-mcp"'],
    ["Bearer wrong", 'Bearer realm="nas-mcp", error="invalid_token"'],
  ] as const) {
    assert.throws(
      () => authenticateBearer(value, "right"),
      (error: unknown) => {
        assert.ok(error instanceof Response);
        assert.equal(error.status, 401);
        assert.equal(error.headers.get("WWW-Authenticate"), expected);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => authenticateBearer("Bearer right", "right"));
});

test("Host and Origin are allowlisted; missing Origin is accepted", async () => {
  process.env.MCP_ALLOWED_ORIGINS = "https://client.example";
  const server = createNasMcpServer({ testMode: true });
  const app = server.getApp();
  assert.notEqual(
    (
      await app.request("http://localhost/mcp", {
        headers: { host: "localhost" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request("http://localhost/mcp", {
        headers: { host: "evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request("http://localhost/mcp", {
        headers: { host: "localhost", origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.notEqual(
    (
      await app.request("http://localhost/mcp", {
        headers: { host: "localhost", origin: "https://client.example" },
      })
    ).status,
    403,
  );
  delete process.env.MCP_ALLOWED_ORIGINS;
});
