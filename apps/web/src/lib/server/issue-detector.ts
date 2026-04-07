import OpenAI from "openai";
import { createIssue, loadIssue, updateIssue, type IssueSeverity, type SupabaseClient } from "./issue-store";
import { seedIssueFromOrigin } from "./issue-agent";
import { getDiagnosisModel } from "./ai-settings";

type DetectedIssue = {
  fingerprint: string;
  title: string;
  summary: string;
  severity: IssueSeverity;
  affected_nas: string[];
  evidence: Array<{ title: string; detail: string }>;
};

function getOpenAIClient() {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or OPENAI_API_KEY is not configured.");
  }

  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
}

async function fetchDetectionContext(supabase: SupabaseClient, lookbackMinutes: number) {
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

  const [alertsResult, logsResult, securityResult] = await Promise.all([
    supabase
      .from("smon_alerts")
      .select("id, source, severity, title, message, details, created_at")
      .eq("status", "active")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("smon_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since)
      .in("severity", ["critical", "error", "warning"])
      .order("ingested_at", { ascending: false })
      .limit(150),
    supabase
      .from("smon_security_events")
      .select("id, severity, type, title, description, file_path, user, detected_at")
      .gte("detected_at", since)
      .order("detected_at", { ascending: false })
      .limit(30),
  ]);

  return {
    alerts: alertsResult.data ?? [],
    logs: logsResult.data ?? [],
    security_events: securityResult.data ?? [],
  };
}

async function detectIssues(context: Awaited<ReturnType<typeof fetchDetectionContext>>) {
  const client = getOpenAIClient();
  const model = await getDiagnosisModel();

  const response = await client.chat.completions.create({
    model,
    messages: [{
      role: "user",
      content: `You are creating operator-facing issue threads from Synology telemetry.

Group events aggressively by root cause. Create only the issue threads an operator should actively work.
Do not just translate logs into English. Produce one stable issue title per cluster.

Telemetry:
${JSON.stringify(context, null, 2)}

Return JSON only:
{
  "issues": [
    {
      "fingerprint": "stable-short-id",
      "title": "Operator-facing issue title",
      "summary": "2-4 sentence summary of the actual problem and business impact",
      "severity": "critical|warning|info",
      "affected_nas": ["edgesynology1"],
      "evidence": [
        {"title":"Why this issue exists", "detail":"specific evidence"}
      ]
    }
  ]
}`
    }],
    response_format: { type: "json_object" },
    max_tokens: 2200,
  });

  const raw = response.choices[0]?.message?.content ?? '{"issues":[]}';
  const parsed = JSON.parse(raw) as { issues?: DetectedIssue[] };
  return parsed.issues ?? [];
}

export async function runIssueDetection(
  supabase: SupabaseClient,
  userId: string,
  lookbackMinutes: number
) {
  const context = await fetchDetectionContext(supabase, lookbackMinutes);
  const issues = await detectIssues(context);

  const createdIds: string[] = [];

  for (const detected of issues) {
    const issueId = await createIssue(supabase, userId, {
      originType: "detected",
      title: detected.title,
      summary: detected.summary,
      severity: detected.severity,
      affectedNas: detected.affected_nas,
      fingerprint: detected.fingerprint,
      metadata: {
        detection_lookback_minutes: lookbackMinutes,
      },
    });

    const existing = await loadIssue(supabase, userId, issueId);
    if (existing && existing.messages.length === 0) {
      await seedIssueFromOrigin(
        supabase,
        userId,
        issueId,
        `Detection summary: ${detected.summary}`
      );
      for (const evidence of detected.evidence ?? []) {
        await seedIssueFromOrigin(
          supabase,
          userId,
          issueId,
          `${evidence.title}: ${evidence.detail}`
        );
      }
    } else {
      await updateIssue(supabase, userId, issueId, {
        title: detected.title,
        summary: detected.summary,
        severity: detected.severity,
        affected_nas: detected.affected_nas,
      });
    }

    createdIds.push(issueId);
  }

  return createdIds;
}
