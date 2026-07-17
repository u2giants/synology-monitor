// Regression tests for the two tier-3 rename tools, after a proven shell-injection
// fix (2026-07-16). Every defect this file guards against was SILENT: the injection
// classified as a plain rename, the tier downgrade produced no error, and the failed
// mv reported success. None of them would surface without an assertion, which is why
// these are tests and not comments.
//
// The tests drive the REAL buildCommand and execute its output, so they fail if the
// builder regresses — a hand-copied command string would not.
//
// The registry-wide sweep at the bottom of this file is the generalisation: the
// rename fix was scoped to two tools, and the follow-up audit found the SAME bug in
// 23 more. Per-tool tests would not have found those, so the sweep asserts the
// invariant over every tool in ALL_TOOL_DEFS, including ones not written yet.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_TOOL_DEFS } from "./nas-tools";

const TOOLS = ["rename_file_to_old", "remove_invalid_chars"] as const;

function build(tool: string, filter: string): string {
  const def = ALL_TOOL_DEFS.find((t) => t.name === tool);
  if (!def?.buildCommand) throw new Error(`tool not found or has no buildCommand: ${tool}`);
  return def.buildCommand({ filter } as never);
}

/**
 * The generated commands address /btrfs/volumeN, which does not exist on a dev box
 * or in CI. Run them in a sandbox where that prefix is a real temp tree: `sh` is
 * started with the temp dir as / via a prefix rewrite, so the command text under
 * test is byte-for-byte what nas-api would run.
 */
