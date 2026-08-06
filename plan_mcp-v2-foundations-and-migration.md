# MCP Reliability Foundations, Degradation-Myth Fix, and `2026-07-28` Official SDK v2 Migration Plan

Updated: 2026-08-05 (America/New_York)

## STATUS

This file is the cross-repository source of truth for the work. Whoever completes a step must update this table, the matching current-state text, and the verification evidence before ending that session.

| Step | Repository | Status | Last updated | Evidence / next action |
|---:|---|---|---|---|
| 0A | synology-monitor | ✅ done | 2026-08-05 | Shared formatter and four focused cases shipped in `bbfaf149`; validator regression and 69 shared tests pass |
| 0B | synology-monitor | ✅ done | 2026-08-05 | Both web paths use the shared formatter; web typecheck and `guard:ai` pass in `bbfaf149` |
| 0C | synology-monitor | ⚠ blocked | 2026-08-05 | Code/docs deployed at exact SHA `bbfaf149`; behavior gate failed because both NAS API health URLs timed out from the live MCP container. See `docs/mcp-refusal-behavior-evaluation-2026-08-05.md` |
| 1 | both | ☐ open | 2026-08-05 | Capture exact current dependency and production build baselines |
| 2 | synology-monitor | ☐ open | 2026-08-05 | Make npm/pnpm and lockfile use deterministic |
| 3 | devops-mcp | ☐ open | 2026-08-05 | Add a Python lockfile and exact runtime dependency policy |
| 4 | both | ☐ open | 2026-08-05 | Build one shared protocol-conformance test contract |
| 5 | synology-monitor | ☐ open | 2026-08-05 | Add NAS MCP unit, HTTP, cancellation, and timeout tests |
| 6 | devops-mcp | ☐ open | 2026-08-05 | Add DevOps MCP unit, HTTP, auth, process, and timeout tests |
| 7 | devops-mcp | ☐ open | 2026-08-05 | Remove obsolete SSE and URL-token paths after usage proof |
| 8 | both | ☐ open | 2026-08-05 | Standardize health, build, protocol, auth, and error metadata |
| 9 | devops-mcp | ☐ open | 2026-08-05 | Align synchronous deadlines below client limits |
| 10 | both | ☐ open | 2026-08-05 | Define and implement durable long-operation handles |
| 11 | synology-monitor | ☐ open | 2026-08-05 | Migrate NAS MCP to the official TypeScript v2 SDK |
| 12 | devops-mcp | ☐ open | 2026-08-05 | Migrate DevOps MCP to the official Python v2 SDK |
| 13 | both | ☐ open | 2026-08-05 | Run side-by-side compatibility and failure-injection tests |
| 14 | both | ☐ open | 2026-08-05 | Cut over, verify production, remove old paths, update docs |

Fresh sessions start at the first open row. Re-read all later phases before starting a phase so that earlier discoveries do not make downstream instructions stale.

## 1. The ultimate goal

POP Creations needs NAS MCP and DevOps MCP to connect reliably from Claude, Codex, Roo Code, Windsurf, and other approved clients without stale sessions, initialization loops, unexplained multi-minute hangs, or successful server work being reported as a client failure.

It also needs every AI consumer to distinguish a permanent command-specific NAS safety refusal from a broken or exhausted MCP session. A refusal must cause the AI to change the command. It must not cause the AI to invent a nonexistent call limit, retry the identical command, abandon the investigation, or start a fresh session.

When this plan is complete:

- both servers speak the stable MCP wire revision `2026-07-28` through exact-pinned official SDK v2 packages;
- both remain stateless over Streamable HTTP at `/mcp`;
- protocol sessions and initialization handshakes are not application failure points;
- short operations finish before the shortest supported client deadline;
- legitimate long work returns a durable operation handle immediately and is checked separately;
- dependency builds are repeatable;
- authentication, cancellation, restarts, stale headers, client disconnects, and proxy behavior are covered by automated tests;
- the production build SHA and protocol behavior are independently verified after deployment.
- both MCP clients and the separate web issue-agent preserve the NAS validator's permanent, stateless refusal explanation;
- a controlled fresh-session evaluation proves that a blocked command causes the AI to choose a safer command instead of claiming that the server has degraded.

If a step conflicts with this goal, the goal wins. Stop and flag the conflict instead of following a stale instruction mechanically.

## 2. What the applications are

### Synology Monitor and NAS MCP

Repository: `https://github.com/u2giants/synology-monitor`

Normal local path: `/worksp/monitor/app`

Branch policy: `main` only.

NAS MCP is the TypeScript service under `apps/nas-mcp`. It gives approved AI clients guarded diagnostic and repair access to two production Synology NAS units. It does not connect directly to a shell on the public endpoint. It calls the Go NAS API running on each NAS, which independently validates commands and approval tiers. The public MCP endpoint is `https://nas-mcp.designflow.app/mcp`. The service runs as a Coolify application and is built as `ghcr.io/u2giants/synology-monitor-nas-mcp`.

Important related code:

- `apps/nas-mcp/src/index.ts`: MCP construction, tool registration, auth, health route, and HTTP startup.
- `apps/nas-mcp/src/nas-client.ts`: NAS API HTTP calls and the 25-second command safety cap.
- `apps/nas-mcp/src/job-client.ts`: existing native background-job client.
- `packages/shared/src/nas-tools.ts` and related shared TypeScript sources: the 132-operation NAS catalog.
- `apps/nas-api/`: Go service that executes guarded NAS commands and durable jobs.
- `apps/nas-mcp/README.md`, `docs/architecture.md`, `docs/development.md`, `docs/deployment.md`, and `docs/mcp-incident-2026-05.md`: current design and incident history.

### DevOps MCP

Repository: `https://github.com/u2giants/devops-mcp`

The implementing session must clone it to a stable workspace path such as `/worksp/devops-mcp`; the planning audit used a temporary read-only clone only.

Branch policy: `main` only.

DevOps MCP is a Python service that gives approved AI clients audited, root-equivalent diagnostic and emergency access to the production VPS. It runs inside a privileged container with the host filesystem, PID namespace, and Docker socket available. Its public MCP endpoint is `https://mcp.designflow.app/mcp`. It is a Coolify service identified in its documentation as `vj5f76xet05bxwdq4utw1kho` and is built as `ghcr.io/u2giants/devops-mcp`.

Important related code:

- `server.py`: MCP construction, Starlette HTTP app, bearer authentication, audit middleware, tool registry, command execution, file operations, Docker operations, and systemd operations.
- `test_server.py`: currently very small in-process tests.
- `requirements.txt`: currently unbounded FastMCP and Uvicorn requirements.
- `Dockerfile`, `docker-compose.yml`, and `.github/workflows/deploy.yml`: build and deployment.
- `docs/server.md`, `docs/architecture.md`, `docs/gotchas.md`, `docs/troubleshooting.md`, and client setup docs: design and incident history.

### Language decision

The services use different languages because of their histories and neighboring code, not because MCP requires it.

- Keep NAS MCP in TypeScript because its operation catalog, schemas, and monorepo tooling are already TypeScript.
- Keep DevOps MCP in Python because its mature command, process-group, file-streaming, Docker, systemd, audit, ASGI, and test code is Python.
- Standardize on the official MCP SDK family and the observable HTTP contract, not on one programming language.
- Do not rewrite DevOps MCP in TypeScript merely for visual uniformity. That would replace security-sensitive, root-equivalent host code without solving a user-visible protocol problem.

## 3. What triggered this work

The request follows repeated connection and timeout failures across the two services:

- NAS MCP returned `Bad Request: Server not initialized` in May 2026.
- Clients reused stale session IDs and received `Session not found`.
- A failed initialization or GET path could leave Claude waiting about four minutes.
- NAS commands are capped at 25 seconds, NAS MCP tools at 45 seconds, and Roo Code gives up around 60 to 75 seconds.
- DevOps MCP allows synchronous commands for 120 seconds by default and up to 600 seconds, so valid server work can continue after Roo has already declared failure.
- DevOps MCP previously hung because child processes retained stdout pipes, large files were materialized, recursive directory results were fully sorted, and audit logs were loaded wholesale. Those four code-level causes were repaired, but there is still no universal request deadline or cancellation contract.

A second, related failure was repeatedly reported as "NAS MCP degrades after roughly 10 to 15 calls." That number once described two real historical problems: loading all 132 tool schemas consumed about 50,000 context tokens, and timed-out keep-alive requests exhausted the HTTP socket pool. Both are already fixed by the seven-tool lazy registry and `Connection: close`. The remaining reproduction is different: the NAS API permanently blocks a dangerous command pattern, but one consumer discards the detailed explanation and the AI invents a session-level failure. The safe reproduction is a recursive grep against a Synology Drive internal store. It is blocked before execution on call 1 exactly as it is on call 100.

The stable `2026-07-28` MCP wire revision removes protocol-level sessions, `Mcp-Session-Id`, and the `initialize` / `notifications/initialized` handshake for July 28 requests. It adds per-request protocol metadata and mandatory `server/discover`. Supported older wire revisions still use their earlier initialization rules through official SDK backward compatibility. This directly removes the protocol concepts behind several historical failures for July 28 clients, but it does not make long shell or filesystem work finish within a client timeout.

Reproduction cases that the new automated suite must preserve are listed in Sections 9 and 10. Do not rely on manual recollection of the incidents.

## 4. Scope

### In scope

