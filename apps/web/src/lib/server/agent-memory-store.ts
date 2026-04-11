/**
 * Agent memory store — persistent knowledge extracted from resolved issues.
 * Each record is a short durable fact tagged with a subject so only relevant
 * topics are loaded per new investigation.
 */

import type { SupabaseClient } from "@/lib/server/issue-store";

export type AgentMemoryType = "nas_profile" | "issue_pattern" | "calibration" | "institutional";

export interface AgentMemoryRecord {
  id: string;
  user_id: string;
  nas_id: string | null;
  subject: string;
  memory_type: AgentMemoryType;
  title: string;
  content: string;
  tags: string[];
  source_issue_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewAgentMemory {
  nas_id: string | null;
  subject: string;
  memory_type: AgentMemoryType;
  title: string;
  content: string;
  tags: string[];
  source_issue_id?: string | null;
}

/**
 * Subjects the knowledge base is partitioned into.
 * The issue agent classifies which subjects are relevant at the start of each
 * investigation and loads only those memories.
 */
export const KNOWN_SUBJECTS = [
  "HyperBackup",
  "BTRFS",
  "RAID",
  "ShareSync",
  "SynologyDrive",
  "Docker",
  "SSL",
  "DSM",
  "SMB",
  "NFS",
  "Network",
  "Disk",
  "Memory",
  "CPU",
  "Process",
  "LogCenter",
  "Security",
  "ShareHealth",
  "SnapshotReplication",
  "C2Backup",
  "QuickConnect",
  "VPN",
  "Packages",
  "StoragePool",
  "Virtualization",
  "DDNS",
  "ReverseProxy",
  "SynologyPhotos",
  "ActiveDirectory",
  "iSCSI",
  "Monitoring",
  "General",
] as const;

export type KnownSubject = (typeof KNOWN_SUBJECTS)[number];

/**
 * Keyword → subject mapping used to classify an issue before memories are loaded.
 * Multiple subjects may match; all are used for the memory query.
 */
const SUBJECT_KEYWORDS: Array<{ subject: KnownSubject; keywords: RegExp }> = [
  { subject: "HyperBackup",         keywords: /hyper.?backup|hb|hibackup|backup.?task|backup.?vault|incremental.?backup|block.?level.?scan/i },
  { subject: "BTRFS",               keywords: /btrfs|snapshot|balance|scrub|send.?receive|subvol/i },
  { subject: "RAID",                keywords: /raid|mdadm|degrad|rebuild|hot.?spare|md\d|parity/i },
  { subject: "ShareSync",           keywords: /share.?sync|synology.?drive.?share|sharesync|syncfolder|sync.?conflict|sync.?backlog/i },
  { subject: "SynologyDrive",       keywords: /synology.?drive|drive.?server|team.?folder|portal|drive.?admin/i },
  { subject: "Docker",              keywords: /docker|container|compose|container.?manager/i },
  { subject: "SSL",                 keywords: /ssl|tls|certificate|let.?s.?encrypt|cert.?renew|https/i },
  { subject: "DSM",                 keywords: /dsm|firmware|package.?center|synopkg|task.?scheduler|syno.?update/i },
  { subject: "SMB",                 keywords: /smb|samba|cifs|windows.?share|file.?sharing/i },
  { subject: "NFS",                 keywords: /nfs|mount|stale.?handle|export/i },
  { subject: "Network",             keywords: /network|bond|vlan|dhcp|dns|port.?forward|interface|link.?down/i },
  { subject: "Disk",                keywords: /smart|bad.?sector|disk.?fail|sda|sdb|sdc|temperature|reallocated|pending.?sector/i },
  { subject: "Memory",              keywords: /memory|oom|out.?of.?memory|swap|psi|dirty.?page|writeback|mem.?pressure/i },
  { subject: "CPU",                 keywords: /cpu|iowait|load.?average|d.?state|steal|softirq/i },
  { subject: "Process",             keywords: /process|zombie|hung|rogue|pid|cmdline/i },
  { subject: "Security",            keywords: /security|ssh.?login|brute.?force|suspicious|file.?integrity|intrusion/i },
  { subject: "ShareHealth",         keywords: /share.?health|share.?database|synoshare|volume.?path|acl|permission/i },
  { subject: "SnapshotReplication", keywords: /snapshot.?replication|replication.?task|snapshot.?replica/i },
  { subject: "C2Backup",            keywords: /c2.?backup|synology.?c2|cloud.?backup|c2.?storage/i },
  { subject: "QuickConnect",        keywords: /quick.?connect|relay|quickconnect|ddns/i },
  { subject: "VPN",                 keywords: /vpn|openvpn|wireguard|vpn.?server/i },
  { subject: "Packages",            keywords: /package|third.?party|package.?center|install.?fail/i },
  { subject: "StoragePool",         keywords: /storage.?pool|volume.?expand|volume.?creat|pool.?degrad/i },
  { subject: "Virtualization",      keywords: /vmm|virtual.?machine|vm|hypervisor/i },
  { subject: "ReverseProxy",        keywords: /reverse.?proxy|application.?portal|proxy.?rule/i },
  { subject: "SynologyPhotos",      keywords: /synology.?photos|photo.?sharing|face.?recognition|album/i },
  { subject: "ActiveDirectory",     keywords: /active.?directory|ldap|domain.?join|kerberos/i },
  { subject: "iSCSI",               keywords: /iscsi|lun|target|initiator|san/i },
  { subject: "Monitoring",          keywords: /monitor.?agent|sensor.?agent|synology.?monitor|agent.?container/i },
];

/**
 * Classifies an issue into a set of relevant subjects based on keyword matching
 * against the issue title, summary, current hypothesis, and affected NAS list.
 * Always includes "General" as a catch-all.
 */
export function classifyIssueSubjects(issue: {
  title: string;
  summary?: string | null;
  current_hypothesis?: string | null;
  tags?: string[] | null;
}): string[] {
  const searchText = [issue.title, issue.summary, issue.current_hypothesis, ...(issue.tags ?? [])].join(" ");
  const matched = SUBJECT_KEYWORDS.filter(({ keywords }) => keywords.test(searchText)).map(({ subject }) => subject);
  // Always include General to catch cross-cutting institutional knowledge
  return [...new Set([...matched, "General"])];
}

/**
 * Loads memories relevant to the current issue.
 * Queries by user_id + matching subjects (or NAS-specific overrides) and
 * returns the 30 most recent records that overlap with the given subject list.
 */
export async function loadMemoriesForIssue(
  supabase: SupabaseClient,
  userId: string,
  subjects: string[],
  nasIds?: string[],
): Promise<AgentMemoryRecord[]> {
  if (subjects.length === 0) return [];

  let query = supabase
    .from("agent_memory")
    .select("id, user_id, nas_id, subject, memory_type, title, content, tags, source_issue_id, created_at, updated_at")
    .eq("user_id", userId)
    .in("subject", subjects)
    .order("created_at", { ascending: false })
    .limit(30);

  // Also include NAS-specific memories for the affected NAS units
  if (nasIds && nasIds.length > 0) {
    query = supabase
      .from("agent_memory")
      .select("id, user_id, nas_id, subject, memory_type, title, content, tags, source_issue_id, created_at, updated_at")
      .eq("user_id", userId)
      .or(`subject.in.(${subjects.join(",")}),nas_id.in.(${nasIds.join(",")})`)
      .order("created_at", { ascending: false })
      .limit(30);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[agent-memory-store] Failed to load memories:", error.message);
    return [];
  }
  return (data ?? []) as AgentMemoryRecord[];
}

/**
 * Saves new memory entries to the agent_memory table.
 * Uses upsert: if a memory with the same (user_id, subject, memory_type, title) already
 * exists it updates content + tags + updated_at rather than duplicating.
 */
export async function saveMemories(
  supabase: SupabaseClient,
  userId: string,
  memories: NewAgentMemory[],
): Promise<void> {
  if (memories.length === 0) return;

  const rows = memories.map((m) => ({
    user_id: userId,
    nas_id: m.nas_id ?? null,
    subject: m.subject,
    memory_type: m.memory_type,
    title: m.title,
    content: m.content,
    tags: m.tags,
    source_issue_id: m.source_issue_id ?? null,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("agent_memory")
    .upsert(rows, {
      onConflict: "user_id,subject,memory_type,title",
      ignoreDuplicates: false,
    });

  if (error) {
    console.error("[agent-memory-store] Failed to save memories:", error.message);
  }
}
