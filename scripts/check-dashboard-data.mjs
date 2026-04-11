const requiredEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const baseUrl = process.env.SUPABASE_URL.replace(/\/+$/, "");
const headers = {
  apikey: process.env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  Prefer: "count=exact",
};

const checks = [
  { page: "overview", table: "nas_units", required: true, note: "registered NAS units" },
  { page: "overview", table: "metrics", required: true, note: "live metrics for gauges" },
  { page: "metrics", table: "metrics", required: true, note: "chart history" },
  { page: "storage", table: "storage_snapshots", required: true, note: "volume and disk data" },
  { page: "docker", table: "container_status", required: true, note: "container cards" },
  { page: "logs", table: "nas_logs", required: true, note: "log table" },
  { page: "security", table: "security_events", required: true, note: "security event feed" },
  { page: "settings", table: "nas_units", required: true, note: "registered unit list" },
  { page: "ai-insights", table: "ai_analyses", required: false, note: "scheduled AI output" },
  { page: "overview", table: "alerts", required: false, note: "active alerts list" },
];

async function fetchCount(table) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?select=*&limit=1`, {
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${table} HTTP ${response.status}: ${body}`);
  }

  const contentRange = response.headers.get("content-range");
  if (!contentRange || !contentRange.includes("/")) {
    throw new Error(`${table} missing content-range header`);
  }

  const total = Number(contentRange.split("/")[1]);
  if (Number.isNaN(total)) {
    throw new Error(`${table} returned invalid content-range: ${contentRange}`);
  }

  return total;
}

async function main() {
  const cache = new Map();
  let hasFailure = false;

  for (const check of checks) {
    let count = cache.get(check.table);
    if (count === undefined) {
      count = await fetchCount(check.table);
      cache.set(check.table, count);
    }

    const status = check.required
      ? count > 0
        ? "PASS"
        : "FAIL"
      : count > 0
      ? "PASS"
      : "WARN";

    if (status === "FAIL") {
      hasFailure = true;
    }

    console.log(
      `${status.padEnd(4)} page=${check.page.padEnd(11)} table=${check.table.padEnd(22)} count=${String(count).padEnd(6)} ${check.note}`
    );
  }

  if (hasFailure) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Dashboard data check failed: ${error.message}`);
  process.exit(1);
});
