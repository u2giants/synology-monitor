# Implementation plan — kill the phantom "MCP degrades after ~10–15 tool calls"

Repo: `u2giants/synology-monitor` · working copy `/worksp/monitor/app` · branch `main`
Written 2026-08-05 · Reviewed by GLM 5.2 (`.ai/reviews/glm-mcp-myth-plan-review-2-20260806T010719Z.md`)

---

## STATUS

Read this table first. Do not re-derive or re-plan; do not redo a `✅` row.

| # | Step | State |
|---|---|---|
| 0 | `BlockExplanation()` written, wired, deployed, verified live on the NAS | ✅ done 2026-06-03, re-verified live 2026-08-05 |
| 1 | Add the "no call limit" paragraph to `MCP_INSTRUCTIONS` (`index.ts:37`) | ⬜ open |
| 2 | Warn up front in the MCP `run_command` description (`index.ts:635`) | ⬜ open |
| 3 | Stop the web issue-agent discarding `preview.summary` — **BOTH** sites (`stage2-reasoning.ts:350-356` and `:411-419`) | ⬜ open — **highest value in the plan** |
| 4 | Align the web issue-agent `run_command` description (`stage2-reasoning.ts:286`) **and its system prompt (`:65-68`)** | ⬜ open |
| 5 | Mark the three symptom lines in `docs/architecture.md` as FIXED | ⬜ open |
| 6 | Annotate the incident sentence at `docs/synology-incident-2026-06.md:398` | ⬜ open |
| 7 | Add the myth entry to `AGENTS.md` | ⬜ open |
| 8 | Ship: scoped commit, push, CI, verify deployed, clean up, fix stale memory | ⬜ open |

**A fresh session starts at Step 1.** Steps 1–7 are independent of each other and may
be done in any order or all at once; Step 8 is last.

---

# PART 1 — WHY

## 1. The ultimate goal, in plain business English

**AI sessions must stop inventing a limit that does not exist, and stop quitting
because of it.**

Today, an AI assistant connected to the NAS tools runs a few commands, gets one
refusal, and concludes "this server degrades after about 10 to 15 calls, only simple
commands are reliable." It then gives up, or hands the work to a brand-new session,
which starts over and hits the same wall. Albert pays for the same investigation
three times and often still does not get an answer.

There is no such limit. There is no counter anywhere in this system. What the
assistant actually hit is a permanent safety rule that refuses one specific dangerous
command, and would refuse it identically on the very first call.

**When this work is done:** an AI that hits a refusal understands, from the words in
front of it, that the refusal is permanent and about the *command*, not about the
session — and it changes the command instead of abandoning the work.

> **If any step below conflicts with that goal, the goal wins. Stop and flag it.**
> The steps are text edits and one bug fix. If an edit would make the message longer
> but less likely to be understood at the moment of refusal, the goal says shorten it.

## 2. What this application is

`synology-monitor` is a monitoring and remediation system for two Synology NAS boxes
(`edgesynology1`, `edgesynology2`) that hold POP Creations' design files.

| Piece | What it is | Where it runs |
|---|---|---|
| `apps/web` | Next.js dashboard **and the AI issue-agent** (a 3-stage pipeline that investigates alerts on its own) | Coolify on the VPS |
| `apps/nas-mcp` | TypeScript FastMCP server exposing NAS tools to chat clients (claude.ai, Claude Desktop, Codex) at `https://nas-mcp.designflow.app/mcp` | Coolify on the VPS |
| `apps/nas-api` | Go service on each NAS that validates and executes commands | NAS Docker + Watchtower |
| `apps/agent` | Telemetry collector, one per NAS | NAS Docker + Watchtower |
| `packages/shared` | Shared tool definitions (`nas-tools.ts`, 132 operations) and the only package with a test runner (vitest) | library |

Stack: TypeScript monorepo (turbo, pnpm-style workspaces) plus one Go service.
Branch policy: **main only, no branches.**

**There are two separate consumers of the NAS tools**, and this is the single most
important structural fact in this plan:

1. **MCP clients** — chat sessions (claude.ai, Claude Desktop, Codex). They have **no
   repository checkout**. They never read `AGENTS.md` or any doc in this repo. The
   only text that reaches them is what the MCP server sends: the `instructions`
   string, tool descriptions, and tool responses.
2. **The web issue-agent** — `apps/web/src/lib/server/ai/`, which calls the NAS API
   directly with its **own** tool definitions. It never goes through `apps/nas-mcp`.

Anything you fix in one does **not** fix the other. Both are in scope.

## 3. What triggered this work

Repeated, documented sessions claiming: *"synology-monitor degrades after roughly
10–15 tool calls; only single simple `run_command` calls stay reliable."*

It is folklore. Root cause established below (§6). Albert asked on 2026-08-05 for the
myth to be killed at the source.

