# WALL ART re-filing runbook

Rare, owner-requested job: find item-number folders scattered around
`\mac\Decor\Character Licensed\____New Structure` and propose (later, perform)
moves into the canonical WALL ART tree:

```
\mac\Decor\Character Licensed\____New Structure\Concept Approved Designs\WALL ART\<Category>\<Size>\<Licensor>\<ITEM>
```

First run: 2026-10-29 (proposal only, nothing moved). Requested by Albert.
Deliberately a runbook, not a skill — it is used too rarely to justify
always-loaded context.

## 1. The filing rule (Albert's words, made exact)

Item numbers look like `GFZ14DYMM01`:

| Characters | Meaning | Where to look it up |
|---|---|---|
| 1–3 (`GFZ`) | product-type prefix | the WALL ART category folder whose name contains that 3-character code (`BGX _GFZ - Printed glass`) |
| 4–5 (`14`) | size code | merch group **MG04** → `11X14"` → size folder `11x14` (fuzzy) |
| 6–7 (`DY`) | licensor code | merch group **MG05** → `DISNEY` → licensor folder `Disney` (fuzzy) |
| 8–11 | property + sequence | not used for filing |

Then the **License Status** column of the Google sheet decides whether it moves.
Move only when the status is exactly one of:

- `Pre-Pro Approved`
- `Concept Approved`
- `Production Approved`

Everything else stays (including `Concept Approved with Comments` and
`Pre Production approved w/comment` — Albert's list does not include them; ask
him again if that ever matters).

Worked example (Albert's): `...\In Development\Customer Adopted\Ross\2025\Ross
Wall Jun-Sep_Harvest_Halloween FH 2025\GFZ14DYMM01` → `...\Concept Approved
Designs\WALL ART\BGX _GFZ - Printed glass\11x14\Disney`. Status Production
Approved. The script reproduces this exactly.

## 2. Where the data lives and how to reach it

| Data | Location | Access |
|---|---|---|
| Folders | edge1 NAS, `/volume1/mac/Decor/Character Licensed/____New Structure` | `ssh edgesynology1` (read-only `find` is enough for the proposal) |
| MG04 / MG05 | shared POP Supabase project `qsllyeztdwjgirsysgai` (named "popdam"), table `core."merchGroup"`, rows with `"mgTypeCode"` `'04'` (size) and `'05'` (licensor). `mg_code` = the 2-char code, `mg_desc` = the text | Supabase Management API read-only query endpoint with the token in 1Password `vibe_coding` → "Supabase CLI Personal Access Token" (run through the 1Password `op_run` tool so the token never appears) |
| License status | Google sheet "MasterData" `1ZL6cEwydC0cWSGP2I92uILn1ixILr_qAeDfDfD6F214`, tab `License.Style`; column **B** = Style # / SKU, column **N** = License Status; data starts row 3 (rows 1–2 are headers) | Google Sheets connector, `get_values` on `License.Style!B3:B` and `License.Style!N3:N` (too large for chat; the tool saves them to files) |

Notes on the data:

- `merchGroup` holds one row per company/division (`CW001`, `EH001`, `SP001`…),
  so a code can have several descriptions (e.g. MG04 `1A` = `15X23"` and
  `10X20"`). The script tries every description and only accepts the result if
  they all point at the same existing folder.
- The `core.product_size` / `core.licensor` tables are newer curated copies;
  Albert's rule says MG04/MG05, so the script uses `merchGroup`.
- Category folders sometimes carry several codes (`BFN_RFF_VFF - …`) and some
  codes appear in two category folders (`MBF`, `MF1`, `MF2`, `MQC`, `VSZ`).
  Those items are marked REVIEW.

## 3. Steps to produce the proposal CSV

Work folder: any scratch folder (`$W` below). All steps are read-only.

1. **Item folders** (≈10 min on edge1):
   ```bash
   ssh edgesynology1 'cd "/volume1/mac/Decor/Character Licensed/____New Structure" && find . -path "*/@eaDir" -prune -o -path "*/#recycle" -prune -o -type d -regextype posix-extended -regex ".*/[A-Za-z0-9]{3}[0-9]{2}[A-Za-z]{2}[^/]*" -printf "%d\t%p\n"' > $W/dirs.tsv
   ```
