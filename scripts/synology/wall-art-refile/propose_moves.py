#!/usr/bin/env python3
"""Propose WALL ART re-filing moves (read-only). See docs/wall-art-refile-runbook.md.

Inputs (all in one work folder, produced by the runbook steps):
  dirs.tsv    depth<TAB>./relative/path of every item-number folder under ____New Structure
  target.txt  ./Category/Size/Licensor folders under WALL ART (find -maxdepth 3)
  mg.json     merchGroup rows for mgTypeCode 04 (size) and 05 (licensor)
  skus.json / status.json  License.Style columns B (Style #) and N (License Status)
Output: proposed_moves.csv
"""
import csv, difflib, json, re, sys
from collections import defaultdict

W = sys.argv[1]
ROOT = r"\mac\Decor\Character Licensed\____New Structure"
WALL = "Concept Approved Designs/WALL ART"
MOVE_STATUSES = {"Pre-Pro Approved", "Concept Approved", "Production Approved"}
ITEM = re.compile(r"^([A-Za-z0-9]{3})([A-Za-z0-9]{2})([A-Za-z]{2})([A-Za-z0-9]{2})(\d{2})")

def norm(s):
    return re.sub(r"[^a-z0-9.]", "", s.lower().replace('”', '').replace('"', ''))

def winpath(rel):
    return ROOT + "\\" + rel.lstrip("./").replace("/", "\\")

# --- target tree -------------------------------------------------------------
tree = defaultdict(lambda: defaultdict(set))     # category -> size -> {licensor}
for line in open(f"{W}/target.txt"):
    p = line.rstrip("\n").split("/")[1:]
    if len(p) >= 2: tree[p[0]][p[1]]
    if len(p) == 3: tree[p[0]][p[1]].add(p[2])
    if len(p) == 1: tree[p[0]]
cat_by_code = defaultdict(list)
for cat in tree:
    head = re.split(r" - |_(?=[A-Z][a-z])", cat)[0]          # drop the description
    for tok in re.split(r"[ _]+", head):
        if re.fullmatch(r"[A-Z0-9]{3}", tok): cat_by_code[tok].append(cat)

# --- code tables -------------------------------------------------------------
mg = defaultdict(set)
for r in json.load(open(f"{W}/mg.json")):
    mg[(r["mgTypeCode"], r["mg_code"].upper())].add(r["mg_desc"].strip())

# --- license status ------------------------------------------------------------
skus = json.load(open(f"{W}/skus.json"))["values"]
stats = json.load(open(f"{W}/status.json"))["values"]
status = defaultdict(set)
for i, s in enumerate(skus):
    if s and s[0].strip():
        status[s[0].strip().upper()].add((stats[i][0].strip() if i < len(stats) and stats[i] else "") or "(blank)")

def match(want, options):
    """exact-normalized, then containment, then close spelling. returns (name, how)"""
    n = norm(want)
    ex = [o for o in options if norm(o) == n]
    if ex: return ex[0], "exact"
    if re.fullmatch(r"[\d.]+x[\d.]+", n):              # size: try swapped dimensions
        a, b = n.split("x")
        sw = [o for o in options if norm(o) == f"{b}x{a}"]
        if sw: return sw[0], "fuzzy (dimensions swapped)"
        return None, None
    co = [o for o in options if len(norm(o)) >= 3 and (norm(o) in n or n in norm(o))]
    if len(co) == 1: return co[0], "fuzzy (contains)"
    cl = difflib.get_close_matches(n, {norm(o): o for o in options}, 1, 0.75)
    if cl: return {norm(o): o for o in options}[cl[0]], "fuzzy (similar spelling)"
    return None, None

# --- sources: top-most item folders outside WALL ART -----------------------------
rows = [l.rstrip("\n").split("\t")[1] for l in open(f"{W}/dirs.tsv")]
items = sorted(r for r in rows if not r.startswith(f"./{WALL}/"))
itemset = set(items)
def nested(p):
    parts = p.split("/")
    return any("/".join(parts[:k]) in itemset for k in range(2, len(parts)))

