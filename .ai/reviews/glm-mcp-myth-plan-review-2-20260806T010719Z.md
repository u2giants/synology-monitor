# GLM review — mcp-myth-plan-review-2

| field | value |
|---|---|
| model | zai-coding-plan/glm-5.2 |
| opencode | 1.18.12 (pinned) |
| session | mcp-myth-plan-review-2 |
| session id | `ses_02b677696ffeBErpcdedZWqvMp` |
| repository | /worksp/monitor/app |
| branch | main |
| caller | claude |
| requested | 2026-08-06T01:07:19Z |
| tokens | `{"input":3465,"output":2871,"reasoning":1380,"cache":{"read":45632,"write":0}}` |

---

I have enough to review thoroughly. All the plan's line citations check out exactly, but I found several real gaps. Here is the critique.

---

## Verdict

The plan is **factually accurate on every cite it makes** — but it is **not complete**, and for the population it claims to fix (MCP-only clients) it picks the **second-best lever** while ignoring the best one. Two of its three "high-value" doc edits have **zero effect** on the stated target. Details below.

---

## 1. Factual correctness — all citations verified exact

I re-checked every line number and wiring claim. All correct:

- `apps/nas-api/cmd/server/main.go:206` → `summary = validator.BlockExplanation(req.Command)` ✅
- `apps/nas-mcp/src/index.ts:167` → `` `[${config.name}] Blocked by NAS API: ${preview.summary}` `` (the `invoke_tool`/write path) ✅
- `apps/nas-mcp/src/index.ts:656` → `` `[${config.name}] Blocked: ${preview.summary}` `` (the `run_command` path) ✅
- `apps/nas-mcp/src/index.ts:635` → the current `run_command` description, verbatim as quoted ✅
- `docs/architecture.md:368`, `:782-783`, `:837` → the three symptom blocks, verbatim ✅
- AGENTS.md contains **no** "10–15"/degradation string (the only grep hit is the false-positive word "exhaustive" at line 462) ✅
- The two root causes are genuinely fixed **in code, not just docs**: `Connection: close` at `apps/nas-mcp/src/nas-client.ts:61` and `job-client.ts:109`; lazy registry with only 2 eager tools (`EAGER_TOOLS` at `index.ts:35`). ✅
- `BlockExplanation()`'s footer (`validator.go:431`) carries the exact "permanent and stateless … NOT a rate limit, quota, or session-degradation symptom" text the plan relies on. ✅

One small wording nit: Step 1 says the symptom appears "three times." The grep `grep -n "10–15\|10-15"` will indeed return exactly three hits (the literal `~10–15` lives on lines 368, 783, 837), so the verify step holds. Fine.

---

## 2. Completeness — five locations the plan misses (this is the valuable part)

The plan's completeness claim ("Search the whole repo for any OTHER place that still teaches the myth") does not hold. Missed:

**(A) The single best lever, omitted entirely — the FastMCP session-level `instructions`.**
`apps/nas-mcp/src/index.ts:37` defines `MCP_INSTRUCTIONS`, wired into the server at `index.ts:450` (`instructions: MCP_INSTRUCTIONS`). This string is delivered to the client at `initialize`, **before any tool call**, and is the natural home for "there is no call limit; refusals are permanent/stateless; on a block, change the command." The plan edits the `run_command` *tool description* but never touches `MCP_INSTRUCTIONS`. This directly answers your Question 3 — and the plan's own body fails to act on it.

**(B) The web issue-agent drops the explanation at refusal time — `apps/web/src/lib/server/ai/stage2-reasoning.ts:349-355`.**
This is the issue-agent's *own* `run_command` handler (not the MCP one). On a block it does:
```
`run_command: "${command}" requires tier-${preview.tier}${preview.blocked ? " (hard-blocked by the NAS validator)" : ""}. `
```
It throws away `preview.summary` — which now carries the full `BlockExplanation` footer — and substitutes a terse, generic message with **no** permanence/stateless note. So the `BlockExplanation` fix that the plan calls "live" reaches MCP clients but **does not reach the web issue-agent model**. This is the exact misread-prone message shape the whole plan exists to kill, on the other consumer. The plan never mentions this path.

