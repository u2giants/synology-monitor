// Canonical allowlist of top-level shared folders the archive file-inventory may
// scan. This is the SAME set as nas-api's jobs.AllowedShares (Go) and the
// read-only share mounts in deploy/synology/docker-compose.agent.yml. Go cannot
// import this TS list, so when the set changes update all three in lockstep
// (see Appendix C of docs/synology-archive-implementation.md).
export const ARCHIVE_SHARES = [
  "files",
  "styleguides",
  "users",
  "homes",
  "Coldlion",
  "Photography",
  "freelancers",
  "mgmt",
  "mac",
  "oldStyleguides",
] as const;

export type ArchiveShare = (typeof ARCHIVE_SHARES)[number];

// The two NAS API targets the web/MCP resolve a NAS by. These match the logical
// NAS_API_NAME each nas-api is deployed with and resolveNasApiConfig's slots.
export const ARCHIVE_NAS_TARGETS = ["edgesynology1", "edgesynology2"] as const;
export type ArchiveNasTarget = (typeof ARCHIVE_NAS_TARGETS)[number];

// Result kinds returned by a completed inventory job.
export const ARCHIVE_RESULT_KINDS = ["yearly", "cutoff", "dirs", "overlay"] as const;
export type ArchiveResultKind = (typeof ARCHIVE_RESULT_KINDS)[number];
