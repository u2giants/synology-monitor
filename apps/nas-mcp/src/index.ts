import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getNasConfigs, nasPreview, nasExec, buildApprovalToken } from "./nas-client.js";
import { ALL_TOOL_DEFS } from "./tool-definitions.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT ?? "3001", 10);
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "../tools-config.json");
const toolsConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
  enabled_read_tools: string[];
  enabled_write_tools: string[];
};

const enabledRead = new Set<string>(toolsConfig.enabled_read_tools ?? []);
const enabledWrite = new Set<string>(toolsConfig.enabled_write_tools ?? []);

// ─── MCP server factory ───────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "synology-nas", version: "1.0.0" });

  // Predefined tools from tool-definitions.ts
  for (const tool of ALL_TOOL_DEFS) {
    const enabled = tool.write ? enabledWrite.has(tool.name) : enabledRead.has(tool.name);
    if (!enabled) continue;

    const params = tool.write
      ? {
          ...tool.params,
          confirmed: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "Set to true to execute after reviewing the command preview. Omit or set false to see what will happen first.",
            ),
        }
      : tool.params;

    server.tool(tool.name, tool.description, params, async (input: Record<string, unknown>) => {
      const target = (input.target as string) ?? "both";
      const configs = getNasConfigs(target);

      if (configs.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No NAS configured for target "${target}". Valid targets: edgesynology1, edgesynology2, both.` }],
        };
      }

      const results = await Promise.all(
        configs.map(async (config) => {
          try {
            let command: string;
            try {
              command = tool.buildCommand(input);
            } catch (err) {
              return `[${config.name}] Cannot build command: ${err instanceof Error ? err.message : String(err)}`;
            }

            const preview = await nasPreview(config, command);

            if (preview.blocked) {
              return `[${config.name}] Blocked by NAS API: ${preview.summary}`;
            }

            if (tool.write && preview.tier >= 2 && !input.confirmed) {
              return [
                `[${config.name}] This action requires your approval before it runs.`,
                ``,
                `Command that will execute:`,
                `\`\`\``,
                command,
                `\`\`\``,
                ``,
                `Call this tool again with confirmed: true to approve and execute.`,
                `If you do not want to proceed, do nothing — no changes have been made.`,
              ].join("\n");
            }

            let approvalToken: string | undefined;
            if (preview.tier >= 2) {
              approvalToken = buildApprovalToken(config, command, preview.tier);
            }

            const result = await nasExec(config, command, preview.tier, approvalToken, 90_000);
            const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
            return `[${config.name}]\n${output || "(no output)"}`;
          } catch (err) {
            return `[${config.name}] Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }),
      );

      return {
        content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }],
      };
    });
  }

  // run_command — free-form tier-1-only tool for deep ad-hoc diagnosis
  if (enabledRead.has("run_command")) {
    server.tool(
      "run_command",
      "Run any read-only shell command on a Synology NAS for deep diagnosis. Write commands are automatically blocked by the NAS API validator before execution.",
      {
        target: z
          .enum(["edgesynology1", "edgesynology2", "both"])
          .describe("Which NAS to run on"),
        command: z.string().describe("The shell command to execute"),
      },
      async ({ target, command }: { target: string; command: string }) => {
        const configs = getNasConfigs(target);

        if (configs.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No NAS configured for target "${target}".` }],
          };
        }

        const results = await Promise.all(
          configs.map(async (config) => {
            try {
              const preview = await nasPreview(config, command);
              if (preview.blocked) {
                return `[${config.name}] Blocked: ${preview.summary}`;
              }
              if (preview.tier >= 2) {
                return `[${config.name}] This command requires write access and cannot be run via run_command. Add it to enabled_write_tools in tools-config.json, or use a specific write tool.`;
              }
              const result = await nasExec(config, command, 1, undefined, 90_000);
              const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
              return `[${config.name}]\n${output || "(no output)"}`;
            } catch (err) {
              return `[${config.name}] Error: ${err instanceof Error ? err.message : String(err)}`;
            }
          }),
        );

        return {
          content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }],
        };
      },
    );
  }

  return server;
}

// ─── Session management ───────────────────────────────────────────────────────

// Each MCP session gets its own transport + server pair.
const sessions = new Map<string, StreamableHTTPServerTransport>();

async function getOrCreateSession(
  sessionId: string | undefined,
): Promise<{ transport: StreamableHTTPServerTransport; isStale: boolean }> {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) return { transport: existing, isStale: false };
    // Unknown session ID — server was restarted and lost in-memory state.
    // Fall through and create a fresh session rather than returning 404.
  }
  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  if (transport.sessionId) {
    sessions.set(transport.sessionId, transport);
  }
  return { transport, isStale: sessionId !== undefined };
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function isAuthorized(req: { headers: { authorization?: string } }): boolean {
  if (!BEARER_TOKEN) return true;
  return req.headers.authorization === `Bearer ${BEARER_TOKEN}`;
}

const httpServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost`);

  // Health check — no auth required
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "nas-mcp",
        sessions: sessions.size,
        read_tools: enabledRead.size,
        write_tools: enabledWrite.size,
      }),
    );
    return;
  }

  if (!isAuthorized(req as Parameters<typeof isAuthorized>[0])) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // MCP endpoint — handles both Streamable HTTP (POST/GET) and session routing
  if (url.pathname === "/sse" || url.pathname === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const { transport, isStale } = await getOrCreateSession(sessionId);

    // Stale session ID: strip it from the request so the freshly-created transport
    // doesn't see a mismatched ID and reject the request with HTTP 400.
    if (isStale) {
      delete (req.headers as Record<string, unknown>)["mcp-session-id"];
    }

    await transport.handleRequest(req, res);
    // Store new session after first request sets the session ID
    if ((!sessionId || isStale) && transport.sessionId) {
      sessions.set(transport.sessionId, transport);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(PORT, () => {
  console.log(`NAS MCP server listening on port ${PORT}`);
  console.log(`Read tools: ${[...enabledRead].join(", ")}`);
  console.log(`Write tools: ${[...enabledWrite].join(", ") || "(none)"}`);
});
