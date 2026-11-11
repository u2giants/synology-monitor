<!-- handoff-pointer: v1 — do not rewrite this file; add a file under HANDOFF.d/ instead -->
# HANDOFF

Active handoffs live in [`HANDOFF.d/`](HANDOFF.d/) — one write-once file per AI
session, named `<UTC-timestamp>-<machine>-<agent>-<slug>.md`.

**Starting a session:** list `HANDOFF.d/`, read the open files **newest first**.
Every file present is an OPEN workstream; finished ones are deleted (git history
keeps the text).

**Ending a session:** create your OWN new file in `HANDOFF.d/` following
the handoff standard (`templates/system/handoff-standard.md` in `popcre/ai-devops`).
**Do not rewrite this file, and do not edit another session's file.** Concurrent
sessions rely on that.
