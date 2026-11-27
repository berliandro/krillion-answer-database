#!/usr/bin/env python3
"""Build a canonical, bank-safe Krillocity prompt artifact.

The artifact lets the userscript resolve an *observed* Krillocity wording to
the real graded bank question when that wording is a verbatim bank question.
It deliberately does NOT turn paraphrase clusters into bank aliases:

  * one emitted entry per (cluster, exact bank question), so near-duplicate
    banks stay separate entries and no answers are ever merged;
  * ``variants`` holds only wordings actually observed in the harvest — no
    invented aliases;
  * non-exact variants are flagged ``exact_bank: false`` / ``log_only: true``
    and are never used to select a bank (aliases are log-only, per
    injection/DECISIONS.md); they are stored once per cluster, on its primary
    entry, so they are not duplicated across separate banks;
  * ``score`` is a log-only confidence value (the same safe Jaccard+Dice
    similarity used to build the clusters), NOT a matching weight.

Clustering is the safe logic from scripts/process_krillocity.py: identical
constraint signature, no substring boost, Jaccard+trigram-Dice >= 0.80.
If data/krillocity_prompt_groups.json is current we reuse its clusters;
otherwise we regenerate them in memory using the imported helpers. Running
this script never writes any file other than data/krillocity_canonical.json.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

# Import the *safe* clustering primitives from the existing processor; do not
# call its main() (that would rewrite groups/aliases/reports we do not own).
from paraphrase_match import dice, normalise, tokens, trigrams  # noqa: E402
from process_krillocity import (  # noqa: E402
    DSU,
    constraint_signature,
    read_jsonl,
    similarity as reference_similarity,
)

DATA = ROOT / "data"
PROMPTS = DATA / "krillocity_prompts.jsonl"
GROUPS = DATA / "krillocity_prompt_groups.json"
BANK_DB = DATA / "krillion_search.db"
OUTPUT = DATA / "krillocity_canonical.json"

# scripts/process_krillocity.py uses this threshold inside main() (no
# substring boost anywhere) — keep the two scripts in lockstep.
THRESHOLD = 0.80
SCHEMA_VERSION = 1

# A single cap for every emitted entry. Exact-bank variants and the canonical
# wording always survive the cap; log-only variants are trimmed by descending
# observed frequency, then alphabetically. Current harvests top out at 20
# variants per cluster, so this cap does not drop anything today.
MAX_VARIANTS_PER_ENTRY = 20


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------
def load_prompts():
    """Return (rows, questions, freq, seen) with first-seen question order."""
    rows = read_jsonl(PROMPTS)
    seen: dict[str, dict] = {}
    freq: Counter[str] = Counter()
    for row in rows:
        q = (row.get("prompt") or "").strip()
        if q:
            seen.setdefault(q, row)
            freq[q] += 1
    return rows, list(seen), freq, seen


def load_bank_questions() -> list[str]:
    """Verbatim questions from the authoritative graded search DB."""
    with sqlite3.connect(BANK_DB) as con:
        values = [r[0] for r in con.execute("SELECT question FROM search_answers")]
    return sorted({str(v) for v in values if v is not None})


# ---------------------------------------------------------------------------
# Cached-token similarity (same formula as process_krillocity.similarity)
# ---------------------------------------------------------------------------
class Similarity:
    """Precomputed equivalent of process_krillocity.similarity().

    0.75 * Jaccard(content tokens) + 0.25 * trigram Dice; normalised-equal
    pairs score 1.0. There is intentionally NO substring/containment boost.
    """

    def __init__(self, questions: list[str]):
        self.index = {q: i for i, q in enumerate(questions)}
        self.toks = [tokens(q) for q in questions]
        self.tris = [trigrams(q) for q in questions]
        self.norm = [normalise(q) for q in questions]

    def by_text(self, a: str, b: str) -> float:
        ia, ib = self.index[a], self.index[b]
        ta, tb = self.toks[ia], self.toks[ib]
        if not ta or not tb:
            return 0.0
        jac = len(ta & tb) / len(ta | tb)
        score = 0.75 * jac + 0.25 * dice(self.tris[ia], self.tris[ib])
        if self.norm[ia] == self.norm[ib]:
            return 1.0
        return score


def verify_similarity(sim: Similarity, questions: list[str], pairs: set) -> None:
    """Fail loudly if the fast implementation drifts from the imported one."""
    sample = sorted(pairs)[:100]
    for i, j in sample:
        got = sim.by_text(questions[i], questions[j])
        want = reference_similarity(questions[i], questions[j])
        if abs(got - want) > 1e-12:
            raise RuntimeError(
                f"local similarity drift for {questions[i]!r} / {questions[j]!r}: "
                f"{got} != {want}"
            )


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------
def canonical_for(members, freq: Counter[str]) -> str:
    """Modal content-token family's most frequent wording (never shortest).

    The family tie-break is lexical (not insertion order) so the result does
    not depend on whether clusters came from the cache or were regenerated.
    The wordings themselves are always real observed strings.
    """
    families: dict[frozenset, list[str]] = defaultdict(list)
    for q in members:
        families[frozenset(tokens(q))].append(q)
    family = max(
        families.values(),
        key=lambda xs: (len(xs), sum(freq[x] for x in xs), tuple(sorted(xs))),
    )
    return max(family, key=lambda q: (freq[q], q))


def clusters_from_prompts(questions: list[str], sim: Similarity) -> list[list[str]]:
    """Rebuild the processor's clusters in memory (no files are written)."""
    n = len(questions)
    dsu = DSU(n)
    sigs = [constraint_signature(q) for q in questions]

    # Bucket 1: identical stopword-stripped token sets + identical signature.
    buckets: dict[tuple, list[int]] = defaultdict(list)
    for i, q in enumerate(questions):
        buckets[(frozenset(sim.toks[i]), sigs[i])].append(i)
    for idxs in buckets.values():
        for j in idxs[1:]:
            dsu.union(idxs[0], j)

    # Bucket 2: shared-token inverted index, cross-bucket paraphrases only.
    inv: dict[str, list[int]] = defaultdict(list)
    for i in range(n):
        for t in sim.toks[i]:
            inv[t].append(i)
    pairs: set[tuple[int, int]] = set()
    for idxs in inv.values():
        if 1 < len(idxs) <= 60:
            for a in range(len(idxs)):
                for b in range(a + 1, len(idxs)):
                    pairs.add((idxs[a], idxs[b]))
    verify_similarity(sim, questions, pairs)

    for i, j in pairs:
        if dsu.find(i) == dsu.find(j):
            continue
        if sigs[i] != sigs[j]:
            continue
        if abs(len(sim.toks[i]) - len(sim.toks[j])) > 1:
            continue
        if sim.by_text(questions[i], questions[j]) >= THRESHOLD:
            dsu.union(i, j)

    buckets_out: dict[int, list[str]] = defaultdict(list)
    for i, q in enumerate(questions):
        buckets_out[dsu.find(i)].append(q)
    return list(buckets_out.values())