- deterministic dependency management for both servers;
- one shared protocol-conformance contract implemented in each repository;
- HTTP, auth, restart, stale-header, cancellation, deadline, and proxy tests;
- removal of unused legacy transport and URL-token behavior after usage proof;
- standard health and build metadata;
- a durable long-operation contract;
- direct use of the official TypeScript SDK v2 in NAS MCP;
- direct use of the official Python SDK v2 in DevOps MCP;
- backward-compatibility tests for the real supported clients;
- side-by-side deployment, production cutover, rollback, and documentation.
- preservation and consistent relay of command-specific NAS safety refusals;
- wording that tells MCP clients there is no per-session call limit;
- regression and fresh-session behavior tests that prove a refusal changes the command instead of ending the investigation.

### Not in this plan

- rewriting DevOps MCP from Python to TypeScript;
- rewriting NAS MCP from TypeScript to Python;
- implementing raw JSON-RPC or MCP framing without an official SDK;
- removing the NAS API's independent command validator or approval tiers;
- raising the arbitrary NAS shell limit merely to accommodate longer work;
- exposing all 132 NAS operations directly in `tools/list`;
- replacing the five-tool DevOps discovery facade with all hidden operations;
- changing shared Supabase data or schema;
- changing unrelated production VPS, NAS, Coolify, Cloudflare, or ContextForge infrastructure;
- adopting the optional Tasks extension as a hard requirement before supported clients prove compatibility;
- changing client software's own timeout settings as the primary fix.
- loosening the NAS validator's dangerous-command patterns;
- treating documentation alone as the fix for clients that cannot read the repository;
- moving DevOps MCP into the Synology Monitor repository. The repositories have different ownership, blast radius, deployment, secrets, and rollback boundaries. They share a protocol contract through mirrored versioned fixtures, not a release unit.

## 5. Current state of the code

### NAS MCP

- `apps/nas-mcp/package.json` declares third-party TypeScript `fastmcp` `^4.0.1`.
- The root pnpm lock resolves FastMCP 4.0.2 and official MCP SDK 1.29.0 indirectly.
- `apps/nas-mcp/package-lock.json` is stale and conflicts with the root pnpm workflow.
- `apps/nas-mcp/Dockerfile` uses `npm install`, so the container build does not enforce the repository's pnpm lock.
- `apps/nas-mcp/src/index.ts` constructs a single FastMCP facade and starts Streamable HTTP with `stateless: true` and JSON responses.
- NAS authentication currently fails open when `MCP_BEARER_TOKEN` is empty because `authenticate` returns success. The container migration must make production mode the default and refuse startup without a non-empty bearer.
- The intended public endpoint is already stateless. It should not depend on a stored session surviving between requests or deployments.
- Tool calls have both a FastMCP `timeoutMs` and a custom `Promise.race` deadline at 45 seconds. The custom race returns a timeout result but does not cancel its underlying promise.
- `apps/nas-mcp/src/nas-client.ts` limits NAS `/exec` to 25 seconds with a five-second HTTP buffer. Preview is eight seconds. Native job HTTP calls are 15 seconds.
- Calls targeting both NAS units run in parallel, not serially.
- No meaningful NAS MCP unit or HTTP protocol suite currently gates CI.
- The seven-tool facade and hidden 132-operation catalog are intentional and working. Preserve them.
- `apps/nas-api/internal/validator/validator.go:426` already provides `BlockExplanation()`. Its shared footer says a safety block is permanent and stateless, not a rate limit or session-degradation symptom. `apps/nas-api/cmd/server/main.go:206` wires it into preview responses, and NAS MCP relays `preview.summary` at the current `apps/nas-mcp/src/index.ts` invoke and `run_command` paths. This behavior is deployed and must not be rewritten.
- The separate web issue-agent calls NAS API directly and does not pass through NAS MCP. In `apps/web/src/lib/server/ai/stage2-reasoning.ts`, both the free-form `run_command` refusal path and the predefined-operation refusal path discard `preview.summary`, substitute terse text, and can render the nonsensical `tier--1`. Those are the live product defects fixed in Phase 0.
- Active architecture and incident documentation still contains historical 10-to-15-call symptoms without consistently marking them fixed. Repository-reading AI sessions can therefore relearn an obsolete diagnosis.

### DevOps MCP

- `requirements.txt` declares `fastmcp>=2.14.0` and `uvicorn>=0.30.0` without upper bounds or a lockfile.
- A routine container rebuild may therefore change the MCP framework and transport behavior without a source change.
- `server.py` constructs the unrelated Python FastMCP project and mounts stateless Streamable HTTP at `/mcp`.
- `server.py` also creates a legacy stateful SSE app and mounts it at `/sse`, although current architecture and client docs say Streamable HTTP is the single supported transport.
- Missing and invalid bearer responses include `WWW-Authenticate`, which prevents known client OAuth-discovery loops.
- Tokens are still accepted from the URL query string. This can leak credentials into browser, proxy, and access logs.
- The default subprocess timeout is 120 seconds; accepted values are clamped to 1 through 600 seconds.
- `_run_on_host` now creates a process group and kills the entire group on timeout. Preserve that behavior.
- File reads, recursive directory lists, and audit-log reads now have bounded implementations. Preserve their bounds and add regression tests.
- There is no universal MCP request deadline around non-subprocess work.
- `test_server.py` has only a handful of in-process tests and does not test the HTTP protocol, authentication, sessions, reconnects, restarts, deadlines, or cancellation.
- The deployment workflow builds and deploys without a test job.

### Git and deployment state

At initial plan creation on 2026-08-05, Synology Monitor `main` was at commit `00ea0d1` and synchronized with `origin/main`. On 2026-08-05 the tracked degradation-myth plan was merged into this plan as Phase 0; no product implementation had begun. Every implementing session must refresh the SHA, branch state, deployed-image evidence, and this paragraph before editing.

The DevOps MCP planning audit read `main` commit `cfdd6a66dc364a4351d8c35bc364583d605bbc0d` from a temporary clone. The implementing session must fetch current `origin/main`, reconcile any changes made after that SHA, and update this section before editing.

Phase 0 code and documentation were committed and pushed on 2026-08-05 as
`bbfaf149e47211e05c225129103c774889765fe8`. The NAS MCP and web workflows passed,
and read-only inspection of both running production containers confirmed that
exact OCI revision. The live NAS MCP initialize response contains the new
no-call-limit instructions. `REFUSAL-009` nevertheless failed because both NAS
API health URLs timed out from inside the deployed NAS MCP container; the
validator therefore could not return its refusal. `REFUSAL-010` was not run.
Phase A has not started because Phase 0's deployed behavior gate remains blocked
on separately authorized restoration or confirmation of NAS API reachability.

No official SDK migration described in Phases A through E has begun.

## 6. Key findings and root causes

1. **The two FastMCP packages are not one standard.** NAS uses an unofficial TypeScript framework layered over `mcp-proxy` and the official v1 SDK. DevOps uses a separate Python framework. Their similar names conceal separate transport and lifecycle implementations.
2. **The language split is not the problem.** The unstable boundary is the protocol and transport shell. The tool business logic is largely independent of it.
3. **Both current `/mcp` endpoints intend to be stateless already.** Stale session and initialization failures should not be application requirements. A current recurrence points to an old deployment, client bridge, proxy, bogus-header handling, or wrapper implementation.
4. **The `2026-07-28` wire revision removes the old protocol failure classes for July 28 clients.** It removes protocol sessions and the initialization handshake, requires per-request version and capability metadata, and adds `server/discover`. Official SDK v2 is a package generation, not the wire protocol's name. Supported older clients retain their older handshake through SDK compatibility.
5. **The `2026-07-28` wire revision does not solve wall-clock limits.** NAS's 25-second cap is an operational safety policy. Roo's approximate 60-second deadline is client behavior. DevOps's 120-second default conflicts with that behavior.
6. **Long work needs durable application state, not a long HTTP request.** The correct pattern is start, receive handle, poll status, fetch result, and cancel. NAS already has a native jobs foundation. DevOps does not.
7. **Dependency drift can reintroduce protocol failures.** Both image builds can install changed transport code without a deliberate upgrade.
8. **Protocol tests are the largest missing safety net.** Neither service currently proves behavior across auth, discovery, version metadata, bogus legacy headers, disconnects, restarts, and proxies.
9. **The wrappers are not deeply embedded in tool logic.** Removing them changes server construction, tool registration, schema adapters, auth context, middleware, HTTP mounting, result types, and lifecycle hooks. NAS HTTP clients do require real cancellation plumbing, but NAS command builders, DevOps host commands, file streaming, process-group termination, Docker operations, systemd operations, and audit entry formatting should remain behaviorally intact.
10. **DevOps MCP is security-sensitive.** It has root-equivalent access. A whole-language rewrite creates more risk than a contained protocol-shell migration.
11. **The degradation myth combines repaired history with one current message-relay bug.** Tool-schema bloat and socket exhaustion were real but are fixed. The validator is a stateless pattern check with no call counter. The web issue-agent's discarded `preview.summary` is the current defect; MCP instructions and corrected documentation are supporting defenses.
12. **The two repositories should remain separate.** Synology Monitor contains a dashboard, NAS agents, NAS API, shared schemas, and NAS MCP. DevOps MCP is a small root-equivalent VPS control plane with independent secrets and rollback. Combining them would increase release coupling and security blast radius without reducing protocol code, because each language still needs its own official SDK adapter and tests.

## 7. Approaches considered and rejected

### Rewrite both services in TypeScript

Rejected. It would create one language but require rewriting mature Python process, filesystem, audit, Docker, systemd, and ASGI behavior in a root-equivalent production tool. Wrapper uniformity does not justify that security and regression risk.

### Rewrite both services in Python

