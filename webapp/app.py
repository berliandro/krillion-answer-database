#!/usr/bin/env python3
"""Tiny stdlib-only webapp for fast Krillion answer search.

Run:  python webapp/app.py
Open: http://127.0.0.1:8765
Search is backed by data/krillion_search.db (FTS5), never the full DB.
"""
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
SEARCH_DB = ROOT / "data" / "krillion_search.db"
HTML = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")


def do_search(query):
    """Exact phrase -> token prefix OR -> LIKE fallback, all on the small DB."""
    query = query.strip()
    if not query:
        return []
    limit = 20
    with sqlite3.connect(SEARCH_DB) as c:
        def fts(match):
            return c.execute(
                "SELECT question, answer, bm25(search_fts) AS score "
                "FROM search_fts WHERE search_fts MATCH ? "
                "ORDER BY score LIMIT ?",
                (match, limit),
            ).fetchall()

        rows = []
        phrase = '"' + query.replace('"', '""') + '"'
        try:
            rows = fts(phrase)
        except sqlite3.OperationalError:
            pass
        if not rows:
            tokens = [t for t in query.split() if t]
            if tokens:
                match = " OR ".join('"' + t.replace('"', '""') + '"*' for t in tokens)
                try:
                    rows = fts(match)
                except sqlite3.OperationalError:
                    pass
        if not rows:
            like = f"%{query}%"
            rows = c.execute(
                "SELECT question, answer, 0 FROM search_answers "
                "WHERE question LIKE ? OR answer LIKE ? LIMIT ?",
                (like, like, limit),
            ).fetchall()
    return [{"question": q, "answer": a} for q, a, _ in rows]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            body = json.dumps({"results": do_search(query)}, ensure_ascii=False).encode("utf-8")
            self._send(200, "application/json; charset=utf-8", body)
        elif parsed.path in ("/", "/index.html"):
            self._send(200, "text/html; charset=utf-8", HTML.encode("utf-8"))
        else:
            self.send_error(404)

    def _send(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    if not SEARCH_DB.exists():
        raise SystemExit(f"Missing {SEARCH_DB} — run: python scripts/krillion_db.py init")
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print("Krillion search running at http://127.0.0.1:8765")
    server.serve_forever()
