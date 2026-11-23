#!/usr/bin/env python3
"""Atomic, lock-protected publication of generated build artefacts.

A simple O_EXCL lock file prevents two builds from interleaving. Files are
published with os.replace() so readers never see a partially written artefact.
Staging lives outside the repo on the same volume (see config.py); if a build
is redirected to another volume, a same-volume temp copy is used before the
final replace.
"""
from __future__ import annotations

import os
import shutil
import time
from contextlib import contextmanager
from pathlib import Path

import config as cfg

STALE_SECONDS = 600


@contextmanager
def build_lock():
    cfg.BUILD_DIR.mkdir(parents=True, exist_ok=True)
    fd = None
    for _ in range(2):
        try:
            fd = os.open(cfg.LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, f"{os.getpid()}\n".encode("ascii"))
            break
        except FileExistsError:
            age = time.time() - cfg.LOCK.stat().st_mtime
            if age < STALE_SECONDS:
                raise RuntimeError(
                    f"build lock held: {cfg.LOCK} (age {age:.0f}s); "
                    "another build is running"
                )
            cfg.LOCK.unlink(missing_ok=True)
    try:
        yield
    finally:
        if fd is not None:
            os.close(fd)
        cfg.LOCK.unlink(missing_ok=True)


def _atomic_move(src: Path, dst: Path) -> None:
    if not src.exists():
        raise FileNotFoundError(f"staged artefact missing: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(src, dst)
    except OSError as exc:
        # WinError 17 / errno 18: cross-volume rename. Copy inside the
        # destination directory, then replace there.
        if getattr(exc, "winerror", None) == 17 or getattr(exc, "errno", None) == 18:
            tmp = dst.with_name(dst.name + ".publishing")
            shutil.copy2(src, tmp)
            os.replace(tmp, dst)
            src.unlink(missing_ok=True)
        else:
            raise


def publish_staged(staging: Path | None = None) -> list[str]:
    """Move manifest, generated JS and v2 arrays into their final paths."""
    staging = Path(staging) if staging is not None else cfg.STAGING
    names = [
        cfg.MANIFEST.relative_to(cfg.ROOT),
        cfg.NORM_JS.relative_to(cfg.ROOT),
        Path(cfg.V2_SEARCH_JSON),
        Path(cfg.V2_KRILLION_JSON),
    ]
    with build_lock():
        for rel in names:
            _atomic_move(staging / rel, cfg.ROOT / rel)
    published = [str(rel).replace("\\", "/") for rel in names]
    print(f"published: {', '.join(published)}")
    return published