let root: string;
function runIn(cmd: string, opts: { pathPrepend?: string } = {}): { code: number; out: string } {
  // Relocate the WHOLE /btrfs/volume prefix (digit-agnostic) under the sandbox,
  // so both the literal paths AND the confinement guard's `case /btrfs/volume[0-9]`
  // pattern move together — otherwise the guard would reject every sandboxed path.
  const rewritten = cmd.split("/btrfs/volume").join(join(root, "btrfs", "volume"));
  const env = { ...process.env };
  if (opts.pathPrepend) env.PATH = `${opts.pathPrepend}:${env.PATH ?? ""}`;
  try {
    // cwd is the sandbox: a payload that escapes quoting writes its marker inside
    // the temp tree rather than into the repo. (Before this was pinned, running the
    // pre-fix builder under test left a real PWNED file in the repo root — the
    // injection is not theoretical.)
    const out = execFileSync("/bin/sh", ["-c", rewritten], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root,
      env,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
function abs(rel: string): string {
  return join(root, "btrfs", "volume1", rel);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nas-write-safety-"));
  mkdirSync(join(root, "btrfs", "volume1", "share"), { recursive: true });
});
afterEach(() => {
  try {
    chmodSync(join(root, "btrfs", "volume1", "share"), 0o700);
  } catch {
    /* best effort */
  }
  rmSync(root, { recursive: true, force: true });
});

describe("shell injection is not possible via the filter path", () => {
  // The original bug: `mv "${filePath}" ...` with filePath='/volume1/x$(touch /tmp/X).txt'
  // executed the payload during word expansion — even though the mv itself then failed.
  const payloads = [
    "$(touch PWNED)",
    "`touch PWNED`",
    "$(touch PWNED).txt",
    "; touch PWNED; echo ",
    "&& touch PWNED",
    "| touch PWNED",
    "' ; touch PWNED ; '",
    '" ; touch PWNED ; "',
    "$IFS$(touch PWNED)",
    "x\ntouch PWNED\n",
  ];

  for (const tool of TOOLS) {
    for (const payload of payloads) {
      it(`${tool}: treats ${JSON.stringify(payload)} as filename data, never code`, () => {
        const cmd = build(tool, `/volume1/share/${payload}`);
        runIn(cmd);
        // The payload touches PWNED relative to cwd, which runIn pins to the sandbox.
        // If any of these exist, the filter escaped quoting and executed as code.
        expect(existsSync(join(root, "PWNED")), "payload executed (marker in sandbox cwd)").toBe(false);
        expect(existsSync(abs("share/PWNED")), "payload executed (marker in share)").toBe(false);
        expect(existsSync(join(process.cwd(), "PWNED")), "payload escaped the sandbox into the repo").toBe(false);
      });
    }
  }

  it("rename_file_to_old: a hostile path is carried single-quoted, and never raw in a double-quoted message", () => {
    const cmd = build("rename_file_to_old", "/volume1/share/x$(touch PWNED).txt");
    // Single-quoted at the use sites that matter (this is what makes $() inert).
    expect(cmd).toContain("'/btrfs/volume1/share/x$(touch PWNED).txt'");
    // The regression that nearly shipped: the path interpolated raw into a
    // double-quoted echo, which the || branch runs precisely when the path is
    // hostile. Inspect the text INSIDE each echo "..." — the mv line legitimately
    // carries the literal (single-quoted) path, so a whole-line check is wrong.
    const messages = [...cmd.matchAll(/echo "([^"]*)"/g)].map((m) => m[1]);
    expect(messages.length, "expected some echo messages to inspect").toBeGreaterThan(0);
    for (const msg of messages) {
      expect(msg, `message interpolates the raw path: ${msg}`).not.toContain("$(touch PWNED)");
    }
  });
});

describe("failure is reported as failure (no false success)", () => {
  it("remove_invalid_chars: a FAILED mv exits non-zero and does not claim 'No invalid characters found'", () => {
    // The original bug: `[ ] && mv && echo "Renamed" || echo "No invalid characters found"`
    // fired the || branch when mv FAILED, printing a no-op message and exiting 0.
    const dir = abs("share/ro");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f:1.txt"), "x");
    chmodSync(dir, 0o500); // read-only dir -> mv fails with EACCES

    const res = runIn(build("remove_invalid_chars", "/volume1/share/ro/f:1.txt"));
    chmodSync(dir, 0o700);

    expect(res.code, "a failed rename must exit non-zero").not.toBe(0);
    expect(res.out).not.toContain("No invalid characters found");
    expect(res.out).toContain("FAILED to rename");
  });

  for (const tool of TOOLS) {
    it(`${tool}: a missing source exits non-zero`, () => {
      const res = runIn(build(tool, "/volume1/share/does-not-exist:x.txt"));
      expect(res.code).not.toBe(0);
      expect(res.out).toContain("ERROR: no such path");
    });
  }
});

describe("happy paths still work", () => {
  it("rename_file_to_old: appends .old", () => {
    writeFileSync(abs("share/normal file.txt"), "x");
    const res = runIn(build("rename_file_to_old", "/volume1/share/normal file.txt"));
    expect(res.code).toBe(0);
    expect(res.out).toContain("Renamed successfully");
    expect(existsSync(abs("share/normal file.txt.old"))).toBe(true);
    expect(existsSync(abs("share/normal file.txt"))).toBe(false);
  });

  it("remove_invalid_chars: replaces sync-breaking characters in the basename only", () => {
    writeFileSync(abs("share/bad:name?.txt"), "x");
    const res = runIn(build("remove_invalid_chars", "/volume1/share/bad:name?.txt"));
    expect(res.code).toBe(0);
    expect(res.out).toContain("Renamed: bad:name?.txt -> bad_name_.txt");
    expect(existsSync(abs("share/bad_name_.txt"))).toBe(true);
  });

  it("remove_invalid_chars: a clean name is a true no-op, exit 0", () => {
    writeFileSync(abs("share/clean.txt"), "x");
    const res = runIn(build("remove_invalid_chars", "/volume1/share/clean.txt"));
    expect(res.code).toBe(0);
    expect(res.out).toContain("No invalid characters found");
    expect(existsSync(abs("share/clean.txt"))).toBe(true);
  });
});

describe("existing destinations are refused, never overwritten", () => {
  it("rename_file_to_old: refuses when .old already exists, leaving both files intact", () => {
    writeFileSync(abs("share/a.txt"), "new");
    writeFileSync(abs("share/a.txt.old"), "precious");
    const res = runIn(build("rename_file_to_old", "/volume1/share/a.txt"));
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("destination already exists");
    expect(existsSync(abs("share/a.txt"))).toBe(true);
  });

  it("remove_invalid_chars: refuses when the cleaned name already exists", () => {
    writeFileSync(abs("share/b:1.txt"), "new");
    writeFileSync(abs("share/b_1.txt"), "precious");
    const res = runIn(build("remove_invalid_chars", "/volume1/share/b:1.txt"));
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("destination already exists");
  });
});

describe("a symlink that escapes the share is refused (path confined by resolution, not just string)", () => {
  // toWritableVolumePath confines the path as a STRING, but mv follows symlinks at
  // the OS level. Reproduced: a symlink inside the share pointing outside it let a
  // "rename a file" approval rename a file anywhere root could reach. The realpath
  // guard rejects it. (Same class as the /btrfs/volumeevil string bypass.)
  for (const tool of TOOLS) {
    it(`${tool}: refuses to act on a path that resolves outside /btrfs/volumeN`, () => {
      // 'escape' inside the share is a symlink to a sibling dir OUTSIDE the share tree.
      const outside = join(root, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "secret.txt"), "SENSITIVE");
      symlinkSync(outside, abs("share/escape"));

      const res = runIn(build(tool, "/volume1/share/escape/secret.txt"));

      expect(res.code, "must refuse a path resolving outside the share").not.toBe(0);
      expect(res.out).toContain("resolves outside the writable share");
      // The file outside the share is untouched — nothing renamed, no .old / _ variant.
      expect(existsSync(join(outside, "secret.txt"))).toBe(true);
      expect(existsSync(join(outside, "secret.txt.old"))).toBe(false);
    });
  }
});

describe("a lying mv (silent no-op) is reported as failure, not success", () => {
  // The deployed image is coreutils 9.1, where `mv -n` on a skipped move exits 0
  // and moves nothing. Simulate the worst case — an mv that ALWAYS exits 0 and
  // moves nothing — by shimming PATH, and assert the end-state check still reports
  // failure. This is the version-agnostic property: success is asserted from the
  // end state (source gone AND dest present), never from mv's exit code.
  function shimNoopMv(): string {
    const bin = join(root, "shimbin");
    mkdirSync(bin, { recursive: true });
    const p = join(bin, "mv");
    writeFileSync(p, "#!/bin/sh\nexit 0\n"); // pretends success, moves nothing
    chmodSync(p, 0o755);
    return bin;
  }

  it("rename_file_to_old: exit non-zero and no false 'Renamed successfully'", () => {
    writeFileSync(abs("share/real.txt"), "x");
    const res = runIn(build("rename_file_to_old", "/volume1/share/real.txt"), { pathPrepend: shimNoopMv() });
    expect(res.code).not.toBe(0);
    expect(res.out).not.toContain("Renamed successfully");
    expect(res.out).toContain("FAILED to rename");
  });

  it("remove_invalid_chars: exit non-zero and no false 'Renamed:' on a silent no-op mv", () => {
    writeFileSync(abs("share/c:1.txt"), "x");
    const res = runIn(build("remove_invalid_chars", "/volume1/share/c:1.txt"), { pathPrepend: shimNoopMv() });
    expect(res.code).not.toBe(0);
    expect(res.out).not.toMatch(/Renamed: /);
    expect(res.out).toContain("FAILED to rename");
  });
});

describe("path contract", () => {
  for (const tool of TOOLS) {
    it(`${tool}: maps /volumeN to the writable /btrfs mount (the per-share binds are :ro)`, () => {
      expect(build(tool, "/volume1/share/x.txt")).toContain("'/btrfs/volume1/share/x.txt'");
    });

    // A loose startsWith("/btrfs/volume") accepts "/btrfs/volumeevil", which is not
    // just off-contract: ClassifyTier's filePatterns match /volume\d+/, so it
    // classifies tier 2 instead of 3. Measured against the real Go validator.
    for (const bad of [
      "/btrfs/volumeevil/x.txt",
      "/btrfs/volume1evil/x.txt",
      "/btrfs/volumeXYZ/x.txt",
      "/etc/passwd",
      "/volume1/../etc/passwd",
      "relative/path.txt",
      "/volume1",
    ]) {
      it(`${tool}: rejects ${bad}`, () => {
        expect(() => build(tool, bad)).toThrow();
      });
    }

    it(`${tool}: allows a legitimate filename containing '..'`, () => {
      expect(() => build(tool, "/volume1/share/my..file.txt")).not.toThrow();
    });
  }
});

describe("declared tier removes the classifier-driven command wart", () => {
  // nas-api now enforces the named tool's declared minimum independently of
  // lexical path proximity, so the raw caller path is assigned once and mv uses
  // shell variables. The Go golden contract proves the resulting command is still
  // effectively tier 3 even though ClassifyTier alone sees tier 2.
  for (const tool of TOOLS) {
    it(`${tool}: the mv line uses the safely quoted source variable`, () => {
      const mvLine = build(tool, "/volume1/share/x.txt")
        .split("\n")
        .find((l) => l.startsWith("mv "));
      expect(mvLine, "no mv line found").toBeDefined();
      expect(mvLine).toContain('mv -n "$src"');
      expect(mvLine).not.toContain("/btrfs/volume");
    });
  }
});

// ─── Registry-wide sweep ──────────────────────────────────────────────────────
//
// Every tool in the catalog, every string parameter, executed for real.
//
// Why execution rather than reading the source or regex-matching the built string:
// the bug is a *shell parsing* question, and the only authority on how sh parses a
// string is sh. Static checks got this wrong in both directions during the audit —
// they missed `echo "${pkg}: ..."` and falsely accused `"$(dirname '...')"`, which
// is correctly quoted. A marker file on disk is not arguable.
//
// Safety: PATH is emptied, so the generated command can run NO external binary —
// no pkill, no sysctl, no btrfs, no mv. The payloads use only shell redirection (a
// builtin), so the marker still appears if and only if the injected text was
// evaluated as code. Without this, running the catalog would restart services.
const PAYLOADS: { name: string; make: (prefix: string) => string }[] = [
  // Needs no quote character: expands inside double quotes AND unquoted.
  { name: "command substitution", make: (p) => `${p}$(>PWNED)` },
  { name: "backticks", make: (p) => `${p}\`>PWNED\`` },
  // Closes a single-quoted shell string that the value was interpolated into raw.
  { name: "single-quote breakout", make: (p) => `${p}'; >PWNED; echo '` },
  { name: "double-quote breakout", make: (p) => `${p}"; >PWNED; echo "` },
];

// Tried in order until one builds: tools validate their input, and a value that
// throws proves nothing. A tool whose every prefix throws is already safe by
// validation and is skipped.
const PREFIXES = ["/volume1/share/x", "", "volume1", "smb", "SynologyDrive", "1"];

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (let i = 0; i < 5; i++) {
    const d = s._def as { typeName?: string; innerType?: z.ZodTypeAny };
    if (d.typeName === "ZodOptional" || d.typeName === "ZodDefault") s = d.innerType!;
    else break;
  }
  return s;
}
function placeholderFor(schema: z.ZodTypeAny): unknown {
  const d = unwrap(schema)._def as { typeName?: string; values?: string[] };
  if (d.typeName === "ZodEnum") return d.values![0];
  if (d.typeName === "ZodNumber") return 5;
  if (d.typeName === "ZodBoolean") return true;
  return "placeholder";
}

