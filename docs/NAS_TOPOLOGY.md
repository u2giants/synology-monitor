# NAS Topology, Sync Direction, and Read/Write Rules

**Status:** authoritative. Last updated 2026-07-24.

This is the single source of truth for how POP Creations' two Synology NAS units
are related, which one you talk to for reads vs. writes, and why. Any repo whose
code, agents, or workers touch NAS files (popdam, popsg, synology-monitor, and any
future consumer) should link here rather than re-describing it.

> Read this before pointing any worker, agent, mount, crawl, or deploy at a NAS.
> Getting the direction wrong silently loses data (see §2).

---

## 1. The two units

| | Hostname | LAN IP | Tailscale IP | SSH | Role |
|---|---|---|---|---|---|
| **NAS 1** | `edgesynology1` | `192.168.3.100` | `100.107.131.35` | port 22 | **Source of truth for files. All file writes go here.** |
| **NAS 2** | `edgesynology2` | `192.168.3.101` | `100.107.131.36` | port 1904 | **Read-only replica. Offload reads here.** |

- **All folders exist on both units.** Same tree on each; the difference is role, not content.
- **Both units are joined to Active Directory `IML.isaacmorris.com`.** The SMB
  login accounts used for file access (e.g. `popdam`, `ahazan`) are **AD domain
  accounts**. Rotating those passwords is an Active Directory change, not a
  Synology-local one.

---

## 2. Sync direction — ONE WAY, edge1 → edge2

Because of a history of extensive sync collisions and errors, replication is
deliberately **one-way**:

```
edgesynology1  ──(edge2 pulls from edge1)──▶  edgesynology2
   (.100)                                          (.101)
 WRITE here                                     READ here
```

- `edgesynology2` **pulls** from `edgesynology1`. Nothing flows back.
- **A change written to `edgesynology2` will NOT propagate to `edgesynology1`.**
  It is stranded on the replica and will eventually be overwritten by the next
  pull from edge1. This is the single most important rule on this page.

---

## 3. The read/write rule

This applies to **FILE operations only** — reading, writing, moving, or deleting
the *files/folders* on the shares. It does **not** govern the NAS operating system
or operating environment (OS packages, Docker/Watchtower, the monitoring agent,
disk/SMART, ShareSync config) — those are per-unit and out of scope here.

| You need to… | Use | Why |
|---|---|---|
| **Read files** — crawl, scan, index, thumbnail, checkout-copy, or deploy any agent/software that only *reads* files | **`edgesynology2` (.101)** | Takes load off edge1, which every write-worker already hammers. |
| **Change files** — move, rename, delete, write, reorganize, or deploy any agent that *modifies* files | **`edgesynology1` (.100)** | Writes to edge2 do not sync back and are lost (§2). |

Rule of thumb: **read on edge2, write on edge1.** If unsure whether an operation
writes, treat it as a write and use edge1.

---

## 4. Current PopDAM / PopSG mapping (verified against admin_config 2026-07-24)

This is how the DAM/SG apps are wired today, and it conforms to §3:

| Consumer | Points at | Share | SMB user | Correct per policy? |
|---|---|---|---|---|
| **PopDAM/PopSG file-scraping agents** (Windows agents; read-only crawl) | `edgesynology2` / `192.168.3.101` | `styleguides` (Y:) and `mac` (Z:) | `popdam`, `ahazan` | ✅ reads → edge2 |
| **Linux worker** (file moves/checkouts; writes) | `edgesynology1` / `192.168.3.100` | `mac` → `/mnt/nas/mac` | (mount) | ✅ writes → edge1 |

The scraping agent that indexes the filesystem for both PopDAM and PopSG runs
against **edge2** on purpose — it only reads.

---

## 5. Consequences / gotchas

- **Never point a file-modifying job at edge2.** Style-group rebuilds, checkouts
  that write back, cleanup/move jobs, and archival must target edge1 (.100).
- If a file is "missing" on one unit, check direction: a brand-new write should
  appear on **edge1 first**, then on edge2 after the next pull. If it only exists
  on edge2, it was written to the wrong unit and is at risk.
- LAN IPs and hostnames are interchangeable within the LAN, but prefer the
  hostnames where possible; the AD/domain resolves them.
- This one-way arrangement is a deliberate mitigation for past sync errors, not a
  permanent design goal. If sync is ever made bidirectional again, this document
  must be updated first.
