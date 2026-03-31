import { createHmac, randomUUID } from "node:crypto";
import OpenAI from "openai";
import { collectNasDiagnostics, executeApprovedCommand } from "@/lib/server/nas";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";

export type ReasoningEffort = "high" | "xhigh";
export type CopilotRole = "user" | "assistant" | "tool";
export type NasTarget = "edgesynology1" | "edgesynology2";

export interface CopilotMessage {
  id: string;
  role: CopilotRole;
  content: string;
}

export interface ProposedAction {
  id: string;
  title: string;
  target: NasTarget;
  command: string;
  reason: string;
  risk: "low" | "medium" | "high";
  approvalToken: string;
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  return new OpenAI({ apiKey });
}

function buildSchema() {
  return {
    name: "nas_copilot_response",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        answer: { type: "string" },
        proposed_actions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              target: {
                type: "string",
                enum: ["edgesynology1", "edgesynology2"],
              },
              command: { type: "string" },
              reason: { type: "string" },
              risk: {
                type: "string",
                enum: ["low", "medium", "high"],
              },
            },
            required: ["title", "target", "command", "reason", "risk"],
          },
        },
      },
      required: ["answer", "proposed_actions"],
    },
    strict: true,
  } as const;
}

function randomId() {
  return randomUUID();
}

function getActionSigningKey() {
  return process.env.COPILOT_ACTION_SIGNING_KEY ?? process.env.OPENAI_API_KEY ?? "";
}

function signAction(target: NasTarget, command: string, expiresAt: string) {
  const signingKey = getActionSigningKey();
  if (!signingKey) {
    throw new Error("COPILOT_ACTION_SIGNING_KEY or OPENAI_API_KEY is not configured.");
  }

  return createHmac("sha256", signingKey)
    .update(`${target}\n${command}\n${expiresAt}`)
    .digest("hex");
}

function buildApprovalToken(target: NasTarget, command: string) {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const signature = signAction(target, command, expiresAt);
  return Buffer.from(JSON.stringify({ target, command, expiresAt, signature })).toString("base64url");
}

function verifyApprovalToken(target: NasTarget, command: string, token: string) {
  let parsed: {
    target: NasTarget;
    command: string;
    expiresAt: string;
    signature: string;
  };

  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new Error("Approval token is invalid.");
  }

  if (parsed.target !== target || parsed.command !== command) {
    throw new Error("Approval token does not match the requested action.");
  }

  if (Date.parse(parsed.expiresAt) < Date.now()) {
    throw new Error("Approval token has expired.");
  }

  const expectedSignature = signAction(parsed.target, parsed.command, parsed.expiresAt);
  if (expectedSignature !== parsed.signature) {
    throw new Error("Approval token signature is invalid.");
  }
}

function sanitizeJson(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
}

export async function generateCopilotResponse(messages: CopilotMessage[], reasoningEffort: ReasoningEffort) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Authentication required.");
  }

  const [nasUnits, alerts, driveLogs, diagnostics] = await Promise.all([
    supabase.from("smon_nas_units").select("id, name, hostname, model, status, last_seen").order("name"),
    supabase
      .from("smon_alerts")
      .select("severity, status, source, title, message, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("smon_logs")
      .select("source, severity, message, metadata, ingested_at")
      .in("source", ["drive", "drive_server", "drive_sharesync"])
      .order("ingested_at", { ascending: false })
      .limit(20),
    collectNasDiagnostics(),
  ]);

  const client = getOpenAIClient();
  const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5.4";

  const context = {
    authenticated_user: user.email,
    nas_units: nasUnits.data ?? [],
    active_alerts: alerts.data ?? [],
    recent_drive_logs: driveLogs.data ?? [],
    ssh_diagnostics: diagnostics,
  };

  const input = [
    {
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text:
            "You are the Synology Monitor Copilot. You help explain NAS state, investigate sync/file-system issues, and propose exact shell commands when a repair is needed. " +
            "Never claim an action already ran. Only propose actions when they are justified by the supplied context. " +
            "Prefer conservative fixes. Avoid destructive commands. Every proposed action will be shown to the human for explicit approval.",
        },
      ],
    },
    {
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text: `Current system context:\n${JSON.stringify(context, null, 2)}`,
        },
      ],
    },
    ...messages.map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: [{ type: "input_text" as const, text: message.content }],
    })),
  ];

  const response = await client.responses.create({
    model,
    reasoning: { effort: reasoningEffort },
    input,
    text: {
      format: {
        type: "json_schema",
        name: "nas_copilot_response",
        schema: buildSchema().schema,
        strict: true,
      },
    },
  });

  const outputText = sanitizeJson(response.output_text ?? "");
  const parsed = JSON.parse(outputText) as {
    answer: string;
    proposed_actions: Omit<ProposedAction, "id">[];
  };

  return {
    answer: parsed.answer,
    proposedActions: parsed.proposed_actions.map((action) => ({
      ...action,
      id: randomId(),
      approvalToken: buildApprovalToken(action.target, action.command),
    })),
  };
}

export async function runApprovedAction(target: NasTarget, command: string, approvalToken: string) {
  verifyApprovalToken(target, command, approvalToken);
  const result = await executeApprovedCommand(target, command);
  const chunks = [];

  if (result.stdout) {
    chunks.push(`stdout:\n${result.stdout}`);
  }
  if (result.stderr) {
    chunks.push(`stderr:\n${result.stderr}`);
  }
  if (chunks.length === 0) {
    chunks.push("Command completed with no output.");
  }

  return {
    ok: result.exitCode === 0,
    content: chunks.join("\n\n"),
    exitCode: result.exitCode,
  };
}
