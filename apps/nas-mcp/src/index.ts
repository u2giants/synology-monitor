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
  _tool_descriptions?: Record<string, string>;
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

  // get_investigation_guide — mid-session tool catalog refresher
  if (enabledRead.has("get_investigation_guide")) {
    const descriptions: Record<string, string> = toolsConfig._tool_descriptions ?? {};
    const allDescriptions = new Map<string, string>([
      ...ALL_TOOL_DEFS.map((t): [string, string] => [t.name, t.description]),
      ["run_command", "Run any read-only shell command on a Synology NAS for deep diagnosis. Write commands are automatically blocked by the NAS API validator before execution."],
      ["get_investigation_guide", "Returns a categorized summary of every enabled tool — call this when you are unsure which tool to use or need a mid-session refresher."],
      ...Object.entries(descriptions),
    ]);

    // Group labels mapped from description prefixes and known clusters.
    const groups: Array<{ label: string; match: (name: string, desc: string) => boolean }> = [
      { label: "ESCAPE HATCH", match: (n) => n === "run_command" },
      { label: "STARTING POINTS", match: (n) => ["get_resource_snapshot", "collect_incident_bundle", "check_system_info"].includes(n) },
      { label: "FILE & FOLDER VISIBILITY", match: (_, d) => d.includes("PHASE-1E") || ["list_directory_contents", "find_problematic_files"].includes(_) },
      { label: "LOG INVESTIGATION", match: (n, d) => d.includes("PHASE-1F") || ["search_all_logs", "tail_system_log", "tail_drive_server_log", "search_drive_server_log", "tail_sharesync_log", "search_webapi_log"].includes(n) },
      { label: "DRIVE & SHARESYNC", match: (n) => ["check_sharesync_status", "check_drive_package_health", "check_drive_database", "check_share_database", "list_shared_folders", "check_drive_network", "check_synology_drive_network"].includes(n) || n.includes("sharesync") || n.includes("drive") },
      { label: "RECOVERY (SNAPSHOTS, RECYCLE BIN, VERSIONS)", match: (_, d) => d.includes("PHASE-3") },
      { label: "STORAGE HEALTH", match: (_, d) => d.includes("PHASE-1C") },
      { label: "PACKAGE & SERVICE HEALTH", match: (_, d) => d.includes("PHASE-1B") || ["check_packages", "check_active_sessions", "check_security_log"].includes(_) },
      { label: "NETWORK", match: (_, d) => d.includes("PHASE-1D") || ["check_tailscale", "check_network_health", "check_network_connections"].includes(_) },
      { label: "IN-PROGRESS TEST STATUS", match: (_, d) => d.includes("PHASE-4") },
      { label: "WRITE TOOLS (require your approval before executing)", match: (n) => enabledWrite.has(n) },
    ];

    server.tool(
      "get_investigation_guide",
      "Returns a categorized summary of every enabled tool. Call this at the start of an investigation or whenever you are unsure which tool covers a diagnostic need.",
      {},
      async () => {
        const assigned = new Set<string>();
        const lines: string[] = [
          "# NAS MCP — Enabled Tool Guide",
          "",
          "All tools target one or both NAS units (edgesynology1 / edgesynology2 / both).",
          "Read tools auto-execute. Write tools show a preview and require confirmed: true.",
          "",
        ];

        for (const group of groups) {
          const tools: string[] = [];
          const pool = group.label.startsWith("WRITE") ? [...enabledWrite] : [...enabledRead];
          for (const name of pool) {
            if (assigned.has(name)) continue;
            const desc = allDescriptions.get(name) ?? "";
            if (group.match(name, desc)) {
              tools.push(`  ${name} — ${desc.replace(/^PHASE-\S+:\s*/, "").replace(/^WRITE[:\s—]+/i, "")}`);
              assigned.add(name);
            }
          }
          if (tools.length > 0) {
            lines.push(`## ${group.label}`);
            lines.push(...tools);
            lines.push("");
          }
        }

        // Catch any unassigned read tools in a misc section
        const misc = [...enabledRead].filter((n) => !assigned.has(n));
        if (misc.length > 0) {
          lines.push("## GENERAL");
          for (const name of misc) {
            const desc = allDescriptions.get(name) ?? "";
            lines.push(`  ${name} — ${desc.replace(/^PHASE-\S+:\s*/, "")}`);
          }
          lines.push("");
        }

        lines.push("---");
        lines.push("If no named tool fits, use run_command to run any read-only shell command.");

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      },
    );
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
  // Pre-generate the UUID and register the transport BEFORE handleRequest runs.
  // Without this, the Mcp-Session-Id header reaches the client while the session
  // is still unregistered — mcp-remote immediately sends notifications/initialized
  // with that ID, hits the "Server not initialized" 400, and the connection fails.
  const newSessionId = randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
  });
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  transport.onclose = () => sessions.delete(newSessionId);
  sessions.set(newSessionId, transport);
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

  // Tools catalog — no auth required; lets any AI agent discover the full
  // enabled tool surface without needing an active MCP session.
  if (url.pathname === "/tools" && req.method === "GET") {
    const descMap = new Map<string, string>(ALL_TOOL_DEFS.map((t) => [t.name, t.description]));
    descMap.set(
      "run_command",
      "Run any read-only shell command on a Synology NAS for deep diagnosis. Write commands are automatically blocked by the NAS API validator before execution.",
    );

    const readTools = [...enabledRead].map((name) => ({
      name,
      description: descMap.get(name) ?? "",
      requires_approval: false,
    }));

    const writeTools = [...enabledWrite].map((name) => ({
      name,
      description: descMap.get(name) ?? "",
      requires_approval: true,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          service: "nas-mcp",
          total: readTools.length + writeTools.length,
          read_tools: readTools,
          write_tools: writeTools,
        },
        null,
        2,
      ),
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
