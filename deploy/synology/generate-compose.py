#!/usr/bin/env python3
"""Generate the per-NAS compose files from one base plus pure-data fragments.

Spec: docs/nas-config-drift.md section 8. Dumb string splicing, no conditionals.
CI re-runs this and fails if the committed outputs differ (git diff --exit-code).
"""
import pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
BOXES = {"nas-1": "edgesynology1", "nas-2": "edgesynology2"}
LINE = re.compile(r"^\{\{([A-Z_]+)\}\}$")
INLINE = re.compile(r"\{\{([A-Z_]+)\}\}")


def fragment(path: pathlib.Path) -> dict:
    data, key = {}, None
    for line in path.read_text().splitlines():
        if line.startswith("## "):
            key = line[3:].strip(); data[key] = []
        elif key is not None:
            data[key].append(line)
        elif line and not line.startswith("#"):
            sys.exit(f"{path}: text before the first ## KEY")
    return data


def render(base: str, data: dict, box: str) -> str:
    out = [f"# GENERATED for {BOXES[box]} — DO NOT EDIT. Change deploy/synology/compose/base.yml",
           f"# or compose/{box}.fragment, then run: python3 deploy/synology/generate-compose.py"]
    used = set()
    lines = base.splitlines()
    while lines and lines[0].startswith("#"):  # base's own header is not copied
        lines.pop(0)
    for line in lines:
        m = LINE.match(line)
        if m:
            used.add(m.group(1)); out.extend(data[m.group(1)]); continue
        def sub(mm):
            used.add(mm.group(1)); vals = data[mm.group(1)]
            if len(vals) != 1: sys.exit(f"{box}: inline key {mm.group(1)} must be one line")
            return vals[0]
        out.append(INLINE.sub(sub, line))
    extra = set(data) - used
    if extra: sys.exit(f"{box}: unused fragment keys {sorted(extra)}")
    return "\n".join(out) + "\n"


def main() -> None:
    base = (HERE / "compose" / "base.yml").read_text()
    for box in BOXES:
        text = render(base, fragment(HERE / "compose" / f"{box}.fragment"), box)
        (HERE / f"docker-compose.{box}.yml").write_text(text)


if __name__ == "__main__":
    main()
