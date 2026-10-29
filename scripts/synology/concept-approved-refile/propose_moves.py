#!/usr/bin/env python3
"""Propose Concept Approved Designs re-filing moves (read-only).
See docs/concept-approved-refile-runbook.md.

Inputs (all in one work folder, produced by the runbook steps):
  dirs.tsv    depth<TAB>./relative/path of every item-number folder under ____New Structure
  target.txt  ./Department/Category/... folders under Concept Approved Designs (find -maxdepth 4)
  mg.json     merchGroup rows for mgTypeCode 04 (size) and 05 (licensor)
  skus.json / status.json  License.Style columns B (Style #) and N (License Status)
Output: proposed_moves.csv
"""
import csv, difflib, json, re, sys
from collections import Counter, defaultdict

W = sys.argv[1]
ROOT = r"\mac\Decor\Character Licensed\____New Structure"
CAD = "Concept Approved Designs"
MOVE_STATUSES = {"Pre-Pro Approved", "Concept Approved", "Production Approved"}
ITEM = re.compile(r"^([A-Za-z0-9]{3})([A-Za-z0-9]{2})([A-Za-z]{2})([A-Za-z0-9]{2})(\d{2})")
SIZE_RE = re.compile(r"^\s*[\d.]+\s*[xX]\s*[\d.]+")

def norm(s):
    return re.sub(r"[^a-z0-9.]", "", s.lower())

def winpath(rel):
    return ROOT + "\\" + rel.lstrip("./").replace("/", "\\")

# --- code tables -------------------------------------------------------------
mg = defaultdict(set)
for r in json.load(open(f"{W}/mg.json")):
    mg[(r["mgTypeCode"], r["mg_code"].upper())].add(r["mg_desc"].strip())
LICENSOR_NAMES = {norm(d) for (t, _), ds in mg.items() if t == "05" for d in ds}
LICENSOR_NAMES |= {"nbcu", "nbcuniversal", "warnerbros", "starwars", "sega", "viacom"}

def is_size(name): return bool(SIZE_RE.match(name)) or norm(name) == "nonstandardsizes"
def is_lic(name):
    n = norm(name)
    return n in LICENSOR_NAMES or any(len(n) >= 3 and (n in l or l in n) for l in LICENSOR_NAMES)

# --- target tree: dept/category -> child tree --------------------------------------
children = defaultdict(set)
for line in open(f"{W}/target.txt"):
    p = tuple(line.rstrip("\n").split("/")[1:])
    for k in range(1, len(p)):
        children[p[:k]].add(p[k])
    children.setdefault(p, set())
cats = [p for p in children if len(p) == 2]
cat_by_code = defaultdict(list)          # 3-char prefix (or 5-char prefix+size) -> categories
def codes(name):
    out = []
    for tok in re.split(r"[ _\-]+", name):
        if re.fullmatch(r"[A-Z0-9]{3}|[A-Z0-9]{5}", tok) and re.search(r"[A-Z]", tok):
            out.append(tok)
        else:
            break                          # codes come first; stop at the description
    return out
for cat in cats:
    for tok in codes(cat[1]):
        cat_by_code[tok].append(cat)

def descend(cat, pre, size):
    """Walk into coded sub-groups (e.g. MDD05_Chicago) that match the item."""
    while True:
        kids = [k for k in children[cat] if not ITEM.match(k)]
        exact = [k for k in kids if pre + size in codes(k)]
        loose = [k for k in kids if pre in codes(k)]
        nxt = exact if len(exact) == 1 else loose if len(loose) == 1 and not exact else []
        if not nxt: return cat
        cat = cat + (nxt[0],)

def layout(cat):  # cat may be a deeper sub-group tuple
    """'size+lic', 'size', 'lic' or 'flat' from what already exists under the category."""
    kids = children[cat]
    sizes = [k for k in kids if is_size(k)]
    lics = [k for k in kids if is_lic(k)]
    if len(sizes) >= max(1, len(lics)):
        sub = set().union(*(children[cat + (s,)] for s in sizes))
        return "size+lic" if any(is_lic(k) for k in sub) else "size"
    return "lic" if lics else "flat"

def match(want, options):
    n = norm(want)
    ex = [o for o in options if norm(o) == n]
    if ex: return ex[0], "exact"
    m = re.fullmatch(r"([\d.]+)x([\d.]+)", n)
    if m:
        sw = [o for o in options if norm(o) == f"{m[2]}x{m[1]}"]
        return (sw[0], "fuzzy (dimensions swapped)") if sw else (None, None)
    co = [o for o in options if len(norm(o)) >= 3 and (norm(o) in n or n in norm(o))]
    if len(co) == 1: return co[0], "fuzzy (contains)"
    by = {norm(o): o for o in options}
    cl = difflib.get_close_matches(n, by, 1, 0.75)
    return (by[cl[0]], "fuzzy (similar spelling)") if cl else (None, None)

def pick(wants, options):
    hits = {match(w, options) for w in wants} - {(None, None)}
    names = {h[0] for h in hits}
    if len(names) == 1: return hits.pop(), None
    return (None, None), (" ; ".join(sorted(names)) if names else None)

# --- license status ------------------------------------------------------------
skus = json.load(open(f"{W}/skus.json"))["values"]
stats = json.load(open(f"{W}/status.json"))["values"]
status = defaultdict(set)
for i, s in enumerate(skus):
    if s and s[0].strip():
        status[s[0].strip().upper()].add((stats[i][0].strip() if i < len(stats) and stats[i] else "") or "(blank)")

