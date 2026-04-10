const port = process.env.PORT || "3000";
const intervalMs = Number(process.env.ISSUE_WORKER_INTERVAL_MS || 3000);
const limit = Number(process.env.ISSUE_WORKER_BATCH_LIMIT || 10);
const token = process.env.ISSUE_WORKER_TOKEN;

if (!token) {
  console.error("[issue-worker] ISSUE_WORKER_TOKEN is required.");
  process.exit(1);
}

const baseUrl = process.env.ISSUE_WORKER_URL || `http://127.0.0.1:${port}`;
const endpoint = `${baseUrl}/api/internal/issue-worker/drain`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick() {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ limit }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Worker drain failed with ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (data.processed > 0) {
    console.log(`[issue-worker] processed ${data.processed} job(s) at ${data.timestamp}`);
  }
}

async function main() {
  console.log(`[issue-worker] starting loop against ${endpoint} every ${intervalMs}ms`);
  while (true) {
    try {
      await tick();
    } catch (error) {
      console.error("[issue-worker]", error instanceof Error ? error.message : error);
    }
    await sleep(intervalMs);
  }
}

main().catch((error) => {
  console.error("[issue-worker] fatal", error);
  process.exit(1);
});
