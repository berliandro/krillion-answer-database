#!/usr/bin/env python3
"""Krillion autofill bridge — local PC-only data service for the userscript.

Serves all known 100-point answers for a prompt and records corrections/learned
answers from real gameplay. Reads the archive read-only; writes only inside
injection/data/ and injection/CHANGELOG.md.

Run:  python injection/bridge.py        (listens on 127.0.0.1:8768)
"""
import hashlib
import importlib.util
import json
import re
import sqlite3
from collections import OrderedDict
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
INJ = Path(__file__).resolve().parent
DATA = INJ / "data"
DATA_DIR = ROOT / "data"
BASE_DB = DATA_DIR / "krillion_only.db"
FULL_DB = DATA_DIR / "krillion_full.db"
# Optional manifest written by the build worker. Absent or unparseable is fine:
# clients then fall back to the legacy, version-less behaviour.
MANIFEST = DATA_DIR / "manifest.json"
# Compact low-tier snapshot (built by the build worker). Optional: when it is
# missing or corrupt, /api/all-tier computes the same rows on demand instead so
# fresh clones work before bootstrap.
TIER_DATA = DATA_DIR / "tier-data.json"
# New answers are also mirrored here so the optimizer's krillion_db.py import
# can ingest them into the authoritative full DB and rebuild the derived DBs.
IMPORT_JSONL = DATA_DIR / "answers_injection.jsonl"
MISSES = INJ / "data" / "failed_prompts.jsonl"
EVIDENCE = INJ / "data" / "evidence.jsonl"
PROMPT_REVIEW = INJ / "data" / "prompt_review.jsonl"
BOT_LOG = INJ / "data" / "bot_log.jsonl"
FETCH_QUEUE = INJ / "data" / "fetch_queue.jsonl"
CORRECTIONS = DATA / "corrections.jsonl"
LEARNED = DATA / "learned.jsonl"
CHANGELOG = INJ / "CHANGELOG.md"
PORT = 8768
TOKEN = 'krillion-local-v1'
# Only the game's own origin may make cross-origin requests to this loopback
# bridge. GM_xmlhttpRequest is CORS-exempt, so the userscript is unaffected.
ALLOWED_ORIGINS = ("https://playdaily.org", "https://playdaily.org/")
LOCK = threading.Lock()


# -- Per-thread read-only SQLite connections ---------------------------------
# ThreadingHTTPServer uses one worker thread per request. resolve_question()
# fans out to answers_for() once per labelled bank, so opening a connection in
# every call meant several connects per request. Keep one connection per
# (thread, database) instead. The store is dropped when its thread ends, and
# _ThreadDB.__del__ closes every handle at that point.
class _ThreadDB:
    __slots__ = ("conns",)

    def __init__(self):
        self.conns = {}

    def get(self, path):
        conn = self.conns.get(path)
        if conn is None:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            self.conns[path] = conn
        return conn

    def close_all(self):
        for conn in self.conns.values():
            try:
                conn.close()
            except Exception:
                pass
        self.conns.clear()

    def __del__(self):
        try:
            self.close_all()
        except Exception:
            pass


_THREAD_DB = threading.local()


def db_conn(path):
    """Return this thread's read-only connection for `path`, creating it once."""
    store = getattr(_THREAD_DB, "store", None)
    if store is None:
        store = _THREAD_DB.store = _ThreadDB()
    return store.get(path)


# Paraphrase tolerance lives in the repo's dependency-free matcher. It is
# imported read-only. At startup we prefer the derived index emitted by
# scripts/emit.py; if it is missing, stale or unreadable we rebuild from the
# stored questions exactly as before. Validation happens once and its result
# is cached in MATCHER_INDEX_STATUS (also exposed on /api/perf).
MATCHER = None
NORM_TO_QUESTION = {}
ALL_QUESTIONS = []
normalise = lambda s: " ".join(str(s).strip().lower().split())

INDEX_PATH = DATA_DIR / "matcher_index.json"
MATCHER_SOURCE = ROOT / "scripts" / "paraphrase_match.py"
_MATCHER_MODULE = None
MATCHER_INDEX_STATUS = "not checked"


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _questions_from_db():
    with sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True) as c:
        return [r[0] for r in c.execute(
            "SELECT DISTINCT question FROM answers ORDER BY question"
        )]


def _norm_map_from(questions, norms):
    """First-wins normalised -> stored wording map (same order as the DB)."""
    mapping = {}
    for q, n in zip(questions, norms):
        mapping.setdefault(n, q)
    return mapping