Rejected. NAS MCP shares TypeScript schemas and catalog logic with the Synology Monitor monorepo. Moving it would duplicate schemas or create a cross-language generation pipeline with no user-visible benefit.

### Keep both third-party FastMCP wrappers and only bump versions

Rejected as the final architecture. It leaves two separately maintained protocol shells between our code and the official SDKs. A version bump could adopt v2, but it would not give the same transport behavior, error shapes, or lifecycle control. It is acceptable only as the short-lived baseline while tests are built.

### Implement the `2026-07-28` wire revision without an SDK

Rejected. This would make POP Creations responsible for JSON-RPC validation, version negotiation, protocol metadata, discovery, HTTP streaming, cancellation, errors, and compatibility. The official SDKs already own that work.

### Raise NAS and client timeouts

Rejected as a root fix. A read-only whole-volume operation can overload production even when technically allowed to run longer. Client limits also remain outside server control.

### Use one long synchronous call plus progress messages

Rejected as the universal long-work design. Progress may keep some SDK deadlines alive, but it does not override Roo's transport deadline, survive a disconnect, or provide durable restart-safe status.

### Require the optional Tasks extension immediately

Rejected until the real client matrix supports it. Design the application job handle so it can later map to the Tasks extension without making Tasks a launch blocker.

### Keep legacy SSE forever

Rejected. SSE is deprecated and the July 28 core uses stateless Streamable HTTP. Keep it only long enough to prove no supported client still uses it.

### Preserve query-string bearer tokens for convenience

Rejected. URLs are routinely logged. Supported clients can send authorization headers.

### Remove or weaken the NAS recursive-command block

Rejected permanently. A recursive grep against the Synology Drive store previously ran for four days and eleven hours. The command must remain blocked. The client must receive the reason and choose a bounded alternative.

### Fix the degradation myth in repository documentation only

Rejected. MCP-only clients never read this checkout, and the web issue-agent has its own tool definitions and direct NAS API path. The refusal-time result is the strongest behavior signal and must be preserved in both consumers.

### Merge DevOps MCP into the Synology Monitor repository

Rejected for this work. A monorepo would not unify TypeScript and Python SDK code or deployment behavior. It would couple a root-equivalent VPS tool to routine dashboard and NAS releases. Reconsider only if measured maintenance costs later exceed the security and release-isolation benefit, with its own migration plan.

## 8. Design decisions

Decisions recorded 2026-08-05.

### Locked decisions

1. Keep NAS MCP in TypeScript.
2. Keep DevOps MCP in Python.
3. Use official SDK v2 packages directly in their native languages and identify wire behavior as protocol revision `2026-07-28`.
4. Do not implement the protocol manually.
5. Keep `/mcp` as stateless Streamable HTTP.
6. Keep bearer authentication in an explicit HTTP layer before MCP processing.
7. Keep the compact visible-tool facades and hidden operation catalogs. Durable operation controls belong behind the existing `invoke_tool` registry unless a measured token-budget and client study explicitly approves a visible-surface change.
8. Keep NAS API validation, approval previews, tiers, signed approval tokens, and the 25-second arbitrary-command safety cap.
9. Keep DevOps process-group termination and bounded file/directory/audit readers.
10. Use durable job handles for work that can exceed the shortest supported client deadline.
11. Do not make the optional Tasks extension a requirement until client compatibility is proven.
12. Deploy side by side before replacing either production endpoint.
13. Keep `u2giants/devops-mcp` as a separate repository. Standardize through the official SDK family, the versioned protocol contract, health fields, errors, and compatibility tests.
14. Preserve the NAS validator's block rules and `BlockExplanation()` as the source of truth. Both NAS consumers must relay it instead of paraphrasing it.
15. Phase 0 lands before dependency and SDK work so the current user-facing failure is fixed and protected independently of the larger migration.

### Open implementation decisions with criteria

1. **Exact official SDK patch versions.** Select the latest stable SDK v2 patch available when implementation starts, then pin it exactly. Do not use a caret, lower-bound-only range, beta, RC, or `latest` tag. Production cutover is blocked if the pinned patches have an open P0 or release-blocking defect affecting Streamable HTTP, auth, cancellation, or supported older wire revisions.
2. **Python lock tool.** Prefer `uv.lock` with a committed `pyproject.toml` if the repository accepts uv cleanly. Otherwise use a fully hashed `requirements.lock`. The outcome must be deterministic local, CI, and Docker installs.
3. **NAS package manager.** Prefer the monorepo's existing pnpm workspace and root lockfile. Remove the app-local npm lock only after Docker and CI both install through pnpm with `--frozen-lockfile`.
4. **Long-job storage.** NAS must reuse its existing NAS API job storage. DevOps should start with a durable, bounded directory on its existing audit volume or a separate named volume, using atomic files and explicit retention. Do not introduce a database unless concurrent state or query needs prove files inadequate.
5. **Maximum synchronous deadline.** Use 45 seconds as the initial cross-service ceiling because it is below the known Roo limit and matches current NAS behavior. A different number requires measured evidence from every supported client and proxy. A deadline response must be error-shaped and must prove underlying work stopped or was transferred to a durable operation.
6. **SSE removal date.** Remove only after production access logs and client configuration searches show zero legitimate `/sse` use for at least seven days.
7. **Tasks extension.** Enable only as an optional adapter after Claude, Codex, Roo, Windsurf, and ContextForge tests establish behavior. Core job tools remain supported regardless.

## 9. Numbered implementation plan

### Phase 0: fix the current refusal-message defect before changing foundations

This is a small, independently deployable product fix. Complete and verify it before Phase A. Do not wait for the SDK migration. Natural context cut after Step 0C: update STATUS and current-state evidence, commit and push the Synology Monitor changes, verify the deployed SHAs, and begin Phase A in a fresh session if needed.

### Step 0A. Lock the permanent NAS refusal contract with tests

Repository: Synology Monitor.

Files:

- `apps/nas-api/internal/validator/validator.go`, existing `BlockExplanation()` near line 426, behavior preserved rather than redesigned;
- `apps/nas-api/internal/validator/validator_test.go`, especially the existing `TestBlockExplanationIsActionableAndStateless` regression test;
- a new small pure formatter under `packages/shared/src/` for web refusal results;
- the matching `packages/shared` Vitest file.

Changes:

- Preserve and run the existing Go regression test proving a known dangerous recursive Synology Drive grep is blocked and its explanation is actionable, permanent, stateless, and not a call/session limit. Strengthen that test only if one of those required ideas is not asserted after the current branch is refreshed. Do not rewrite working validator behavior merely to create new code.
- Add a shared TypeScript formatter that accepts the NAS preview shape and requested operation label. For `preview.blocked === true` with a non-empty summary, return that summary verbatim with a short operation prefix and `isError: true`. If the summary is unexpectedly empty, return a loud fallback that still says the refusal is permanent and command-specific. Never emit `tier--1`.
- For `preview.blocked === false && preview.tier !== 1`, preserve today's approval-tier message and `isError: true`.
- Make extraction into tested shared code mandatory. Do not choose the old plan's inline, no-test option.

Dependencies: none.

Verification gate: the focused Go validator tests and `packages/shared` Vitest suite pass; tests fail if the summary is dropped, `isError` becomes false, the fallback becomes silent, or `tier--1` reappears.

### Step 0B. Relay the refusal through both web issue-agent paths

Repository: Synology Monitor.

File: `apps/web/src/lib/server/ai/stage2-reasoning.ts`.

Changes:

- Replace the hand-built blocked response in the free-form `run_command` path, currently around lines 350 through 356, with the tested shared formatter from Step 0A.
- Replace the separate hand-built blocked response in the predefined NAS-operation path, currently around lines 411 through 419, with the same formatter.
- Keep `isError: true` for blocked and privileged previews because provider adapters use it to mark tool failures correctly.
- Do not change the actual validator, approval tiers, write confirmation, operation builders, or the non-blocked tier-2/tier-3 remediation flow.
- Add or extend the web AI guard test so CI statically proves both call sites use the shared formatter. This complements the formatter unit tests and prevents one path from drifting back to a local paraphrase.

Dependencies: Step 0A.

Verification gate: `pnpm --filter @synology-monitor/web type-check` and `pnpm --filter @synology-monitor/web guard:ai` pass; a fixture for each of the two paths returns the exact NAS summary and never `tier--1`.

### Step 0C. Give MCP clients the same truth, correct history, and prove behavior live

Repository: Synology Monitor.

Files:

- `apps/nas-mcp/src/index.ts`, the server instructions and `run_command` description;
- `apps/web/src/lib/server/ai/stage2-reasoning.ts`, the web system prompt and its `run_command` description;
- `docs/architecture.md` historical degradation entries;
- `docs/synology-incident-2026-06.md`, annotate rather than rewrite incident history;
- `AGENTS.md`, this plan's routing row and the intentional-quirks section;
- `plan_mcp-degradation-myth.md`, mark superseded by this canonical merged plan without deleting its historical review record.

Changes:

