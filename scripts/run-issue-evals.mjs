#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    dir: "evals/fixtures",
    models: [],
    reasoning: "auto",
    limit: null,
    output: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else
    if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--model") args.models.push(argv[++i]);
    else if (arg === "--models") args.models.push(...argv[++i].split(",").map((value) => value.trim()).filter(Boolean));
    else if (arg === "--reasoning") args.reasoning = argv[++i] ?? "auto";
    else if (arg === "--limit") args.limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--output") args.output = argv[++i] ?? null;
  }

  if (args.models.length === 0) {
    args.models.push(process.env.EVAL_MODEL || "openai/gpt-5.4");
  }

  return args;
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordSimilarity(a, b) {
  const left = new Set(normalizeText(a).split(" ").filter(Boolean));
  const right = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function exactScore(a, b) {
  return normalizeText(a) === normalizeText(b) ? 1 : 0;
}

function arrayKindScore(expected, actual) {
  const left = new Set((expected ?? []).map((entry) => normalizeText(entry.kind ?? entry)));
  const right = new Set((actual ?? []).map((entry) => normalizeText(entry.kind ?? entry)));
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((value) => right.has(value)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function scoreFixture(expected, actual) {
  const status = exactScore(expected.status, actual.status);
  const confidence = exactScore(expected.hypothesis_confidence, actual.hypothesis_confidence);
  const hypothesis = wordSimilarity(expected.current_hypothesis, actual.current_hypothesis);
  const nextStep = wordSimilarity(expected.next_step, actual.next_step);
  const escalations = arrayKindScore(expected.approved_escalations, actual.approved_escalations);
  const overall =
    (status * 0.25) +
    (confidence * 0.15) +
    (hypothesis * 0.3) +
    (nextStep * 0.2) +
    (escalations * 0.1);

  return { status, confidence, hypothesis, next_step: nextStep, escalations, overall };
}

async function loadFixtures(dir, limit = null) {
  const root = resolve(process.cwd(), dir);
  const entries = (await fs.readdir(root).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  const selected = limit && Number.isFinite(limit) ? entries.slice(0, limit) : entries;
  const fixtures = [];
  for (const name of selected) {
    const fullPath = join(root, name);
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    fixtures.push({ name, path: fullPath, data: parsed });
  }
  return fixtures;
}

function buildEvalPrompt(fixture) {
  return [
    "You are evaluating a Synology NAS investigation handoff.",
    "Read the case prompt and respond with JSON only.",
    'Return schema: {"status":"","current_hypothesis":"","hypothesis_confidence":"high|medium|low","next_step":"","approved_escalations":[{"kind":""}]}',
    "Do not explain your reasoning.",
    "",
    "Case prompt:",
    fixture.prompt,
  ].join("\n");
}

async function callModel({ model, reasoning, prompt }) {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or OPENAI_API_KEY is required.");
  }

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2500,
  };
  if (reasoning && reasoning !== "auto") {
    body.reasoning = { effort: reasoning === "xhigh" ? "high" : reasoning };
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}$/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  return {
    parsed,
    usage: data?.usage ?? {},
  };
}

function formatScore(value) {
  return `${(value * 100).toFixed(0)}%`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: pnpm eval:issues -- --dir evals/fixtures --model openai/gpt-5.4 --reasoning high

Options:
  --dir <path>         Fixture directory. Default: evals/fixtures
  --model <id>         Model to evaluate. Can be passed multiple times.
  --models <a,b,c>     Comma-separated model list.
  --reasoning <level>  auto|minimal|low|medium|high
  --limit <n>          Limit number of fixtures.
  --output <path>      Save JSON results.
`);
    return;
  }
  const fixtures = await loadFixtures(args.dir, args.limit);
  if (fixtures.length === 0) {
    throw new Error(`No fixtures found in ${resolve(process.cwd(), args.dir)}`);
  }

  const results = [];
  for (const model of args.models) {
    let totalOverall = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const perFixture = [];

    for (const fixture of fixtures) {
      const { parsed, usage } = await callModel({
        model,
        reasoning: args.reasoning,
        prompt: buildEvalPrompt(fixture.data),
      });
      const scores = scoreFixture(fixture.data.expected, parsed);
      totalOverall += scores.overall;
      totalInputTokens += Number(usage?.input_tokens ?? 0);
      totalOutputTokens += Number(usage?.output_tokens ?? 0);
      perFixture.push({
        fixture: fixture.name,
        expected: fixture.data.expected,
        actual: parsed,
        scores,
        usage,
      });
      console.log(
        `${model} :: ${fixture.name} :: overall ${formatScore(scores.overall)} :: status ${formatScore(scores.status)} :: hyp ${formatScore(scores.hypothesis)} :: next ${formatScore(scores.next_step)}`,
      );
    }

    const summary = {
      model,
      reasoning: args.reasoning,
      fixture_count: perFixture.length,
      average_overall: perFixture.length > 0 ? totalOverall / perFixture.length : 0,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      per_fixture: perFixture,
    };
    results.push(summary);
    console.log(
      `\n${model} summary :: overall ${formatScore(summary.average_overall)} :: input ${summary.total_input_tokens} :: output ${summary.total_output_tokens}\n`,
    );
  }

  if (args.output) {
    await fs.writeFile(resolve(process.cwd(), args.output), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