def _try_matcher_index():
    """Return (matcher, norm_map, questions, status) if a valid index exists."""
    try:
        if not INDEX_PATH.exists():
            return None, {}, [], "missing"
        manifest = load_manifest()
        expected = None
        if isinstance(manifest, dict) and isinstance(manifest.get("artifacts"), dict):
            expected = manifest["artifacts"].get("matcher_index.json")
        actual = _sha256_file(INDEX_PATH)
        if not isinstance(expected, str) or expected.lower() != actual:
            return None, {}, [], "manifest-sha-mismatch"
        payload = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        src = payload.get("matcher_source_sha256")
        if not isinstance(src, str) or src.lower() != _sha256_file(MATCHER_SOURCE):
            return None, {}, [], "source-hash-mismatch"
        matcher = _MATCHER_MODULE.Matcher.from_index(INDEX_PATH)
        if not matcher.questions:
            return None, {}, [], "empty-index"
        norm_map = _norm_map_from(matcher.questions, matcher.norm)
        return matcher, norm_map, list(matcher.questions), "loaded"
    except Exception as e:
        print(f"matcher index unusable ({e}); rebuilding from questions")
        return None, {}, [], "error"


def _init_matcher():
    """One-time startup: load a validated index, else build from questions."""
    global MATCHER, NORM_TO_QUESTION, ALL_QUESTIONS, normalise
    global MATCHER_INDEX_STATUS, _MATCHER_MODULE
    try:
        spec = importlib.util.spec_from_file_location(
            "krillion_paraphrase", MATCHER_SOURCE
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _MATCHER_MODULE = mod
        normalise = mod.normalise
    except Exception as e:
        print(f"paraphrase matcher unavailable, exact matching only: {e}")
        MATCHER_INDEX_STATUS = "no-module"
        return

    matcher, norm_map, questions, status = _try_matcher_index()
    if matcher is not None:
        MATCHER = matcher
        NORM_TO_QUESTION = norm_map
        ALL_QUESTIONS = questions
        MATCHER_INDEX_STATUS = status
        return

    # Fallback: the original startup path (build matcher + norm map from DB).
    try:
        questions = _questions_from_db()
        MATCHER = mod.Matcher(questions)
        norm_map = {}
        for q in questions:
            norm_map.setdefault(normalise(q), q)
        NORM_TO_QUESTION = norm_map
        ALL_QUESTIONS = questions
        MATCHER_INDEX_STATUS = status
    except Exception as e:
        print(f"paraphrase matcher build failed, exact matching only: {e}")
        MATCHER = None
        NORM_TO_QUESTION, ALL_QUESTIONS = {}, []
        MATCHER_INDEX_STATUS = "build-error"

# Dedicated lock for the read caches. Kept separate from LOCK (which guards
# append-only writes) so a slow cold resolve never blocks bleed logging.
CACHE_LOCK = threading.RLock()
RESOLVE_MAX = 512
# normalised query -> (is_exact, tuple of (stored_question, score)).
# Groups (answers) are rebuilt on every call so removed_pairs() corrections
# always apply, even for a cached match.
RESOLVE_CACHE = OrderedDict()
LEARNED_CACHE = None
LEARNED_KEY = None
PERF = {
    "resolve_hits": 0, "resolve_misses": 0,
    "learned_hits": 0, "learned_misses": 0,
    "all_hits": 0, "all_misses": 0,
}


_MANIFEST_CACHE = None  # (cache_key, parsed_dict_or_None)
# (cache_key, (version, etag, rows) or None) for data/tier-data.json. A None
# cached value means "no usable snapshot" — callers then use the on-demand
# fallback rather than treating a missing file as an error.
_TIER_SNAPSHOT_CACHE = None


def load_manifest():
    """Read data/manifest.json defensively, cached by mtime_ns + size.

    The build worker creates that file in parallel. Missing, unreadable or
    malformed content is NOT an error: return None so callers omit version/etag
    and keep serving exactly the legacy response.
    """
    global _MANIFEST_CACHE
    try:
        st = MANIFEST.stat()
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        key = None
    with CACHE_LOCK:
        if _MANIFEST_CACHE is not None and _MANIFEST_CACHE[0] == key:
            return _MANIFEST_CACHE[1]
        parsed = None
        if key is not None:
            try:
                candidate = json.loads(MANIFEST.read_text(encoding="utf-8"))
                if isinstance(candidate, dict):
                    parsed = candidate
            except (OSError, ValueError, TypeError):
                parsed = None
        _MANIFEST_CACHE = (key, parsed)
        return parsed


def manifest_meta():
    """Return (version, etag, counts) from the manifest; each may be None."""
    m = load_manifest()
    if not m:
        return None, None, None
    version = m.get("data_version")
    if not isinstance(version, int) or isinstance(version, bool):
        version = None
    etag = m.get("etag")
    if not isinstance(etag, str):
        etag = None
    counts = m.get("counts")
    if not isinstance(counts, dict):
        counts = None
    return version, etag, counts


# Startup bootstrap (defined above but called here, after load_manifest and
# CACHE_LOCK exist). Cached in MATCHER_INDEX_STATUS; never repeated.
_init_matcher()


def cached_learned():
    """read_jsonl(LEARNED) cached by mtime+size (same idea as _ALL_CACHE)."""
    global LEARNED_CACHE, LEARNED_KEY
    try:
        st = LEARNED.stat()
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        key = (0, 0)
    with CACHE_LOCK:
        if LEARNED_CACHE is None or LEARNED_KEY != key:
            LEARNED_KEY = key
            LEARNED_CACHE = read_jsonl(LEARNED)
            PERF["learned_misses"] += 1
        else:
            PERF["learned_hits"] += 1
        return LEARNED_CACHE


DATA.mkdir(parents=True, exist_ok=True)
for f in (CORRECTIONS, LEARNED, IMPORT_JSONL, MISSES, EVIDENCE, PROMPT_REVIEW, BOT_LOG, FETCH_QUEUE):
    f.touch(exist_ok=True)
if not CHANGELOG.exists():
    CHANGELOG.write_text(
        "# Krillion injection changelog\n\n"
        "Every entry is written by `injection/bridge.py` when the userscript\n"
        "reports a gameplay result. Newest entries are appended at the bottom.\n",
        encoding="utf-8",
    )


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_jsonl(path):
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


_ALL_CACHE = None
_ALL_KEY = None


def all_answers_payload():
    """The entire rare-answer archive for one-shot client-side preloading."""
    global _ALL_CACHE, _ALL_KEY
    src_path = ROOT / "krillion" / "krillion-data.json"
    key = (
        src_path.stat().st_mtime if src_path.exists() else 0,
        CORRECTIONS.stat().st_mtime if CORRECTIONS.exists() else 0,
    )
    with CACHE_LOCK:
        PERF["all_hits" if (_ALL_CACHE is not None and _ALL_KEY == key) else "all_misses"] += 1
    if _ALL_CACHE is None or _ALL_KEY != key:
        _ALL_KEY = key
        if src_path.exists():
            data = json.loads(src_path.read_text(encoding="utf-8"))
        else:
            with sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True) as c:
                rows = c.execute("SELECT question, answer FROM answers ORDER BY question, answer").fetchall()
            grouped = {}
            for q, a in rows:
                grouped.setdefault(q, []).append(a)
            data = [{"q": q, "answers": a} for q, a in grouped.items()]
        removed = removed_pairs()
        for item in data:
            q = item.get("q", "")
            item["answers"] = [a for a in item.get("answers", []) if (q, a) not in removed]
            # Same strict pipeline the matcher uses: normalise, then rewrite.
            # Clients key their netCache on nq; older userscript copies still
            # fall back to their own local normaliser when nq is absent.
            item["nq"] = rewrite_query(normalise(q))
        _ALL_CACHE = data
    return _ALL_CACHE


