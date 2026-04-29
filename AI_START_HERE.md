# AI Start Here

Use this file first if you are an AI coding agent working in this repo.

## Core rule

Do not answer questions about the Synology Monitor app's live findings/history from the repo alone.

The live source of truth is Supabase.

## If the user asks about live monitor state

Examples:
- what problems the monitor found
- what the AI recommended
- what actions were proposed or executed
- what the operator and AI already said

Then do this:

1. Read [AI_CONTEXT.md](/worksp/monitor/app/AI_CONTEXT.md)
2. Read [AI_CONTEXT_QUERIES.md](/worksp/monitor/app/AI_CONTEXT_QUERIES.md)
3. Query Supabase using MCP / SQL access
4. Answer from live backend data, not from guesswork

## If you do not have Supabase access

State that clearly.

Do not imply that the repo itself contains the live monitor history.

## Canonical technical overview

After the AI context docs, read:
- [AGENTS.md](/worksp/monitor/app/AGENTS.md)

## Minimal repo reading order

1. [AI_CONTEXT.md](/worksp/monitor/app/AI_CONTEXT.md)
2. [AI_CONTEXT_QUERIES.md](/worksp/monitor/app/AI_CONTEXT_QUERIES.md)
3. [AGENTS.md](/worksp/monitor/app/AGENTS.md)
4. [README.md](/worksp/monitor/app/README.md)