existing_items = {r.split("/")[-1].upper(): r for r in rows if r.startswith(f"./{WALL}/")}

out = []
for src in items:
    if nested(src): continue
    name = src.split("/")[-1]
    m = ITEM.match(name)
    item = m.group(0).upper() if m else name
    rec = dict(item_number=item, source_folder=winpath(src), area=src.split("/")[1],
               license_status="", category_folder="", size_code="", size_from_MG04="",
               size_folder="", licensor_code="", licensor_from_MG05="", licensor_folder="",
               destination_folder="", decision="", notes="")
    notes = []
    if not m:
        rec.update(decision="SKIP", notes="folder name is not a standard item number"); out.append(rec); continue
    pre, size, lic = m.group(1).upper(), m.group(2).upper(), m.group(3).upper()
    rec.update(size_code=size, licensor_code=lic)
    st = status.get(item) or status.get(name.upper())
    rec["license_status"] = " | ".join(sorted(st)) if st else "(not in sheet)"
    cats = cat_by_code.get(pre, [])
    if len(cats) == 1: rec["category_folder"] = cats[0]
    elif cats: notes.append("prefix appears in several WALL ART folders: " + " ; ".join(cats))
    else: notes.append(f"no WALL ART folder carries prefix {pre}")
    sizes = sorted(mg.get(("04", size), []))
    lics = sorted(mg.get(("05", lic), []))
    rec["size_from_MG04"] = " | ".join(sizes) or "(code not in MG04)"
    rec["licensor_from_MG05"] = " | ".join(lics) or "(code not in MG05)"
    cat = rec["category_folder"]
    if cat:
        so = list(tree[cat])
        hits = {match(s, so) for s in sizes} - {(None, None)}
        if len({h[0] for h in hits}) == 1:
            sf, how = hits.pop(); rec["size_folder"] = sf
            if how != "exact": notes.append(f"size matched {how}")
        elif hits: notes.append("several size folders match: " + " ; ".join(h[0] for h in hits))
        elif sizes:
            rec["size_folder"] = re.sub(r'["”]', "", sizes[0]).lower()
            notes.append("size folder does not exist yet - would be created")
        if rec["size_folder"]:
            lo = set().union(*tree[cat].values()) if tree[cat] else set()
            here = tree[cat].get(rec["size_folder"], set())
            hits = {match(l, here) for l in lics} - {(None, None)}
            if not hits: hits = {match(l, lo) for l in lics} - {(None, None)}
            if len({h[0] for h in hits}) == 1:
                lf, how = hits.pop(); rec["licensor_folder"] = lf
                if how != "exact": notes.append(f"licensor matched {how}")
                if lf not in here: notes.append("licensor folder does not exist under this size yet - would be created")
            elif lics:
                rec["licensor_folder"] = lics[0].title()
                notes.append("no licensor folder name matches - would create one; check spelling")
    if rec["category_folder"] and rec["size_folder"] and rec["licensor_folder"]:
        dest = f"./{WALL}/{cat}/{rec['size_folder']}/{rec['licensor_folder']}"
        rec["destination_folder"] = winpath(dest)
        if item in existing_items:
            notes.append("a folder with this item number already exists in WALL ART: " + winpath(existing_items[item]))
    ok_status = bool(st) and st <= MOVE_STATUSES
    if not cats:
        rec["decision"] = "LEAVE - not a wall-art product"
    elif not rec["destination_folder"]:
        rec["decision"] = "REVIEW - destination unresolved"
    elif not ok_status:
        rec["decision"] = "DO NOT MOVE - status"
    elif any(k in " ".join(notes) for k in ("already exists", "would create one", "several")):
        rec["decision"] = "REVIEW"
    else:
        rec["decision"] = "MOVE"
    rec["notes"] = "; ".join(notes)
    out.append(rec)

with open(f"{W}/proposed_moves.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
from collections import Counter
print(Counter(r["decision"] for r in out))
print(Counter(r["area"] for r in out if r["decision"] == "MOVE"))
