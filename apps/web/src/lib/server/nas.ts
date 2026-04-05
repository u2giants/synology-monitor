import { spawn } from "node:child_process";

type NasTarget = "edgesynology1" | "edgesynology2";

export interface NasConfig {
  name: NasTarget;
  host: string;
  port: string;
  user: string;
  sshPassword: string;
  sudoPassword: string;
}

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\//i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bdd\s+if=/i,
  /\bpasswd\b/i,
  /\buser(add|del|mod)\b/i,
  />\s*\/dev\/sd/i,
  /\bmount\b/i,
  /\bumount\b/i,
];

export function getNasConfigs(): NasConfig[] {
  const configs: NasConfig[] = [
    {
      name: "edgesynology1",
      host: process.env.NAS_EDGE1_HOST ?? "",
      port: process.env.NAS_EDGE1_PORT ?? "22",
      user: process.env.NAS_EDGE1_USER ?? "",
      sshPassword: process.env.NAS_EDGE1_PASSWORD ?? "",
      sudoPassword: process.env.NAS_EDGE1_SUDO_PASSWORD ?? process.env.NAS_EDGE1_PASSWORD ?? "",
    },
    {
      name: "edgesynology2",
      host: process.env.NAS_EDGE2_HOST ?? "",
      port: process.env.NAS_EDGE2_PORT ?? "22",
      user: process.env.NAS_EDGE2_USER ?? "",
      sshPassword: process.env.NAS_EDGE2_PASSWORD ?? "",
      sudoPassword: process.env.NAS_EDGE2_SUDO_PASSWORD ?? process.env.NAS_EDGE2_PASSWORD ?? "",
    },
  ];

  return configs.filter((config) => config.host && config.user && config.sshPassword && config.sudoPassword);
}

export function validateWriteCommand(command: string) {
  const trimmed = command.trim();

  if (!trimmed) {
    return "Command is empty.";
  }

  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return "Command matches a blocked destructive pattern.";
  }

  return null;
}

export async function runNasScript(config: NasConfig, script: string, timeoutMs = 20_000) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(
      "sshpass",
      [
        "-e",
        "ssh",
        "-p",
        config.port,
        "-o",
        "ConnectTimeout=6",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=1",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `${config.user}@${config.host}`,
        "sudo",
        "-S",
        "-p",
        "",
        "bash",
        "-s",
      ],
      {
        env: {
          ...process.env,
          SSHPASS: config.sshPassword,
        },
      }
    );

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
    });

    child.stdin.write(`${config.sudoPassword}\n${script}`);
    child.stdin.end();
  });
}

export async function collectNasDiagnostics(lookbackHours = 2) {
  const configs = getNasConfigs();
  const driveLines = Math.max(60, Math.min(300, lookbackHours * 50));
  const shareSyncLines = Math.max(40, Math.min(240, lookbackHours * 30));

  const script = [
    "set -e",
    "echo '## hostname'",
    "hostname",
    "echo '## uptime'",
    "uptime",
    "echo '## volume1'",
    "df -h /volume1 2>/dev/null || true",
    "echo '## agent'",
    "/usr/local/bin/docker ps --format '{{.Image}}|{{.Status}}|{{.Names}}' | grep synology-monitor-agent || true",
    "echo '## drive_log'",
    `tail -n ${driveLines} /var/log/synologydrive.log 2>/dev/null || true`,
    "echo '## sharesync_log'",
    `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "$f"; tail -n ${shareSyncLines} "$f"; done 2>/dev/null || true`,
  ].join("\n");

  const results = await Promise.all(
    configs.map(async (config) => {
      try {
        const result = await runNasScript(config, script);
        return {
          target: config.name,
          ok: result.exitCode === 0,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (error) {
        return {
          target: config.name,
          ok: false,
          stdout: "",
          stderr: error instanceof Error ? error.message : "Unknown SSH error",
        };
      }
    })
  );

  return results;
}

export async function executeApprovedCommand(target: NasTarget, command: string) {
  const config = getNasConfigs().find((item) => item.name === target);

  if (!config) {
    throw new Error(`Unknown NAS target: ${target}`);
  }

  const validationError = validateWriteCommand(command);
  if (validationError) {
    throw new Error(validationError);
  }

  return runNasScript(config, command, 90_000);
}