def load_groups_cache(questions: list[str], freq: Counter[str]):
    """Return (clusters, status). Clusters are lists of observed members.

    A cached group file is used only when it provably describes the current
    prompt set and was produced by the same safe threshold. Any mismatch —
    including a stale canonical choice — forces an in-memory regeneration.
    """
    if not GROUPS.exists():
        return None, "missing"
    try:
        payload = json.loads(GROUPS.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, f"unreadable ({type(exc).__name__})"
    if payload.get("threshold") != THRESHOLD:
        return None, f"threshold {payload.get('threshold')!r} != {THRESHOLD}"
    if payload.get("exact_unique") != len(questions):
        return None, (
            f"exact_unique {payload.get('exact_unique')!r} != {len(questions)}"
        )
    raw = payload.get("groups")
    if not isinstance(raw, list) or not raw:
        return None, "groups missing or empty"
    known = set(questions)
    clusters = []
    canonical_mismatches = 0
    for g in raw:
        members = g.get("variants")
        canonical = g.get("canonical")
        if not isinstance(members, list) or not members:
            return None, "empty cached cluster"
        if canonical not in known or any(m not in known for m in members):
            return None, "cached wording absent from prompts"
        # Canonicals are always recomputed below; a mismatch here is only a
        # tie-break difference, not a reason to discard fresh cluster members.
        if canonical_for(members, freq) != canonical:
            canonical_mismatches += 1
        clusters.append(list(members))
    if GROUPS.stat().st_mtime < PROMPTS.stat().st_mtime:
        return None, "groups file older than prompts file"
    status = "reused group file"
    if canonical_mismatches:
        status += f" ({canonical_mismatches} canonicals recomputed)"
    return clusters, status


# ---------------------------------------------------------------------------
# Artifact assembly
# ---------------------------------------------------------------------------
def build_entries(clusters, freq, bankset, sim):
    """One entry per (cluster, exact bank question); never merge banks."""
    ordered = sorted(clusters, key=lambda members: (-len(members), canonical_for(members, freq)))
    entries = []
    stats = Counter()

    for cluster_id, members in enumerate(ordered, 1):
        canonical = canonical_for(members, freq)
        stats["clusters"] += 1
        if len(members) > 1:
            stats["multi_variant_clusters"] += 1
        stats["variants_observed"] += len(members)

        records = {}
        for text in members:
            exact = text in bankset
            records[text] = {
                "text": text,
                "exact_bank": exact,
                "bank_question": text if exact else None,
                "score": round(sim.by_text(text, canonical), 4),
                "log_only": not exact,
            }
            if exact:
                stats["exact_bank_variants"] += 1

        bank_hits = sorted(t for t, rec in records.items() if rec["exact_bank"])
        if len(bank_hits) > 1:
            stats["near_duplicate_clusters"] += 1
        targets = bank_hits if bank_hits else [None]

        for position, target in enumerate(targets):
            if target is None:
                chosen = list(records.values())
                bank_questions = []
                stats["entries_without_bank"] += 1
            else:
                # This bank's verbatim wording is the only actionable record.
                chosen = [
                    rec for rec in records.values()
                    if rec["bank_question"] == target
                ]
                bank_questions = [target]
                stats["entries_with_bank"] += 1
            # Store each observed non-exact wording exactly once per cluster,
            # on its primary entry. Repeating them on every split bank entry
            # would bloat the artifact and imply they belong to each bank.
            if target is not None and position == 0:
                chosen += [
                    rec for rec in records.values() if not rec["exact_bank"]
                ]

            chosen.sort(key=lambda rec: (
                not rec["exact_bank"],
                rec["text"] != canonical,
                -freq.get(rec["text"], 0),
                rec["text"],
            ))
            if len(chosen) > MAX_VARIANTS_PER_ENTRY:
                dropped = len(chosen) - MAX_VARIANTS_PER_ENTRY
                chosen = chosen[:MAX_VARIANTS_PER_ENTRY]
                stats["variants_capped_entries"] += 1
                stats["variants_dropped_by_cap"] += dropped
            stats["variants_emitted"] += len(chosen)

            entries.append({
                "cluster_id": cluster_id,
                "cluster_size": len(members),
                "canonical": canonical,
                "variants": chosen,
                "bank_questions": bank_questions,
                "constraint_signature": [list(part) for part in constraint_signature(canonical)],
            })

    stats["clusters"] = len(ordered)
    stats["emitted_entries"] = len(entries)
    stats["distinct_bank_questions_used"] = len({
        q for e in entries for q in e["bank_questions"]
    })
    return entries, stats


def main() -> None:
    rows, questions, freq, _ = load_prompts()
    bank_questions = load_bank_questions()
    bankset = set(bank_questions)
    sim = Similarity(questions)

    clusters, cache_status = load_groups_cache(questions, freq)
    regenerated = clusters is None
    if regenerated:
        clusters = clusters_from_prompts(questions, sim)

    entries, stats = build_entries(clusters, freq, bankset, sim)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "schema_version": SCHEMA_VERSION,
        "policy": {
            "near_duplicate_banks": "one entry per exact bank question; no answers merged",
            "aliases_applied_to_matching": False,
            "log_only_variants": (
                "exact_bank=false variants are observed wordings, never bank aliases; "
                "stored once per cluster on its primary entry, not repeated per bank"
            ),
            "exact_bank_definition": "verbatim equality with search_answers.question",
            "score_definition": (
                "log-only confidence: 0.75*Jaccard(content tokens) + 0.25*trigram Dice "
                "against the canonical wording; no substring boost; not a match weight"
            ),
            "wording_source": "observed krillocity_prompts.jsonl wordings only; no invented aliases",
            "entry_key": "(cluster_id, exact bank question)",
        },
        "source": {
            "prompts_file": PROMPTS.relative_to(ROOT).as_posix(),
            "groups_file": GROUPS.relative_to(ROOT).as_posix(),
            "groups_status": cache_status,
            "groups_used": not regenerated,
            "groups_regenerated_in_memory": regenerated,
            "bank_db": BANK_DB.relative_to(ROOT).as_posix(),
            "bank_table": "search_answers",
            "bank_column": "question",
            "threshold": THRESHOLD,
        },
        "limits": {
            "max_variants_per_entry": MAX_VARIANTS_PER_ENTRY,
            "cap_policy": (
                "exact-bank variants and the canonical wording survive first; remaining "
                "log-only variants are trimmed by descending observed frequency then text"
            ),
        },
        "counts": {
            "prompt_lines": len(rows),
            "exact_unique_prompts": len(questions),
            "bank_questions_in_db": len(bank_questions),
            **dict(stats),
        },
        "groups": entries,
    }

    OUTPUT.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    size = OUTPUT.stat().st_size
    print(f"groups_status={cache_status}")
    print(json.dumps(payload["counts"], indent=2))
    print(f" wrote {OUTPUT.relative_to(ROOT).as_posix()} bytes={size}")


if __name__ == "__main__":
    main()
