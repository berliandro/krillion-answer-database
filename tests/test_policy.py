#!/usr/bin/env python3
"""Policy guards: only bank-authoritative records may demote a 100-point answer."""
from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path

from _common import add_scripts_to_path, require

add_scripts_to_path()

import config as cfg  # noqa: E402  (scripts/ is on sys.path by design)
import derive  # noqa: E402
import ingest  # noqa: E402


def test_policy_constants_and_pure_guard() -> str:
    require(
        cfg.BANK_AUTHORITATIVE_MODES.isdisjoint(cfg.PLAY_MODES),
        "BANK_AUTHORITATIVE_MODES overlaps PLAY_MODES",
    )
    require(cfg.REMOVAL_ACTIONS == frozenset({"remove", "demote"}), "unexpected REMOVAL_ACTIONS")

    accepted = 0
    for mode in cfg.BANK_AUTHORITATIVE_MODES:
        for action in cfg.REMOVAL_ACTIONS:
            require(
                derive.is_bank_authoritative({"action": action, "mode": mode}),
                f"bank-authoritative record rejected: mode={mode!r} action={action!r}",
            )
            accepted += 1
    rejected = 0
    for mode in cfg.PLAY_MODES:
        require(
            not derive.is_bank_authoritative({"action": "remove", "mode": mode}),
            f"play mode accepted as bank-authoritative: {mode!r}",
        )
        rejected += 1
    for action in ("add", "keep", "note", "evidence"):
        require(
            not derive.is_bank_authoritative({"action": action, "mode": "bank"}),
            f"non-removal action accepted: {action!r}",
        )
        rejected += 1
    require(
        derive.is_bank_authoritative({"action": " REMOVE ", "mode": " Dive-End "}),
        "guard does not normalise case/whitespace",
    )

    # The real corrections log (if any) may contain only authoritative records.
    real = derive.read_jsonl(cfg.CORRECTIONS)
    bad = [r for r in real if not derive.is_bank_authoritative(r)]
    require(not bad, f"{len(bad)} non-authoritative records in {cfg.CORRECTIONS}")

    return (
        f"{len(cfg.BANK_AUTHORITATIVE_MODES)} bank modes accepted ({accepted} combos), "
        f"{rejected} play/non-removal records rejected, {len(real)} real corrections clean"
    )


def test_policy_demotion_probe() -> str:
    with tempfile.TemporaryDirectory(prefix="krillion-policy-") as td:
        probe = Path(td) / "corrections.jsonl"
        probe.write_text(
            json.dumps({"question": "Q", "answer": "A", "action": "remove", "mode": "play"})
            + "\n"
            + json.dumps({"question": "Q", "answer": "B", "action": "remove", "mode": "bank"})
            + "\n",
            encoding="utf-8",
        )
        with sqlite3.connect(":memory:") as c:
            c.execute("CREATE TABLE answers(question TEXT, answer TEXT, is_krillion INTEGER)")
            c.execute("INSERT INTO answers VALUES('Q', 'A', 1)")
            c.execute("INSERT INTO answers VALUES('Q', 'B', 1)")
            demoted = ingest.apply_bank_demotions(c, probe)
            tiers = dict(c.execute("SELECT answer, is_krillion FROM answers").fetchall())
    require(demoted == 1, f"expected exactly 1 bank demotion, got {demoted}")
    require(tiers == {"A": 1, "B": 0}, f"play answer demoted or bank answer kept: {tiers}")
    return "play record rejected, bank record demoted (in-memory DB probe)"
