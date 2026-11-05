/** Search health joins the monitor's existing dashboard alert channel. */
export const ALERT_IDS = {
  dam: "d31a3e36-57ce-44a4-8b64-cd5fe6b24951",
  popsg: "d31a3e36-57ce-44a4-8b64-cd5fe6b24952",
  unavailable: "d31a3e36-57ce-44a4-8b64-cd5fe6b24953",
};
export function validateHealth(rows) {
  if (!Array.isArray(rows) || rows.length !== 2 || new Set(rows.map(r => r?.corpus)).size !== 2 ||
    rows.some(r => !["dam", "popsg"].includes(r?.corpus) || typeof r.stale !== "boolean" ||
      !Number.isFinite(r.pending) || r.pending < 0 || !Number.isFinite(r.errored) || r.errored < 0)) {
    throw new Error("Invalid search health response");
  }
  return rows;
}
export async function checkSearchEmbeddings(env = process.env, fetcher = fetch) {
  const sourceUrl = env.POPDAM_SUPABASE_URL;
  const sourceKey = env.POPDAM_SUPABASE_SERVICE_ROLE_KEY;
  if (!sourceUrl && !sourceKey) return { enabled: false };
  const targetUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const targetKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!targetUrl || !targetKey) throw new Error("Monitor alert database is not configured");
  async function request(url, key, options = {}) {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...options.headers } });
    if (!response.ok) throw new Error(`Search watchdog request failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  async function publish(kind, active, title, message, details = {}) {
    const id = ALERT_IDS[kind];
    const previous = await request(`${targetUrl}/rest/v1/alerts?id=eq.${id}&select=id,status`, targetKey);
    if (active && previous?.[0]?.status !== "active") {
      await request(`${targetUrl}/rest/v1/alerts?on_conflict=id`, targetKey, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ id, nas_id: null, severity: "warning", source: "agent", status: "active", title, message,
          created_at: new Date().toISOString(), resolved_at: null, acknowledged_at: null,
          details: { monitor: "popdam-search-embedding", corpus: kind, ...details } }),
      });
    } else if (!active && previous?.[0] && previous[0].status !== "resolved") {
      await request(`${targetUrl}/rest/v1/alerts?id=eq.${id}`, targetKey, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "resolved", resolved_at: new Date().toISOString() }),
      });
    }
  }
  let rows;
  try {
    if (!sourceUrl || !sourceKey) throw new Error("Search health credentials are incomplete");
    rows = validateHealth(await request(`${sourceUrl}/rest/v1/rpc/get_search_embedding_health`, sourceKey, { method: "POST", body: "{}" }));
  } catch {
    await publish("unavailable", true, "Search indexing health is unavailable", "The monitor cannot check artwork and style-guide indexing. Existing stalled alerts remain open.");
    return { enabled: true, unavailable: true };
  }
  for (const row of rows) {
    const name = row.corpus === "dam" ? "Artwork library" : "Style guides";
    await publish(row.corpus, row.stale, `${name}: picture indexing stalled`,
      `${row.pending.toLocaleString()} available pictures are waiting with no indexing progress for at least two hours.`, row);
  }
  await publish("unavailable", false, "", "");
  return { enabled: true, stale: rows.filter(r => r.stale).length };
}