- Add concise instructions stating that NAS MCP has no per-session call limit. A blocked command is permanently and statelessly refused because of its pattern; retrying or starting another session cannot change it; change the command.
- Put the same four ideas in both NAS `run_command` descriptions and the web issue-agent system prompt. Keep the response-time `BlockExplanation()` as the authority rather than duplicating its detailed examples everywhere.
- Mark the old 10-to-15-call schema-bloat and socket-pool symptoms as fixed, with their fixes named. Preserve incident history and dates.
- Verify that `AGENTS.md` still routes future MCP work to this file and tells readers to start at its STATUS table. Update it only if stale; do not add a duplicate row. Remove the old plan from the active router only if it reappears.
- Add a controlled behavior evaluation using a fresh supported client and safe blocked preview. Run the reproduction as the first tool call and again after at least ten harmless calls. In both cases verify the server returns the permanent/stateless explanation and the AI selects a bounded alternative instead of claiming degradation, retrying identically, or asking for a new session. Allow at most three fresh-session attempts per case and record every transcript. If all three fail, mark the evaluation failed and require human review; never silently rerun until it passes. Record client name/version, protocol revision, source SHA, deployed image SHA, prompts, tool results, and pass/fail without secrets.
- Ship the web and NAS MCP images through their normal GitHub Actions paths. Verify each live service reports or embeds the exact pushed commit SHA. Then execute the read-only behavior evaluation against the deployed services.

Dependencies: Steps 0A and 0B.

Verification gate: focused tests, lint, typecheck, build, and affected existing suites are green; GitHub Actions is green; live NAS MCP and web report the exact pushed SHA; the fresh-session evaluation passes at call 1 and after at least ten harmless calls; the checked-in evaluation record contains no secret; this plan's STATUS and Current State are updated before the session ends.

### Phase A: freeze the baseline and make builds repeatable

Natural context cut after Step 3. Update STATUS, commit each repository independently, and start a fresh session before Phase B if context is crowded.

### Step 1. Capture exact baselines

Repositories: both.

Changes:

- Record current `main`, image digest, live build SHA, framework version, transitive official SDK version, endpoint response behavior, and client configurations.
- In Synology Monitor, update this plan's Current State with the fetched SHA and create a small machine-readable test fixture under `apps/nas-mcp/test/fixtures/current-contract.json` containing only public protocol expectations, never tokens.
- In DevOps MCP, create the equivalent `tests/fixtures/current-contract.json`.
- Capture `/mcp` behavior for `server/discover`, a normal old-era request, missing auth, invalid auth, a bogus `Mcp-Session-Id`, unsupported protocol version, `tools/list`, and one harmless tool call.
- Label every captured case either `legacy-parity` or `intentional-cutover-change`. Only legacy-parity behavior is replayed as an unchanged migration gate. Current failures for July 28-only features are historical baseline evidence, not expected post-migration results.
- Record whether ContextForge calls DevOps MCP and whether any supported client still calls `/sse`.

Dependencies: none.

Verification gate: a checked-in fixture exists in each repository, contains no secret, identifies the exact source SHA and image digest, and labels every response by replay policy. The Step 4 through 6 harness can reproduce the recorded legacy-parity cases. Cases 003, 006 through 008, 014, 015, 020, and the legacy halves of 016 and 019 are candidates for parity replay; cases 001, 002, 004, 005, 009, 010, 018, and the July 28 half of 019 are intentionally asserted only against the new contract. Resolve any case not listed here explicitly before coding rather than guessing.

### Step 2. Make NAS MCP dependency installation deterministic

Repository: Synology Monitor.

Files:

- `apps/nas-mcp/package.json`
- root `pnpm-lock.yaml`
- `apps/nas-mcp/Dockerfile`
- remove `apps/nas-mcp/package-lock.json` only after confirming it is not used by another workflow
- `.github/workflows/nas-mcp-image.yml`
- `apps/nas-mcp/README.md`
- `docs/development.md`

Changes:

- Declare exact MCP and transport package versions during the baseline phase.
- Use pnpm consistently in local development, CI, and Docker.
- Use `pnpm install --frozen-lockfile` with the workspace files copied in a cache-friendly order.
- Make Docker fail when the lock and manifest disagree.
- Add an automated check that rejects a new app-local npm lockfile.
- Add the CI workflow shape and named prerequisite jobs so unit/protocol tests must pass before any future image build or GHCR push. During Step 2, the existing baseline tests occupy those jobs. Step 5 replaces/extends them with the full 21-case protocol suite and proves a failing protocol test prevents publishing.
- Correct stale documentation that claims an AbortController implementation or SSE behavior not present in source.

Dependencies: Step 1.

Verification gate: perform one documented clean-build reproducibility confirmation; changing a manifest without refreshing `pnpm-lock.yaml` makes CI and Docker fail; `git grep` finds no active build instruction using `npm install` or `--no-frozen-lockfile` for NAS MCP; workflow dependency inspection proves the image job cannot run until the current baseline test job succeeds. The frozen-lockfile failure checks are the permanent gate. The intentional failing-protocol-test publish proof is deferred to Step 5 after the 21-case suite exists.

### Step 3. Make DevOps MCP dependency installation deterministic

Repository: DevOps MCP.

Files:

- replace or supersede `requirements.txt` with `pyproject.toml` plus `uv.lock`, or a fully pinned hashed lockfile
- `Dockerfile`
- `.github/workflows/deploy.yml`
- `docs/development.md`
- `docs/deployment.md`
- `docs/configuration.md`

Changes:

- Pin FastMCP, Uvicorn, Starlette, test dependencies, and transitives during the baseline phase.
- Make Docker and CI install only from the lock.
- Add a dependency-version command used by health metadata and CI.
- Add an intentional upgrade procedure requiring lock refresh, protocol suite execution, and changelog review.

Dependencies: Step 1.

Verification gate: perform one documented clean-image reproducibility confirmation; an unlocked install is absent from Docker and CI; changing a declared dependency without refreshing the lock fails. The locked-install failure checks are the permanent gate.

### Phase B: build the safety net before changing the protocol shell

Natural context cut after Step 6.

### Step 4. Define one cross-service protocol-conformance contract

Repositories: both, with the canonical prose stored in this plan and executable equivalents in each repository.

Required cases:

1. authenticated `server/discover` returns the supported revisions, identity, and capabilities;
2. a valid July 28 request includes the required per-request protocol version metadata and succeeds; optional `clientInfo` and `clientCapabilities` metadata is accepted and validated when present but its absence is not rejected;
3. a supported 2025-era client completes its required `initialize` / `notifications/initialized` flow and then succeeds through official backward compatibility;
4. an unsupported revision returns the official unsupported-version error;
5. no request requires `initialize` or `notifications/initialized` for July 28;
6. missing static bearer auth is 401 with the exact configured `WWW-Authenticate: Bearer realm="<service>"` challenge and does not start OAuth discovery;
7. invalid static bearer auth is 401 with `WWW-Authenticate: Bearer realm="<service>", error="invalid_token"`; 403 is reserved for an authenticated caller denied by application policy or insufficient scope;
8. a bogus legacy `Mcp-Session-Id` cannot bind work to another client, revive state, or hang;
9. `tools/list` order is deterministic and includes required `ttlMs` and `cacheScope` under the July 28 contract;
10. `tools/call` returns a complete result with required `resultType` and server identity metadata;
11. a client disconnect cancels request-scoped work where safe and never records false success;
12. a server restart between two independent calls does not require reconnection state;
13. a request over 45 seconds returns a loud, error-shaped `deadline_exceeded` result, never success-shaped text, and proves cancellable work stopped or transferred to a durable operation;
14. health checks do not require MCP auth but expose no secrets or operation arguments;
15. Host validation permits only configuration-driven production host, candidate host, and loopback test values; Origin validation permits a missing Origin for non-browser MCP clients and only an explicit configured allowlist when Origin is present;
16. legacy SSE is either explicitly supported during transition or returns a clear permanent-removal response after cutover;
17. proxy tests cover Cloudflare/Coolify and `mcp-remote` behavior without relying on production mutation;
18. every Streamable HTTP POST carries and validates the required `Mcp-Method` and `Mcp-Name` headers for the July 28 wire revision;
19. `subscriptions/listen` is tested for July 28 clients, while supported older clients' GET/notification behavior is tested separately and cannot enter an initialization hang;
20. the May `Bad Request: Server not initialized` reproduction sends the historical GET/request sequence and must return or fail clearly within five seconds, never wait four minutes;
21. executable contract fixtures in both repositories carry the same `contractVersion`, stable case IDs, and content digest; local CI rejects accidental changes against its recorded digest, while coordinated cross-repository review owns coherence between the two copies.

Changes:

- Store the same versioned, language-neutral contract manifest in both repositories because each must remain executable when cloned alone. Give it a `contractVersion`, stable case IDs, and expected digest. A deliberate contract update changes both copies in coordinated commits. Each repository's CI can prove only that its local copy matches its recorded digest; the coordinated pull requests and Step 13 matrix prove cross-repository agreement. Do not claim one isolated CI run can inspect the other repository's unmerged state.
- Generate language-specific requests and assertions from that local manifest. Do not duplicate business-tool fixtures when only the protocol expectation is identical.
- Do not make exact error prose part of the contract unless a human or client depends on it. Assert status, error type/code, required fields, cancellation, and bounded timing.

Dependencies: Steps 2 and 3.

Verification gate: both repositories have the same versioned test manifest listing all 21 cases with stable identifiers and matching digests; CI fails if either service omits a case or its local manifest does not match the approved contract digest.

### Step 5. Add the NAS MCP test layers

Repository: Synology Monitor.

Files and new test areas:

- `apps/nas-mcp/src/index.ts`: extract a side-effect-free server/handler factory; do not listen during imports.
- `apps/nas-mcp/src/nas-client.ts`: accept an `AbortSignal` or official equivalent, inject or mock HTTP transport, and destroy the in-flight request/socket on cancellation.
- `apps/nas-mcp/src/job-client.ts`: accept the same cancellation signal, inject or mock HTTP transport, and destroy in-flight request/socket work on cancellation.
- `apps/nas-mcp/test/protocol.test.ts`
- `apps/nas-mcp/test/auth.test.ts`
- `apps/nas-mcp/test/deadline.test.ts`
- `apps/nas-mcp/test/nas-client.test.ts`
- `apps/nas-mcp/test/job-client.test.ts`
- `apps/nas-mcp/test/catalog.test.ts`
- `apps/nas-mcp/package.json`
- root test orchestration and `.github/workflows/nas-mcp-image.yml`

