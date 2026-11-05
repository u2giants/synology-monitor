/** Realtime UPDATEs may reactivate a stable alert ID after it was removed. */
export function mergeActiveAlert<T extends { id: string; status: string; created_at: string }>(previous: T[], incoming: T): T[] {
  const remaining = previous.filter(alert => alert.id !== incoming.id);
  if (incoming.status !== "active") return remaining;
  return [incoming, ...remaining].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}
