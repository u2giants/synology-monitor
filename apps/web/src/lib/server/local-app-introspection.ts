import { promises as fs } from "node:fs";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

async function pathExists(path: string) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function findRepoRoot() {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), ".."),
    resolve(process.cwd(), "../.."),
  ];

  for (const candidate of candidates) {
    const [hasPackageJson, hasAppsDir] = await Promise.all([
      pathExists(join(candidate, "package.json")),
      pathExists(join(candidate, "apps")),
    ]);
    if (hasPackageJson && hasAppsDir) return candidate;
  }

  return process.cwd();
}

async function safeReadJson(path: string) {
  try {
    const content = await fs.readFile(path, "utf8");
    return JSON.parse(content) as JsonRecord;
  } catch {
    return null;
  }
}

async function safeReadText(path: string) {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function safeExecGit(repoRoot: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], { timeout: 4000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseComposeServices(composeText: string | null) {
  if (!composeText) return [];
  const serviceLines = composeText
    .split("\n")
    .map((line) => line.match(/^  ([A-Za-z0-9._-]+):\s*$/)?.[1] ?? null)
    .filter((value): value is string => Boolean(value));
  return serviceLines.slice(0, 12);
}

export async function getLocalAppIntrospectionSnapshot() {
  const repoRoot = await findRepoRoot();
  const [packageJson, composeText, branch, gitStatus] = await Promise.all([
    safeReadJson(join(repoRoot, "package.json")),
    safeReadText(join(repoRoot, "docker-compose.yml")),
    safeExecGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    safeExecGit(repoRoot, ["status", "--short"]),
  ]);

  const scripts = typeof packageJson?.scripts === "object" && packageJson.scripts
    ? Object.keys(packageJson.scripts as JsonRecord).slice(0, 20)
    : [];
  const envPresence = {
    OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY),
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
    ISSUE_WORKER_MODE: process.env.ISSUE_WORKER_MODE ?? null,
    ISSUE_WORKER_TOKEN: Boolean(process.env.ISSUE_WORKER_TOKEN),
  };

  return {
    repo_root: repoRoot,
    branch: branch ?? "unknown",
    dirty_file_count: gitStatus ? gitStatus.split("\n").filter(Boolean).length : null,
    dirty_files_preview: gitStatus ? gitStatus.split("\n").filter(Boolean).slice(0, 20) : [],
    package_name: typeof packageJson?.name === "string" ? packageJson.name : null,
    package_manager: typeof packageJson?.packageManager === "string" ? packageJson.packageManager : null,
    root_scripts: scripts,
    compose_present: composeText != null,
    compose_services: parseComposeServices(composeText),
    env_presence: envPresence,
  };
}