def removed_pairs():
    return {
        (r.get("question", "").strip(), r.get("answer", "").strip())
        for r in read_jsonl(CORRECTIONS)
        if r.get("action") == "remove"
    }


def log_change(message):
    with CHANGELOG.open("a", encoding="utf-8") as f:
        f.write(f"- {now()} {message}\n")


# Rewrites observed repeatedly in prompt_review.jsonl. Applied only after a
# literal exact match fails, so a genuine stored wording is never changed.
REWRITES = [
    (r"^what is an example of an ", "name an "),
    (r"^what is an example of a ", "name a "),
    (r"^what is one ", "name a "),
    (r"^name any one ", "name a "),
    (r"^name any ", "name a "),
    (r"^name one ", "name a "),
]


def rewrite_query(text):
    q = normalise(text)
    for pattern, replacement in REWRITES:
        changed = re.sub(pattern, replacement, q)
        if changed != q:
            q = changed
            break
    return re.sub(r"\bbeginning\s+with\b", "starting with", q, flags=re.I)


def answers_for(question, removed=None):
    if removed is None:
        removed = removed_pairs()
    c = db_conn(BASE_DB)
    rows = c.execute(
        "SELECT answer FROM answers WHERE question = ? ORDER BY answer COLLATE NOCASE",
        (question,),
    ).fetchall()
    return [a for (a,) in rows if (question, a) not in removed]


def _resolve_candidates(nq):
    """Pure, cacheable part of resolve_question().

    Returns (is_exact, ((stored_question, score), ...)) for a normalised
    query. All matching rules are preserved: exact first, rewritten-exact
    second, distinct labelled banks (never merged), kind/type variants, and
    the strict relative cut-off.
    """
    exact = NORM_TO_QUESTION.get(nq)
    if exact:
        return True, ((exact, 1.0),)

    # A rewritten wording can become an exact stored prompt (e.g. "Name one
    # verb" -> "Name a verb"), so check that before fuzzy matching.
    q = rewrite_query(nq)
    rewritten_exact = NORM_TO_QUESTION.get(q)
    if rewritten_exact:
        return True, ((rewritten_exact, 1.0),)

    hits = MATCHER.search(q, limit=5, threshold=0.62) if MATCHER else []
    # "kind/type" are separate stored wordings; try both if the first pass
    # finds nothing (e.g. "type of hat" vs "kind of hat").
    if not hits:
        for variant in (q.replace("type of", "kind of"), q.replace("kind of", "type of")):
            if variant == q:
                continue
            candidate = MATCHER.search(variant, limit=5, threshold=0.62) if MATCHER else []
            if candidate:
                hits = candidate
                break
    # Stricter relative cut-off than the general matcher: only near-equal
    # candidates survive, so a "song" bank never tags along on a "film" query.
    if hits:
        best = max(h["score"] for h in hits)
        hits = [h for h in hits if h["score"] >= max(0.62, best * 0.90)]
    return False, tuple((h["question"], h["score"]) for h in hits)


