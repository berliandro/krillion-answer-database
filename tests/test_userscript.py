#!/usr/bin/env python3
"""Static checks for injection/krillion-autofill.user.js."""
from __future__ import annotations

import re

from _common import REPO_ROOT, node_check, require

SCRIPT = REPO_ROOT / "injection" / "krillion-autofill.user.js"

# The 16 DOM ids created by the userscript's root.innerHTML template.
REQUIRED_IDS = {
    "ka-head", "ka-title", "ka-count", "ka-toggle", "ka-body", "ka-status",
    "ka-list", "ka-botbar", "ka-auto", "ka-bot", "ka-botstate", "ka-botnote",
    "ka-botdeps", "ka-pick", "ka-mode", "ka-foot",
}


def test_userscript_static() -> str:
    node_check(SCRIPT)
    source = SCRIPT.read_text(encoding="utf-8")

    header_match = re.search(
        r"//\s*==UserScript==(.*?)//\s*==/UserScript==",
        source,
        re.DOTALL,
    )
    require(header_match is not None, "missing ==UserScript== header block")
    header = header_match.group(1)
    for host in ("127.0.0.1", "localhost"):
        require(
            re.search(r"^\s*//\s*@connect\s+" + re.escape(host) + r"\s*$", header, re.MULTILINE)
            is not None,
            f"header missing @connect {host}",
        )

    ids = re.findall(r'\bid="([A-Za-z0-9_-]+)"', source)
    require(len(ids) == len(REQUIRED_IDS), f"expected 16 id= attributes, found {len(ids)}")
    require(len(set(ids)) == len(ids), f"duplicate id= attributes: {sorted({i for i in ids if ids.count(i) > 1})}")
    require(set(ids) == REQUIRED_IDS, f"id set mismatch: missing={sorted(REQUIRED_IDS - set(ids))}, extra={sorted(set(ids) - REQUIRED_IDS)}")

    return f"node --check ok; {len(ids)} unique ids; @connect 127.0.0.1 + localhost"