**How to reproduce the refusal that starts the myth** (safe, read-only, blocked before
anything executes):

```
run_command({ target: "edgesynology1", command: "grep -r \"test\" /volume1/@synologydrive" })
```

Run this on call #1 of a brand-new session and it is refused identically. That single
fact disproves the "degrades after 10–15 calls" claim, and is worth re-running if
anyone doubts the premise of this plan.

## 4. Scope

**In scope:** the eight steps in the STATUS table. Wording in one MCP instructions
string, two tool descriptions, one refusal message in the web issue-agent, three doc
lines, one incident annotation, one AGENTS.md entry, and shipping it.

**NOT in scope — do not touch:**

- **The validator's block patterns** (`apps/nas-api/internal/validator/validator.go`
  `hardBlocked`). Do not loosen, narrow, or "improve" them. The recursive-grep block
  exists because one such grep ran **4 days 11 hours** on production before anyone
  caught it. Making the refusal go away is the opposite of this plan.
- `BlockExplanation()` itself. It is correct, shipped, and live.
- The 7-tool lazy registry, `Connection: close`, tool tiers, HMAC approval tokens.
- Anything requiring a `nas-api` image build or a NAS-side container recreate. **No
  step here touches Go.** If you find yourself editing Go, you have left the plan.
- Any database, schema, RLS, or migration change. There is none here.
- The MCP spec upgrade (2026-07-28 / SDK v2). Separate, unstarted decision.
- `docs/architecture.md:405` and `apps/nas-mcp/README.md:111`. They mention the
  socket-pool symptom but already sit beside their fix, so they do not teach the myth.
  GLM flagged them; we are deliberately leaving them (see §7, rejected #5).

---

# PART 2 — WHAT WE ALREADY KNOW

## 5. Current state of the code

Branch `main`, clean except for the artifacts named in Step 8c. Everything below was
verified by reading the files on 2026-08-05 — trust it, but the `file:line` refs are
exact so you can confirm cheaply.

### Already done and LIVE — do not redo

`validator.BlockExplanation()` (`apps/nas-api/internal/validator/validator.go:426`)
returns a specific, actionable reason for each hard-block, ending in a shared footer
(`validator.go:431`):

> "This block is permanent and stateless — it is NOT a rate limit, quota, or
> session-degradation symptom, and it fired on the command pattern alone. Retrying it
> or starting a fresh session will return the exact same result; change the command
> instead."

It is wired at `apps/nas-api/cmd/server/main.go:206` (`handlePreview` swaps `Summary`
for `BlockExplanation` when `tier == -1`) and surfaces in the MCP server at
`apps/nas-mcp/src/index.ts:167` (invoke_tool path) and `:656` (run_command path).

**It is deployed.** Verified 2026-08-05 by running the reproduction command in §3
against `edgesynology1`; the response carried the full explanation including the
footer. An earlier note claiming this was "written but never committed" is **stale** —
that note is fixed in Step 8d.

### Both original root causes are fixed IN CODE, not just documented

- Lazy tool registry: `EAGER_TOOLS` at `apps/nas-mcp/src/index.ts:35` registers only
  two tools eagerly; the other 130 are reached via `tool_search` / `invoke_tool`.
- `Connection: close`: `apps/nas-mcp/src/nas-client.ts:61` and
  `apps/nas-mcp/src/job-client.ts:109`.

### What is still open — the five edit sites

| Site | State |
|---|---|
| `apps/nas-mcp/src/index.ts:37` (`MCP_INSTRUCTIONS`, wired at `:450`) | Says nothing about refusals or limits |
| `apps/nas-mcp/src/index.ts:635` (MCP `run_command` description) | Mentions write blocks only; nothing about permanence |
| `apps/web/src/lib/server/ai/stage2-reasoning.ts:349-355` | **Bug** — discards `preview.summary` |
| `apps/web/src/lib/server/ai/stage2-reasoning.ts:286-291` | Web agent's own description; same gap as `:635` |
| `docs/architecture.md:368`, `:783`, `:837`; `docs/synology-incident-2026-06.md:398`; `AGENTS.md` | Docs teach the symptom with no "fixed" marker |

## 6. Key findings and root cause

**The "~10–15" number was real, twice, for two unrelated reasons. Both are fixed.**

1. **Tool-schema bloat.** Eagerly registering all 132 tool schemas put roughly 50k
   tokens into every session. Answer quality fell off after ~10–15 calls because the
   context was full of schemas. Fixed by the lazy registry.
2. **Socket-pool exhaustion.** undici's keep-alive pool exhausted after ~10–15 calls
   because timed-out requests never returned their socket. Fixed by `Connection: close`.

Two different fixes, same number, both written down in `docs/architecture.md` as bare
symptoms with no resolution marker. An AI reads either line and concludes the server
degrades today.

**What sessions actually hit now** is `hardBlocked` in `validator.go` — a **stateless,
pure** pattern list. Same command in, same refusal out, on call 1 or call 100. No
counter exists anywhere in `nas-mcp`, `nas-api`, or the web agent.

**The sequence that produces the hallucination:** session runs a few calls fine →
requests a recursive grep on a Drive path → gets a refusal it did not expect → matches
it to the "degrades after 10–15 calls" story it read in the repo (or invents it from
training priors) → concludes the session is spent → abandons or hands off.

**GLM's finding, verified independently:** the fix that is "live" reaches MCP clients
but **not** the web issue-agent. `stage2-reasoning.ts:349-355` receives `preview` —
whose `.summary` now carries the full `BlockExplanation` — and throws it away,
substituting:

```ts
`run_command: "${command}" requires tier-${preview.tier}${preview.blocked ? " (hard-blocked by the NAS validator)" : ""}. ` +
`Read-only investigation is tier-1 only. If a privileged action is warranted, propose it as a remediation.`
```

Terse, generic, and silent on permanence. That is exactly the message shape this whole
plan exists to eliminate — still live on the other consumer. **This is the highest-value
step in the plan.**

**Ranking of levers, by how much they actually change model behavior** (GLM's analysis,
which I agree with):

1. **Refusal-time message** (`BlockExplanation`) — strongest, because it is what is in
   the conversation at the moment the model re-reasons. Already shipped for MCP;
   **missing for the web agent** → Step 3.
2. **Session-start `instructions`** — reaches every MCP client before any tool call →
   Step 1.
3. **Tool descriptions** — read at tool-selection time, not re-injected at refusal
   time; and `MCP_INSTRUCTIONS` steers models toward `tool_search` over `run_command`,
   so fewer models even load that schema → Steps 2 and 4, modest.
4. **Docs** — zero reach into MCP-only clients. They help sessions working *in this
   checkout* (like Claude Code) → Steps 5–7.

**Be honest about this:** Steps 5, 6 and 7 do **not** fix the MCP-only population named
in the goal. They are still worth doing — they stop repo-reading sessions from
re-learning the myth — but do not count them as the fix.

## 7. Approaches considered and REJECTED

1. **Fix it with documentation alone.** Rejected. The affected sessions have no repo
   checkout. This was the original instinct and it is why the myth survived this long.
2. **Loosen or remove the grep hard-block so the refusal stops happening.** Rejected,
   permanently. See §4 — 4d11h runaway grep on production.
3. **Client-side `settings.json` permissions.** They have no effect on a server-side
   Go validator. Mentioning them is a dead end.
4. **`notifications/tools/list_changed` to push updated descriptions to live
   sessions.** Rejected — documented at `docs/architecture.md:783`: Claude clients
   cache the initial `tools/list` and do not re-fetch. See the caching caveat in Step 2.
5. **Rewriting `docs/architecture.md:405` and `apps/nas-mcp/README.md:111`** (GLM's
   finding E). Rejected as noise: both already state the symptom next to its fix, so
   neither reads as a live limit. Recorded here so the next reviewer does not re-raise it.
6. **`git add -A` in the ship step.** Rejected — GLM caught this. The tree has
   unrelated partial work (see `HANDOFF.md`) plus this plan's own artifacts. Step 8
   stages named files only.
7. **Adding vitest to `apps/web` or `apps/nas-mcp` to test the new message.** Rejected
   as scope creep — neither package has a test runner today. Step 3 instead extracts a
   pure function into `packages/shared`, which already runs vitest. See §10.
8. **Deleting the incident sentence at `synology-incident-2026-06.md:398`.** Rejected —
   never rewrite incident history. Step 6 annotates it in brackets instead.

## 8. Design decisions already made

| Decision | Date | Locked? |
|---|---|---|
| The block patterns stay exactly as they are | 2026-06 | **LOCKED** |
| The message, not the block, is what changes | 2026-06-03 | **LOCKED** |
| Both consumers (MCP + web agent) must carry the same explanation | 2026-08-05 | **LOCKED** |
| `MCP_INSTRUCTIONS` is the primary MCP-side lever; tool descriptions are secondary | 2026-08-05, per GLM | **LOCKED** |
| Incident history is annotated, never rewritten | 2026-08-05 | **LOCKED** |
| Exact wording of each new paragraph | 2026-08-05 | **OPEN** — the drafts below are good; tighten if you can keep every load-bearing idea (no limit / permanent / stateless / change the command, don't retry) |
| Whether to extract the block-message formatter to `packages/shared` or inline it | 2026-08-05 | **OPEN** — see Step 3, judgment call with criteria |

---

# PART 3 — HOW TO BUILD IT

## 9. The plan

All of Steps 1–7 are independent. One session can do all eight; there is no context
cut point in work this size.

---

### Step 1 — Add the "no call limit" paragraph to `MCP_INSTRUCTIONS` — **highest MCP-side reach**

**File:** `apps/nas-mcp/src/index.ts:37` (the `MCP_INSTRUCTIONS` template literal,
wired into the server at `:450` as `instructions: MCP_INSTRUCTIONS`).

**Why here:** this string is delivered to the client at `initialize`, before any tool
call, to every MCP client. It is the earliest text we control.

**What to do:** append this paragraph before the closing backtick, after the existing
"Do not invent or expose bearer tokens." line:

```
There is NO per-session call limit and no session degradation on this server. If a
command is refused, that refusal is permanent and stateless: it fired on the command
pattern alone and the identical command will be refused identically on every future
call, in this session or a brand-new one. Retrying it or starting a fresh session
changes nothing. Change the command instead — for example, replace a recursive grep
of a Synology Drive store with a bounded non-recursive grep of one named log file.
```

**Behavior when done:** every new MCP session begins with that text in context, so a
refusal arriving later has a pre-loaded frame that contradicts the "degradation" story.

**Verification gate:** `cd apps/nas-mcp && npx tsc --noEmit` exits 0. After deploy,
Step 8b confirms it live.

---

### Step 2 — Warn up front in the MCP `run_command` description

**File:** `apps/nas-mcp/src/index.ts:635`.

**Replace:**

```ts
description: "Run any read-only shell command on a Synology NAS for deep diagnosis. Write commands are automatically blocked by the NAS API validator before execution. For named capabilities, prefer tool_search followed by invoke_tool.",
```

**With:**

```ts
description: "Run any read-only shell command on a Synology NAS for deep diagnosis. Write commands, and a fixed list of dangerous read patterns (notably recursive grep against Synology Drive internal stores), are blocked by the NAS API validator before execution. Those blocks are permanent and stateless — the same command is refused identically on every call. There is NO per-session call limit and no session degradation; a refusal never means retry or start a fresh session, it means change the command. For named capabilities, prefer tool_search followed by invoke_tool.",
```

**Caching caveat — write this down for whoever asks later:** neither this nor Step 1
reaches an **already-connected** session. Per `docs/architecture.md:783`, Claude
clients cache the initial `tools/list` and do not re-fetch. Both take effect on the
next `initialize`, i.e. a new chat session after the deploy.

**Verification gate:** `npx tsc --noEmit` in `apps/nas-mcp` exits 0.

---

### Step 3 — Stop the web issue-agent discarding the explanation — **the real bug**

**File:** `apps/web/src/lib/server/ai/stage2-reasoning.ts:349-355`.

**Current behavior:** on a blocked or non-tier-1 command it builds its own terse
message and drops `preview.summary`, which now carries the full `BlockExplanation`.

**THERE ARE TWO SITES, NOT ONE.** Grok 4.5 found the second on 2026-08-05, verified:

- `:350-356` — the free-form `run_command` path (the one originally diagnosed).
- `:411-419` — the **predefined NAS tools** path. Identical bug: same
  `if (preview.blocked || preview.tier !== 1)` shape, same discard of
  `preview.summary`. Fixing only the first leaves the myth alive for every one of the
  ~130 named tools. **Both must be fixed.**

**Two further details, both verified:**

- **Keep `isError: true`.** Both current returns set it (`:355`, `:418`). Dropping it
  regresses provider error marking (`providers/anthropic.ts:155-160`). Only `content`
  changes.
- **The current message prints `tier--1`** on a block, because `preview.tier` is `-1`
  and the template says `tier-${preview.tier}`. That garbled string is itself
  myth-fuel — it reads as "something weird happened." Relaying `summary` removes it.

**Intended behavior:** when `preview.blocked` is true and `preview.summary` is
non-empty, the returned `content` **must include `preview.summary` verbatim**. The
NAS API is the authority on why a command was refused; the web agent must relay that
authority, not paraphrase it. Keep the existing tier-2/tier-3 branch (not blocked, but
`tier !== 1`) as it is — that path is about approval, not about a permanent block, and
its current wording is correct.

**Shape to aim for:**

- `preview.blocked === true` → `content` = `preview.summary` (prefixed with
  `run_command: "<command>" was refused. `), falling back to the existing terse text
  only if `summary` is empty.
- `preview.blocked === false && preview.tier !== 1` → unchanged from today.

**Judgment call (OPEN):** whether to extract this formatting into a small pure function
in `packages/shared` or inline it. **Criteria:** extract it if you want the unit test in
§10 (recommended — `packages/shared` is the only package with vitest, and the global
rule is to add tests for code you create). Inline it only if extraction would drag
unrelated types across the package boundary; if you inline it, say so in the commit
message and skip the vitest addition.

**Verification gate:** `cd apps/web && npx tsc --noEmit` exits 0; and if extracted,
`cd packages/shared && npx vitest run` is green including the new test.

---

### Step 4 — Align the web issue-agent's own `run_command` description

**File:** `apps/web/src/lib/server/ai/stage2-reasoning.ts:286-291`.

This is a **separate** description string from `index.ts:635` — the web agent has its
own tool definitions and never reads the MCP server's.

**Current tail:** `"Write commands are hard-blocked by the NAS validator."`

**Replace that sentence with:**

```
Write commands, and a fixed list of dangerous read patterns (notably recursive grep against Synology Drive internal stores), are hard-blocked by the NAS validator. Those blocks are permanent and stateless — the same command is refused identically every time. There is no per-session call limit; on a refusal, change the command rather than retrying.
```

Keep the rest of the description (the `tail -n N`, `/proc`, `/sys` examples) exactly as
it is — it is good and load-bearing.

**Also fix the system prompt at `stage2-reasoning.ts:65-68`.** Grok found this and it
is the stronger of the two for the web model: the system prompt's `run_command` bullet
ends with the same thin `"Write commands are hard-blocked by the NAS validator."` Add
one sentence after it:

```
Some dangerous read patterns are blocked too, permanently and statelessly — on a refusal, change the command; retrying or restarting changes nothing.
```

**Verification gate:** `cd apps/web && npx tsc --noEmit` exits 0.

---

### Step 5 — Mark the three symptom lines in `docs/architecture.md` as FIXED

**Rule being applied:** never leave a bare symptom with no resolution in a doc. An AI
reads it as current behavior.

**5a — line ~368.** Replace:

```
The registry is never loaded eagerly — loading all 132 schemas
put ~50k tokens into every session and degraded it after ~10–15 tool calls.
```

with:

```
The registry is never loaded eagerly. Loading all 132 schemas used to put ~50k tokens
into every session, which degraded answer quality after roughly 10–15 tool calls. That
is FIXED by this lazy design and is not current behavior — there is no per-session call
limit on this server (see AGENTS.md → "There is no ~10–15-call session limit").
```

**5b — line ~783. Replace ONLY the first two lines of that paragraph.** GLM flagged
that a literal block-replace here would clobber the following sentences. The paragraph
continues with *"Lazy-load via catalog/search/detail + `invoke_tool` keeps the
always-on surface compact. `notifications/tools/list_changed` is not used because..."* —
**that text must survive.** Replace only:

```
Pre-loading 132 schemas puts ~50k tokens into every session and degrades it after
~10–15 calls.
```

with:

```
Pre-loading 132 schemas WOULD put ~50k tokens into every session and degrade answer
quality after roughly 10–15 calls. The lazy design prevents that; the degradation is
historical, not a live symptom.
```

Then re-read the paragraph — if the surviving "Lazy-load via catalog…" sentence now
reads redundantly, tighten it, but do not delete the `list_changed` note.

**5c — line ~837. Same caution:** the trailing sentence *"NAS API is reached over
Tailscale (sub-ms RTT), making re-handshake cost negligible."* must survive. Replace
only:

```
Undici's keep-alive pool exhausts after ~10–15 calls when timed-out requests do
not return their socket.
```

with:

```
Undici's keep-alive pool WOULD exhaust after ~10–15 calls when timed-out requests do
not return their socket. `Connection: close` prevents it. This is the second
independent source of the historical "~10–15 calls" number and is likewise fixed — do
not read it as a live limit.
```

**Verification gate:** `grep -n "10–15\|10-15" docs/architecture.md` returns hits at
~368, ~783, ~837 (plus the untouched `:405` region), and **every one of them sits
beside an explicit FIXED / WOULD / historical marker.** Also confirm by eye that the
`list_changed` sentence and the Tailscale sentence still exist.

---

### Step 6 — Annotate the incident sentence

**File:** `docs/synology-incident-2026-06.md:398`.

**Current:** *"…and the MCP session degraded before deeper log inspection completed."*

This is the strongest myth-teacher in the repo, because it is a forensic record: it
reads as witnessed evidence rather than a passing remark.

**Do not rewrite history.** Append a bracketed correction in place:

```
and the MCP session degraded before deeper log inspection completed. [Correction
2026-08-05: this was not session degradation — no such effect exists. The session hit
the stateless validator hard-block on recursive grep. See AGENTS.md → "There is no
~10–15-call session limit".]
```

**Verification gate:** the original sentence is intact and the bracketed correction
follows it.

---

### Step 7 — Add the myth entry to `AGENTS.md`

**File:** `AGENTS.md`, inside "Intentional quirks and non-obvious decisions", matching
the existing Looks like / Actually / Why / Do not change format used by its neighbours
(see the entries around `AGENTS.md:180-260` for the house style).

```markdown
### There is no ~10–15-call session limit

Looks like:
The MCP server degrades or starts refusing commands after roughly 10–15 tool calls,
so only single simple `run_command` calls stay reliable.

Actually:
No counter gates commands in nas-mcp or nas-api, and nothing anywhere degrades with
call count. (The web issue-agent does have a real bound — `maxToolIterations: 8` at
`stage2-reasoning.ts:522` and `TURN_CAP = 8` in `stage2-turn.ts:38` — but that ends a
reasoning turn cleanly; it never refuses a command and it is not what MCP chat
sessions are hitting.) Refusals come from `hardBlocked` in
`apps/nas-api/internal/validator/validator.go` — a stateless, pure pattern list. Same
command in, same refusal out, on call 1 or call 100. The "~10–15" figure in
`docs/architecture.md` describes two already-fixed problems (eager tool-schema bloat,
undici socket-pool exhaustion), neither of which ever blocked a command.

Why:
Sessions hit the stateless grep block, misread it as degradation, and abandon or hand
off instead of correcting the command — costing a full session each time.

Do not change because:
Retrying a blocked command or starting a fresh session returns the identical result.
If a NAS command is blocked, change the command: a bounded non-recursive grep of the
specific log file, `search_file_access_audit`, `check_backup_status`, or a Postgres
query. Never loosen the block patterns — one recursive grep ran 4d11h on production.
```

**Verification gate:** heading style matches its neighbours; all four labelled
paragraphs present.

---

### Step 8 — Ship

**8a — commit, scoped.** Never `git add -A` here: the tree carries unrelated partial
work (see `HANDOFF.md`) and this plan's own artifacts.

```bash
cd /worksp/monitor/app
git var GIT_COMMITTER_IDENT
```

Must print `Albert Hazan <u2giants@users.noreply.github.com>`. **Fix it before
committing if not** — correcting it afterwards means rewriting history.

Then stage only what you changed:

```bash
cd /worksp/monitor/app
git add apps/nas-mcp/src/index.ts \
        apps/web/src/lib/server/ai/stage2-reasoning.ts \
        docs/architecture.md \
        docs/synology-incident-2026-06.md \
        AGENTS.md \
        plan_mcp-degradation-myth.md
# plus packages/shared/src/<new>.ts and its .test.ts if Step 3 was extracted
git status --short   # confirm nothing unexpected is staged
git commit -m "docs+mcp: kill the phantom ~10-15-call degradation myth"
git push origin main
```

Commit subject follows repo style (`area: short imperative`).

**8b — verify the deploy.** The push touches `apps/nas-mcp/**` and `apps/web/**`, so
GitHub Actions `nas-mcp-image.yml` and `web-image.yml` build to GHCR and Coolify
redeploys. **No Watchtower, no NAS-side recreate** — nothing here touches `nas-api`.

Wait for both workflows green, then confirm the new text is actually live:

```bash
# initialize a fresh MCP session and read back the instructions + run_command description
curl -s -X POST https://nas-mcp.designflow.app/mcp \
  -H "Authorization: Bearer <MCP_BEARER_TOKEN>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}'
```

You are looking for `NO per-session call limit` in the `instructions` field, and the
same phrase in the `run_command` entry of a follow-up `tools/list`. Token location in
§12 — never paste its value into a file or a commit.

**8c — clean up this review's artifacts.** These are untracked leftovers from the
planning session and must not be handed to the next session as mystery files:

```bash
rm -f /worksp/monitor/app/PLAN-degradation-myth.md   # superseded by this file
ls /worksp/monitor/app/.ai/reviews/                  # GLM's report — keep or delete deliberately
```

Keep `plan_mcp-degradation-myth.md` (this file) until every STATUS row is `✅`, then
delete it in a follow-up commit.

**8d — fix the stale memory note.**
`~/.claude/projects/-worksp-monitor/memory/call-limit-folklore.md` ends with "NOT yet
built/committed (no Go toolchain in that session)." That is **wrong** as of 2026-08-05
and will cause a future session to redo finished work. Update that closing paragraph to
record: shipped, wired through `handlePreview` → MCP, and verified live on 2026-08-05;
then add the web-agent fix from Step 3.

*(If that file's contents do not match what is described here — it lives outside the
repo and could not be verified at plan time — do not guess. Read it, then correct
whatever it actually says about build/commit state.)*

**8e — update this plan's STATUS table** to `✅` per row as you go, with dates. Whoever
does the work owns de-staling the plan.

---

## 10. Tests required

**Must stay green (existing):**

```bash
cd /worksp/monitor/app/packages/shared && npx vitest run
```

Four suites: `nas-tools.golden.test.ts`, `nas-tools.write-safety.test.ts`,
`repair-path-ownership.test.ts`, `inspect-effective-permissions.test.ts`.

**GLM verified no test asserts on any string this plan edits** — no golden fixture
breaks. `nas-tools.golden.test.ts` locks the generated *write commands*, which no step
here touches.

**Type checks (all must pass):**

```bash
cd /worksp/monitor/app && npm run type-check      # turbo, whole monorepo
```

**New test (only if Step 3 is extracted, which is the recommendation):**

Add `packages/shared/src/block-message.test.ts` covering the pure formatter:

- `formatBlockedCommandMessage` returns text **containing `preview.summary` verbatim**
  when `blocked: true` and `summary` is non-empty. (This is the regression that
  matters — it is exactly the bug being fixed.)
- Falls back to the terse tier text when `blocked: true` and `summary` is `""`.
- Leaves the non-blocked `tier !== 1` message unchanged.

Do **not** add vitest to `apps/web` or `apps/nas-mcp` — see §7, rejected #7.

## 11. Constraints, standing rules, and gotchas in force

- **Branch policy: `main` only, no branches**, for this repo.
- **Commit identity:** must be `Albert Hazan <u2giants@users.noreply.github.com>`.
  Verify with `git var GIT_COMMITTER_IDENT` **before** the first commit. Git invents an
  identity silently when unset — that put 231 wrong-identity commits into shared
  history once already.
- **No band-aids.** If a step's wording does not actually change model behavior, say so
  rather than shipping something that looks like a fix.
- **No database change.** There is none in this plan. If one appears, it goes through
  `u2giants/shared-db` first, never an app-repo migration.
- **Nothing hard-coded that should be configurable** — not an issue here (all edits are
  human-facing prose), but do not introduce a new constant for the message text.
- **Two consumers, one myth.** The single easiest way to fail this plan is to fix the
  MCP side, see the myth persist in the dashboard's AI agent, and conclude the fix did
  not work. Steps 3 and 4 are the web side. Do both.
- **Do not restart or "reset" anything to clear a block.** The block is stateless. If
  you find yourself restarting a session to see whether a command works this time, you
  have reproduced the exact bug this plan is fixing.
- **`.claude/worktrees/` contains stale copies of these files.** Ignore them; edit only
  the real paths named in each step.
- **Do not paste the MCP bearer token anywhere.** §12.

## 12. Access and environment

| Need | Where |
|---|---|
| Working copy | `/worksp/monitor/app`, branch `main` |
| Repo | `u2giants/synology-monitor` |
| Authenticated CLIs | `gh`, `gcloud`, `op` (1Password), `git` — all pre-authenticated |
| NAS MCP endpoint | `https://nas-mcp.designflow.app/mcp` |
| `MCP_BEARER_TOKEN` | 1Password vault `vibe_coding` — **reference by location only, never paste the value** |
| Live NAS access for verification | The `synology-monitor` MCP server is already connected in this session (`run_command`, `tool_search`, `invoke_tool`) |
| Type-check | `npm run type-check` at repo root |
| Tests | `cd packages/shared && npx vitest run` |
| Local dev | `npm run dev` (turbo; web on port 3000) — **not needed for this plan**; no UI change, so no visual verification step |
| Deploy | push to `main` → GitHub Actions (`nas-mcp-image.yml`, `web-image.yml`) → GHCR → Coolify |
| Go toolchain | present at `/usr/local/bin/go` — **not needed**; no step touches Go |

---

# PART 4 — LANDING IT

## 13. Definition of done, risks, open questions

**Done means every one of these:**

- [ ] `MCP_INSTRUCTIONS` carries the no-limit paragraph (Step 1)
- [ ] Both `run_command` descriptions warn up front (Steps 2, 4)
- [ ] The web issue-agent relays `preview.summary` verbatim on a block (Step 3)
- [ ] Unit test added for the block-message formatter, if extracted (§10)
- [ ] Three `architecture.md` lines marked fixed, with the `list_changed` and Tailscale
      sentences intact (Step 5)
- [ ] Incident sentence annotated, original text intact (Step 6)
- [ ] `AGENTS.md` myth entry added (Step 7)
- [ ] `npm run type-check` clean; `packages/shared` vitest green
- [ ] Committed with **verified identity**, scoped `git add`, pushed to `main`
- [ ] Both GitHub Actions workflows green
- [ ] New instructions text confirmed live via a fresh `initialize` against the MCP
      endpoint (Step 8b)
- [ ] `PLAN-degradation-myth.md` removed; `.ai/reviews/` handled deliberately (Step 8c)
- [ ] `call-limit-folklore.md` memory corrected (Step 8d)
- [ ] This file's STATUS table updated to `✅` with dates (Step 8e)

**Risks and rollback**

| Risk | Likelihood | Impact | Mitigation / rollback |
|---|---|---|---|
| A doc block-replace clobbers the `list_changed` or Tailscale sentence | Medium | Low | Step 5 calls this out explicitly; verification gate checks both survive |
| Step 3 changes the tier-2/tier-3 approval message by accident | Low | Medium | Only the `blocked === true` branch changes; type-check plus the unit test |
| Coolify redeploy of `web` or `nas-mcp` fails | Low | Medium | Routine path; roll back by reverting the commit and pushing |
| The wording still does not change model behavior | **Medium** | Medium | See open question below — this is the honest uncertainty |

Rollback for everything here is a single `git revert` of one commit. Nothing is
destructive, nothing touches the NAS, nothing touches data.

**Open questions**

1. **Does the wording actually change behavior?** GLM's blunt assessment, which I
   share: the refusal-time message (Step 3) is the one most likely to work, because it
   is in front of the model at the moment it decides. `MCP_INSTRUCTIONS` (Step 1) is
   next. The tool descriptions and the docs are weaker. **Decision criterion:** if a
   session still claims a call limit after all eight steps ship, the next move is not
   more prose — it is to make `BlockExplanation` the *first* thing in the tool result
   rather than embedded in a `Blocked:` prefix, and to consider a structured
   `isError` + machine-readable reason code the client cannot paraphrase away.
2. **Should the same treatment go to the other hard-block categories** (destructive
   disk ops, reboot, account changes)? They already share the `BlockExplanation`
   footer, so probably yes automatically. Not verified end-to-end for those paths.
3. **`.ai/reviews/` retention** — keep GLM's review in the repo as a record, or delete
   it? Albert's call; Step 8c leaves it deliberate rather than accidental.

---

## Second review — Grok 4.5, 2026-08-05

Reviewed after GLM. Every claim below was independently verified in the code before
being folded in. Grok's headline judgment, which is fair:

> "Half of this plan is a real bug fix. The other half will not stop models from
> inventing a call limit."

**Accepted and folded in:**

1. **The second discard site at `:411-419`** (predefined tools). Step 3 now covers both.
   Biggest miss by both the plan and GLM.
2. **The web system prompt at `:65-68`.** Step 4 now covers it. Stronger lever for the
   web model than the tool description.
3. **Keep `isError: true`; the `tier--1` garbling.** Both now written into Step 3.
4. **"No counter anywhere" was overstated** — §6 corrected for `maxToolIterations: 8`.
5. **Ranking honesty.** Steps 2, 5 and 6 are cleanup, not the fix. The STATUS table
   now marks Step 3 as the highest-value row.

**Accepted but deliberately not acted on yet:**

6. **MCP blocked results are not marked as errors.** `apps/nas-mcp/src/index.ts:655-670`
   returns a block as ordinary success text, so models underweight it. Grok's proposed
   structural fix — set an error flag and lead with a short machine-readable prefix
   (`PERMANENT BLOCK (not a rate limit). Change the command. Do not retry.`) before the
   long explanation — is the right next move **if the myth survives this plan**. It is
   open question #1's answer and is deliberately held back so this plan stays a clean
   test of the wording hypothesis.

**Disputed:**

7. Grok calls the plan over-engineered for the work. Partly right — the real work is
   one bug at two sites plus some prose. The length is the fresh-session handoff
   standard, not the size of the change. Keeping it, because the two-consumer structure
   in §2 is exactly what a naive implementer gets wrong.
8. Grok would demote Step 1 (`MCP_INSTRUCTIONS`) to "optional garnish", against GLM's
   ranking of it as the best MCP-side lever. Keeping it: it is one paragraph in a file
   already being edited, so its cost is ~zero and the two reviewers disagree.

## Self-audit (required by the implementation-plan-writer standard)

**1. Could a brand-new AI session with no project knowledge and no context from the
planning conversation execute this to perfection without asking anything?**
Yes. §2 explains what the app is and, critically, that there are **two** independent
consumers of the NAS tools — the fact most likely to make a naive implementer fix half
the problem. §3 gives a one-line reproduction. §5 gives the exact state of all five
edit sites with `file:line`. Every step names its file, its intended behavior, and a
runnable verification gate. §12 lists every command, URL, and toolchain, and confirms
Go is not needed.

**2. Does it carry every piece of background, nuance, and reasoning currently held —
including what was ruled out and why?**
Yes. §6 carries the full root cause including *both* historical sources of the "~10–15"
number and the exact hallucination sequence. §7 lists eight rejected approaches,
including three raised and rejected during GLM's review (`architecture.md:405`,
`git add -A`, adding vitest to `apps/web`), so a reviewer does not re-raise them. §6
also carries the honest lever ranking, including the admission that three of eight
steps have zero reach into the target population — the nuance most likely to be lost.

**3. Is the ultimate goal clear enough for a correct judgment call when a step is
wrong?**
Yes. §1 states it in plain business English before any technical wording, gives the
concrete cost (Albert paying three times for one investigation), and instructs
explicitly that the goal beats the step. §8's table marks what is locked versus open,
and the two open items (exact wording, extract-vs-inline) each carry decision criteria
rather than being left to taste.

**Gap found during the audit and fixed:** the first draft did not say what to do if the
plan ships and the myth *still* appears. That is the most likely real-world failure, so
open question #1 now carries a concrete next move rather than leaving the implementer
with nothing.

**Self-audit result: PASS** — all checklist items yes.
