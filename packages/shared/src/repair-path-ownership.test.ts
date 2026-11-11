import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_TOOL_DEFS } from "./nas-tools";

function def() {
  const d = ALL_TOOL_DEFS.find((tool) => tool.name === "repair_path_ownership");
  if (!d?.buildCommand || !d.buildPreflight) throw new Error("repair_path_ownership is missing");
  return d;
}
function build(filter: string, exactPath: string): string {
  return def().buildCommand!({ filter, exactPath } as never);
}
function preflight(filter: string, exactPath: string): string {
  return def().buildPreflight!({ filter, exactPath } as never);
}

let root: string;
let file: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ownership-repair-")));
  file = join(root, "btrfs", "volume1", "share", "scratch.txt");
  mkdirSync(join(root, "btrfs", "volume1", "share"), { recursive: true });
  mkdirSync(join(root, "host", "etc"), { recursive: true });
  mkdirSync(join(root, "host", "usr", "syno", "bin"), { recursive: true });
  writeFileSync(file, "scratch");
  const { uid, gid } = statSync(file);
  writeFileSync(join(root, "host", "etc", "passwd"), `scratchuser:x:${uid}:${gid}:Scratch:/tmp:/bin/sh\n`);
  writeFileSync(join(root, "host", "etc", "group"), `scratchgroup:x:${gid}:\n`);
  const acl = join(root, "host", "usr", "syno", "bin", "synoacltool");
  // Mirrors live DSM 7: Linux-mode answer on stdout with exit 255.
  writeFileSync(acl, "#!/bin/sh\necho \"(synoacltool.c, 596)It's Linux mode\"\nexit 255\n");
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
    expect(command).toContain("chown -h \"$uid:$gid\" -- '/btrfs/volume1/share/scratch.txt'");
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

  it("rejects recursion, traversal, and off-volume paths at build time", () => {
    expect(() => build("recursive:scratchuser:scratchgroup", "/volume1/share/scratch.txt")).toThrow(/recursive.*disabled/);
    expect(() => build("scratchuser:scratchgroup", "/volume1/../etc/shadow")).toThrow();
    expect(() => build("scratchuser:scratchgroup", "/etc/shadow")).toThrow();
  });

  it("refuses a symlink target at run time without chowning it", () => {
    // The symlink guard is a runtime `[ ! -L ]` shell check, not a build-time
    // throw — so it can only be proven by executing the command against an actual
    // symlink. The build succeeds; execution must abort before the chown.
    const link = join(root, "btrfs", "volume1", "share", "link.txt");
    symlinkSync(file, link);
    const command = build("scratchuser:scratchgroup", "/volume1/share/link.txt");
    const result = run(command);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("symbolic links are refused");
    expect(result.out).not.toContain("VERIFIED");
  });

  it("fails closed when the ACL read fails", () => {
    const acl = join(root, "host", "usr", "syno", "bin", "synoacltool");
    writeFileSync(acl, "#!/bin/sh\necho 'boom' >&2\nexit 3\n");
    chmodSync(acl, 0o755);
    const result = run(build("scratchuser:scratchgroup", "/volume1/share/scratch.txt"));
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("synoacltool exit 3");
    expect(result.out).not.toContain("VERIFIED");
  });

  it("fails closed on a Synology-ACL path", () => {
    const acl = join(root, "host", "usr", "syno", "bin", "synoacltool");
    writeFileSync(acl, "#!/bin/sh\necho 'ACL version: 1'\necho '[0] user:mac:allow:rwx'\n");
    chmodSync(acl, 0o755);
    const result = run(build("scratchuser:scratchgroup", "/volume1/share/scratch.txt"));
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("uses Synology ACLs");
    expect(result.out).not.toContain("VERIFIED");
  });

  it("refuses a path under a symlinked parent folder", () => {
    const real = join(root, "btrfs", "volume1", "share", "realdir");
    mkdirSync(real);
    writeFileSync(join(real, "f.txt"), "x");
    symlinkSync(real, join(root, "btrfs", "volume1", "share", "linkdir"));
    const result = run(build("scratchuser:scratchgroup", "/volume1/share/linkdir/f.txt"));
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("resolves elsewhere");
    expect(result.out).not.toContain("VERIFIED");
  });

  it("refuses a file with several hard links", () => {
    linkSync(file, join(root, "btrfs", "volume1", "share", "twin.txt"));
    const result = run(build("scratchuser:scratchgroup", "/volume1/share/scratch.txt"));
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("hard links");
  });

  it("preflight shows the facts, never chowns, and the command does", () => {
    const pre = preflight("scratchuser:scratchgroup", "/volume1/share/scratch.txt");
    expect(pre).not.toMatch(/\bchown\b/);
    const result = run(pre);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Current ownership:");
    expect(result.out).toContain("It's Linux mode");
    expect(result.out).toContain("PREFLIGHT OK");
  });

  it("shows the ACL output and no warning when the ACL read succeeds", () => {
    const result = run(build("scratchuser:scratchgroup", "/volume1/share/scratch.txt"));
    expect(result.out).toContain("It's Linux mode");
    expect(result.out).not.toContain("WARNING: ACL mode could not be read");
  });

  it("keeps hostile path text inert", () => {
    const command = build("scratchuser:scratchgroup", "/volume1/share/x$(touch OWNED)");
    expect(command).toContain("'/btrfs/volume1/share/x$(touch OWNED)'");
    run(command);
    expect(() => statSync(join(root, "OWNED"))).toThrow();
  });
});
