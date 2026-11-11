---
summary: Detail moved out of AGENTS.md: credentials and environment summary, NAS .env plaintext ruling, and the full operator hand-off rule.
kind: living
status: current
read-when: AGENTS.md points here for credentials overview or how to write steps for the operator.
---

# AGENTS.md reference detail

Moved verbatim from `AGENTS.md` on 2026-11-11 so the router stays small. 

## Credentials and environment

Never commit secret values. Production runtime values live in Coolify or each NAS's
untracked `.env`; CI values live in GitHub Secrets; human-accessible secrets live in
1Password vault `vibe_coding`.

**NAS `.env` plaintext is accepted — do not "fix" it.** Each NAS agent's
`/volume1/docker/synology-monitor-agent/.env` (and its `.env.bak.*` copies) holds
`DSM_PASSWORD` and other secrets as plain text. This is an accepted owner decision
(Albert, 2026-10-01): the files are `root:root` mode `600`, so only the NAS
administrator can read them. Do not flag this as a finding, and do not rotate or
change NAS account passwords on that basis. History: on 2026-10-01 a session treated
it as a problem, the `ai` and `popdam` DSM passwords were changed, the agents on both
NAS units crash-looped (DSM login error 400/407), and DSM auto-blocked `::1`. Any
future change of the `popdam` DSM password must update `DSM_PASSWORD` in both `.env`
files, then `docker compose up -d --force-recreate` (a plain `docker restart` keeps the old
environment), and clear `::1` from DSM's auto-block list if it was added.

| Variable/group | Purpose | Stored where | Required in dev | Required in prod |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser Supabase access | Local web env / Coolify; also GitHub build secrets | yes for web | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged web/server DB access | Local web env / Coolify | yes for full web | yes |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Agent/scripts DB writes | NAS `.env` / 1Password-backed command env | for agent/scripts | yes on NAS |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, optional provider keys/base URLs | AI providers | Local web env / Coolify | at least one for AI | as configured |
| `NAS_EDGE{1,2}_API_URL`, `_SECRET`, `_SIGNING_KEY` | Web/MCP/relay access and tier-3 approval | Local env / Coolify | yes for live NAS calls | yes |
| `NAS_API_SECRET`, `NAS_API_APPROVAL_SIGNING_KEY`, `NAS_API_NAME`, `NAS_API_PORT` | Per-NAS API auth and identity | NAS `.env` | no | yes |
| `NAS_ID`, `NAS_NAME`, `DSM_*`, `AGENT_IMAGE_TAG`, `TZ` | Agent identity, DSM access, image/runtime | NAS `.env` | agent only | yes |
| `MCP_BEARER_TOKEN`, `MCP_PORT` | Public NAS MCP auth/listen port | Coolify and client secret config | MCP only | yes |
| `ISSUE_WORKER_*`, `RUN_ISSUE_WORKER` | Background issue processing | Local web env / Coolify | optional | deployment-specific |
| `COPILOT_ACTION_SIGNING_KEY`, `COPILOT_ADMIN_EMAILS` | Dashboard copilot action authorization | Local web env / Coolify | optional | when feature enabled |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Browser push subscription | Local web env / Coolify/build | optional | when push enabled |
| `RELAY_*`, relay `NAS_EDGE*` values | Relay auth, origins, upstreams | Relay runtime env | relay only | relay only |
| `COOLIFY_TOKEN`, `COOLIFY_WEBHOOK_UUID`, GitHub `GITHUB_TOKEN` | CI publish/redeploy | GitHub Secrets | no | CI only |

The exhaustive variable-by-service reference is `docs/configuration.md`. Secret
retrieval procedures are in `docs/1password.md`.


## Operator hand-off rule (non-negotiable rule 1, full text)

1. **The operator is not a programmer. Hand him runnable commands, never verbs.**
     "Deploy nas-mcp", "enable the tool in `tools-config.json`", "recreate the
     container", "run the migration" are not instructions — they are the task,
     restated. They only look actionable because *you* can already see the host, the
     path, and the command behind them; he cannot. Every hand-off step must be:
     1. The literal command, copy-pasteable, one per line, with `sudo` where needed
        and the real host and path filled in (`ssh ahazan@100.107.131.35` for
        edgesynology1, `ssh ahazan@100.107.131.36` port **1904** for edgesynology2 —
        both are SSH-config aliases `edgesynology1`/`edgesynology2`; not `ssh <nas>`).
     2. What correct output looks like, so he can judge success without asking —
        "you should see `74:      - /etc/group:/host/etc/group:ro`", not "verify it
        applied". **Mark which parts of the expected output vary.** A made-up file
        size in an example gets compared literally: on 2026-07-16 a sample line with
        an invented `1234` had him report a mismatch against his real `1396` when the
        step had in fact succeeded. Say "the size and date will differ — only the
        filename matters", or show real captured output and label it as shape-only.
     3. A command you have actually run, or whose exact form you have tested. Do not
        hand over a command you composed but never executed — the quoting, the flag,
        or the path will be wrong, and he has no way to tell your typo from his. The
        `sed` that worked on edgesynology1 matched **zero** lines on edgesynology2
        (CRLF endings) and would have silently done nothing.
     4. Named clicks if it is a UI action (DSM → Container Manager → Project → …).
     If you cannot produce a runnable command because a value is unknown or you lack
     access, say exactly which value is missing and ask. Do not paper over the gap
     with a verb. This is the most repeated complaint in this project's history.


