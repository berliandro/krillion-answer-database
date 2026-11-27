#!/usr/bin/env python3
"""Process the harvested Krillocity prompts and the diagnostic logs.

Policy (injection/DECISIONS.md / PROCESS-LOG.md):
  * Never merge near-duplicate banks. Variants are GROUPED for reporting and
    written to injection/data/aliases.jsonl as log-only aliases — they are NOT
    applied to matching.
  * Other-player answers stay in data/krillocity_answers.jsonl and are never
    imported into the graded archive.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from paraphrase_match import dice, normalise, tokens, trigrams  # noqa: E402

DATA = ROOT / "data"
INJDATA = ROOT / "injection" / "data"
PROMPTS = DATA / "krillocity_prompts.jsonl"
ANSWERS = DATA / "krillocity_answers.jsonl"
ALIASES = INJDATA / "aliases.jsonl"
GROUPS = DATA / "krillocity_prompt_groups.json"
REPORT = DATA / "krillocity_process_report.json"

LOGS = {
    "evidence": INJDATA / "evidence.jsonl",
    "prompt_review": INJDATA / "prompt_review.jsonl",
    "bot_log": INJDATA / "bot_log.jsonl",
    "failed_prompts": INJDATA / "failed_prompts.jsonl",
    "corrections": INJDATA / "corrections.jsonl",
    "learned": INJDATA / "learned.jsonl",
    "krillocity_answers": ANSWERS,
}


def read_jsonl(path: Path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def constraint_signature(q: str) -> tuple:
    """Restrictive markers that MUST match before two wordings may cluster.

    A short generic prompt is often a literal substring of a constrained one
    ("Name any fruit" vs "Name a fruit starting with P"). Treating containment
    as paraphrase merged 63 distinct prompt families in the first harvest.
    """
    n = normalise(q)
    sig = []
    # letter constraints
    m = re.search(r"\b(?:start(?:s|ing)?|begin(?:s|ning)?)\s+with\s+([a-z0-9]+)", n)
    if m:
        sig.append(("start", m.group(1)))
    m = re.search(r"\bend(?:s|ing)?\s+with\s+([a-z0-9]+)", n)
    if m:
        sig.append(("end", m.group(1)))
    # quoted terms are hard constraints
    sig.extend(("quote", x) for x in re.findall(r'"([^"]+)"', n))
    # origin / material / use / attribute markers
    for marker in ("from", "made of", "used in", "with", "without", "has", "or"):
        if re.search(r"\b" + re.escape(marker) + r"\b", n):
            sig.append((marker,))
    # negation and numbers
    if set(tokens(q)) & {"not", "no", "never", "without", "non"}:
        sig.append(("neg",))
    sig.extend(("num", x) for x in re.findall(r"\d+", n))
    return tuple(sorted(sig))


def similarity(a: str, b: str) -> float:
    """Jaccard + trigram Dice. NO substring boost: the audit found all 63
    substring bridges were false merges between a generic bank and a
    constrained one, and lost zero true rewordings when removed."""
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    jac = len(ta & tb) / len(ta | tb)
    tri = dice(trigrams(a), trigrams(b))
    score = 0.75 * jac + 0.25 * tri
    if normalise(a) == normalise(b):
        return 1.0
    return score


class DSU:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def main():
    rows = read_jsonl(PROMPTS)
    seen = {}
    freq = Counter()
    for r in rows:
        q = (r.get("prompt") or "").strip()
        if q:
            seen.setdefault(q, r)
            freq[q] += 1
    questions = list(seen)
    n = len(questions)
    print(f"harvest prompt lines={len(rows)} exact-unique={n}")

    dsu = DSU(n)
    sigs = [constraint_signature(q) for q in questions]
    # Bucket 1: identical token sets (stopword-stripped) — catches most
    # "Name any one X" / "Name one X" / "What's an example of X" variants.
    # A constraint signature guard keeps distinct qualifiers apart.
    buckets = defaultdict(list)
    for i, q in enumerate(questions):
        buckets[(frozenset(tokens(q)), sigs[i])].append(i)
    for idxs in buckets.values():
        for j in idxs[1:]:
            dsu.union(idxs[0], j)

    # Bucket 2: shared-token inverted index for cross-bucket paraphrases.
    inv = defaultdict(list)
    for i, q in enumerate(questions):
        for t in tokens(q):
            inv[t].append(i)
    pairs = set()
    for idxs in inv.values():
        if 1 < len(idxs) <= 60:
            for a in range(len(idxs)):
                for b in range(a + 1, len(idxs)):
                    pairs.add((idxs[a], idxs[b]))
    print(f"candidate pairs={len(pairs)}")

    THRESHOLD = 0.80
    for i, j in pairs:
        if dsu.find(i) == dsu.find(j):
            continue
        if sigs[i] != sigs[j]:
            continue
        if abs(len(tokens(questions[i])) - len(tokens(questions[j]))) > 1:
            continue
        if similarity(questions[i], questions[j]) >= THRESHOLD:
            dsu.union(i, j)

    clusters = defaultdict(list)
    for i, q in enumerate(questions):
        clusters[dsu.find(i)].append(q)

    # Canonical: the modal content-token family's most frequent wording, NOT
    # the shortest string (which was usually a qualifier-free generic bank).
    grouped = []
    for root, members in clusters.items():
        families = defaultdict(list)
        for q in members:
            families[frozenset(tokens(q))].append(q)
        family = max(families.values(), key=lambda xs: (len(xs), sum(freq[x] for x in xs)))
        canonical = max(family, key=lambda q: (freq[q], q))
        grouped.append({
            "canonical": canonical,
            "variants": sorted(members, key=lambda s: (s != canonical, s)),
            "count": len(members),
            "sources": sorted({seen[q].get("source", "") for q in members}),
            "races": sorted({seen[q].get("race") for q in members if seen[q].get("race") is not None}),
        })
    grouped.sort(key=lambda g: (-g["count"], g["canonical"]))
    multi = [g for g in grouped if g["count"] > 1]
    print(f"paraphrase clusters={len(grouped)} multi-variant={len(multi)} "
          f"variants-collapsed={sum(g['count'] - 1 for g in multi)}")

    GROUPS.write_text(json.dumps({
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "threshold": THRESHOLD,
        "exact_unique": n,
        "clusters": len(grouped),
        "multi_variant_clusters": len(multi),
        "variants_collapsed": sum(g["count"] - 1 for g in multi),
        "groups": grouped,
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    # Aliases are LOG ONLY — never applied to matching (PROCESS-LOG.md step 2).
    # This file is generated solely by this script; rewrite it so false aliases
    # from the earlier substring-boost clustering cannot linger.
    before = ALIASES.stat().st_size if ALIASES.exists() else 0
    with ALIASES.open("w", encoding="utf-8") as f:
        for g in multi:
            for v in g["variants"]:
                if v == g["canonical"]:
                    continue
                f.write(json.dumps({
                    "kind": "krillocity-paraphrase",
                    "canonical": g["canonical"],
                    "variant": v,
                    "applied_to_matching": False,
                    "source": "harvest",
                }, ensure_ascii=False) + "\n")
    print(f"aliases appended bytes={ALIASES.stat().st_size - before}")

    # Log review (PROCESS-LOG.md step 1).
    log_summary = {}
    for name, path in LOGS.items():
        rows_ = read_jsonl(path)
        d = {"lines": len(rows_)}
        if name == "prompt_review":
            d["kinds"] = dict(Counter(r.get("kind", "") for r in rows_))
            d["zero_match"] = sum(1 for r in rows_ if r.get("kind") == "no-match")
        if name == "evidence":
            d["outcomes"] = dict(Counter(r.get("outcome", "") for r in rows_))
            d["modes"] = dict(Counter(r.get("mode", "") for r in rows_))
            d["below_100"] = sum(1 for r in rows_ if isinstance(r.get("points"), (int, float)) and 0 < r["points"] < 100)
        if name == "bot_log":
            d["events"] = dict(Counter(r.get("event", "") for r in rows_).most_common(12))
        if name == "krillocity_answers":
            d["matched"] = sum(1 for r in rows_ if r.get("match") is True)
            d["zero_match"] = sum(1 for r in rows_ if r.get("zero_match") is True)
            d["unique_answers"] = len({(r.get("prompt"), r.get("answer")) for r in rows_})
        log_summary[name] = d
    REPORT.write_text(json.dumps({
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "prompt_dedupe": {
            "lines": len(rows), "exact_unique": n, "clusters": len(grouped),
            "multi_variant_clusters": len(multi),
            "variants_collapsed": sum(g["count"] - 1 for g in multi),
        },
        "logs": log_summary,
        "policy": "aliases logged only; banks never merged; other-player answers never imported",
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(log_summary, indent=2))


if __name__ == "__main__":
    main()
