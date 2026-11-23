#!/usr/bin/env python3
"""Syntax-check every inline <script> block in the three shipped HTML pages."""
from __future__ import annotations

import re
import tempfile
from pathlib import Path

from _common import REPO_ROOT, node_check, require

PAGES = (
    Path("index.html"),
    Path("krillion") / "index.html",
    Path("webapp") / "index.html",
)
SCRIPT_RE = re.compile(r"<script\b[^>]*>(.*?)</script\s*>", re.IGNORECASE | re.DOTALL)


def test_site_inline_js_syntax() -> str:
    counts = {}
    with tempfile.TemporaryDirectory(prefix="krillion-site-js-") as td:
        temp = Path(td)
        for page in PAGES:
            path = REPO_ROOT / page
            require(path.exists(), f"missing page: {page}")
            blocks = SCRIPT_RE.findall(path.read_text(encoding="utf-8"))
            require(bool(blocks), f"no inline <script> blocks in {page}")
            counts[str(page)] = len(blocks)
            for i, code in enumerate(blocks, 1):
                target = temp / f"{page.as_posix().replace('/', '_')}_{i}.js"
                target.write_text(code, encoding="utf-8")
                node_check(target)
    return ", ".join(f"{name}({n} blocks)" for name, n in counts.items())
