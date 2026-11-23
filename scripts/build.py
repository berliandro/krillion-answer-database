#!/usr/bin/env python3
"""Single reproducible build entry point.

    python scripts/build.py all | ingest | derive | emit | verify | publish

Every stage is deterministic: JSONL inputs and questions are sorted, JSON uses
stable separators, and no locale-dependent sorting is used. ``all`` runs
ingest -> derive -> emit -> verify -> publish and refuses to publish on a
verification failure.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import config as cfg
import derive
import emit
import ingest
import publish
import verify


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ingest", help="append-only JSONL -> Full DB + bank demotions")
    sub.add_parser("derive", help="delta materialisations + legacy DB rebuilds")
    pe = sub.add_parser("emit", help="manifest + generated JS + v2 arrays (staging)")
    pe.add_argument("--out-dir", type=Path, default=None)
    sub.add_parser("verify", help="read-only checks; never mutates data")
    pp = sub.add_parser("publish", help="atomically publish staged artefacts")
    pp.add_argument("--staging", type=Path, default=None)
    pa = sub.add_parser("all", help="ingest, derive, emit, verify, publish")
    pa.add_argument("--out-dir", type=Path, default=None)
    args = p.parse_args()

    if args.cmd == "ingest":
        ingest.import_answers()
    elif args.cmd == "derive":
        derive.derive_all()
    elif args.cmd == "emit":
        emit.emit(args.out_dir)
    elif args.cmd == "verify":
        return 0 if verify.verify()["ok"] else 1
    elif args.cmd == "publish":
        publish.publish_staged(args.staging)
    elif args.cmd == "all":
        staging = args.out_dir if args.out_dir is not None else cfg.STAGING
        ingest.init()
        ingest.import_answers()
        derive.derive_all()
        emit.emit(staging)
        if not verify.verify()["ok"]:
            print("build aborted: verification failed; nothing published")
            return 1
        publish.publish_staged(staging)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
