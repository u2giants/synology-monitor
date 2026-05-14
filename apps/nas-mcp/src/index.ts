import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getNasConfigs, nasPreview, nasExec, buildApprovalToken } from "./nas-client.js";
import { ALL_TOOL_DEFS } from "./tool-definitions.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT ?? "3001", 10);
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";

/**
 * Hard ceiling on any single tool invocation. Fires an MCP error rather than
 * letting the call hang until Claude Desktop's own 4-minute client timeout.
 * Must be comfortably less than Claude Desktop's 4-minute limit.
 */
const TOOL_DEADLINE_MS = 45_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "../tools-config.json");
const toolsConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
  enabled_read_tools: string[];
  enabled_write_tools: string[];
};

const enabledRead = new Set<string>(toolsConfig.enabled_read_tools ?? []);
const enabledWrite = new Set<string>(toolsConfig.enabled_write_tools ?? []);

// ─── Tool deadline wrapper ────────────────────────────────────────────────────

type ToolResult = { content: { type: "text"; text: string }[] };

/**
 * Wraps a tool handler with a hard deadline. If the inner handler doesn't
 * resolve within TOOL_DEADLINE_MS, this resolves with a clear error message
 * instead of hanging until Claude Desktop's own 4-minute client timeout fires.
 */
async function withToolDeadline(toolName: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[nas-mcp] Tool "${toolName}" deadline reached after ${TOOL_DEADLINE_MS}ms`);
      resolve({
        content: [{
          type: "text" as const,
          text: `Tool "${toolName}" timed out after ${TOOL_DEADLINE_MS / 1000}s. The NAS may be under heavy load or unreachable. Try again in a moment, or target a single NAS instead of "both".`,
        }],
      });
    }, TOOL_DEADLINE_MS);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

async function executePredefinedToolOnNas(
  tool: (typeof ALL_TOOL_DEFS)[number],
  input: Record<string, unknown>,
  config: ReturnType<typeof getNasConfigs>[number],
): Promise<string> {
  let command: string;
  try {
    command = tool.buildCommand(input);
  } catch (err) {
    return `[${config.name}] Cannot build command: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    if (!tool.write) {
      const result = await nasExec(config, command, 1);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return `[${config.name}]\n${output || "(no output)"}`;
    }

    const preview = await nasPreview(config, command);

    if (preview.blocked) {
      return `[${config.name}] Blocked by NAS API: ${preview.summary}`;
    }

    if (preview.tier >= 2 && !input.confirmed) {
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

    const result = await nasExec(config, command, preview.tier, approvalToken);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return `[${config.name}]\n${output || "(no output)"}`;
  } catch (err) {
    return `[${config.name}] Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
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
      return withToolDeadline(tool.name, async () => {
        const target = (input.target as string) ?? "both";
        const configs = getNasConfigs(target);

        if (configs.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No NAS configured for target "${target}". Valid targets: edgesynology1, edgesynology2, both.` }],
          };
        }

        const results = await Promise.all(configs.map((config) => executePredefinedToolOnNas(tool, input, config)));
        return {
          content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }],
        };
      });
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
        return withToolDeadline("run_command", async () => {
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
                const result = await nasExec(config, command, 1);
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
      },
    );
  }

  return server;
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

  // MCP endpoint — fully stateless: each request gets its own transport+server.
  // No session Map means no stale-session failures after container restarts.
  // GET without session ID: the claude.ai proxy opens a standalone SSE notification
  // stream before sending any tool calls; stateless mode handles it cleanly.
  if (url.pathname === "/sse" || url.pathname === "/mcp") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    transport.onerror = (err) => {
      console.warn("[nas-mcp] transport error:", err instanceof Error ? err.message : String(err));
    };
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// Traefik (Coolify's proxy) keeps connections alive longer than Node's default
// 5s keepAliveTimeout. When Node closes the socket first, Traefik gets a reset
// and claude.ai shows "connection interrupted". Setting these above Traefik's
// idle timeout (90s) prevents that race.
httpServer.keepAliveTimeout = 120_000;
httpServer.headersTimeout = 125_000;

httpServer.listen(PORT, () => {
  console.log(`NAS MCP server listening on port ${PORT}`);
  console.log(`Read tools: ${[...enabledRead].join(", ")}`);
  console.log(`Write tools: ${[...enabledWrite].join(", ") || "(none)"}`);
});
