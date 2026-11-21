#!/usr/bin/env python3
"""Krillion autofill bridge — local PC-only data service for the userscript.

Serves all known 100-point answers for a prompt and records corrections/learned
answers from real gameplay. Reads the archive read-only; writes only inside
injection/data/ and injection/CHANGELOG.md.

Run:  python injection/bridge.py        (listens on 127.0.0.1:8768)
"""
import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
INJ = Path(__file__).resolve().parent
DATA = INJ / "data"
DATA_DIR = ROOT / "data"
BASE_DB = DATA_DIR / "krillion_only.db"
# New answers are also mirrored here so the optimizer's krillion_db.py import
# can ingest them into the authoritative full DB and rebuild the derived DBs.
IMPORT_JSONL = DATA_DIR / "answers_injection.jsonl"
CORRECTIONS = DATA / "corrections.jsonl"
LEARNED = DATA / "learned.jsonl"
CHANGELOG = INJ / "CHANGELOG.md"
PORT = 8768
TOKEN = 'krillion-local-v1'
LOCK = threading.Lock()

# Paraphrase tolerance lives in the repo's dependency-free matcher. It is
# imported read-only; if that file ever changes, we fall back to exact match.
MATCHER = None
try:
    import importlib.util
    _spec = importlib.util.spec_from_file_location(
        "krillion_paraphrase", ROOT / "scripts" / "paraphrase_match.py"
    )
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    with sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True) as _c:
        _questions = [r[0] for r in _c.execute("SELECT DISTINCT question FROM answers ORDER BY question")]
    MATCHER = _mod.Matcher(_questions)
    normalise = _mod.normalise
except Exception as _e:
    print(f"paraphrase matcher unavailable, exact matching only: {_e}")
    normalise = lambda s: " ".join(str(s).strip().lower().split())

DATA.mkdir(parents=True, exist_ok=True)
for f in (CORRECTIONS, LEARNED, IMPORT_JSONL):
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


def removed_pairs():
    return {
        (r.get("question", "").strip(), r.get("answer", "").strip())
        for r in read_jsonl(CORRECTIONS)
        if r.get("action") == "remove"
    }


def log_change(message):
    with CHANGELOG.open("a", encoding="utf-8") as f:
        f.write(f"- {now()} {message}\n")


def answers_for(question, removed=None):
    if removed is None:
        removed = removed_pairs()
    with sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True) as c:
        rows = c.execute(
            "SELECT answer FROM answers WHERE question = ? ORDER BY answer COLLATE NOCASE",
            (question,),
        ).fetchall()
    return [a for (a,) in rows if (question, a) not in removed]


def resolve_question(query):
    """Return DISTINCT candidate prompts, never a merged answer list.

    Exact match wins outright. Otherwise fuzzy candidates are returned as
    separately labelled groups so similar prompts (e.g. with/without a ball)
    stay visually and logically separate.
    """
    removed = removed_pairs()
    with sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True) as c:
        all_questions = [r[0] for r in c.execute("SELECT DISTINCT question FROM answers")]
    nq = normalise(query)
    exact = next((q for q in all_questions if normalise(q) == nq), None)
    if exact:
        return True, [{
            "question": exact, "score": 1.0,
            "answers": answers_for(exact, removed),
        }]

    hits = MATCHER.search(query, limit=5, threshold=0.62) if MATCHER else []
    # Stricter relative cut-off than the general matcher: only near-equal
    # candidates survive, so a "song" bank never tags along on a "film" query.
    if hits:
        best = max(h["score"] for h in hits)
        hits = [h for h in hits if h["score"] >= max(0.62, best * 0.90)]
    groups = [{
        "question": h["question"], "score": h["score"],
        "answers": answers_for(h["question"], removed),
    } for h in hits]
    return False, groups


def add_correction(body):
    question = str(body.get("question", "")).strip()
    answer = str(body.get("answer", "")).strip()
    points = body.get("points")
    tier = str(body.get("tier", "")).strip()
    mode = str(body.get("mode", "classic")).strip()
    try:
        points = int(points)
    except (TypeError, ValueError):
        return {"ok": False, "error": "points must be an integer"}
    if not question or not answer:
        return {"ok": False, "error": "question and answer are required"}

    existing = read_jsonl(CORRECTIONS)
    key = (question, answer)
    if any((r.get("question"), r.get("answer")) == key for r in existing):
        return {"ok": True, "duplicate": True}

    if points >= 100:
        log_change(f"verified {answer!r} for {question!r} at 100 points ({mode})")
        return {"ok": True, "action": "verified"}

    rec = {
        "at": now(), "question": question, "answer": answer,
        "points": points, "tier": tier, "mode": mode,
        "action": "remove",
    }
    with CORRECTIONS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    log_change(
        f"REMOVED {answer!r} from 100-point answers for {question!r} "
        f"(scored {points}, tier {tier or 'unknown'}, {mode})"
    )
    return {"ok": True, "action": "removed"}


def add_bank(rows):
    if not isinstance(rows, list):
        return {"ok": False, "error": "rows must be an array"}
    existing = {(r.get("question"), r.get("answer")) for r in read_jsonl(LEARNED)}
    added = 0
    new_records = []
    for row in rows:
        question = str(row.get("question", "")).strip()
        answer = str(row.get("answer", "")).strip()
        tier = str(row.get("tier", "")).strip()
        try:
            points = int(row.get("points", 0))
        except (TypeError, ValueError):
            points = 0
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
    return {"ok": True, "added": added}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, obj, ctype="application/json; charset=utf-8"):
        body = (json.dumps(obj, ensure_ascii=False) if not isinstance(obj, str) else obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Krillion-Token")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        if self.headers.get('X-Krillion-Token') != TOKEN:
            self._send(403, {"ok": False, "error": "bad token"})
            return
        if parsed.path in ("/api/status", "/api/health"):
            self._send(200, {
                "ok": True, "service": "krillion-bridge",
                "base_answers": sum(1 for _ in sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True).execute("SELECT 1 FROM answers")),
                "corrections": len(read_jsonl(CORRECTIONS)),
                "learned": len(read_jsonl(LEARNED)),
            })
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
        if self.headers.get('X-Krillion-Token') != TOKEN:
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
            if self.path == "/api/correction":
                self._send(200, add_correction(body))
            elif self.path == "/api/bank":
                self._send(200, add_bank(body.get("rows", [])))
            else:
                self._send(404, {"ok": False, "error": "not found"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Krillion bridge at http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
