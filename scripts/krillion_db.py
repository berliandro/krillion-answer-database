#!/usr/bin/env python3
"""Thin legacy alias for the reproducible build (see scripts/build.py).

The old CLI is unchanged for PROCESS-LOG.md compatibility:
  init | import | rebuild | search TERM [-n N] | krillion-only | stats

All behaviour now lives in scripts/ingest.py and scripts/derive.py.
"""
import argparse

import derive
import ingest


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("import")
    sub.add_parser("rebuild")
    sub.add_parser("krillion-only")
    s = sub.add_parser("search")
    s.add_argument("term")
    s.add_argument("-n", "--limit", type=int, default=10)
    sub.add_parser("stats")
    args = p.parse_args()

    if args.cmd == "init":
        ingest.init()
    elif args.cmd == "import":
        ingest.import_answers()
        derive.rebuild()
        derive.build_krillion_only()
    elif args.cmd == "rebuild":
        derive.rebuild()
    elif args.cmd == "krillion-only":
        derive.build_krillion_only()
    elif args.cmd == "search":
        derive.search(args.term, args.limit)
    elif args.cmd == "stats":
        derive.stats()


if __name__ == "__main__":
    main()
