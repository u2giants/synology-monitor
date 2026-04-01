import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { collectNasDiagnostics } from "@/lib/server/nas";
import { getCopilotRole } from "@/lib/server/copilot-store";
import OpenAI from "openai";

// Rate limiter for batch analysis (10 per hour per user)
const batchRateLimiter = new Map<string, { count: number; resetAt: number }>();
const BATCH_RATE_LIMIT = 10;
const BATCH_WINDOW_MS = 60 * 60 * 1000;

function checkBatchRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = batchRateLimiter.get(userId);

  if (!entry || now > entry.resetAt) {
    batchRateLimiter.set(userId, { count: 1, resetAt: now + BATCH_WINDOW_MS });
    return true;
  }

  if (entry.count >= BATCH_RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

interface ErrorContext {
  nas_id: string;
  nas_name: string;
  source: string;
  severity: string;
  message: string;
  user?: string;
  path?: string;
  action?: string;
  component?: string;
  logged_at: string;
}

interface BatchAnalysisResult {
  answer: string;
  findings: Array<{
    id: string;
    kind: string;
    title: string;
    detail: string;
    timestamp: string;
  }>;
  recommendations: Array<{
    id: string;
    title: string;
    target: string;
    toolName: string;
    reason: string;
    risk: string;
    approvalToken: string;
  }>;
  context: {
    errors_analyzed: number;
    time_period_hours: number;
    nas_count: number;
    severity_breakdown: { error: number; warning: number; critical: number };
    top_users: Array<[string, number]>;
    top_paths: Array<[string, number]>;
    top_components: Array<[string, number]>;
  };
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    // Check batch rate limit
    if (!checkBatchRateLimit(user.id)) {
      return NextResponse.json(
        { error: "Batch analysis rate limit exceeded. Please wait before requesting another batch analysis." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { nasId, hours = 1, maxErrors = 50 } = body as {
      nasId?: string;
      hours?: number;
      maxErrors?: number;
    };

    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    // Fetch sync errors from all relevant sources
    let query = supabase
      .from("smon_logs")
      .select("*")
      .in("source", ["drive", "drive_server", "drive_sharesync", "smb"])
      .in("severity", ["error", "warning", "critical"])
      .gte("ingested_at", cutoff)
      .order("ingested_at", { ascending: false })
      .limit(maxErrors);

    if (nasId) {
      query = query.eq("nas_id", nasId);
    }

    const { data: errors, error: fetchError } = await query;

    if (fetchError) {
      return NextResponse.json({ error: "Failed to fetch sync errors." }, { status: 500 });
    }

    if (!errors || errors.length === 0) {
      return NextResponse.json({
        answer: "No sync errors found in the specified time period.",
        findings: [],
        recommendations: [],
        context: {
          errors_analyzed: 0,
          time_period_hours: hours,
          nas_count: 0,
          severity_breakdown: { error: 0, warning: 0, critical: 0 },
          top_users: [],
          top_paths: [],
          top_components: [],
        },
      });
    }

    // Get NAS names
    const nasIds = [...new Set(errors.map((e) => e.nas_id))];
    const { data: nasUnits } = await supabase
      .from("smon_nas_units")
      .select("id, name")
      .in("id", nasIds);

    const nasMap = new Map((nasUnits || []).map((n) => [n.id, n.name]));

    // Enrich errors with metadata
    const enrichedErrors: ErrorContext[] = errors.map((log) => {
      const meta = (log.metadata as Record<string, unknown>) || {};
      return {
        nas_id: log.nas_id,
        nas_name: nasMap.get(log.nas_id) || "Unknown",
        source: log.source,
        severity: log.severity,
        message: log.message,
        logged_at: log.logged_at,
        user: typeof meta.user === "string" ? meta.user : undefined,
        path: typeof meta.path === "string" ? meta.path : undefined,
        action: typeof meta.action === "string" ? meta.action : undefined,
        component: typeof meta.component === "string" ? meta.component : undefined,
      };
    });

    // Get copilot role
    const roleInfo = await getCopilotRole(supabase, user);
    if (roleInfo.role === "viewer") {
      return NextResponse.json(
        { error: "Viewer role cannot perform batch analysis. Please contact an admin." },
        { status: 403 }
      );
    }

    // Collect SSH diagnostics
    const diagnostics = await collectNasDiagnostics(hours);

    // Build context for AI analysis
    const context = {
      analysis_type: "batch_sync_triage",
      time_period_hours: hours,
      nas_count: nasIds.length,
      errors_analyzed: enrichedErrors.length,
      error_sources: [...new Set(errors.map((e) => e.source))],
      severity_breakdown: {
        error: errors.filter((e) => e.severity === "error").length,
        warning: errors.filter((e) => e.severity === "warning").length,
        critical: errors.filter((e) => e.severity === "critical").length,
      },
      top_users: Object.entries(
        enrichedErrors.reduce((acc, e) => {
          if (e.user) acc[e.user] = (acc[e.user] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      top_paths: Object.entries(
        enrichedErrors.reduce((acc, e) => {
          if (e.path) acc[e.path] = (acc[e.path] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      top_components: Object.entries(
        enrichedErrors.reduce((acc, e) => {
          if (e.component) acc[e.component] = (acc[e.component] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
    };

    // Sample of errors (max 20 for context)
    const errorSamples = enrichedErrors.slice(0, 20);

    // Build diagnostic section
    const diagnosticSection = diagnostics
      .map((d) => `NAS Diagnostics (${d.target}): ${d.ok ? d.stdout.slice(0, 500) : d.stderr}`)
      .join("\n\n");

    // Call OpenAI directly for batch analysis
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY not configured." }, { status: 500 });
    }

    const client = new OpenAI({ apiKey });
    const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-4.1";

    const prompt = `You are the Synology Monitor Batch Sync Triage AI. Your job is to analyze multiple sync errors together to identify patterns, root causes, and recommend actions.

Look for:
1. Common users affected by multiple errors
2. Common paths or folders with multiple issues
3. Specific components (drive, sharesync, smb) with most errors
4. Time-based patterns
5. Correlation between different error types
6. Files that might need manual intervention

Provide your analysis as a detailed report with:
- Summary of findings
- Top patterns identified
- Recommended actions (if any)

Context: ${JSON.stringify(context, null, 2)}

Error samples (showing first ${errorSamples.length}):
${errorSamples.map((e, i) => `[${i + 1}] ${e.nas_name} | ${e.source} | ${e.severity} | ${e.action || "N/A"} | user: ${e.user || "N/A"} | path: ${e.path || "N/A"} | message: ${e.message.substring(0, 200)}`).join("\n\n")}

${diagnosticSection}

Please analyze these errors for patterns and correlations.`;

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant specializing in Synology NAS troubleshooting, particularly Synology Drive and ShareSync sync issues.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const answer = response.choices[0]?.message?.content || "Analysis complete. No specific patterns identified.";

    return NextResponse.json({
      answer,
      findings: [],
      recommendations: [],
      context: {
        errors_analyzed: enrichedErrors.length,
        time_period_hours: hours,
        nas_count: nasIds.length,
        severity_breakdown: context.severity_breakdown,
        top_users: context.top_users.slice(0, 5),
        top_paths: context.top_paths.slice(0, 5),
        top_components: context.top_components.slice(0, 5),
      },
    } as BatchAnalysisResult);
  } catch (error) {
    console.error("Batch analysis error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to perform batch analysis.",
      },
      { status: 500 }
    );
  }
}