Specific tests:

- all Step 4 cases applicable before and after migration;
- 25-second clamp cannot be raised by tool input;
- preview uses eight seconds and `/exec` uses command timeout plus five-second HTTP buffer;
- target `both` starts both requests concurrently;
- deadline abort reaches the underlying NAS and job HTTP requests rather than merely winning `Promise.race`;
- late success after a deadline cannot be logged or returned as current success;
- deadline returns an official error result or `isError` result with structured category `deadline_exceeded`, never ordinary success-shaped text content;
- disabled operations cannot execute through `invoke_tool`;
- write operations require preview, explicit confirmation, and tier-dependent approval token;
- catalog search and result ordering stay deterministic;
- seven always-on tools remain the expected visible surface;
- production mode is the default in the container and startup fails closed when `MCP_BEARER_TOKEN` or required NAS configuration is missing or empty; an explicit test-only mode is required to run without bearer auth;
- exact missing-token and invalid-token challenges match Step 4, while authenticated policy denial uses 403;
- Host values come from `MCP_ALLOWED_HOSTS` with `nas-mcp.designflow.app` and the recorded candidate host in production configuration; missing Origin is accepted for non-browser clients, while present Origin must match `MCP_ALLOWED_ORIGINS`.

Dependencies: Step 4.

Verification gate: `pnpm --filter @synology-monitor/nas-mcp test` passes locally and in CI; tests use fake NAS endpoints and cannot reach production; intentional cancellation and stale-header regressions fail the suite; an intentionally failing protocol case proves the image/GHCR job never starts.

### Step 6. Add the DevOps MCP test layers

Repository: DevOps MCP.

Files and new test areas:

- `server.py`: keep `create_app()` import-safe and make configuration injectable for tests.
- `tests/test_protocol.py`
- `tests/test_auth.py`
- `tests/test_deadlines.py`
- `tests/test_process_groups.py`
- `tests/test_file_bounds.py`
- `tests/test_catalog.py`
- `tests/test_audit.py`
- dependency and CI files from Step 3

Specific tests:

- all Step 4 cases applicable before and after migration;
- token identity propagates to the audit entry for concurrent clients without crossing contexts;
- URL query tokens are rejected after Step 7;
- production mode is the default container mode and startup fails closed when no non-empty `TOKEN_*` bearer values exist; explicit test mode is required for auth-free in-process tests;
- missing and invalid token responses match the static-bearer 401 challenges in Step 4; authenticated policy denial alone uses 403;
- subprocess timeout kills the whole process group and returns within a small bounded margin;
- disconnect cancellation kills cancellable child work;
- file reads never exceed configured byte and line limits;
- recursive lists stop collecting at the bound and never sort the full tree;
- audit reads seek only the bounded tail window;
- command timeout cannot exceed policy through `invoke_tool`;
- visible tools remain `health`, `list_capabilities`, `get_capability_details`, `tool_search`, and `invoke_tool`;
- hidden operations validate required and optional arguments;
- write/destructive safety metadata is deterministic and no fallback silently labels unknown work read-only.

Dependencies: Step 4.

Verification gate: the locked test command passes locally and in CI without Docker-socket, host-PID, production filesystem, or network access; regression fixtures prove each former hang returns within its expected bound.

### Phase C: remove avoidable risk and separate short work from long work

Natural context cut after Step 10.

### Step 7. Retire DevOps legacy SSE and query-string authentication

Repository: DevOps MCP.

Files:

- `server.py`, especially `PUBLIC_PREFIXES`, `AuthMiddleware`, and `create_app()`
- `docs/DECISIONS.md`
- `docs/architecture.md`
- `docs/server.md`
- `docs/claude-desktop-setup.md`
- `docs/windsurf-roo-setup.md`
- `docs/troubleshooting.md`
- client setup scripts in `u2giants/ai-devops` if they still point at SSE or query tokens

Changes:

- Search production access logs and all managed client configurations for `/sse` over a seven-day window.
- If zero legitimate use is proven, remove the SSE app, `/sse` mount, `/sse/messages` public bypass, and stale docs.
- Remove query-string token parsing. Accept only `Authorization: Bearer`.
- Add a clear response or redirect-free diagnostic for retired paths. Do not silently route old SSE clients into `/mcp`.
- Pin `mcp-remote` in machine setup scripts and remove `@latest`.

Dependencies: Step 6 and the seven-day evidence window.

Verification gate: no source or active config accepts `?token=`; no public auth bypass remains for `/sse/messages`; supported clients connect through `/mcp`; retired-path tests return the documented response.

### Step 8. Standardize observable server metadata and errors

Repositories: both.

Changes:

- Health responses must include service name, source SHA, image/build identifier, official SDK name and exact version, supported MCP revisions, transport, stateless flag, maximum synchronous deadline, and enabled long-job capability.
- Health responses must not include tokens, command arguments, host secrets, approval keys, or client identities.
- MCP July 28 results must include required server identity metadata and result types.
- Define common error categories: authentication, unsupported protocol, invalid arguments, policy blocked, deadline exceeded, upstream unavailable, operation not found, operation disabled, and internal failure.
- Preserve framework-native official error codes where specified. Use project error data only for application categories.
- Every fallback must be loud in logs and structured in the client result.
- Add `BUILD_SHA` and exact SDK version to container build arguments and OCI labels, then pass `BUILD_SHA` into the runtime health response. A missing or `unknown` build SHA is a CI/deploy failure outside explicit local development.

Files:

- NAS: `apps/nas-mcp/src/index.ts` or extracted server/HTTP modules, `apps/nas-mcp/Dockerfile`, `.github/workflows/nas-mcp-image.yml`, README, deployment docs.
- DevOps: `server.py`, `Dockerfile`, `.github/workflows/deploy.yml`, status page, server/configuration/troubleshooting docs.

Dependencies: Steps 5 through 7.

Verification gate: the same smoke-test script can query both health endpoints and print a comparable table; error tests assert categories and no fallback returns an apparently successful empty result.

### Step 9. Align synchronous deadlines with supported clients

Repository: DevOps MCP, with NAS regression verification.

Changes:

- **Step 9A, preparation only:** add cancellation/deadline plumbing, typed results, policy configuration, and tests, but leave the current production timeout behavior unchanged. Do not deploy rejection text that tells callers to use long-operation tools before those tools exist.
- Separate subprocess policy timeout from MCP request deadline. The shorter remaining request budget wins.
- Thread cancellation/deadline context into subprocess, bounded filesystem, Docker, and systemd operations.
- Return a typed deadline result only after cancellable work is stopped or explicitly transferred to a durable job.
- **Step 9B, activation after Step 10:** only after the durable operations exist, are enabled, and pass their candidate tests, set the default and hard maximum for ordinary synchronous MCP operations to 45 seconds. Then reject a caller's attempt to request a longer synchronous timeout with a clear instruction to use the working long-operation registry.
- Keep NAS's 25-second command cap and 45-second outer deadline unless measured evidence justifies a smaller safe value.

Dependencies: Step 9A depends on Steps 6 and 8. Step 10 depends on Step 9A's cancellation primitives but not on activating the shorter limit. Step 9B depends on Step 10 and executes after Step 10's verification gate. The STATUS row for Step 9 remains partial until 9B passes.

Verification gate: Step 9A proves cancellation and error shapes without changing the live ceiling. After Step 10 passes, Step 9B proves no supported synchronous request remains active after 45 seconds plus a small shutdown margin; Roo's 60-second client does not time out first; the long-operation instructions point to enabled tools; audit records distinguish completed, cancelled, deadline, and transferred-to-job outcomes.

### Step 10. Implement durable long-operation handles

Repositories: both.

Common contract exposed as allowlisted hidden registry operations behind the existing visible `invoke_tool` facade:

- `start_operation`: validates and starts only a named long-capable operation, returns `operation_id`, state, start time, expiry, safe summary, and polling guidance immediately.
- `get_operation_status`: returns queued/running/succeeded/failed/cancelled/expired plus bounded progress.
- `get_operation_result`: returns bounded result data or a result-file handle, never unbounded output.
- `cancel_operation`: requests cancellation and reports whether work actually stopped.
- These four names are registry operations, not four new always-on MCP tools. The visible-tool counts remain seven for NAS MCP and five for DevOps MCP. Any proposal to expose them directly requires a measured tool-schema token budget, real-client discovery proof, and an explicit update to locked decision 7.
- Both services may run asynchronous work only from an explicit, code-reviewed allowlist of named durable operations. `start_operation` may dispatch only to those registered names. It must never accept or construct a generic background shell, arbitrary `/exec`, command string, script path, or unregistered callable.
- IDs must be unguessable, scoped to the authenticated caller where identities differ, and validated as plain IDs rather than paths.
- State writes must be atomic and survive MCP process restart.
- Store command name and safe arguments needed for audit, but redact configured sensitive fields.
- Enforce concurrency, CPU/I/O priority, output size, retention, and expiry.
- On restart, reconcile running records with real PIDs/jobs and mark orphaned or indeterminate work loudly.

NAS implementation:

