#!/usr/bin/env python3
"""Reference implementation of paraphrase-tolerant matching for Krillion.

This module is the *specification* used by both the local webapp and the
static site. It is intentionally dependency-free so the exact same
algorithm can be mirrored in JavaScript (see scripts/build_static.py).

Key ideas:
  * normalise freely (we never change what the USER typed, only how we
    compare it internally);
  * keep quoted terms and negation words as high-signal tokens;
  * light stemming + a small question-language synonym map;
  * IDF-weighted token overlap, scored as a harmonic mean of coverage
    (how much of the query is explained) and precision (how much of the
    candidate is in the query), so extra words in a candidate are penalised;
  * trigram Dice as a tie-breaker for typos / small wording changes.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Only function words that carry no meaning in a Krillion prompt.
# "without", "not", "never", "q:" tokens are deliberately NOT stop words.
STOP = {
    "a", "an", "the", "any", "one", "of", "name", "give", "list", "state",
    "please", "can", "you", "i", "we", "me", "tell", "us", "some", "anyone",
    "do", "does", "did", "is", "are", "that", "which", "what", "example",
    "examples", "with", "in", "for", "to", "and", "or", "on", "at", "as",
    "by", "from", "this", "it", "its", "has", "have", "had", "be", "been",
    "there", "they", "them", "your", "my", "our", "would", "could", "should",
    "will", "shall", "after", "can", "could", "about", "like",
}

# Negation flips the meaning of a prompt; a candidate missing a negation the
# user typed (or adding one they did not) must not outrank the correct one.
NEGATIONS = {"without", "not", "never", "no", "non", "neither"}

# Canonical synonym groups for the vocabulary of question prompts.
SYNONYMS: list[tuple[str, ...]] = [
    ("name", "give", "list", "state", "tell", "mention", "identify", "cite"),
    ("famous", "wellknown", "notable", "celebrated", "renowned", "popular", "famed"),
    ("movie", "film", "motionpicture"),
    ("song", "track", "tune"),
    ("show", "series", "program", "programme", "tvshow"),
    ("book", "novel"),
    ("character", "person", "hero", "heroine", "figure"),
    ("country", "nation", "state"),
    ("food", "dish", "cuisine", "meal"),
    ("sport", "game"),
    ("item", "thing", "object", "article"),
    ("clothing", "clothes", "garment", "apparel", "wear"),
    ("winter", "cold", "snow", "coldseason"),
    ("oneword", "singleword"),
    ("threedimensional", "3d"),
    ("follow", "after", "comesafter"),
    ("park", "parkland", "gardens"),
    ("author", "writer", "novelist"),
    ("actor", "actress", "performer"),
    ("city", "town", "metropolis"),
    ("animal", "creature", "beast"),
    ("plant", "flower", "tree"),
    ("band", "group", "musicalgroup"),
    ("album", "record", "lp"),
    ("team", "club", "squad"),
    ("brand", "company", "maker", "manufacturer"),
    ("large", "big", "huge"),
    ("small", "tiny", "little"),
    ("old", "ancient", "historic"),
    ("new", "modern", "recent"),
    ("characterfrom", "character"),
]
SYN_LOOKUP: dict[str, str] = {}
for _group in SYNONYMS:
    for _w in _group:
        SYN_LOOKUP[_w] = _group[0]


def stem(w: str) -> str:
    """Very small, conservative stemmer (no外部 dependency)."""
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 5 and w.endswith("ing"):
        return w[:-3]
    if len(w) > 4 and w.endswith("ed"):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return w


def normalise(text: str) -> str:
    t = text.strip().lower()
    t = t.replace("’", "'").replace("“", '"').replace("”", '"')
    t = t.replace("–", "-").replace("—", "-")
    contractions = {
        "you'd": "you would", "you're": "you are", "you've": "you have",
        "you'll": "you will", "it's": "it is", "they're": "they are",
        "we'd": "we would", "we're": "we are", "don't": "do not",
        "doesn't": "does not", "can't": "can not", "won't": "will not",
        "isn't": "is not", "wasn't": "was not", "i'd": "i would",
        "that's": "that is", "there's": "there is", "what's": "what is",
    }
    for k, v in contractions.items():
        t = re.sub(r"\b" + re.escape(k) + r"\b", v, t)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"[?!.,:;]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def canonical_token(w: str) -> str:
    w = re.sub(r"[^a-z0-9]+", "", w)
    if not w:
        return ""
    return SYN_LOOKUP.get(w, stem(w))


# Multi-word phrases that should behave like one hyphenated word.
PHRASES = [
    ("one word", "oneword"), ("single word", "singleword"),
    ("well known", "wellknown"), ("three dimensional", "threedimensional"),
    ("motion picture", "motionpicture"), ("dc comics", "dccomics"),
]


def tokens(text: str) -> set[str]:
    """Quoted terms become q:<term> and are never stemmed/stopped."""
    t = normalise(text)
    for phrase, joined in PHRASES:
        t = re.sub(r"\b" + re.escape(phrase) + r"\b", joined, t)
    quoted = [canonical_token(x) for x in re.findall(r'"([^"]*)"', t)]
    unquoted = re.sub(r'"[^"]*"', " ", t)
    out: set[str] = set()
    for w in re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", unquoted):
        w = w.replace("'", "")
        if not w or w in STOP:
            continue
        c = canonical_token(w)
        if c:
            out.add(c)
    out.update("q:" + q for q in quoted if q)
    return out


def trigrams(s: str) -> set[str]:
    s = re.sub(r"[^a-z0-9]+", " ", normalise(s))
    s = " " + s + " "
    return {s[i:i + 3] for i in range(len(s) - 2)}


def dice(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


class Matcher:
    def __init__(self, questions: list[str]):
        self.questions = list(questions)
        self.norm = [normalise(q) for q in questions]
        self.toks = [tokens(q) for q in questions]
        self.tris = [trigrams(q) for q in questions]
        n = len(questions)
        df: dict[str, int] = {}
        for ts in self.toks:
            for t in ts:
                df[t] = df.get(t, 0) + 1
        self.idf = {t: math.log((n + 1) / (d + 1)) + 1.0 for t, d in df.items()}
        self.default_idf = math.log((n + 1) / 1.0) + 1.0
        self.by_exact: dict[str, int] = {}
        for i, q in enumerate(self.norm):
            self.by_exact.setdefault(q, i)

    def idf_of(self, t: str) -> float:
        return self.idf.get(t, self.default_idf)

    def shared_weight(self, qt: set[str], ct: set[str]) -> float:
        """Sum IDF of query tokens explained by the candidate.

        A quoted term can also be matched against an unquoted word (and vice
        versa) with a small boost: users often drop the quote marks when
        paraphrasing "Name a word that can follow X".
        """
        total = 0.0
        for t in qt:
            if t in ct:
                total += self.idf_of(t)
            elif t.startswith("q:") and t[2:] in ct:
                total += 1.2 * self.idf_of(t[2:])
            elif "q:" + t in ct:
                total += 1.2 * self.idf_of(t)
        return total

    def _query_side(self, query: str):
        """Compute query-side scoring inputs exactly once per query.

        These values are invariant across all candidates, so the hot loop in
        search() must not recompute them for every one of the ~5,800 banks.
        """
        qt = tokens(query)
        qw = sum(self.idf_of(t) for t in qt)
        qtri = trigrams(query)
        qneg = bool(qt & NEGATIONS)
        nq = normalise(query)
        return qt, qw, qtri, qneg, nq

    def _similarity_precomputed(self, qt, qw, qtri, qneg, nq, i: int) -> float:
        """Score one candidate against precomputed query-side inputs.

        Semantics are identical to similarity(); only the query-side work has
        been hoisted out of the candidate loop by the caller.
        """
        ct = self.toks[i]
        if not qt or not ct:
            return 0.0
        sw = self.shared_weight(qt, ct)
        cw = sum(self.idf_of(t) for t in ct)
        coverage = sw / qw if qw else 0.0
        precision = sw / cw if cw else 0.0
        # harmonic mean punishes candidates that add lots of extra words
        overlap = 2 * coverage * precision / (coverage + precision) if coverage + precision else 0.0
        tri = dice(qtri, self.tris[i])
        score = 0.88 * overlap + 0.12 * tri
        if qneg != bool(ct & NEGATIONS):
            score *= 0.7
        if nq == self.norm[i]:
            score = 1.0
        elif nq in self.norm[i]:
            score = max(score, 0.90)
        return score

    def similarity(self, query: str, i: int) -> float:
        """Public single-candidate API (unchanged): hoists query work per call."""
        qt, qw, qtri, qneg, nq = self._query_side(query)
        return self._similarity_precomputed(qt, qw, qtri, qneg, nq, i)

    def search(self, query: str, limit: int = 10, threshold: float = 0.34) -> list[dict]:
        query = query[:200]
        if not query.strip():
            return []
        qt, qw, qtri, qneg, nq = self._query_side(query)
        if not qt:
            # Non-Latin scripts / emoji produce no Latin tokens; degrade to a
            # literal substring match instead of reporting nothing.
            q = nq
            found = [
                (q, i) for i, norm_q in enumerate(self.norm)
                if q and q in norm_q
            ][:limit]
            return [{"question": self.questions[i], "score": 1.0} for _, i in found]
        scored = [
            (self._similarity_precomputed(qt, qw, qtri, qneg, nq, i), i)
            for i in range(len(self.questions))
        ]
        scored = [(s, i) for s, i in scored if s >= threshold]
        scored.sort(key=lambda x: (-x[0], self.questions[x[1]]))
        # Relative cut-off: show the best hit (and genuine aliases) but not
        # every loosely-related question that merely shares one content word.
        if scored:
            best = scored[0][0]
            scored = [x for x in scored if x[0] >= max(threshold, best * 0.72)]
        return [
            {"question": self.questions[i], "score": round(s, 4)}
            for s, i in scored[:limit]
        ]


def old_score(item_q: str, q: str) -> int:
    """Exact port of the current static-site score() for comparison."""
    question = item_q.lower()
    words = q.split()
    if question == q:
        return 100
    if question.startswith(q):
        return 80
    if words and all(w in question for w in words):
        return 60
    if q in question:
        return 50
    if all(w in item_q.lower() for w in words):
        return 30
    if q in item_q.lower():
        return 20
    return 0


def evaluate() -> None:
    with sqlite_rows() as rows:
        matcher = Matcher([q for q, _ in rows])
        answer = dict(rows)
        tests = json.loads((ROOT / "data" / "paraphrase_tests.json").read_text(encoding="utf-8"))
        for label, fn in (
            ("CURRENT (literal)", lambda q: sorted(
                ((old_score(qq, normalise(q)), qq) for qq, _ in rows), reverse=True)[:10]),
            ("NEW (paraphrase-tolerant)", lambda q: [(x["score"], x["question"]) for x in matcher.search(q, 10)]),
        ):
            hits = {1: 0, 3: 0, 10: 0}
            print(f"\n=== {label} ===")
            for t in tests:
                typed, expect = t["typed"], t["expect"]
                ranked = fn(typed)
                got = [qq for _, qq in ranked]
                for k in hits:
                    if expect in got[:k]:
                        hits[k] += 1
                mark = "OK " if expect in got[:1] else "MISS"
                print(f"  {mark} {typed!r:52} -> top: {got[:2]}")
            n = len(tests)
            print(f"  recall@1={hits[1]}/{n}  recall@3={hits[3]}/{n}  recall@10={hits[10]}/{n}")


def sqlite_rows():
    import sqlite3
    from contextlib import contextmanager
    db = ROOT / "data" / "krillion_search.db"

    @contextmanager
    def _rows():
        with sqlite3.connect(db) as c:
            yield c.execute("SELECT question, answer FROM search_answers").fetchall()
    return _rows()


if __name__ == "__main__":
    evaluate()
