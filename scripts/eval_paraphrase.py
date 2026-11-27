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
from paraphrase_match import Matcher, tokens  # noqa: E402

GROUPS = ROOT / "data" / "krillocity_prompt_groups.json"
INDEX = ROOT / "data" / "matcher_index.json"
OUT = ROOT / "data" / "paraphrase_eval.json"


def main():
    g = json.loads(GROUPS.read_text(encoding="utf-8"))
    groups = [x for x in g["groups"] if x["count"] > 1]
    canon_matcher = Matcher([x["canonical"] for x in groups])
    live_matcher = Matcher.from_index(INDEX) if INDEX.exists() else None
    stats, live = Counter(), Counter()
    misses, live_misses = [], []
    for grp in groups:
        for variant in grp["variants"]:
            if variant == grp["canonical"]:
                continue
            stats["total"] += 1
            res = canon_matcher.search(variant, limit=5, threshold=0.20)
            ids = [r.get("question") for r in res if isinstance(r, dict)]
            if grp["canonical"] in ids[:1]:
                stats["rank1"] += 1
            elif grp["canonical"] in ids[:5]:
                stats["rank2to5"] += 1
            else:
                stats["miss"] += 1
                misses.append({"variant": variant, "expected": grp["canonical"], "got": ids[:3]})
            if live_matcher is None:
                continue
            live["total"] += 1
            lr = live_matcher.search(variant, limit=1, threshold=0.34)
            top = lr[0].get("question") if lr else None
            # Success against the real bank: the top hit has the same content
            # token set as the on-screen wording (constraint banks stay separate).
            if top and frozenset(tokens(top)) == frozenset(tokens(variant)):
                live["rank1"] += 1
            else:
                live["miss"] += 1
                if len(live_misses) < 30:
                    live_misses.append({"variant": variant, "expected": grp["canonical"], "got": top})
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "clusters": len(groups),
        "canonical_only": {
            "stats": dict(stats),
            "rank1_rate": round(stats["rank1"] / max(1, stats["total"]), 4),
            "note": "canonical-only proxy; false-merge clusters can make this look worse than the live path",
        },
        "live_bank": {
            "stats": dict(live),
            "rank1_rate": round(live["rank1"] / max(1, live["total"]), 4),
            "misses": live_misses,
            "note": "top hit from the real 5,810-bank index must share the variant's content token set",
        },
    }
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"clusters": len(groups), "canonical_only": report["canonical_only"]["stats"],
                      "live_bank": report["live_bank"]["stats"],
                      "live_rank1_rate": report["live_bank"]["rank1_rate"]}, indent=2))
    for m in misses[:15]:
        print("MISS:", m["variant"], "=>", m["expected"], "| got:", m["got"])


if __name__ == "__main__":
    main()
