# Issue Evals

This directory is for saved investigation fixtures exported from the assistant.

Recommended workflow:

1. Open an issue in the assistant.
2. Use `Export fixture` to download a compact regression fixture.
3. Save the JSON file into `evals/fixtures/`.
4. When you change model routing, prompt structure, deep-mode behavior, or escalation policy, re-run the same cases and compare:
   - status
   - current hypothesis
   - hypothesis confidence
   - next step
   - approved escalation pattern

Quick runner:

`pnpm eval:issues -- --dir evals/fixtures --model openai/gpt-5.4 --reasoning high`

Multiple models:

`pnpm eval:issues -- --dir evals/fixtures --models openai/gpt-5.4,qwen/qwen3.6-plus`

Save JSON results:

`pnpm eval:issues -- --dir evals/fixtures --model deepseek/deepseek-v3.2 --output evals/results/deepseek-v3.2.json`

Notes:
- This first runner evaluates the exported `next_agent_prompt` handoff path.
- It is useful for comparing candidate models and reasoning settings quickly.
- It is not yet a full in-process replay of the app’s internal stage pipeline.

The fixture format is intentionally compact:
- `prompt`: handoff prompt for another agent
- `expected`: current accepted outcome
- `fixtures`: the evidence/actions/stage-runs needed to reproduce the judgment

These fixtures are not meant to be source-of-truth archives. Use transcript exports for that.
