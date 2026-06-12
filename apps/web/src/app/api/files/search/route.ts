import { NextResponse, type NextRequest } from "next/server";
import { findToolByName } from "@synology-monitor/shared/nas-tools";
import {
  executeNasCommandOnConfig,
  getNasApiConfigs,
  resolveNasApiConfig,
  type NasApiConfig,
} from "@/lib/server/nas-api-client";
import { getAuthedUser, nasUnreachable, unauthorized } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type SearchTarget = "edgesynology1" | "edgesynology2" | "both";

interface SearchBody {
  target?: SearchTarget;
  root_path?: string;
  name_pattern?: string;
  entry_type?: "file" | "directory" | "any";
  case_sensitive?: boolean;
  max_depth?: number;
  max_results?: number;
  include_synology_metadata?: boolean;
}

interface FileSearchMatch {
  kind: string;
  size_bytes: number | null;
  modified_at: string;
  owner_group: string;
  path: string;
}

function configsForTarget(target: SearchTarget): NasApiConfig[] {
  if (target === "both") return getNasApiConfigs();
  const config = resolveNasApiConfig(target);
  return config ? [config] : [];
}

function parseMatches(stdout: string): FileSearchMatch[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 5) return null;
      const sizeMatch = parts[1].match(/^(\d+) bytes$/);
      return {
        kind: parts[0],
        size_bytes: sizeMatch ? Number(sizeMatch[1]) : null,
        modified_at: parts[2],
        owner_group: parts[3],
        path: parts.slice(4).join("\t"),
      };
    })
    .filter((match): match is FileSearchMatch => Boolean(match));
}

export async function POST(request: NextRequest) {
  if (!(await getAuthedUser())) return unauthorized();

  const body = (await request.json().catch(() => null)) as SearchBody | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const target = body.target ?? "both";
  if (!["edgesynology1", "edgesynology2", "both"].includes(target)) {
    return NextResponse.json({ error: "target must be edgesynology1, edgesynology2, or both." }, { status: 400 });
  }

  const namePattern = (body.name_pattern ?? "").trim();
  if (!namePattern) {
    return NextResponse.json({ error: "name_pattern is required." }, { status: 400 });
  }

  const tool = findToolByName("live_file_search");
  if (!tool) return NextResponse.json({ error: "live_file_search is not available in the shared registry." }, { status: 500 });
  if (!tool.buildCommand) {
    return NextResponse.json({ error: "live_file_search cannot build a NAS command in this registry version." }, { status: 500 });
  }

  const configs = configsForTarget(target);
  if (configs.length === 0) {
    return NextResponse.json({ error: `No NAS API config is available for ${target}.` }, { status: 400 });
  }

  const args = {
    root_path: (body.root_path ?? "").trim(),
    name_pattern: namePattern,
    entry_type: body.entry_type ?? "file",
    case_sensitive: body.case_sensitive ?? true,
    max_depth: body.max_depth ?? 0,
    max_results: body.max_results ?? 500,
    include_synology_metadata: body.include_synology_metadata ?? false,
  };

  try {
    const results = await Promise.all(
      configs.map(async (config) => {
        try {
          const command = tool.buildCommand!({ target: config.name, ...args });
          const result = await executeNasCommandOnConfig(config, command, 120_000);
          return {
            target: config.name,
            ok: result.exitCode === 0,
            exit_code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            matches: parseMatches(result.stdout),
          };
        } catch (err) {
          return {
            target: config.name,
            ok: false,
            exit_code: -1,
            stdout: "",
            stderr: err instanceof Error ? err.message : "Unknown NAS API error",
            matches: [],
          };
        }
      }),
    );

    return NextResponse.json({
      ok: results.every((result) => result.ok),
      query: args,
      results,
    });
  } catch (err) {
    return nasUnreachable(err);
  }
}