def resolve_question(query):
    """Return DISTINCT candidate prompts, never a merged answer list.

    Exact match wins outright. Otherwise fuzzy candidates are returned as
    separately labelled groups so similar prompts (e.g. with/without a ball)
    stay visually and logically separate. The expensive candidate resolution
    is cached by normalised query; only the small answers_for() DB lookups and
    corrections are redone per call.
    """
    nq = normalise(query)
    with CACHE_LOCK:
        cached = RESOLVE_CACHE.get(nq)
        if cached is not None:
            RESOLVE_CACHE.move_to_end(nq)  # LRU: most-recent last
            PERF["resolve_hits"] += 1
            exact, candidates = cached
        else:
            PERF["resolve_misses"] += 1
            # Held across the compute on purpose: single-flight, so two
            # concurrent identical prompts never both pay the ~10s search.
            exact, candidates = _resolve_candidates(nq)
            RESOLVE_CACHE[nq] = (exact, candidates)
            while len(RESOLVE_CACHE) > RESOLVE_MAX:
                RESOLVE_CACHE.popitem(last=False)

    # always fresh so demotions reported during play take effect immediately
    removed = removed_pairs()
    groups = [{
        "question": q, "score": s,
        "answers": answers_for(q, removed),
    } for q, s in candidates]
    return exact, groups


def tier_answers(question):
    """Return (krillion_answers, deepcut_answers, deepcut_is_exact).

    Deep Cut (85-point) answers are only known where a full graded bank was
    captured with tierIndex 4. For other prompts we fall back to non-krillion
    answers from the full DB (correctly below 100, exact tier unknown).
    """
    rare = answers_for(question)
    learned = cached_learned()
    exact = [r.get("answer", "") for r in learned
             if r.get("question") == question
             and (r.get("tierIndex") == 4 or r.get("tier") == "DEEP CUT"
                  or r.get("points") == 85)]
    exact = [a for a in exact if a]
    if exact:
        return rare, exact, True
    c = db_conn(FULL_DB)
    # Force the question index. The planner otherwise picks
    # idx_answers_krillion and builds a temp B-tree, turning an O(log n)
    # probe into a cold multi-second scan.
    rows = c.execute(
        "SELECT answer FROM answers INDEXED BY idx_answers_question "
        "WHERE question=? AND is_krillion=0 "
        "ORDER BY answer COLLATE NOCASE LIMIT 20", (question,)
    ).fetchall()
    return rare, [a for (a,) in rows], False


def _load_tier_snapshot():
    """Return (version, etag, rows) from data/tier-data.json, else None.

    Cached by mtime_ns + size (microsecond-safe, same idea as cached_learned
    and load_manifest). A missing/unreadable/malformed file is NOT an error:
    return None so callers compute the rows on demand with version 0. The
    build worker creates this file in parallel, so it may not exist yet.
    """
    global _TIER_SNAPSHOT_CACHE
    try:
        st = TIER_DATA.stat()
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        key = None
    with CACHE_LOCK:
        if _TIER_SNAPSHOT_CACHE is not None and _TIER_SNAPSHOT_CACHE[0] == key:
            return _TIER_SNAPSHOT_CACHE[1]
        result = None
        if key is not None:
            try:
                raw = TIER_DATA.read_bytes()
                payload = json.loads(raw.decode("utf-8"))
                version = payload.get("version")
                rows = payload.get("rows")
                if (isinstance(payload, dict)
                        and isinstance(version, int) and not isinstance(version, bool)
                        and isinstance(rows, list)
                        and all(
                            isinstance(r, (list, tuple)) and len(r) == 2
                            and isinstance(r[0], str) and isinstance(r[1], list)
                            for r in rows
                        )):
                    result = (version, hashlib.sha256(raw).hexdigest(),
                              [[r[0], list(r[1])] for r in rows])
            except (OSError, ValueError, TypeError, UnicodeDecodeError):
                result = None
        _TIER_SNAPSHOT_CACHE = (key, result)
        return result