# --- sources --------------------------------------------------------------------
rows = [l.rstrip("\n").split("\t")[1] for l in open(f"{W}/dirs.tsv")]
def filed(p):
    """Already sits at Concept Approved Designs/Dept/Category/[size]/[licensor]/ITEM."""
    parts = p.split("/")[1:]
    if parts[0] != CAD or len(parts) < 4 or (parts[1], parts[2]) not in children: return False
    return all(is_size(x) or is_lic(x) for x in parts[3:-1])
itemset = set(rows)
def nested(p):
    parts = p.split("/")
    return any("/".join(parts[:k]) in itemset for k in range(2, len(parts)))
filed_items = {}
for r in rows:
    if filed(r): filed_items.setdefault(ITEM.match(r.split("/")[-1]).group(0).upper()
                                        if ITEM.match(r.split("/")[-1]) else r, r)

out = []
for src in sorted(rows):
    if filed(src) or nested(src): continue
    name = src.split("/")[-1]
    m = ITEM.match(name)
    item = m.group(0).upper() if m else name
    rec = dict(item_number=item, source_folder=winpath(src), area=src.split("/")[1],
               license_status="", department="", category_folder="", size_code="",
               size_from_MG04="", size_folder="", licensor_code="", licensor_from_MG05="",
               licensor_folder="", destination_folder="", decision="", notes="")
    notes = []
    if not m:
        rec.update(decision="SKIP", notes="folder name is not a standard item number"); out.append(rec); continue
    pre, size, lic = m[1].upper(), m[2].upper(), m[3].upper()
    rec.update(size_code=size, licensor_code=lic)
    st = status.get(item) or status.get(name.upper())
    rec["license_status"] = " | ".join(sorted(st)) if st else "(not in sheet)"
    sizes = sorted(mg.get(("04", size), []))
    lics = sorted(mg.get(("05", lic), []))
    rec["size_from_MG04"] = " | ".join(sizes) or "(code not in MG04)"
    rec["licensor_from_MG05"] = " | ".join(lics) or "(code not in MG05)"

    cands = cat_by_code.get(pre + size) or cat_by_code.get(pre, [])
    cat = cands[0] if len(cands) == 1 else None
    if len(cands) > 1: notes.append("prefix appears in several category folders: " + " ; ".join("/".join(c) for c in cands))
    elif not cands: notes.append(f"no category folder carries prefix {pre}")
    dest = None
    if cat:
        cat = descend(cat, pre, size)
        rec["department"], rec["category_folder"] = cat[0], "/".join(cat[1:])
        lay = layout(cat); here = cat; parts = []
        if lay.startswith("size"):
            (sf, how), amb = pick(sizes, [k for k in children[cat] if is_size(k)])
            if amb: notes.append("several size folders match: " + amb)
            elif sf:
                if how != "exact": notes.append(f"size matched {how}")
            elif sizes:
                sf = re.sub(r'\s+|["”]', "", sizes[0]).lower(); notes.append("size folder would be created")
            rec["size_folder"] = sf or ""
            if sf: parts.append(sf); here = cat + (sf,)
        if lay in ("size+lic", "lic") and (parts or lay == "lic"):
            local = [k for k in children[here] if is_lic(k)]
            pool = local or sorted({k for s in children[cat] for k in (children[cat + (s,)] if is_size(s) else [s]) if is_lic(k)})
            (lf, how), amb = pick(lics, pool)
            if amb: notes.append("several licensor folders match: " + amb)
            elif lf:
                if how != "exact": notes.append(f"licensor matched {how}")
                if lf not in children[here]: notes.append("licensor folder would be created under this size")
            elif lics:
                lf = lics[0].title(); notes.append("no licensor folder name matches - would create one; check spelling")
            rec["licensor_folder"] = lf or ""
            if lf: parts.append(lf)
        need = {"size+lic": 2, "size": 1, "lic": 1, "flat": 0}[lay]
        if lay == "flat":
            groups = [k for k in children[cat] if not ITEM.match(k) and not k.startswith(("_", "@"))]
            if groups: notes.append("category has sub-groups that the item number cannot pick between: " + " ; ".join(sorted(groups)[:6]))
        if len(parts) == need:
            dest = "./" + "/".join((CAD,) + cat + tuple(parts))
            rec["destination_folder"] = winpath(dest)
            if item in filed_items:
                notes.append("this item number is already filed at: " + winpath(filed_items[item]))
    ok = bool(st) and st <= MOVE_STATUSES
    txt = " ".join(notes)
    if not cands:
        rec["decision"] = "LEAVE - no matching category"
    elif not dest:
        rec["decision"] = "REVIEW - destination unresolved"
    elif not ok:
        rec["decision"] = "DO NOT MOVE - status"
    elif any(k in txt for k in ("already filed", "would create one", "several", "sub-groups", "size folder would be created")):
        rec["decision"] = "REVIEW"
    else:
        rec["decision"] = "MOVE"
    rec["notes"] = "; ".join(notes)
    out.append(rec)

with open(f"{W}/proposed_moves.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
print(Counter(r["decision"] for r in out))
print(Counter(r["department"] for r in out if r["decision"] == "MOVE"))
