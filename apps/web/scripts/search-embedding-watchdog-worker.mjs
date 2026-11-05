import { checkSearchEmbeddings } from "./search-embedding-watchdog.mjs";

// Independent of the optional AI issue queue; never starts or drains AI jobs.
console.log("[search-watchdog] starting one-minute health checks");
while (true) {
  try { await checkSearchEmbeddings(); }
  catch { console.error("[search-watchdog] alert check failed; will retry"); }
  await new Promise(resolve => setTimeout(resolve, 60000));
}