def _compute_tier_rows():
    """Compute low-tier snapshot rows on demand (mirrors the build worker).

    For every question in the FULL DB with non-krillion answers, take up to 20
    of those answers ORDER BY answer COLLATE NOCASE. Prepend the exact DEEP CUT
    answers from learned.jsonl (tierIndex 4 / tier "DEEP CUT" / points 85),
    dedupe keeping first occurrence (so DEEP CUT wins), cap at 20, and order
    the final rows by question. Same logic the snapshot builder uses, so the
    fallback is byte-for-byte equivalent before the snapshot exists.
    """
    deepcut = {}
    for r in cached_learned():
        question = r.get("question")
        answer = r.get("answer")
        if not question or not answer:
            continue
        if (r.get("tierIndex") == 4 or r.get("tier") == "DEEP CUT"
                or r.get("points") == 85):
            bucket = deepcut.setdefault(question, [])
            if answer not in bucket:
                bucket.append(answer)

    c = db_conn(FULL_DB)
    questions = [r[0] for r in c.execute(
        "SELECT DISTINCT question FROM answers WHERE is_krillion=0 ORDER BY question"
    )]
    rows = []
    for question in questions:
        db_answers = [a for (a,) in c.execute(
            "SELECT answer FROM answers INDEXED BY idx_answers_question "
            "WHERE question=? AND is_krillion=0 "
            "ORDER BY answer COLLATE NOCASE LIMIT 20", (question,)
        )]
        merged = []
        seen = set()
        for answer in deepcut.get(question, []) + db_answers:
            if answer in seen:
                continue
            seen.add(answer)
            merged.append(answer)
            if len(merged) >= 20:
                break
        if merged:
            rows.append([question, merged])
    return rows


def all_tier_payload():
    """Return (version, etag, rows) for the low-tier preload snapshot.

    Serve data/tier-data.json when present and valid; otherwise compute the
    identical rows on demand and report version 0 (old clones, pre-bootstrap).
    """
    snapshot = _load_tier_snapshot()
    if snapshot is not None:
        return snapshot
    return 0, "0", _compute_tier_rows()


def add_evidence(body):
    """Record a play event. NEVER demotes an answer.

    The user's policy: play scores are unreliable (the game grades unknown
    answers with an AI, so the same answer can be 100 once and 30 later).
    Only the game's own dive-end graded bank may change the rare tier.
    """
    prompt = str(body.get("screen_prompt") or body.get("question") or "").strip()
    answer = str(body.get("answer", "")).strip()
    if not prompt and not answer:
        return {"ok": False, "error": "prompt or answer is required"}
    rec = {"at": now()}
    for key in ("screen_prompt", "chosen_bank", "answer", "points", "outcome",
                "tier", "mode", "exact", "group_count", "group_scores", "auto", "refusal",
                "game_state", "input_state"):
        if key in body:
            rec[key] = body[key]
    if "question" in body and "chosen_bank" not in rec:
        rec["chosen_bank"] = body["question"]
    with EVIDENCE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"ok": True, "action": "logged"}


def add_prompt_review(body):
    """Record the prompt the game actually showed when matching was uncertain
    or a submitted answer scored below 100. This is how we learn the real
    wording and fix the matcher later, instead of blaming the answer."""
    prompt = str(body.get("screen_prompt", "")).strip()
    kind = str(body.get("kind", "ambiguous")).strip()
    if not prompt:
        return {"ok": False, "error": "screen_prompt is required"}
    rec = {"at": now(), "kind": kind, "screen_prompt": prompt}
    for key in ("candidates", "chosen_bank", "answer", "points", "tier",
                "mode", "exact", "auto", "refusal", "game_state", "input_state"):
        if key in body:
            rec[key] = body[key]
    with PROMPT_REVIEW.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"ok": True, "kind": kind}


def add_bot_log(body):
    rec = {"at": now()}
    for key in ("event", "mode", "room", "detail", "count", "rooms", "note",
                "game_state", "input_state"):
        if key in body:
            rec[key] = body[key]
    with BOT_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"ok": True}


# Backwards compatibility for any older userscript copy still posting here.
add_correction = add_evidence


def add_miss(body):
    prompt = str(body.get("prompt", "")).strip()
    reason = str(body.get("reason", "unknown")).strip()
    if not prompt:
        return {"ok": False, "error": "prompt is required"}
    with MISSES.open("a", encoding="utf-8") as f:
        f.write(json.dumps({
            "at": now(), "prompt": prompt, "reason": reason,
        }, ensure_ascii=False) + "\n")
    # If the script supplied the game's prompt id + ticket, queue a fetch of
    # that prompt's real graded bank. Dedupe by prompt id.
    pid = str(body.get("promptId", "")).strip()
    ticket = str(body.get("ticket", "")).strip()
    if pid and ticket:
        known = {str(r.get("promptId", "")) for r in read_jsonl(FETCH_QUEUE)}
        known |= {str(r.get("promptId", "")) for r in read_jsonl(MISSES)}
        if pid not in known:
            with FETCH_QUEUE.open("a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "at": now(), "prompt": prompt, "promptId": pid, "ticket": ticket,
                    "status": "queued",
                }, ensure_ascii=False) + "\n")
            log_change(f"queued bank fetch for unresolved prompt {prompt!r}")
    return {"ok": True}


