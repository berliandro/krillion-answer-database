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

    # "beginning with" is a common paraphrase of the bank's "starting with".
    # Without this rewrite a real bank scores only ~0.57 and misses the cutoff.
    q = re.sub(r"\bbeginning\s+with\b", "starting with", query, flags=re.I)
    hits = MATCHER.search(q, limit=5, threshold=0.62) if MATCHER else []
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
                "tier", "mode", "exact", "group_count", "group_scores", "auto"):
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
                "mode", "exact", "auto"):
        if key in body:
            rec[key] = body[key]
    with PROMPT_REVIEW.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"ok": True, "kind": kind}


def add_bot_log(body):
    rec = {"at": now()}
    for key in ("event", "mode", "room", "detail", "count", "rooms", "note"):
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

    # Authoritative demotion: the game's own graded bank at dive end.
    demoted = 0
    existing_corrections = {
        (r.get("question"), r.get("answer")) for r in read_jsonl(CORRECTIONS)
        if r.get("action") == "remove"
    }
    with sqlite3.connect(f"file:{BASE_DB}?mode=ro", uri=True) as c:
        for r in new_records:
            try:
                observed = int(r.get("points", 0))
            except (TypeError, ValueError):
                observed = 0
            tier = r.get("tier", "")
            is_low = observed < 100 or (
                r.get("tierIndex") is not None and r.get("tierIndex") != 5
            ) or (tier and "krillion" not in tier.lower() and observed == 0)
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
        self.send_header("Access-Control-Allow-Origin", "*")
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
        if parsed.path == "/api/all":
            self._send(200, {"ok": True, "data": all_answers_payload()})
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
