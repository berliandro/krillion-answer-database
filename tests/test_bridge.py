#!/usr/bin/env python3
"""Isolated bridge endpoint-shape test.

The live bridge on 8768 is NEVER contacted. We copy the minimum repo files into
a TemporaryDirectory, patch only the PORT line of the copy, and launch it on
127.0.0.1:8799 with KRILLION_NO_FETCH=1. All writes (touch/CHANGELOG/corrections)
therefore happen inside the temp directory.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from _common import REPO_ROOT, CheckFailure, require

PORT = 8799
TOKEN = "krillion-local-v1"


def _prepare(temp: Path) -> Path:
    (temp / "scripts").mkdir()
    (temp / "data").mkdir()
    (temp / "injection" / "data").mkdir(parents=True)
    (temp / "krillion").mkdir()

    shutil.copy2(REPO_ROOT / "scripts" / "paraphrase_match.py", temp / "scripts" / "paraphrase_match.py")
    for name in ("krillion_only.db", "krillion_full.db", "matcher_index.json", "manifest.json"):
        shutil.copy2(REPO_ROOT / "data" / name, temp / "data" / name)
    shutil.copy2(
        REPO_ROOT / "krillion" / "krillion-data.json",
        temp / "krillion" / "krillion-data.json",
    )
    shutil.copy2(
        REPO_ROOT / "injection" / "krillion-autofill.user.js",
        temp / "injection" / "krillion-autofill.user.js",
    )

    source = (REPO_ROOT / "injection" / "bridge.py").read_text(encoding="utf-8")
    port_line = re.compile(r"(?m)^PORT[ \t]*=[ \t]*\d+[ \t]*(\r?)$")
    patched, count = port_line.subn(
        lambda m: f"PORT = {PORT}" + m.group(1), source, count=1
    )
    require(count == 1, "could not patch PORT in copied bridge.py")
    bridge_copy = temp / "injection" / "bridge.py"
    bridge_copy.write_text(patched, encoding="utf-8")
    return bridge_copy


def _get(path: str, timeout: int = 20):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        status = resp.status
        raw = resp.read()
    finally:
        conn.close()
    return status, json.loads(raw.decode("utf-8"))


def _auth(path: str) -> str:
    return path + ("&" if "?" in path else "?") + "t=" + TOKEN


def _port_open() -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", PORT)) == 0


def test_bridge_endpoints() -> str:
    require(not _port_open(), f"port {PORT} is already in use; refusing to attach")
    proc = None
    log = None
    with tempfile.TemporaryDirectory(prefix="krillion-bridge-test-") as td:
        temp = Path(td)
        log_path = temp / "bridge.log"
        try:
            bridge_copy = _prepare(temp)
            env = os.environ.copy()
            env["KRILLION_NO_FETCH"] = "1"
            env["KRILLION_ROOT"] = str(temp)  # defensive; bridge uses __file__-relative paths
            log = open(log_path, "wb")
            proc = subprocess.Popen(
                [sys.executable, str(bridge_copy)],
                cwd=str(temp),
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )

            deadline = time.monotonic() + 25
            ready = False
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    log.flush()
                    tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
                    raise CheckFailure(f"bridge copy exited early (rc={proc.returncode}):\n{tail}")
                try:
                    status, _ = _get(_auth("/api/perf"), timeout=2)
                    if status == 200:
                        ready = True
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(0.15)
            require(ready, "isolated bridge did not become ready on port 8799")

            checks = 0

            # /api/all: version + etag from manifest, and nq on every item.
            status, payload = _get(_auth("/api/all"))
            require(status == 200, f"/api/all status={status}")
            require(payload.get("ok") is True, "/api/all missing ok=true")
            require(isinstance(payload.get("version"), int), "/api/all missing numeric version")
            require(isinstance(payload.get("etag"), str) and payload["etag"], "/api/all missing etag")
            data = payload.get("data")
            require(isinstance(data, list) and data, "/api/all data is not a non-empty list")
            require(
                all(isinstance(x.get("q"), str) and isinstance(x.get("nq"), str)
                    and isinstance(x.get("answers"), list) for x in data[:50]),
                "/api/all items must carry q / nq / answers",
            )
            checks += 1

            # /api/answers: groups[] with the expected per-group shape.
            status, payload = _get(_auth("/api/answers?q=Name%20a%203D%20shape"))
            require(status == 200, f"/api/answers status={status}")
            require(payload.get("ok") is True, "/api/answers missing ok=true")
            groups = payload.get("groups")
            require(isinstance(groups, list) and groups, "/api/answers groups[] is empty")
            require(
                all(isinstance(g.get("question"), str)
                    and isinstance(g.get("score"), (int, float))
                    and isinstance(g.get("answers"), list) for g in groups),
                "/api/answers group shape invalid",
            )
            require(
                payload.get("count") == sum(len(g["answers"]) for g in groups),
                "/api/answers count does not match groups",
            )
            checks += 1

            # /api/answers-tier and /api/perf must respond.
            status, payload = _get(_auth("/api/answers-tier?q=Name%20a%203D%20shape"))
            require(status == 200, f"/api/answers-tier status={status}")
            require(
                payload.get("ok") is True
                and isinstance(payload.get("krillion"), list)
                and isinstance(payload.get("deepcut"), list)
                and isinstance(payload.get("deepcut_exact"), bool),
                "/api/answers-tier response shape invalid",
            )
            checks += 1

            status, payload = _get(_auth("/api/perf"))
            require(status == 200, f"/api/perf status={status}")
            require(
                payload.get("ok") is True
                and isinstance(payload.get("matcher_questions"), int)
                and isinstance(payload.get("resolve_cache"), dict),
                "/api/perf response shape invalid",
            )
            require(
                payload.get("matcher_index") == "loaded",
                f"matcher_index status is {payload.get('matcher_index')!r}, expected 'loaded'",
            )
            checks += 1

            # No token -> 403, on a read-only endpoint.
            status, payload = _get("/api/all")
            require(status == 403, f"/api/all without token returned {status}, expected 403")
            require(payload.get("ok") is False, "403 body missing ok=false")
            checks += 1

            return (
                f"port {PORT} isolated copy, {len(data)} archived banks in /api/all, "
                f"{checks} endpoint checks, 8768 untouched"
            )
        finally:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            if log is not None:
                log.close()