def add_bank(rows):
    if not isinstance(rows, list):
        return {"ok": False, "error": "rows must be an array"}
    existing = {(r.get("question"), r.get("answer")) for r in read_jsonl(LEARNED)}
    added = 0
    new_records = []
    skipped_others = 0
    for row in rows:
        # Never record other players' answers: their scores come from the
        # site's AI and are inconsistent. Only our own rows and the game's
        # own graded banks are trustworthy.
        if str(row.get("source", "")) not in ("own", "api", "bank"):
            skipped_others += 1
            continue
        question = str(row.get("question", "")).strip()
        answer = str(row.get("answer", "")).strip()
        tier = str(row.get("tier", "")).strip()
        # Keep an unparseable/missing points value as None (no signal) instead
        # of coercing it to 0. The demotion step below needs to tell "unknown"
        # apart from "explicitly zero", otherwise a partial capture is treated
        # as a low tier and permanently poisons the pair via dedup.
        raw_points = row.get("points")
        try:
            points = int(raw_points) if raw_points is not None else None
        except (TypeError, ValueError):
            points = None
        if not question or not answer or (question, answer) in existing:
            continue
        existing.add((question, answer))
        rec = {
            "at": now(), "question": question, "answer": answer,
            "tier": tier, "points": points, "source": str(row.get("source", "")),
        }
        if row.get("tierIndex") is not None:
            rec["tierIndex"] = row.get("tierIndex")
        new_records.append(rec)
        added += 1
    if new_records:
        with LEARNED.open("a", encoding="utf-8") as f:
            for r in new_records:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        # Mirror into the optimizer's ingest path so krillion_db.py import can
        # fold these rows into the authoritative full DB.
        with IMPORT_JSONL.open("a", encoding="utf-8") as f:
            for r in new_records:
                is_krillion = (
                    r.get("tierIndex") == 5
                    or "krillion" in r.get("tier", "").lower()
                )
                f.write(json.dumps({
                    "question": r["question"], "answer": r["answer"],
                    "is_krillion": bool(is_krillion),
                    "source_url": "https://playdaily.org/krillion",
                }, ensure_ascii=False) + "\n")
        log_change(f"learned {added} new answer(s) from expanded answer banks")

    # Authoritative demotion: the game's own graded bank at dive end.
    demoted = 0
    existing_corrections = {
        (r.get("question"), r.get("answer")) for r in read_jsonl(CORRECTIONS)
        if r.get("action") == "remove"
    }
    with sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True) as c:
        for r in new_records:
            # A demotion needs POSITIVE evidence of a low tier. A missing or
            # unparseable points value is "no signal", NOT "zero points": the
            # old default-to-0 turned a partial capture into a permanent
            # removal, and dedup then blocked any later correct capture from
            # reversing it. Only the game's own graded bank can demote — play
            # scores never reach this function (source filter above).
            raw_points = r.get("points")
            try:
                observed = int(raw_points) if raw_points is not None else None
            except (TypeError, ValueError):
                observed = None
            tier = str(r.get("tier", "")).strip()
            tier_index = r.get("tierIndex")
            try:
                tier_index_num = int(tier_index) if tier_index is not None else None
            except (TypeError, ValueError):
                tier_index_num = None

            # tierIndex 5 (or explicitly Krillion tier text) is the
            # authoritative "this IS a 100-point Krillion tier" signal and wins
            # outright — even if a stray/unparseable points value reads low.
            is_krillion = (tier_index_num == 5) or ("krillion" in tier.lower())
            # Each of these is positive evidence of a LOW tier; the absence of
            # all three (e.g. garbage points, no tier data) is no-signal.
            low_points = observed is not None and observed < 100
            low_tier_index = tier_index is not None and tier_index_num != 5
            low_tier_text = bool(tier) and "krillion" not in tier.lower()
            is_low = not is_krillion and (low_points or low_tier_index or low_tier_text)
            if not is_low:
                continue
            key = (r["question"], r["answer"])
            if key in existing_corrections:
                continue
            row = c.execute(
                "SELECT 1 FROM answers WHERE question=? AND answer=?", key
            ).fetchone()
            if not row:
                continue
            with CORRECTIONS.open("a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "at": now(), "question": r["question"], "answer": r["answer"],
                    "points": observed, "tier": tier, "mode": "bank",
                    "action": "remove",
                }, ensure_ascii=False) + "\n")
            existing_corrections.add(key)
            demoted += 1
            log_change(
                f"BANK DEMOTED {r['answer']!r} for {r['question']!r} "
                f"(bank tier {tier or observed})"
            )
    if skipped_others:
        log_change(f"ignored {skipped_others} answer(s) from other players")
    return {"ok": True, "added": added, "bank_demoted": demoted,
            "ignored_other_players": skipped_others}