- Extend the existing native NAS API job model in `apps/nas-api/internal/jobs/` and `apps/nas-mcp/src/job-client.ts`.
- Adapt existing file-inventory and archive-move start/status/result/cancel operations into the common registry contract where useful. Do not create a second parallel job system or duplicate existing stored state.
- The first NAS allowlist contains only the existing durable file-inventory and archive-move job families. New families require their own NAS API native job implementation, resource limits, tests, safety review, and explicit addition to the allowlist. Thin aliases may call existing job operations; they may not widen arguments or bypass the 25-second `/exec` policy.
- Do not route broad long-running scans through the 25-second `/exec` endpoint.
- Follow the existing Synology long-running-operation safety pattern for broad metadata walks.

DevOps implementation:

- Add a narrow job registry module rather than embedding more logic in `server.py`.
- Store bounded state in a durable named volume, using atomic files and a lock discipline.
- Only explicitly registered operations may run asynchronously. Do not create a generic unaudited background shell escape.
- Use process groups and low priority for heavy operations.
- Gate the new DevOps durable-operation surface behind `MCP_LONG_OPERATIONS_ENABLED=false` by default. Enable it on the candidate only after restart, cancellation, quota, and rollback-format tests pass; enable it in production only after the protocol cutover itself is verified.

Optional official Tasks-extension adapter:

- Map the common operation state to the official Tasks extension only after client matrix tests pass.
- Keep the four hidden registry operations through `invoke_tool` as the compatibility path.

Dependencies: Step 8 and Step 9A only. Step 10 must finish before Step 9B activates the 45-second DevOps ceiling.

Verification gate: start a test operation, disconnect the MCP client, restart the MCP server, reconnect, retrieve the same status/result, then cancel a second operation and prove its process/job stopped. All tests run against fake or isolated work, never production data.

### Phase D: replace the protocol wrappers

Natural context cut after each repository migration.

### Step 11. Migrate NAS MCP to the official TypeScript v2 SDK

Repository: Synology Monitor.

Target packages:

- exact stable `@modelcontextprotocol/server@x.y.z` SDK v2 package selected and recorded at implementation time;
- the exact official Node/HTTP mount package and API documented for that pinned patch, recorded in the plan before code changes rather than left as “some thin middleware”;
- a Standard Schema-compatible validator, upgrading Zod only if the chosen SDK requires it.

Refactor boundary:

- Extract a cheap per-request MCP factory.
- Register the same seven visible tools with the same names, descriptions, schemas, safety behavior, and catalog results.
- Preserve the business behavior in `nas-client.ts`, `job-client.ts`, shared operation definitions, approval logic, and command builders, but explicitly change both clients to accept cancellation context and destroy in-flight HTTP requests. This is a real client-layer refactor, not typing glue.
- Replace FastMCP construction, `addTool`, `getApp`, `start`, wrapper auth, wrapper timeout, and wrapper result conversions.
- Mount an explicit `/health` route in front of the official MCP handler.
- Use the official stateless per-request HTTP handler. Do not create or store protocol sessions.
- Do not mount legacy SSE in the new NAS handler. The dual-era suite must still exercise official older-client compatibility and the historical GET sequence without relying on a persistent server session or legacy `/sse` endpoint.
- Implement the Step 4 Host/Origin contract using `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`. Production hosts include `nas-mcp.designflow.app` plus the recorded candidate host; loopback is local-test-only; missing Origin is allowed for non-browser clients.
- Use JSON response mode for ordinary tool results unless a tested client requires response streaming for progress.
- Remove `fastmcp` and `mcp-proxy` from the dependency graph.

Expected rewrite size:

- Moderate protocol-shell rewrite in `index.ts` or newly extracted `server.ts` and `http.ts`.
- Schema/result adaptations and cancellation plumbing through `nas-client.ts` and `job-client.ts`.
- Little or no rewrite in NAS command builders, approval policy, or shared catalog definitions.

Dependencies: Steps 2, 4, 5, 8, 9, and 10.

Verification gate: all NAS legacy-parity tests pass against the pre-migration fixture, and all intentionally changed behavior passes the July 28 contract. Never require a July 28-only method both to reproduce its old method-not-found result and succeed. Dependency inspection contains no third-party FastMCP or `mcp-proxy`; the seven-tool surface and all enabled hidden operations match the recorded baseline.

### Step 12. Migrate DevOps MCP to the official Python v2 SDK

Repository: DevOps MCP.

Target packages:

- exact stable official `mcp==x.y.z` SDK v2 package selected and recorded at implementation time;
- its `MCPServer` API;
- Starlette/Uvicorn only as needed for the status page, auth boundary, and deployment runtime.

Refactor boundary:

- Preserve Python and keep operation functions, process groups, bounded readers, Docker/systemd logic, audit entry formatting, catalog metadata, and status-page content.
- Replace FastMCP construction, decorators, middleware types, `http_app`, session instructions, result conversions, and lifecycle integration.
- Create an adapter that registers existing functions and derives schemas from type hints or explicit official SDK schemas.
- Keep bearer auth in the outer ASGI layer and pass verified caller identity into official request context.
- Replace FastMCP audit middleware with an explicit official handler wrapper or tool adapter that logs start, completion, cancellation, deadline, failure, and duration.
- Use official stateless Streamable HTTP and implement the same metadata/error contract as NAS MCP.
- Remove third-party `fastmcp` only after parity tests pass.

Expected rewrite size:

- Moderate changes to the top, registration, middleware, and bottom HTTP sections of `server.py`, or extraction into `mcp_server.py` and `http_app.py`.
- Tool decorators may require mechanical conversion, but tool bodies should remain intact.
- Do not combine protocol migration with stylistic rewrites of host-operation code.

Dependencies: Steps 3, 4, 6, 7, 8, 9, and 10.

Verification gate: all DevOps tests pass; dependency inspection contains no third-party `fastmcp`; operation counts, schemas, safety metadata, audit identity, command bounds, and status output match the baseline except for intentional v2 fields and removed legacy paths.

### Phase E: compatibility, cutover, and cleanup

### Step 13. Run isolated side-by-side compatibility and failure-injection tests

Repositories: both.

Changes and environment:

- Build the exact candidate images locally or in CI and run them as isolated containers named `nas-mcp-20260728-candidate` and `devops-mcp-20260728-candidate`. Do not mount production Docker sockets, host PID, host root, NAS paths, audit volumes, or job volumes. Use fake NAS and host adapters plus synthetic test data.
- Expose each isolated container only for the compatibility window through a temporary HTTPS tunnel protected by the MCP bearer and an unguessable temporary hostname. The tunnel must create no persistent DNS, Coolify application, volume, or shared-cloud resource. Record the temporary FQDNs in this STATUS table, allowlist only those FQDNs, and shut the tunnels down after the matrix. If the available tunnel mechanism requires persistent account or infrastructure creation, stop and obtain separate authority rather than substituting a production host.
- Give each candidate a dedicated temporary bearer stored as a clearly named candidate field/item in the `vibe_coding` vault or generated for the isolated test run and kept only in protected runtime environment. Never reuse a production bearer, NAS approval key, audit volume, or DevOps job volume.
- Give DevOps candidate an isolated temporary audit directory and durable-operation volume. Keep `MCP_LONG_OPERATIONS_ENABLED=false` until its isolated storage tests pass.
- Do not replace the production `/mcp` routes yet.
- Before opening tunnels, record for Claude.ai, Claude Desktop, Claude Code, Codex, Roo Code, Windsurf, and ContextForge whether the tested version can attach a static `Authorization: Bearer` header directly. Use a pinned `mcp-remote` bridge for clients that cannot, and record the bridge version and configuration shape without tokens.
- Test every listed client either directly or through that recorded pinned bridge, plus direct official clients.
- For each client, test discovery, tools list, harmless call, invalid auth, restart between calls, bogus legacy session header, unsupported revision, 45-second deadline, disconnect, and durable job reconnect.
- Test one instance and two load-balanced instances to prove no hidden process-local session state. Put a disposable loopback reverse proxy, such as an unprivileged Caddy or nginx container with no host mounts, in front of the two candidate container ports; point the Quick Tunnel at that one proxy port. Record and remove its exact container/image/config with the other candidate resources.
- Inject an upstream NAS timeout, NAS API restart, DevOps subprocess tree timeout, MCP container restart, Cloudflare disconnect, and malformed request.
- Record client version, transport, bridge version, protocol selected, and result in a checked-in compatibility matrix. Do not record tokens.

Dependencies: Steps 11 and 12.

Verification gate: candidate image digests, temporary URLs, isolated secret references, and temporary volumes are recorded; no Coolify or persistent shared-cloud resource was created; production domains remain untouched; every supported client passes the required matrix; any unsupported client has an explicit business decision and documented fallback; two-instance testing proves requests do not depend on local session state; temporary tunnels and containers are confirmed stopped after the matrix.

### Step 14. Cut over production and close the work

Repositories: both.

Changes:

- Verify commit identity before each first commit with `git var GIT_COMMITTER_IDENT`; it must be `Albert Hazan <u2giants@users.noreply.github.com>`.
- Commit and push each repository's focused changes to `main` under its branch policy.
- Require tests, lint/typecheck, build, container smoke test, dependency-lock validation, and protocol contract in CI before deploy.
- Block cutover unless both exact SDK patches have no known open P0 or release-blocking Streamable HTTP, auth, cancellation, or backward-compatibility defect; the dual-era client matrix is green; no supported path requires the optional Tasks extension; and the exact prior SHA images have been redeployed once to a disposable candidate to prove rollback.
- Deploy through GitHub Actions to GHCR and Coolify. Do not live-edit production source.
- Verify the running build SHA and exact SDK version from health metadata and OCI labels. Fail deployment verification when health SHA differs from the GitHub commit being deployed or reports `unknown`.
- Run the read-only production smoke subset for both endpoints.
- Watch logs and audit outcomes through at least the longest supported operation and one service restart.
- Remove old wrapper dependencies and transitional candidate resources only after production verification and rollback window.
- Update all affected Markdown files, this STATUS table, repository handoffs, client setup, incident docs, architecture, development, deployment, troubleshooting, and the `ai-devops` machine setup scripts.
- Add durable navigation from each repository's `AGENTS.md` to the final protocol/operations document. Remove or mark this plan complete only when all work is deployed and verified.

