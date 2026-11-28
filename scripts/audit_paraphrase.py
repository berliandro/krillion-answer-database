#!/usr/bin/env python3
"""Read-only paraphrase-duplicate audit for the "process the log" workflow.

Classifies candidate prompt/answer pairs into TRIVIAL, PARAPHRASE and
ANSWER-VARIANT using the same normalisation as scripts/paraphrase_match.py
(NFKC + casefold + diacritic strip before pm.normalise), applies the graded-bank
evidence gate, reports tier disagreements, and writes injection/PROCESS-REPORT.md.

This script NEVER writes raw JSONL and NEVER demotes anything.
"""
from __future__ import annotations

import collections
import json
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import paraphrase_match as pm  # noqa: E402

FULL = ROOT / "data" / "krillion_full.db"
ALIASES = ROOT / "injection" / "data" / "aliases.jsonl"
LEARNED = ROOT / "injection" / "data" / "learned.jsonl"
REPORT = ROOT / "injection" / "PROCESS-REPORT.md"


def norm(text: str) -> str:
    t = unicodedata.normalize("NFKC", str(text or "")).casefold()
    t = "".join(c for c in unicodedata.normalize("NFKD", t)
                if not unicodedata.combining(c))
    return pm.normalise(t)


def read_jsonl(path: Path) -> list[dict]:
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


def title(s: str, n: int = 140) -> str:
    s = str(s or "").replace("|", "\\|")
    return s if len(s) <= n else s[: n - 3] + "..."


