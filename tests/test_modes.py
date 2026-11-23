#!/usr/bin/env python3
"""Dependency-free regression tests for the two mode-fix contracts.

Spec: injection/CONTRACT-MODES.md (frozen).  These tests assert the *post-merge*
shape of injection/krillion-autofill.user.js at source level so a future edit
cannot silently regress either mode.

Stream gating note
------------------
This worktree (feat/mode-tests) may be merged *after* these tests are written,
so its userscript can still be pre-merge.  Stream A / Stream B checks are
enforced whenever that stream's post-merge symbols are present; when a stream's
symbols are entirely absent the checks are reported as PENDING (pre-merge)
rather than as false failures.  A normal regression (removing a guard but
leaving the surrounding stream code) still flips the check to FAIL.
Shared invariants always run.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import CheckFailure, REPO_ROOT  # noqa: E402

SCRIPT = REPO_ROOT / "injection" / "krillion-autofill.user.js"

# The 16 DOM ids created by the userscript's root.innerHTML template.
REQUIRED_IDS = {
    "ka-head", "ka-title", "ka-count", "ka-toggle", "ka-body", "ka-status",
    "ka-list", "ka-botbar", "ka-auto", "ka-bot", "ka-botstate", "ka-botnote",
    "ka-botdeps", "ka-pick", "ka-mode", "ka-foot",
}

# Tokens that, when they appear before restartFromResults() in the classic
# results flow, mean the restart is genuinely gated on bank-capture completion
# (await / .then / a settled/capturing/sent flag, or a bounded setTimeout wait).
# A bare `bankCapturePromise` reference is deliberately NOT enough: the promise
# must actually be awaited/settled, otherwise an ungated restart could regress
# while the identifier still appears in the function.
GUARD_RE = re.compile(
    r"\bawait\s|\.then\s*\(|\bPromise\b|\bsettled\b|"
    r"\bbankCapturing\b|\bbankSent\b|\bsetTimeout\s*\("
)

# A Stream B symbol is a camelCase race* helper or a snake_case race_* helper.
# Plain prose like 'race answer sent' must NOT count (that is pre-merge).
STREAM_B_SYMBOL_RE = re.compile(
    r"\brace[A-Z]\w*|\brace_(?:tick|step|burst|submit|answer|loop|fire)\b"
)


# --------------------------------------------------------------------------- #
# source helpers
# --------------------------------------------------------------------------- #
def _extract_function(src: str, name: str) -> str:
    """Return the full text of `function name(...) { ... }` (brace balanced)."""
    m = re.search(r"\bfunction\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", src)
    if not m:
        return ""
    i = m.end() - 1  # index of the opening brace
    depth = 0
    n = len(src)
    quote = None
    while i < n:
        c = src[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in ("'", '"', "`"):
            quote = c
            i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[m.start(): i + 1]
        i += 1
    return ""


def _named_functions(src: str, name_re: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen: set[int] = set()
    for m in re.finditer(r"\bfunction\s+(" + name_re + r")\s*\([^)]*\)\s*\{", src):
        if m.start() in seen:
            continue
        seen.add(m.start())
        body = _extract_function(src, m.group(1))
        if body:
            out.append((m.group(1), body))
    return out


def _strip_literals(text: str) -> str:
    """Blank out string/template literals and comments (keep newlines/length).

    Guard tokens must come from executable code, not from a log message like
    "capture settled before restart" which would otherwise fake a gate.
    """
    out: list[str] = []
    i, n, quote = 0, len(text), None
    while i < n:
        c = text[i]
        if quote:
            if c == "\\":
                out.append("  ")
                i += 2
                continue
            if c == quote:
                quote = None
                out.append(c)
                i += 1
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append("".join("\n" if text[k] == "\n" else " " for k in range(i, j)))
            i = j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join("\n" if text[k] == "\n" else " " for k in range(i, j)))
            i = j
            continue
        if c in ("'", '"', "`"):
            quote = c
            out.append(" ")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _race_region(src: str) -> str:
    parts = [
        _extract_function(src, "answerCurrentPrompt"),
        _extract_function(src, "resetBotRound"),
    ]
    parts += [body for _, body in _named_functions(src, r"race\w*")]
    return "\n".join(p for p in parts if p)


def _stream_a_present(src: str) -> bool:
    if re.search(r"\bbankCapturePromise\b|\bfunction\s+(?:finalize|classic)\w*\s*\(", src):
        return True
    # Fallback: the results branch itself is gated (even if named differently).
    bot = _extract_function(src, "botTick")
    m = re.search(r"if\s*\(\s*roundClosed\s*\)", bot)
    results = bot[m.start():] if m else ""
    return bool(re.search(r"\b(?:finalize|classic)\w*\s*\(", results)
                or GUARD_RE.search(_strip_literals(results)))


def _stream_b_present(src: str) -> bool:
    if STREAM_B_SYMBOL_RE.search(src):
        return True
    # Fallback: burst implemented inline in answerCurrentPrompt (no race* fn).
    return "lastSubmitAt" in src and re.search(r"lastSubmitAt[^\n]{0,40}700", src) is None


# --------------------------------------------------------------------------- #
# check helpers
# --------------------------------------------------------------------------- #
def _add(out: list[tuple[str, str, str]], name: str, ok: bool, detail: str,
         *, stream: str | None = None, stream_present: bool = True) -> None:
    if stream is not None and not stream_present:
        out.append(("PENDING", name, f"pre-merge ({stream} symbols absent): {detail}"))
    else:
        out.append(("PASS" if ok else "FAIL", name, detail))


def _check_invariants(src: str) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []

    ids = re.findall(r'\bid="([A-Za-z0-9_-]+)"', src)
    ok = len(ids) == len(REQUIRED_IDS) and len(set(ids)) == len(ids) and set(ids) == REQUIRED_IDS
    detail = ("16 unique ids" if ok else
              f"found {len(ids)} ids / {len(set(ids))} unique; "
              f"missing={sorted(REQUIRED_IDS - set(ids))}, extra={sorted(set(ids) - REQUIRED_IDS)}")
    _add(out, "shared: all 16 ids exactly once", ok, detail)

    m = re.search(r"//\s*==UserScript==(.*?)//\s*==/UserScript==", src, re.DOTALL)
    header = m.group(1) if m else ""
    missing = [tok for tok in ("@author", "berliandro", "@homepage",
                               "@downloadURL", "@updateURL", "@version") if tok not in header]
    for host in ("127.0.0.1", "localhost"):
        if not re.search(r"@connect\s+" + re.escape(host) + r"\s*$", header, re.MULTILINE):
            missing.append("@connect " + host)
    _add(out, "shared: header credits + @version + @connect", not missing,
         "missing: " + ", ".join(missing) if missing else
         "author/homepage/download/update/version + 127.0.0.1 & localhost present")

    foot_ok = bool(re.search(r'id="ka-foot"[^>]*>.*?github\.com/berliandro', src, re.DOTALL))
    _add(out, "shared: footer GitHub credit link", foot_ok,
         "ka-foot links github.com/berliandro" if foot_ok else "ka-foot GitHub link missing")

    bot = _extract_function(src, "botTick")
    race_calls = re.findall(r"\brace[A-Za-z0-9_]*\s*\(", bot)
    _add(out, "lanes: botTick has no Stream B race* helper call", not race_calls,
         "botTick calls: " + ", ".join(race_calls) if race_calls else "botTick clean of race* helpers")
    return out


def _check_classic(src: str, stream_present: bool) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []

    cap = _extract_function(src, "captureBanks")
    ok = "bankCapturing" in cap and "bankSent" in cap
    _add(out, "classic: captureBanks in-flight + idempotency guards", ok,
         "bankCapturing guard + bankSent signature guard" if ok else
         "missing bankCapturing and/or bankSent guard in captureBanks",
         stream="A", stream_present=stream_present)

    bot = _extract_function(src, "botTick")
    helpers = [body for _, body in _named_functions(src, r"(?:finalize|classic)\w*")]
    # The restart may be called directly from botTick's results branch or
    # delegated to a finalize*/classic* helper owned by Stream A.
    flow = bot + "\n" + "\n".join(helpers)
    starts = [m.start() for m in re.finditer(r"restartFromResults\s*\(", flow)]
    _add(out, "classic: single restartFromResults call site in restart flow", len(starts) == 1,
         f"found {len(starts)} restartFromResults() call(s) in botTick + finalize/classic helpers",
         stream="A", stream_present=stream_present)

    m = re.search(r"if\s*\(\s*roundClosed\s*\)", bot)
    results = bot[m.start():] if m else ""
    gated = False
    detail = "could not locate botTick's results branch"
    if m:
        # Shape 1: the results branch gates the restart itself.
        direct = results.find("restartFromResults(")
        if direct >= 0:
            gm = GUARD_RE.search(_strip_literals(results[:direct]))
            if gm:
                gated = True
                detail = f"gate token '{gm.group(0)}' precedes direct restartFromResults() in results branch"
        # Shape 2: the results branch delegates to a finalize*/classic* helper
        # that gates the restart on capture completion.
        if not gated:
            hm = re.search(r"\b((?:finalize|classic)\w*)\s*\(", results)
            if hm:
                hbody = _extract_function(src, hm.group(1))
                hr = hbody.find("restartFromResults(")
                gm = GUARD_RE.search(_strip_literals(hbody[:hr])) if hr >= 0 else None
                if hr >= 0 and gm:
                    gated = True
                    detail = (f"results branch delegates to {hm.group(1)}(); "
                              f"gate token '{gm.group(0)}' precedes its restartFromResults()")
        if not gated:
            detail = "results branch calls restartFromResults()/finalize* with NO capture gate before it"
    _add(out, "classic: results branch gated before restartFromResults", gated, detail,
         stream="A", stream_present=stream_present)

    notes = []
    if re.search(r"\bfunction\s+(?:finalize|classic)\w*\s*\(", src) or "bankCapturePromise" in src:
        notes.append("finalize/classic or bankCapturePromise signal present")
    if re.search(r"(?:capture[^\n]{0,60}restart|restart[^\n]{0,60}capture)", src, re.IGNORECASE):
        notes.append("capture-then-restart decision log present")
    if re.search(r"setTimeout\([^\n]{0,120}(?:capture|finalize|bank)", src, re.IGNORECASE):
        notes.append("bounded capture wait present")
    out.append(("INFO", "classic: bounded wait / finalize helper / decision log",
                "; ".join(notes) if notes else "not statically detected (informational)"))
    return out


def _check_race(src: str, stream_present: bool) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    region = _race_region(src)

    throttled = (re.search(r"lastSubmitAt[^\n]{0,60}700|700[^\n]{0,60}lastSubmitAt", region)
                 is not None or re.search(r"lastSubmitAt\s*<\s*700", src) is not None)
    _add(out, "race: no 700ms per-answer throttle", not throttled,
         "700ms race throttle still wired to lastSubmitAt" if throttled else
         "no 700ms race throttle remains",
         stream="B", stream_present=stream_present)

    keyed = bool(re.search(r"submittedForPrompt[^\n]{0,100}answer|answer[^\n]{0,100}submittedForPrompt", region))
    _add(out, "race: submittedForPrompt keyed by prompt + answer", keyed,
         "submittedForPrompt used with an answer key" if keyed else
         "no prompt+answer key usage of submittedForPrompt in race path",
         stream="B", stream_present=stream_present)

    race_fns = _named_functions(src, r"race\w*")
    schedulers = [name for name, body in race_fns if "setTimeout" in body]
    _add(out, "race: a race* helper self-schedules setTimeout", bool(schedulers),
         "self-scheduling helpers: " + ", ".join(schedulers) if schedulers else
         "no race* helper schedules its own next burst step",
         stream="B", stream_present=stream_present)

    tier_ok = "tierPremap" in region and "parseTierAnswers" in region
    _add(out, "race: lower-tier fallback via tierPremap/parseTierAnswers", tier_ok,
         "tierPremap + parseTierAnswers present in race path" if tier_ok else
         "missing tierPremap and/or parseTierAnswers in race path",
         stream="B", stream_present=stream_present)
    return out


# --------------------------------------------------------------------------- #
# public entry point
# --------------------------------------------------------------------------- #
def test_modes() -> str:
    """Run all mode-contract checks; raise CheckFailure on a genuine regression."""
    source = SCRIPT.read_text(encoding="utf-8")
    a = _stream_a_present(source)
    b = _stream_b_present(source)

    out: list[tuple[str, str, str]] = []
    out += _check_invariants(source)
    out += _check_classic(source, a)
    out += _check_race(source, b)

    print("mode-contract regression checks (injection/CONTRACT-MODES.md)")
    print(f"  Stream A post-merge symbols: {'present' if a else 'ABSENT (pre-merge)'}")
    print(f"  Stream B post-merge symbols: {'present' if b else 'ABSENT (pre-merge)'}")
    for status, name, detail in out:
        print(f"[{status}] {name}: {detail}")

    fails = [n for s, n, _ in out if s == "FAIL"]
    pending = [n for s, n, _ in out if s == "PENDING"]
    passed = len(out) - len(fails) - len(pending)
    summary = (f"Summary: {passed} PASS, {len(fails)} FAIL, "
               f"{len(pending)} PENDING (pre-merge)")
    print(summary)
    if fails:
        raise CheckFailure(summary + " -> " + ", ".join(fails))
    return summary


if __name__ == "__main__":
    try:
        test_modes()
    except CheckFailure:
        raise SystemExit(1)