Dependencies: Step 13.

Verification gate: both production health endpoints report the intended SHA, exact official SDK v2 package version, `2026-07-28` wire support, stateless HTTP, and the deadline/job settings; all production smoke tests pass; CI is green; old wrappers are absent from deployed images; rollback images and instructions are verified.

## 10. Tests required

The following named behaviors are mandatory. The implementing session may choose framework-specific filenames but must preserve the stable case IDs.

### Degradation-myth and refusal-relay cases

- `REFUSAL-001-validator-block-is-permanent-stateless-and-actionable`
- `REFUSAL-002-shared-formatter-preserves-nonempty-summary-verbatim`
- `REFUSAL-003-shared-formatter-empty-summary-fails-loudly`
- `REFUSAL-004-shared-formatter-never-emits-negative-tier-label`
- `REFUSAL-005-freeform-web-path-uses-shared-formatter`
- `REFUSAL-006-predefined-web-path-uses-shared-formatter`
- `REFUSAL-007-nonblocked-privileged-preview-keeps-approval-guidance`
- `REFUSAL-008-mcp-instructions-and-tool-description-state-no-call-limit`
- `REFUSAL-009-fresh-client-call-one-changes-command`
- `REFUSAL-010-fresh-client-after-ten-calls-changes-command`

Cases 001 through 008 are automated CI gates. Cases 009 and 010 are controlled deployed-behavior evaluations recorded as versioned, secret-free evidence until a deterministic model-evaluation harness exists. A pass requires the assistant to choose a bounded alternative and forbids an identical retry, a degradation claim, or a request to start a fresh session. Each case permits at most three fully recorded fresh-session attempts. Three failures require human review and remain a failed gate; silent retries are forbidden.

### Shared protocol cases

- `MCP20260728-001-discover-supported-revisions`
- `MCP20260728-002-july-request-with-per-request-meta`
- `MCP20260728-003-supported-legacy-client-initializes`
- `MCP20260728-004-unsupported-version-error`
- `MCP20260728-005-july-client-needs-no-initialize`
- `MCP20260728-006-missing-static-bearer-challenge`
- `MCP20260728-007-invalid-static-bearer-challenge`
- `MCP20260728-008-bogus-session-header-is-harmless`
- `MCP20260728-009-deterministic-cacheable-tools-list`
- `MCP20260728-010-result-type-and-server-info`
- `MCP20260728-011-disconnect-stops-or-transfers-work`
- `MCP20260728-012-restart-between-independent-calls`
- `MCP20260728-013-deadline-error-and-work-stopped`
- `MCP20260728-014-health-redacts-sensitive-data`
- `MCP20260728-015-host-origin-validation`
- `MCP20260728-016-legacy-sse-transition`
- `MCP20260728-017-proxy-and-bridge-compatibility`
- `MCP20260728-018-required-method-and-name-headers`
- `MCP20260728-019-subscriptions-listen-and-legacy-get`
- `MCP20260728-020-may-server-not-initialized-hang-regression`
- `MCP20260728-021-cross-repo-contract-digest`

### NAS-specific cases

- `NAS-001-exec-timeout-clamped-to-25s`
- `NAS-002-preview-and-http-buffer-bounds`
- `NAS-003-both-targets-run-concurrently`
- `NAS-004-deadline-aborts-underlying-request`
- `NAS-005-no-late-success-after-timeout`
- `NAS-006-disabled-operation-cannot-run`
- `NAS-007-write-preview-confirmation-and-token`
- `NAS-008-catalog-order-and-seven-tool-surface`
- `NAS-009-job-survives-mcp-restart`
- `NAS-010-job-cancellation-stops-real-work`

### DevOps-specific cases

- `DEVOPS-001-concurrent-auth-context-isolation`
- `DEVOPS-002-query-token-rejected`
- `DEVOPS-003-production-auth-fails-closed`
- `DEVOPS-004-process-group-killed-on-timeout`
- `DEVOPS-005-disconnect-kills-cancellable-child`
- `DEVOPS-006-file-read-bounds`
- `DEVOPS-007-directory-walk-bounds`
- `DEVOPS-008-audit-tail-bounds`
- `DEVOPS-009-caller-cannot-extend-sync-deadline`
- `DEVOPS-010-five-tool-visible-surface`
- `DEVOPS-011-hidden-operation-schema-validation`
- `DEVOPS-012-safety-classification-fails-loudly`
- `DEVOPS-013-job-survives-mcp-restart`
- `DEVOPS-014-job-cancellation-kills-process-group`

### Existing suites and build gates

- Synology Monitor: run the repository's existing lint, TypeScript check, tests, build, Go tests for any touched NAS API job code, and the 55 Synology script tests if shared archive behavior is touched.
- DevOps MCP: preserve existing `test_server.py` behavior while moving it into the locked test command; add formatting/static checks chosen in Step 3.
- Both: build the exact production container, start it locally with fake credentials/upstreams, run the protocol smoke suite, and inspect the final dependency graph.

No test may contact, mutate, scan, or load the production VPS, NAS units, Supabase project, Coolify, or Cloudflare unless Step 13 or 14 explicitly identifies a read-only production smoke check.

## 11. Constraints, standing rules, and gotchas

- GitHub is the source of truth. No production source edits.
- Both repositories use `main` only.
- Before the first commit in each repo, `git var GIT_COMMITTER_IDENT` must show `Albert Hazan <u2giants@users.noreply.github.com>`.
- Preserve unrelated work. Never assume the checkout is clean from this historical plan text; inspect current status and stage only named files belonging to the active step.
- No shared database change is expected. If one becomes necessary, stop and use the shared-db migration and PR process.
- Production and shared infrastructure remain read-only by default. A future implementation request may authorize normal application deployment, but it does not authorize Terraform, Cloud Build trigger mutation, or unrelated infrastructure changes.
- Never expose or commit bearer tokens, NAS HMAC keys, Cloudflare tokens, Coolify tokens, or 1Password values.
- Serialize all 1Password reads.
- Never raise the Synology Monitor MCP's 25-second NAS API safety timeout to make broad scans synchronous.
- A read-only NAS walk can still overload production. Use the approved durable low-priority job design and obtain explicit approval for broad production metadata walks.
- Keep every fallback loud and typed. Do not return empty success for unknown, timed out, cancelled, disabled, or policy-blocked work.
- Do not hard-code SDK versions, protocol versions, domains, client deadlines, or job limits inside scattered tool functions. Centralize configuration with documented safe defaults.
- Do not assume `Mcp-Session-Id`, initialize, GET polling, Last-Event-ID, or SSE resumability exists in July 28 core.
- Do not add the optional Tasks extension as the only way to retrieve long results.
- Do not expose all hidden operations to fix discovery. The compact facades are intentional context controls.
- DevOps MCP is root-equivalent. Keep the protocol migration separate from refactoring host behavior.
- The official HTTP handler does not automatically verify bearer tokens, Host, or Origin in every mounting pattern. Keep explicit validation in front.
- A deadline response is not cancellation proof. Tests must demonstrate underlying work stopped or moved to a durable job.
- Pin client bridges and sidecars used in the compatibility path. Do not rely on `@latest`, `cloudflared:latest`, or an RC gateway silently changing during protocol validation. Changing unrelated sidecars is out of scope unless required to freeze the test baseline.
- Phases A through C must land and stay green before either official SDK wrapper migration begins. A protocol-shell migration may not be combined with dependency locking, auth hardening, cancellation plumbing, or deadline-shape changes in one unreviewable commit.
- Documentation is a verification gate: `apps/nas-mcp/README.md` must stop claiming AbortController before it exists, `apps/nas-mcp/Dockerfile` must stop claiming SSE, and active docs must distinguish July 28 stateless requests from supported older-client initialization behavior.

## 12. Access and environment

Expected authenticated tools:

- `gh` for `u2giants/synology-monitor` and `u2giants/devops-mcp`;
- Docker or the repository's local container runtime for isolated builds;
- installed `cloudflared` Quick Tunnels (`cloudflared tunnel --url http://127.0.0.1:<candidate-port>`) for temporary client-matrix HTTPS URLs; Quick Tunnels must use generated temporary hostnames and must not create persistent DNS or account resources;
- Coolify read/deploy access through the existing approved API path for application deployment only;
- read-only GitHub Actions and GHCR verification;
- approved client applications for the compatibility matrix;
- 1Password vault `vibe_coding` for secret references only.

Relevant 1Password items named in current documentation:

- `designflow-mcp` for managed MCP connection references;
- `devops-mcp-client-tokens` for DevOps MCP client bearer fields;
- `nas-monitor-secrets` for NAS Monitor runtime secret references.

Never put their values in the plan, fixtures, commands captured to logs, or commits.

Local setup:

