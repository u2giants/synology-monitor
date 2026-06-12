import { NextResponse, type NextRequest } from "next/server";
import { executeNasCommandOnConfig, resolveNasApiConfig } from "@/lib/server/nas-api-client";
import { getAuthedUser, nasUnreachable, unauthorized } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type TreeTarget = "edgesynology1" | "edgesynology2";

interface TreeEntry {
  name: string;
  path: string;
  modified_at: string;
  owner_group: string;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildTreeCommand(path: string): string {
  const p = path.trim() || "/";
  if (p !== "/" && !/^\/(volume[0-9]+|home)(\/|$)/.test(p)) {
    throw new Error("Path must be /, /volumeN, /volumeN/..., /home, or /home/...");
  }

  if (p === "/") {
    return [
      "echo '=== DIRECTORY TREE ROOTS ==='",
      "for d in /volume[0-9]* /home; do",
      "  [ -d \"$d\" ] || continue",
      "  stat -c '%n\t%y\t%U:%G' \"$d\" 2>/dev/null",
      "done | sort",
    ].join("\n");
  }

  return [
    `ROOT=${quote(p)}`,
    "echo '=== DIRECTORY TREE CHILDREN ==='",
    "[ -d \"$ROOT\" ] || { echo 'ERROR: directory not found'; exit 2; }",
    "find \"$ROOT\" -mindepth 1 -maxdepth 1 -type d \\( -name '@eaDir' -o -name '.SynologyWorkingDirectory' \\) -prune -o -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | while IFS= read -r d; do",
    "  stat -c '%n\t%y\t%U:%G' \"$d\" 2>/dev/null",
    "done | sort",
  ].join("\n");
}

function parseTree(stdout: string): TreeEntry[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 3) return null;
      const path = parts[0];
      return {
        name: path.split("/").filter(Boolean).pop() ?? path,
        path,
        modified_at: parts[1],
        owner_group: parts[2],
      };
    })
    .filter((entry): entry is TreeEntry => Boolean(entry));
}

export async function GET(request: NextRequest) {
  if (!(await getAuthedUser())) return unauthorized();

  const target = request.nextUrl.searchParams.get("target") as TreeTarget | null;
  if (!target || !["edgesynology1", "edgesynology2"].includes(target)) {
    return NextResponse.json({ error: "target must be edgesynology1 or edgesynology2." }, { status: 400 });
  }

  const config = resolveNasApiConfig(target);
  if (!config) {
    return NextResponse.json({ error: `No NAS API config is available for ${target}.` }, { status: 400 });
  }

  const path = request.nextUrl.searchParams.get("path") ?? "/";
  let command: string;
  try {
    command = buildTreeCommand(path);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid path." }, { status: 400 });
  }

  try {
    const result = await executeNasCommandOnConfig(config, command, 30_000);
    return NextResponse.json({
      ok: result.exitCode === 0,
      target: config.name,
      path: path.trim() || "/",
      entries: parseTree(result.stdout),
      stderr: result.stderr,
      exit_code: result.exitCode,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return nasUnreachable(new Error(`${config.name}: ${msg}`));
  }
}