def fetch_worker():
    """Fetch graded banks for unresolved prompts. Respects the ~65s cooldown.

    Enabled by default; set KRILLION_NO_FETCH=1 to disable. Only ever writes
    new answer rows to data/answers_injection.jsonl for the normal importer.
    """
    while True:
        try:
            queue = read_jsonl(FETCH_QUEUE)
            item = next((r for r in queue if r.get("status") == "queued"), None)
            if item is None:
                time.sleep(5)
                continue
            pid = str(item.get("promptId", ""))
            ticket = str(item.get("ticket", ""))
            url = ("https://playdaily.org/api/krillion/answers?prompt="
                   + urllib.parse.quote(pid) + "&ticket=" + urllib.parse.quote(ticket))
            data = None
            for _ in range(4):
                try:
                    req = urllib.request.Request(url, headers={
                        "User-Agent": "Mozilla/5.0", "Referer": "https://playdaily.org/krillion",
                    })
                    with urllib.request.urlopen(req, timeout=15) as r:
                        data = json.loads(r.read().decode("utf-8"))
                    break
                except urllib.error.HTTPError as e:
                    if e.code == 425:
                        try:
                            wait = int((json.loads(e.read().decode()).get("wait", 65000)) or 65000)
                        except Exception:
                            wait = 65000
                        time.sleep(min(180000, wait) / 1000 + 2)
                        continue
                    break
                except Exception:
                    time.sleep(5)
            rows = (data or {}).get("answers") if isinstance(data, dict) else None
            if isinstance(rows, list):
                existing = {(r.get("question"), r.get("answer")) for r in read_jsonl(IMPORT_JSONL)}
                added = 0
                with IMPORT_JSONL.open("a", encoding="utf-8") as f:
                    for row in rows:
                        tier = int(row[0]) if isinstance(row, (list, tuple)) and len(row) > 1 else 0
                        answer = str(row[1]).strip() if isinstance(row, (list, tuple)) and len(row) > 1 else ""
                        key = (item.get("prompt", ""), answer)
                        if not answer or key in existing:
                            continue
                        existing.add(key)
                        f.write(json.dumps({
                            "question": item.get("prompt", ""), "answer": answer,
                            "is_krillion": tier == 5,
                            "source_url": "https://playdaily.org/krillion",
                        }, ensure_ascii=False) + "\n")
                        added += 1
                log_change(f"fetched {added} answer(s) for unresolved prompt {item.get('prompt')!r}")
                item["status"] = "done"
            else:
                item["status"] = "failed"
            with FETCH_QUEUE.open("w", encoding="utf-8") as f:
                for r in queue:
                    if r is item:
                        r = item
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
        except Exception as e:
            log_change(f"bank fetch error: {e}")
            time.sleep(10)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, obj, ctype="application/json; charset=utf-8"):
        body = (json.dumps(obj, ensure_ascii=False) if not isinstance(obj, str) else obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # Responses vary by Origin. Echo Access-Control-Allow-Origin ONLY for
        # the game's own origin; with no ACAO header the browser rejects every
        # other site, so a random web page cannot POST to the loopback bridge
        # with the public token and demote answers. Non-CORS clients (the
        # userscript via GM_xmlhttpRequest, curl, same-origin) are unaffected.
        self.send_header("Vary", "Origin")
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Krillion-Token")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        supplied = (params.get("t") or [self.headers.get('X-Krillion-Token', "")])[0]
        if supplied != TOKEN:
            self._send(403, {"ok": False, "error": "bad token"})
            return
        if parsed.path == "/api/perf":
            with CACHE_LOCK:
                snap = dict(PERF)
                resolve_size = len(RESOLVE_CACHE)
                learned_rows = len(LEARNED_CACHE) if LEARNED_CACHE is not None else 0
                all_items = len(_ALL_CACHE) if _ALL_CACHE is not None else 0
            version, etag, counts = manifest_meta()
            perf_resp = {
                "ok": True,
                "resolve_cache": {
                    "size": resolve_size, "max": RESOLVE_MAX,
                    "hits": snap["resolve_hits"], "misses": snap["resolve_misses"],
                },
                "learned_cache": {
                    "rows": learned_rows,
                    "hits": snap["learned_hits"], "misses": snap["learned_misses"],
                },
                "all_cache": {
                    "items": all_items,
                    "hits": snap["all_hits"], "misses": snap["all_misses"],
                },
                "normalised_prompts": len(NORM_TO_QUESTION),
                "matcher_questions": len(MATCHER.questions) if MATCHER else 0,
            }
            # Additive: which startup path produced MATCHER (loaded/missing/
            # manifest-sha-mismatch/source-hash-mismatch/built/...).
            perf_resp["matcher_index"] = MATCHER_INDEX_STATUS
            # Additive fields only: every pre-existing /api/perf field is kept.
            if version is not None:
                perf_resp["version"] = version
            if etag is not None:
                perf_resp["etag"] = etag
            if counts is not None:
                perf_resp["counts"] = counts
            self._send(200, perf_resp)
            return
        if parsed.path in ("/api/status", "/api/health"):
            self._send(200, {
                "ok": True, "service": "krillion-bridge",
                "base_answers": sum(1 for _ in sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True).execute("SELECT 1 FROM answers")),
                "corrections": len(read_jsonl(CORRECTIONS)),
                "learned": len(read_jsonl(LEARNED)),
                "misses": len(read_jsonl(MISSES)),
                "log_lines": {
                    "evidence": len(read_jsonl(EVIDENCE)),
                    "prompt_review": len(read_jsonl(PROMPT_REVIEW)),
                    "bot_log": len(read_jsonl(BOT_LOG)),
                },
            })
            return
        if parsed.path == "/api/failed":
            self._send(200, {"ok": True, "misses": read_jsonl(MISSES)[-50:]})
            return
        if parsed.path == "/api/evidence":
            self._send(200, {"ok": True, "events": read_jsonl(EVIDENCE)[-100:]})
            return
        if parsed.path == "/api/bot-log":
            self._send(200, {"ok": True, "events": read_jsonl(BOT_LOG)[-100:]})
            return
        if parsed.path == "/api/answers-tier":
            q = (parse_qs(parsed.query).get("q") or [""])[0]
            q = unquote(q).strip()
            if not q:
                self._send(400, {"ok": False, "error": "q is required"})
                return
            rare, deep, exact = tier_answers(q)
            alt = (parse_qs(parsed.query).get("alt") or [""])[0]
            alt = unquote(alt).strip()
            if alt and alt != q and not deep:
                _, alt_deep, alt_exact = tier_answers(alt)
                if alt_deep:
                    deep, exact = alt_deep, alt_exact
            self._send(200, {
                "ok": True, "question": q,
                "krillion": rare, "deepcut": deep,
                "deepcut_exact": exact,
            })
            return
        if parsed.path == "/api/all":
            resp = {"ok": True, "data": all_answers_payload()}
            version, etag, _counts = manifest_meta()
            # Omitted entirely when the build worker has not produced a
            # manifest yet, so old clients see exactly the legacy payload.
            if version is not None:
                resp["version"] = version
            if etag is not None:
                resp["etag"] = etag
            self._send(200, resp)
            return
        if parsed.path == "/api/all-tier":
            version, etag, rows = all_tier_payload()
            self._send(200, {
                "ok": True, "version": version, "etag": etag, "data": rows,
            })
            return
        if parsed.path == "/api/prompt-review":
            self._send(200, {"ok": True, "prompts": read_jsonl(PROMPT_REVIEW)[-200:]})
            return
        if parsed.path == "/api/fetch-queue":
            self._send(200, {"ok": True, "queue": read_jsonl(FETCH_QUEUE)[-50:]})
            return
        if parsed.path == "/api/userscript.js":
            src = (INJ / "krillion-autofill.user.js").read_text(encoding="utf-8")
            self._send(200, src, "application/javascript; charset=utf-8")
            return
        if parsed.path == "/api/answers":
            params = parse_qs(parsed.query)
            q = (params.get("q") or params.get("prompt") or [""])[0]
            q = unquote(q).strip()
            if not q:
                self._send(400, {"ok": False, "error": "q is required"})
                return
            exact, groups = resolve_question(q)
            self._send(200, {
                "ok": True, "question": q, "exact": exact,
                "groups": groups,
                # flat list kept for older userscript versions
                "answers": groups[0]["answers"] if groups else [],
                "count": sum(len(g["answers"]) for g in groups),
            })
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        supplied = (params.get("t") or [self.headers.get('X-Krillion-Token', "")])[0]
        if supplied != TOKEN:
            self._send(403, {"ok": False, "error": "bad token"})
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._send(400, {"ok": False, "error": "invalid JSON"})
            return
        with LOCK:
            if parsed.path in ("/api/correction", "/api/evidence"):
                self._send(200, add_evidence(body))
            elif parsed.path == "/api/bank":
                self._send(200, add_bank(body.get("rows", [])))
            elif parsed.path == "/api/miss":
                self._send(200, add_miss(body))
            elif parsed.path == "/api/prompt-review":
                self._send(200, add_prompt_review(body))
            elif parsed.path == "/api/bot-log":
                self._send(200, add_bot_log(body))
            else:
                self._send(404, {"ok": False, "error": "not found"})

    def handle_error(self, request, client_address):
        # Browsers abort in-flight requests on navigation; do not spam logs.
        err = sys.exc_info()[1]
        if isinstance(err, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    if __import__("os").environ.get("KRILLION_NO_FETCH") != "1":
        threading.Thread(target=fetch_worker, daemon=True).start()
        print("Unresolved-prompt bank fetching: ON (KRILLION_NO_FETCH=1 to disable)")
    print(f"Krillion bridge at http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