def main() -> None:
    con = sqlite3.connect(f"file:{FULL}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT question, answer, is_krillion FROM answers"
    ).fetchall()
    con.close()
    questions = {q for q, _, _ in rows}
    by_question = collections.defaultdict(list)
    for q, a, k in rows:
        by_question[q].append((a, k))

    learned = read_jsonl(LEARNED)
    graded = {str(r.get("question", "")).strip() for r in learned
              if str(r.get("source", "")).strip() in ("api", "own")}
    graded.discard("")

    # ---- TRIVIAL prompt pairs (different stored strings, same normalised key)
    qgroups = collections.defaultdict(set)
    for q in questions:
        qgroups[norm(q)].add(q)
    trivial_prompt_pairs = []
    for key, variants in qgroups.items():
        variants = sorted(variants)
        if len(variants) > 1:
            base = variants[0]
            for other in variants[1:]:
                trivial_prompt_pairs.append((key, base, other,
                                             base in graded and other in graded))

    # ---- ANSWER-VARIANT pairs (same question, answers equal after normalisation)
    answer_variant_pairs = []
    for q, answers in by_question.items():
        agroups = collections.defaultdict(set)
        for a, _ in answers:
            agroups[norm(a)].add(a)
        for key, variants in agroups.items():
            variants = sorted(variants)
            if len(variants) > 1:
                base = variants[0]
                for other in variants[1:]:
                    answer_variant_pairs.append((q, key, base, other))

    # ---- PARAPHRASE pairs from log-only aliases, with evidence gate
    aliases = read_jsonl(ALIASES)
    matcher_questions = sorted(questions | graded)
    matcher = pm.Matcher(matcher_questions)
    paraphrase_pairs = []
    alias_trivial = []
    negation_traps = 0
    for rec in aliases:
        canon = str(rec.get("canonical", "")).strip()
        variant = str(rec.get("variant", "")).strip()
        if not canon or not variant or norm(canon) == norm(variant):
            alias_trivial.append((canon, variant))
            continue
        ca, va = pm.tokens(canon), pm.tokens(variant)
        if not ca or not va:
            continue
        jac = len(ca & va) / len(ca | va)
        tri = pm.dice(pm.trigrams(canon), pm.trigrams(variant))
        score = 0.75 * jac + 0.25 * tri
        if score < 0.55:
            continue
        trap = bool((ca ^ va) & pm.NEGATIONS)
        if trap:
            negation_traps += 1
        both_graded = canon in graded and variant in graded
        paraphrase_pairs.append((canon, variant, round(score, 4), both_graded, trap))

    # ---- Tier disagreement: same normalised answer under paraphrase-grouped prompts
    # Index tiers by normalised prompt once, not per pair (was quadratic).
    tiers_by_q = collections.defaultdict(set)
    for q, a, k in rows:
        tiers_by_q[norm(q)].add(int(k))
    graded_q_tiers = {q: tiers_by_q.get(norm(q), set())
                      for q in (questions | graded)}
    tier_disagreements = []
    for canon, variant, score, both_graded, trap in paraphrase_pairs:
        if not both_graded:
            continue
        for q in (canon, variant):
            if len(graded_q_tiers.get(q, set())) > 1:
                tier_disagreements.append((canon, variant, q,
                                           sorted(graded_q_tiers[q])))
                break

    # ---- Proposed paraphrase groups (graded pairs only, link/id only)
    groups = []
    for i, (canon, variant, score, both_graded, trap) in enumerate(
            [p for p in paraphrase_pairs if p[3]], start=1):
        groups.append({"group_id": f"pg-{i:04d}", "canonical": canon,
                       "variant": variant, "score": score, "negation_trap": trap})

    generated = datetime.now(timezone.utc).isoformat()
    lines = [
        "# PROCESS REPORT — paraphrase-duplicate audit",
        "",
        f"Generated: {generated}",
        "",
        "Read-only audit. No raw JSONL was rewritten, no answer demoted, no alias applied.",
        "",
        "## Counts",
        "",
        f"- Full DB rows: {len(rows)}; distinct stored prompts: {len(questions)}",
        f"- Graded-bank prompt strings (learned source api/own): {len(graded)}",
        f"- TRIVIAL prompt pairs (same normalised key, different stored wording): {len(trivial_prompt_pairs)}",
        f"  - of which both strings are game-graded: {sum(1 for p in trivial_prompt_pairs if p[3])}",
        f"- ANSWER-VARIANT pairs (same prompt, same normalised answer): {len(answer_variant_pairs)}",
        f"- PARAPHRASE pairs from aliases: {len(paraphrase_pairs)}",
        f"  - both strings game-graded: {sum(1 for p in paraphrase_pairs if p[3])}",
        f"  - negation traps flagged: {negation_traps}",
        f"- alias pairs already trivial after normalisation: {len(alias_trivial)}",
        f"- tier disagreements (100 vs <100) under paraphrase groups: {len(tier_disagreements)}",
        f"- proposed paraphrase groups (link only): {len(groups)}",
        "",
        "## TRIVIAL prompt examples (up to 20)",
        "",
    ]
    lines += [f"| key | stored A | stored B | both graded |",
              "| --- | --- | --- | --- |"]
    for key, a, b, both in trivial_prompt_pairs[:20]:
        lines.append(f"| `{title(key,60)}` | {title(a)} | {title(b)} | {both} |")
    lines += ["", "## ANSWER-VARIANT examples (up to 20)", "",
              "| prompt | normalised answer | stored A | stored B |",
              "| --- | --- | --- | --- |"]
    for q, key, a, b in answer_variant_pairs[:20]:
        lines.append(f"| {title(q,70)} | `{title(key,50)}` | {title(a,60)} | {title(b,60)} |")
    lines += ["", "## PARAPHRASE examples (up to 20)", "",
              "| canonical | variant | score | both graded | negation trap |",
              "| --- | --- | --- | --- | --- |"]
    for canon, variant, score, both, trap in paraphrase_pairs[:20]:
        lines.append(f"| {title(canon,70)} | {title(variant,70)} | {score} | {both} | {trap} |")
    lines += ["", "## Tier disagreements (report only — never demote)", ""]
    for canon, variant, na, tiers in tier_disagreements[:20]:
        lines.append(f"- `{title(canon,60)}` ↔ `{title(variant,60)}` answer `{title(na,50)}` tiers {tiers}")
    if not tier_disagreements:
        lines.append("- none found")
    lines += ["", "## Proposed paraphrase groups (graded pairs, link only)", "",
              "| group_id | canonical | variant | score | negation |",
              "| --- | --- | --- | --- | --- |"]
    for g in groups[:20]:
        lines.append(f"| {g['group_id']} | {title(g['canonical'],60)} | {title(g['variant'],60)} | {g['score']} | {g['negation_trap']} |")
    if len(groups) > 20:
        lines.append(f"| … | ({len(groups) - 20} more in the JSON artifact) | | | |")
    lines += [
        "",
        "## Decisions needed from the user (STOP)",
        "",
        "- Whether to merge PARAPHRASE banks (NOT done here — game treats them as separate banks).",
        "- Whether Search DB should hold one answer per paraphrase group (NOT done here).",
        "- Whether to apply any alias to the matcher (NOT done here; aliases stay log-only).",
        "",
        "Automatic applications allowed by the directive: TRIVIAL prompt and ANSWER-VARIANT",
        "cleanup, non-destructively in the import/derive layer, preserving original strings.",
    ]
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    artifact = ROOT / "data" / "norm_audit.json"
    artifact.write_text(json.dumps({
        "generated_at": generated,
        "counts": {
            "full_rows": len(rows), "distinct_prompts": len(questions),
            "graded_prompts": len(graded),
            "trivial_prompt_pairs": len(trivial_prompt_pairs),
            "answer_variant_pairs": len(answer_variant_pairs),
            "paraphrase_pairs": len(paraphrase_pairs),
            "paraphrase_pairs_graded": sum(1 for p in paraphrase_pairs if p[3]),
            "negation_traps": negation_traps,
            "tier_disagreements": len(tier_disagreements),
            "proposed_groups": len(groups),
        },
        "trivial_prompt_pairs": trivial_prompt_pairs,
        "answer_variant_pairs": answer_variant_pairs,
        "paraphrase_pairs": paraphrase_pairs,
        "tier_disagreements": tier_disagreements,
        "groups": groups,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(json.loads(artifact.read_text(encoding="utf-8"))["counts"], indent=2))
    print(f"wrote {REPORT.relative_to(ROOT)} and {artifact.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