**(C) The web issue-agent's own `run_command` tool description — `stage2-reasoning.ts:286-291`.**
A *separate* description string from MCP's `index.ts:635`, parallel to the one the plan edits. It says "Write commands are hard-blocked by the NAS validator" and nothing about read-pattern blocks or permanence. If Step 3's reasoning applies to the MCP description, it applies identically here. Missed for consistency.

**(D) The most mythology-reinforcing sentence in the repo — `docs/synology-incident-2026-06.md:398`.**
> "the MCP session degraded before deeper log inspection completed."

This is a *forensic incident record* stating "MCP session degraded" as witnessed fact. Of all the sentences the plan could worry about, this one is the strongest teacher, because it reads as established evidence rather than a passing remark. The plan never touches it. You shouldn't rewrite incident history, but a bracketed correction (`[i.e. the stateless validator block, not session degradation — see AGENTS.md]`) is warranted.

**(E) A fourth mention of the socket-pool symptom — `docs/architecture.md:405`.**
> "`Connection: close` on every nas-api request — prevents undici pool exhaustion when timed-out requests do not return their socket"

The plan claims "three symptom lines"; there are **four** mentions of the two root causes. This one escapes the plan's verify grep because it has no `~10–15` literal. It's arguably acceptable (it's paired with its resolution), but the completeness *count* is wrong and the plan should acknowledge it. There's also a fifth, lower-priority restatement at `apps/nas-mcp/README.md:111`.

---

## 3. Is `run_command` the right lever? No — `MCP_INSTRUCTIONS` is, and the plan omits it

For MCP-only clients, the ranking of pre-refusal levers is:

1. **`instructions` field (`MCP_INSTRUCTIONS`, `index.ts:37/:450`)** — delivered at `initialize`, seen by every client, before any tool call. **Best lever. Not edited by the plan.**
2. **The `run_command` tool description (`index.ts:635`)** — only loaded when the model inspects that tool's schema. The plan edits this. It's *useful* but second-best, and notably the `MCP_INSTRUCTIONS` itself steers the model to *prefer `tool_search`/`invoke_tool` over `run_command`* (lines 39-43), so the population that even loads `run_command`'s schema is a subset.
3. **The refusal-time message (`BlockExplanation`, already live)** — strongest *at the moment* of refusal, because that's what's actually in the conversation when the model re-reasons. The plan correctly notes this is shipped.

The plan's claim that the `run_command` description is "the only one of the three edits that reaches an MCP client with no repo checkout" is **misleading**: `MCP_INSTRUCTIONS` reaches every MCP client too, and earlier. Critically, editing `MCP_INSTRUCTIONS` is **the same file, same deploy** (`apps/nas-mcp/**` → `nas-mcp-image.yml`), so there is zero incremental deploy cost. There is no good reason to skip it.

**Caching caveat (relevant to all of the above):** `docs/architecture.md:781-783` itself documents that "Claude clients cache the initial `tools/list` and do not re-fetch on the notification." So neither the new tool description **nor** `instructions` reaches an *already-connected* session — only new `initialize` calls. The plan's verify step (call `tools/list` against the endpoint) confirms the deploy is live for *new* sessions, but says nothing about existing sessions needing to reconnect. Worth one sentence.

---

## 4. Will this change model behavior? Bluntly: partly, and less than the plan implies

- A **tool-description string is read at tool-selection time, not at refusal-handling time.** When the model gets a `Blocked:` response, it re-reasons from the conversation; the tool *description* is not re-injected. What *is* in front of it then is the `BlockExplanation` footer (already live, detailed). So the refusal-time work is already done by someone else; the `run_command` description edit only helps *prevent* the first misread, and only for sessions that consult that tool's schema.
- **Two of the three doc edits + the AGENTS.md edit have exactly zero effect on the stated target** (claude.ai / Desktop / Codex MCP sessions). Those clients never read the repo. Those edits are still worth doing — they stop *coding* agents (Claude Code in this checkout) from re-learning the myth — but the plan should not count them toward fixing the MCP-only hallucination. Right now 3 of the plan's 4 "scope" items are invisible to the population it names.
- The **honest ranking of what actually moves the needle**: (1) `BlockExplanation` footer at refusal — already shipped, strongest; (2) `MCP_INSTRUCTIONS` at session start — **omitted**, the one new edit with model-wide reach; (3) `run_command` description — the plan's Step 3, modest, subset-only; (4) docs — useful for repo sessions only.
- **What would actually change behavior more reliably:** add a 2-3 line "There is no call limit; a refusal is a permanent, stateless block — change the command, do not retry or restart" block to `MCP_INSTRUCTIONS`. That is injected once per session into the model's working context and is the thing most likely to survive into the decision at refusal time. Without it, the plan leaves the best lever unused.

---

## 5. Risk / scope / test breakage

- **No test breaks.** I grepped `*.test.*` for the `run_command` description string, `MCP_INSTRUCTIONS`, and the doc symptom lines — no test asserts on any of them. The doc edits and the description edit break no golden fixture. ✅
- **Step 4 `git add -A && git commit && git push` is risky in this repo.** AGENTS.md rule #2 mandates checking for concurrent work first; `git add -A` will also stage `PLAN-degradation-myth.md` itself plus any unrelated working-tree drift (the repo has several partial items per `HANDOFF.md`). The plan should `git add` the three specific files. The commit-identity check (`git var GIT_COMMITTER_IDENT`) is good and AGENTS-consistent.
- **Step 1b and 1c "Current:" quotes are truncated mid-paragraph.**
  - 1b's real current text (`architecture.md:782-785`) continues with *"Lazy-load via catalog/search/detail + `invoke_tool` keeps the always-on surface compact. `notifications/tools/list_changed` is not used because Claude clients cache the initial `tools/list`…"* The plan's replacement targets only the first two lines, so the `tools/list_changed` note survives — but an implementer doing a literal block-replace could clobber it, and the kept "Lazy-load via catalog…" sentence then reads redundantly after the new "The lazy design prevents that." Show the full paragraph or say "replace only the first two lines."
  - 1c similarly leaves the trailing "NAS API is reached over Tailscale (sub-ms RTT), making re-handshake cost negligible." sentence — fine, but the "Current:" quote omits it, so flag that it must be preserved.
- **Scope exclusion of the web issue-agent is silent but material.** The plan's stated *goal* is "kill the phantom"; its *scope* silently excludes the web issue-agent, which has the unfixed block message (finding B) and a parallel description (finding C). Either widen scope to cover `stage2-reasoning.ts:286-291` and `:349-355`, or state explicitly why the web consumer is lower risk and out of scope. Currently it's just absent.
- **Step 5** edits a file outside the repo (`~/.claude/projects/-worksp-monitor/memory/…`). I cannot verify its current contents from the repo; if the asserted ending sentence doesn't match, the step no-ops or edits the wrong file. Flag as unverifiable here.

---

## Bottom line

Correct in what it asserts, incomplete in what it covers, and it picks the weaker of two available pre-refusal levers while spending three of four edits on text the target population never reads. **Highest-value additions:** (1) put the "no call limit / permanent-stateless block / change the command" note into `MCP_INSTRUCTIONS` (`index.ts:37`); (2) stop the web issue-agent from discarding `preview.summary` at `stage2-reasoning.ts:349-355`; (3) annotate the incident-doc sentence at `synology-incident-2026-06.md:398`.
