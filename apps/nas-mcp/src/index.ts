import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getNasConfigs, nasPreview, nasExec, buildApprovalToken } from "./nas-client.js";
import {
  ALL_TOOL_DEFS,
  type McpToolDef,
  searchTools,
  formatToolForSearch,
  findToolByName,
  getGroup,
  listUntaggedTools,
} from "./nas-tools.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT ?? "3001", 10);
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";

/**
 * Hard ceiling on any single tool invocation. Fires an MCP error rather than
 * letting the call hang until Claude Desktop's own 4-minute client timeout.
 * Must be comfortably less than Claude Desktop's 4-minute limit.
 */
const TOOL_DEADLINE_MS = 45_000;

/**
 * Tools registered eagerly on every session in addition to tool_search /
 * invoke_tool / run_command. Two carefully chosen freebies for the most common
 * one-shot questions.
 */
const EAGER_TOOLS = ["check_disk_space", "restart_nas_api"] as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "../tools-config.json");
const toolsConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
  enabled_read_tools: string[];
  enabled_write_tools: string[];
};

const enabledRead = new Set<string>(toolsConfig.enabled_read_tools ?? []);
const enabledWrite = new Set<string>(toolsConfig.enabled_write_tools ?? []);
const allEnabled = new Set<string>([...enabledRead, ...enabledWrite]);

// One-time startup warning for tools missing from TOOL_GROUPS — they still
// work via the "misc" fallback, but should be tagged eventually.
{
  const untagged = listUntaggedTools().filter((n) => allEnabled.has(n));
  if (untagged.length) {
    console.warn(
      `[nas-mcp] ${untagged.length} enabled tool(s) untagged in TOOL_GROUPS (assigned group="misc"): ${untagged.join(", ")}`,
    );
  }
}

// ─── Tool deadline wrapper ────────────────────────────────────────────────────

type ToolResult = { content: { type: "text"; text: string }[] };

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
  tool: McpToolDef,
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

/**
 * Runs a predefined tool against the requested target NAS(es), returning the
 * combined text result. Shared between eager registration and invoke_tool.
 */
async function runPredefinedTool(
  tool: McpToolDef,
  input: Record<string, unknown>,
): Promise<ToolResult> {
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
}

/**
 * Registers a single predefined tool directly with the MCP server. Used only
 * for the small set of eagerly-loaded tools; everything else flows through
 * invoke_tool.
 */
function registerToolDef(server: McpServer, tool: McpToolDef): void {
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
    return withToolDeadline(tool.name, () => runPredefinedTool(tool, input));
  });
}

// ─── MCP server factory ───────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "synology-nas", version: "1.0.0" });

  // ── Always-on tool 1: tool_search ─────────────────────────────────────────
  server.tool(
    "tool_search",
    "Search the NAS diagnostic + admin tool registry by keyword. Call this FIRST to find the right tool for the task, then call invoke_tool to execute. Returns tool names, descriptions, and parameter shapes as text. Try keywords like: snapshot, backup, drive, sync, disk, smart, btrfs, network, tailscale, memory, cpu, logs, package, restart, files, permission, acl, recover, recycle, security, audit, volume, space, task. Group names also work: system, performance, network, security, drive_sync, logs, storage, files, recovery, packages, backup, write_restart, write_storage, write_files, write_tasks, misc.",
    {
      query: z.string().describe("Keywords describing what you want to do, e.g. 'snapshot recovery', 'sharesync errors', 'restart drive package'."),
      limit: z.number().int().optional().default(8).describe("Max tools to return. Default 8, max 30."),
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      return withToolDeadline("tool_search", async () => {
        const matches = searchTools(query, allEnabled);
        if (matches.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No tools matched "${query}". Try broader keywords (e.g. snapshot, drive, disk, network, files, logs, restart) or a group name (system, performance, network, security, drive_sync, logs, storage, files, recovery, packages, backup, write_restart, write_storage, write_files, write_tasks).`,
            }],
          };
        }
        const cap = Math.max(1, Math.min(limit ?? 8, 30));
        const top = matches.slice(0, cap);
        const body = top.map(formatToolForSearch).join("\n\n");
        const more = matches.length > top.length
          ? `\n\n(${matches.length - top.length} additional match(es) not shown — refine the query or raise limit.)`
          : "";
        const header = `Found ${matches.length} tool(s) for "${query}". Showing top ${top.length}.\nExecute any of these with: invoke_tool({ name: "<tool>", target: "edgesynology1|edgesynology2|both", args: { ... } })\n\n`;
        return { content: [{ type: "text" as const, text: header + body + more }] };
      });
    },
  );

  // ── Always-on tool 2: invoke_tool ─────────────────────────────────────────
  server.tool(
    "invoke_tool",
    "Execute a NAS tool discovered via tool_search. Pass the tool's exact name, the target NAS, and any tool-specific params in args. For write tools, include confirmed: true inside args to actually run (omit it first to see a preview). Returns the tool's output as text.",
    {
      name: z.string().describe("Exact tool name from tool_search output."),
      target: z
        .enum(["edgesynology1", "edgesynology2", "both"])
        .describe("Which NAS to run on."),
      args: z
        .record(z.unknown())
        .optional()
        .describe("Tool-specific parameters from the tool_search schema. For write tools, include confirmed: true to execute."),
    },
    async ({ name, target, args }: { name: string; target: string; args?: Record<string, unknown> }) => {
      return withToolDeadline(`invoke_tool:${name}`, async () => {
        const tool = findToolByName(name);
        if (!tool) {
          return {
            content: [{
              type: "text" as const,
              text: `Unknown tool: "${name}". Call tool_search first to discover available tools.`,
            }],
          };
        }
        const isEnabled = tool.write ? enabledWrite.has(name) : enabledRead.has(name);
        if (!isEnabled) {
          return {
            content: [{
              type: "text" as const,
              text: `Tool "${name}" exists but is disabled in tools-config.json (${tool.write ? "enabled_write_tools" : "enabled_read_tools"}). Group: ${getGroup(name)}.`,
            }],
          };
        }
        const input: Record<string, unknown> = { ...(args ?? {}), target };
        return runPredefinedTool(tool, input);
      });
    },
  );

  // ── Always-on tool 3: run_command (free-form, tier-1-only) ────────────────
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
                  return `[${config.name}] This command requires write access and cannot be run via run_command. Add it to enabled_write_tools in tools-config.json, or use invoke_tool with a specific write tool.`;
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

  // ── Eager freebies: check_disk_space + restart_nas_api ────────────────────
  // Common enough that paying tool_search round-trip for them isn't worth it.
  for (const eagerName of EAGER_TOOLS) {
    const tool = ALL_TOOL_DEFS.find((t) => t.name === eagerName);
    if (!tool) continue;
    const isEnabled = tool.write ? enabledWrite.has(tool.name) : enabledRead.has(tool.name);
    if (!isEnabled) continue;
    registerToolDef(server, tool);
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
        registry_tools: ALL_TOOL_DEFS.length,
        always_on: ["tool_search", "invoke_tool", "run_command", ...EAGER_TOOLS],
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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`NAS MCP server listening on port ${PORT}`);
  console.log(`Registry: ${ALL_TOOL_DEFS.length} tools (${enabledRead.size} read + ${enabledWrite.size} write enabled)`);
  console.log(`Always-on: tool_search, invoke_tool, run_command, ${EAGER_TOOLS.join(", ")}`);
});
