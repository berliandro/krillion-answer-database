#!/usr/bin/env python3
"""Evaluate the live matcher against real harvested paraphrase pairs.

For each cluster in data/krillocity_prompt_groups.json, every non-canonical
wording is used as a user query; success means the cluster canonical is returned
at rank 1 (or within the top 5). Writes data/paraphrase_eval.json.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from paraphrase_match import Matcher  # noqa: E402

GROUPS = ROOT / "data" / "krillocity_prompt_groups.json"
OUT = ROOT / "data" / "paraphrase_eval.json"


def main():
    g = json.loads(GROUPS.read_text(encoding="utf-8"))
    groups = [x for x in g["groups"] if x["count"] > 1]
    matcher = Matcher([x["canonical"] for x in groups])
    stats = Counter()
    misses = []
    for grp in groups:
        for variant in grp["variants"]:
            if variant == grp["canonical"]:
                continue
            res = matcher.search(variant, limit=5, threshold=0.20)
            ids = [r.get("question") for r in res if isinstance(r, dict)]
            stats["total"] += 1
            if grp["canonical"] in ids[:1]:
                stats["rank1"] += 1
            elif grp["canonical"] in ids[:5]:
                stats["rank2to5"] += 1
            else:
                stats["miss"] += 1
                misses.append({
                    "variant": variant,
                    "expected": grp["canonical"],
                    "got": ids[:3],
                    "top_score": res[0].get("score") if res else None,
                })
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "clusters": len(groups),
        "stats": dict(stats),
        "rank1_rate": round(stats["rank1"] / max(1, stats["total"]), 4),
        "miss_rate": round(stats["miss"] / max(1, stats["total"]), 4),
        "misses": misses,
        "note": "A 'miss' can also be a false-merge cluster where the canonical is a genuinely different prompt.",
    }
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("clusters", "stats", "rank1_rate", "miss_rate")}, indent=2))
    for m in misses[:15]:
        print("MISS:", m["variant"], "=>", m["expected"], "| got:", m["got"])


if __name__ == "__main__":
    main()