describe("no tool executes a caller-supplied value (registry-wide)", () => {
  for (const def of ALL_TOOL_DEFS) {
    if (!def.buildCommand) continue; // native job tools dispatch over REST, no shell
    const shape = def.params ?? {};
    const stringParams = Object.keys(shape).filter(
      (k) => (unwrap(shape[k])._def as { typeName?: string }).typeName === "ZodString",
    );

    for (const param of stringParams) {
      it(`${def.name}: treats '${param}' as data, never code`, () => {
        for (const payload of PAYLOADS) {
          for (const prefix of PREFIXES) {
            const input: Record<string, unknown> = {};
            for (const k of Object.keys(shape)) input[k] = placeholderFor(shape[k]);
            input[param] = payload.make(prefix);

            let cmd: string;
            try {
              cmd = def.buildCommand!(input);
            } catch {
              continue; // rejected by the tool's own validator; try the next prefix
            }

            const sandbox = mkdtempSync(join(tmpdir(), "nas-sweep-"));
            try {
              execFileSync("/bin/sh", ["-c", cmd], {
                cwd: sandbox,
                stdio: ["ignore", "ignore", "ignore"],
                env: { PATH: "" },
                timeout: 5000,
              });
            } catch {
              // The visible command failing is expected (no binaries on PATH) and
              // irrelevant: the injection runs at word expansion, before it.
            }
            const executed = existsSync(join(sandbox, "PWNED"));
            rmSync(sandbox, { recursive: true, force: true });

            expect(
              executed,
              `${def.name}.${param} executed an injected payload (${payload.name}). ` +
                `Route the value through quote()/echoMsg() — see the header of nas-tools.ts.\n${cmd}`,
            ).toBe(false);
            break; // this payload built and ran; move to the next payload
          }
        }
      });
    }
  }
});