2. **Target tree**:
   ```bash
   ssh edgesynology1 'cd "/volume1/mac/Decor/Character Licensed/____New Structure/Concept Approved Designs/WALL ART" && find . -mindepth 1 -maxdepth 3 -type d -not -path "*@eaDir*" -printf "%p\n"' > $W/target.txt
   ```
3. **MG04/MG05** → `$W/mg.json` (JSON array of rows):
   ```sql
   select "mgTypeCode", mg_code, mg_desc, is_active, "companyCode_fk", "divisionCode_fk"
   from core."merchGroup" where "mgTypeCode" in ('04','05') order by 1,2;
   ```
   POST `{"query": …}` to
   `https://api.supabase.com/v1/projects/qsllyeztdwjgirsysgai/database/query/read-only`
   with `Authorization: Bearer <token>`.
4. **Sheet columns** → copy the two saved `get_values` results to
   `$W/skus.json` (column B) and `$W/status.json` (column N). Both must have the
   same row count — that is how rows are paired.
5. **Run**: `python3 -I scripts/synology/wall-art-refile/propose_moves.py $W`
   → `$W/proposed_moves.csv` (UTF-8 with BOM so Excel opens it cleanly).
6. Spot-check `GFZ14DYMM01` still maps to the worked example.

### What the script does

- Sources = every item-number folder under `____New Structure` **except**
  those already inside WALL ART, and only the top-most one when item folders
  are nested inside each other.
- Matching is case-insensitive and ignores spaces/quotes/punctuation. Sizes
  also accept swapped dimensions (`14x11`). Licensors accept containment
  (`NBC` ↔ `NBCU`) or close spelling. Every non-exact match is written in the
  notes column.
- Status is looked up by the 11-character item number, then by the full folder
  name.

### CSV columns and decisions

Columns: item number, source folder, area, license status, category folder,
size code, MG04 text, size folder, licensor code, MG05 text, licensor folder,
destination folder, decision, notes.

| Decision | Meaning |
|---|---|
| `MOVE` | everything resolved, status allowed, destination folders exist |
| `DO NOT MOVE - status` | destination resolved but status not in the allowed three (or SKU missing from the sheet) |
| `REVIEW` | resolvable but needs a human glance: item already exists in WALL ART, prefix in two categories, or a licensor folder would have to be created |
| `REVIEW - destination unresolved` | wall-art prefix found but size or licensor could not be resolved |
| `LEAVE - not a wall-art product` | prefix matches no WALL ART category (tabletop, storage, etc.) |
| `SKIP` | folder name is not a standard item number |

Results 2026-10-29: 478 MOVE, 389 REVIEW, 190 unresolved, 506 blocked by
status, 2,653 not wall art, 224 skipped.

## 4. Performing the moves later (not done yet)

Only after Albert approves the CSV (or an edited copy of it).

**Timestamps.** A move inside the same share on the same volume is a rename:
the folder and everything inside keep their modified time and their
created/birth time (Btrfs `otime`, which is what Windows/macOS show as
"Created"). The only thing that changes is the Linux *inode change time*
(`ctime`) of the moved folder itself, which no SMB/Finder user sees and no tool
can set. Never use copy-then-delete, Synology File Station "copy", or a
cross-share move — those rewrite birth times.

**How.** Run on the NAS as root through Python (`ahazan`/`ai` has passwordless
sudo only for `/usr/bin/python3`; see AGENTS "Direct NAS maintenance safety"):

1. Confirm a recent `mac` snapshot holds real data (`scripts/synology/README.md`,
   "Before running anything that writes") and record it in the handoff.
2. Filter the CSV to rows marked `MOVE` (plus REVIEW rows Albert cleared).
3. For each row: translate `\mac\...` → `/volume1/mac/...`; resolve every
   destination path component case-insensitively against what exists (never
   create `Disney` beside `disney` — see README trap 1); create missing size or
   licensor folders with `os.makedirs` copying the parent's owner and ACL;
   refuse if `<dest>/<ITEM>` already exists; then `os.rename(src, dest/ITEM)`.
   Dry-run first, printing every rename.
4. Record before/after `stat` (mtime, birth) of a sample of moved folders and
   files to prove nothing changed.
5. Synology Drive clients will see the rename as a move; do it outside working
   hours and spot-check one client.