1. Synology Monitor is `/worksp/monitor/app`; read `AGENTS.md` first.
2. Clone DevOps MCP to `/worksp/devops-mcp`; read its `AGENTS.md` first.
3. Fetch current `origin/main` in both, check for concurrent work, and fast-forward only after preserving unrelated changes.
4. Use fake bearer tokens and fake NAS/host adapters for local tests.
5. Bind local servers to loopback unless a specific container test requires an isolated Docker network.
6. Never mount `/`, `/var/run/docker.sock`, host PID, or production NAS paths for ordinary unit/protocol tests.
7. On the current planning machine, `/usr/local/bin/cloudflared` and Docker are installed. Re-verify before Step 13. If Quick Tunnels are unavailable, use an equivalent temporary non-persistent HTTPS tunnel only if it requires no shared-infrastructure mutation; otherwise stop for authority rather than using production.

Production identifiers and URLs:

- NAS MCP: `https://nas-mcp.designflow.app/mcp`.
- DevOps MCP: `https://mcp.designflow.app/mcp`.
- Synology Monitor web: `https://mon.designflow.app`.
- DevOps MCP Coolify service UUID: `vj5f76xet05bxwdq4utw1kho`.
- NAS MCP Coolify application ID: `efl17f5iocnz94840pexre9d`.

## 13. Definition of done, risks, and open questions

### Definition of done

- [ ] All 17 STATUS rows, including 0A through 0C, are complete with dates and evidence.
- [ ] Both NAS consumers preserve the validator's permanent, stateless refusal explanation and all eight automated refusal tests pass.
- [ ] The deployed fresh-client behavior evaluation passes on call 1 and after at least ten harmless calls, with the exact web and NAS MCP SHAs recorded.
- [ ] Both dependency installations are locked and reproducible.
- [ ] Both CI pipelines run unit, protocol, auth, cancellation, deadline, and container smoke tests before deployment.
- [ ] Both servers use exact stable official SDK v2 packages directly and report wire revision `2026-07-28` separately.
- [ ] No third-party FastMCP or NAS `mcp-proxy` remains in deployed dependency graphs.
- [ ] Both `/mcp` endpoints are stateless and pass July 28 `server/discover` and per-request metadata tests.
- [ ] Supported older clients pass the compatibility matrix.
- [ ] Obsolete DevOps SSE and query-token paths are removed, or an explicit dated exception with owner and removal gate is recorded.
- [ ] Short calls finish before the shortest supported client deadline.
- [ ] Long operations use durable, bounded, cancellable handles and survive MCP restart.
- [ ] NAS validation, approval, and 25-second arbitrary command policies remain intact.
- [ ] DevOps process-group and bounded-reader protections remain intact.
- [ ] Both repositories are committed and pushed with Albert's correct identity.
- [ ] CI is green and GHCR contains the expected SHA-tagged images.
- [ ] Production health metadata and read-only smoke tests prove the deployed SHAs.
- [ ] All affected Markdown, AGENTS routing, client setup, troubleshooting, and handoff state is current.
- [ ] Transitional endpoints/resources are removed after the verified rollback window.

### Primary risks and mitigations

1. **New v2 SDK defects shortly after release.** Pin exact patches, run side by side, test real clients, and retain rollback images.
2. **Client does not yet support July 28.** Use official SDK backward compatibility; record negotiated revisions; do not remove the last working path until the client matrix passes.
3. **Tool schema or result drift during wrapper removal.** Snapshot the existing visible and hidden catalogs and compare automatically.
4. **Auth identity lost across request contexts.** Add concurrent-client isolation and audit tests before migration.
5. **Cancellation reports success while work continues.** Require process/PID/job evidence in tests.
6. **Long-job storage grows without bound.** Enforce quotas, retention, expiry, output limits, and cleanup tests.
7. **DevOps migration weakens root-level safety.** Keep host functions unchanged and review the adapter separately from operation logic.
8. **NAS migration weakens approval boundaries.** Preserve NAS API independent classification and verify every write path.
9. **Proxy or bridge changes protocol headers.** Pin versions and test direct plus proxied paths.
10. **Documentation describes a pre-migration world.** Make plan and docs updates a CI/review and session-close gate.

### Rollback

- Keep the last known-good SHA-tagged image for each service.
- Candidate endpoints remain separate until cutover.
- If production fails a smoke test, route or redeploy back to the exact prior image without changing tokens or infrastructure.
- Do not roll back by reinstalling an unpinned dependency set.
- Durable job records must be forward/backward readable during the rollback window, or the new job feature must remain disabled until cutover is final.

### Open questions and decision gates

1. Which exact official TypeScript and Python v2 patch versions are stable when implementation begins? Resolve from official release notes and pin them.
2. Which current clients send `/sse` to DevOps MCP? Decide from seven days of logs and managed configuration searches.
3. Does ContextForge fully support July 28, or must it remain on an earlier revision through SDK compatibility? Decide from the side-by-side matrix.
4. Which operations genuinely need durable long execution? Start with documented failures and measured duration; do not make every operation asynchronous.
5. Do any clients support the redesigned Tasks extension well enough to enable the optional adapter? Decide from real calls, not feature claims.
6. Does DevOps job state belong on the existing audit volume or a new named volume? Choose the least-privileged durable location with independent quotas and rollback compatibility.

## Mandatory self-audit

### 1. Could a brand-new AI session execute this perfectly without asking Albert anything?

Yes. Sections 1 through 8 explain the business goal, both applications, the historical degradation myth, the current refusal-relay defect, the protocol failures, exact scope, current state, root causes, rejected paths, repository-boundary decision, and locked decisions. Section 9 begins with the independently deployable Phase 0 behavior fix, then names every foundation and migration step with repository files, behavior, dependencies, context cut points, and verification gates. Sections 10 through 13 provide named automated and deployed-behavior tests, constraints, access, definition of done, rollback, and bounded decision criteria.

### 2. Does the plan carry the full background, nuance, and rejected reasoning?

Yes. Sections 3, 5, and 6 preserve the session, initialization, four-minute hang, 25/45/60/120-second timeout chain, dependency drift, stateless current design, hidden-tool facades, both repaired historical 10-to-15-call causes, the live web refusal-relay defect, and repaired DevOps hang patterns. Section 7 records why language unification, repository unification, raw protocol implementation, validator weakening, documentation-only mitigation, timeout increases, synchronous progress, mandatory Tasks, permanent SSE, and URL tokens were rejected.

### 3. Is the ultimate goal clear enough for a correct judgment call if a step is wrong?

Yes. Section 1 defines the user-visible outcome and explicitly says the goal wins over a conflicting step. Section 8 separates locked architecture from open choices and gives criteria. Section 13 defines measurable completion, risks, rollback, and the remaining evidence-based gates.

Self-audit result: PASS. All 13 required sections are present. Phase 0 incorporates the full degradation-myth diagnosis and fixes the missing proof points: both web paths have mandatory regression coverage, the safe validator behavior is locked by test, the fresh-client behavior is evaluated at call 1 and after ten calls, the plan is routed from `AGENTS.md`, and completion requires exact deployed SHA verification. All later migration steps name concrete targets and verification gates; scope, repository boundaries, and rejected approaches are explicit; secrets are referenced only by vault item name; and completion includes commit, push, CI, deploy, rollback, and production SHA proof.

## Independent review history

Review date: 2026-08-05 (America/New_York)

Grok session: `019fd4ad-8b7c-7623-976b-3efb4167e239`

Grok reviewed and approved the original foundation and v2 migration portion. It first required 12 corrections covering wire-versus-SDK terminology, missing protocol cases, fail-closed auth, cancellation, deadline result shape, durable-job placement, exact SDK cutover gates, candidate isolation, build identity, CI ordering, documentation gates, and cross-repository contract ownership. After those changes, Grok found three remaining mechanics: Step 2 depended prematurely on the Step 5 suite, candidate Coolify creation lacked authority, and the NAS asynchronous allowlist was not narrow enough.

The reviewed migration portion moves the full publish-failure proof to Step 5, uses isolated Docker candidates with non-persistent Quick Tunnel URLs instead of creating Coolify resources, and limits asynchronous work to code-reviewed allowlists with NAS initially restricted to existing inventory/archive-move native jobs. Grok's final verdict on that portion was: **APPROVE. No concrete implementation blocker remains.**

Phase 0 came from `plan_mcp-degradation-myth.md`, which records its own GLM 5.2 and Grok review history. The 2026-08-05 merge resolved the four concrete gaps found in the later Codex audit: mandatory tests for both web paths, a real fresh-client behavior evaluation, exact deployed-SHA proof, and `AGENTS.md` discovery. No review verdict is represented as covering edits made after that reviewer saw the source plan.

### Kimi K3 review and debate

Review date: 2026-08-05 (America/New_York)

Kimi K3 session: `session_3bf019cb-36b5-495e-b337-a4e7283b8386`

Kimi independently checked the plan against both repositories and the official July 28 protocol and SDK v2 documentation. It found two blockers: the first sequencing would have activated the 45-second DevOps limit before durable operation tools existed, and the baseline fixture gate required intentionally changed July 28 behavior both to fail as before and succeed after migration. It also found six smaller ambiguities in optional client metadata, existing AGENTS routing, cross-repository digest claims, load-balancer setup, model-evaluation retry limits, and duplicate reproducibility builds.

The debate ended with agreement after the plan split deadline work into 9A preparation, Step 10 durable operations, and 9B activation; divided fixture cases into legacy parity versus intentional cutover changes; and incorporated all six smaller corrections. Kimi re-read the amended diff, traced the dependency graph through cutover, challenged the result for new defects, and returned **APPROVE** with no remaining blocker. Its final non-blocking consistency note about the DevOps dual-build check was also incorporated.
