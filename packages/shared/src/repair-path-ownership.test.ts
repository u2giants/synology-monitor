import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_TOOL_DEFS } from "./nas-tools";

function build(filter: string, exactPath: string): string {
  const def = ALL_TOOL_DEFS.find((tool) => tool.name === "repair_path_ownership");
  if (!def?.buildCommand) throw new Error("repair_path_ownership is missing");
  return def.buildCommand({ filter, exactPath } as never);
}

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ownership-repair-"));
  file = join(root, "btrfs", "volume1", "share", "scratch.txt");
  mkdirSync(join(root, "btrfs", "volume1", "share"), { recursive: true });
  mkdirSync(join(root, "host", "etc"), { recursive: true });
  mkdirSync(join(root, "host", "usr", "syno", "bin"), { recursive: true });
  writeFileSync(file, "scratch");
  const { uid, gid } = statSync(file);
  writeFileSync(join(root, "host", "etc", "passwd"), `scratchuser:x:${uid}:${gid}:Scratch:/tmp:/bin/sh\n`);
  writeFileSync(join(root, "host", "etc", "group"), `scratchgroup:x:${gid}:\n`);
  const acl = join(root, "host", "usr", "syno", "bin", "synoacltool");
  writeFileSync(acl, "#!/bin/sh\necho \"It's Linux mode\"\n");
  chmodSync(acl, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(command: string): { code: number; out: string } {
  const rewritten = command
    .split("/btrfs/volume1").join(join(root, "btrfs", "volume1"))
    .split("/host").join(join(root, "host"));
  try {
    return { code: 0, out: execFileSync("/bin/sh", ["-c", rewritten], { encoding: "utf8" }) };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("repair_path_ownership", () => {
  it("maps the logical path, resolves NAS names numerically, and verifies a no-op chown", () => {
    const command = build("scratchuser:scratchgroup", "/volume1/share/scratch.txt");
    expect(command).toContain("Logical path: /volume1/share/scratch.txt");
    expect(command).toContain("Writable path: /btrfs/volume1/share/scratch.txt");
    expect(command).toContain("chown \"$uid:$gid\" '/btrfs/volume1/share/scratch.txt'");
    const result = run(command);
    expect(result.code).toBe(0);
    expect(result.out).toContain("VERIFIED: ownership is");
  });

  it("fails loudly when the NAS group mount is missing", () => {
    rmSync(join(root, "host", "etc", "group"));
    const result = run(build("scratchuser:scratchgroup", "/volume1/share/scratch.txt"));
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("NAS group database is not mounted");
  });

  it("accepts numeric ids", () => {
    const { uid, gid } = statSync(file);
    const result = run(build(`${uid}:${gid}`, "/volume1/share/scratch.txt"));
    expect(result.code).toBe(0);
  });

  it("rejects recursion, traversal, off-volume paths, and symlinks", () => {
    expect(() => build("recursive:scratchuser:scratchgroup", "/volume1/share/scratch.txt")).toThrow(/recursive.*disabled/);
    expect(() => build("scratchuser:scratchgroup", "/volume1/../etc/shadow")).toThrow();
    expect(() => build("scratchuser:scratchgroup", "/etc/shadow")).toThrow();
  });

  it("keeps hostile path text inert", () => {
    const command = build("scratchuser:scratchgroup", "/volume1/share/x$(touch OWNED)");
    expect(command).toContain("'/btrfs/volume1/share/x$(touch OWNED)'");
    run(command);
    expect(() => statSync(join(root, "OWNED"))).toThrow();
  });
});
