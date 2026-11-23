# Krillion test suite

A real, committed, dependency-free test suite. No pytest, no npm install, no
network access, and no writes to repository data.

**Prerequisite:** the SQLite databases are generated, not committed (they are
gitignored), and several tests open them directly. After a fresh clone, run:

```bat
python scripts/bootstrap.py --apply
```

before `run_all.py`. The suite itself has no third-party dependencies, but it
needs the generated DBs (`krillion_search.db`, `krillion_only.db`, ...) to exist.

Run everything:

```bat
python tests/run_all.py
```

Optional: `python tests/run_all.py --verbose` prints full tracebacks for failures.

`run_all.py` prints one `PASS`/`FAIL` line per test, a final summary, and exits
non-zero if any test failed. Target runtime is under 60 seconds.

## What each test covers

| Test | File | Coverage |
| --- | --- | --- |
| `matcher.parity_recall` | `test_matcher.py` | Loads the real `scripts/paraphrase_match.py`, builds a `Matcher` from `krillion_search.db` (the same source `build.py verify` uses), and asserts every one of the 36 cases in `data/paraphrase_tests.json` ranks its expected bank in the top 10. Reports recall@1/@3/@10; requires 36/36 recall@10. |
| `matcher.persisted_index_parity` | `test_matcher.py` | Loads `data/matcher_index.json` with `Matcher.from_index()` and compares its `search()` output against a freshly built `Matcher` (questions from `krillion_only.db`) across all 36 cases and three `(limit, threshold)` combinations the bridge uses. Reports the exact comparison count (108 on the current repo). |
| `build.build_verify` | `test_build.py` | Runs `python scripts/build.py verify` as a subprocess; requires exit 0 and `[verify] RESULT: PASS`. Hashes all three DBs before and after to prove the check is read-only. |
| `bridge.bridge_endpoints` | `test_bridge.py` | Isolated bridge test. Copies the minimum repo files into a TemporaryDirectory, patches only the `PORT` line of the copied `bridge.py`, and starts it on `127.0.0.1:8799` with `KRILLION_NO_FETCH=1`. The live bridge on **8768 is never contacted**. Asserts `/api/all` returns `version`, `etag`, and `nq` on items; `/api/answers` returns well-formed `groups[]`; `/api/answers-tier` and `/api/perf` respond; and a tokenless request returns 403. Always terminates the subprocess. |
| `userscript.userscript_static` | `test_userscript.py` | `node --check injection/krillion-autofill.user.js`, all 16 DOM `id="..."` attributes present exactly once, and the userscript header declares `@connect 127.0.0.1` and `@connect localhost`. |
| `site-js.site_inline_js_syntax` | `test_site_js.py` | Extracts every inline `<script>` block from `index.html`, `krillion/index.html`, and `webapp/index.html` into temporary `.js` files and runs `node --check` on each. |
| `policy.policy_constants_and_pure_guard` | `test_policy.py` | Checks `scripts/config.py` policy constants, that `BANK_AUTHORITATIVE_MODES` and `PLAY_MODES` are disjoint, and that `derive.is_bank_authoritative()` accepts every bank-mode/removal-action combination while rejecting play modes and non-removal actions. Also validates the real corrections log. |
| `policy.policy_demotion_probe` | `test_policy.py` | In-memory SQLite probe through `ingest.apply_bank_demotions()`: a play-mode record must not demote, a bank-mode record must demote. |
| `modes.test_modes` | `test_modes.py` | Source-level regression assertions for the two mode fixes: classic dive-end bank capture is gated before restart (bounded wait, idempotency, one gated restart in the finalize helper) and Krillocity bursts rare-then-low-tier answers without the 700 ms throttle, with per-prompt dedupe and self-scheduled re-entry. Also re-checks the shared IDs, header credit and footer link. |

## Design notes

- Only the Python standard library is used. JavaScript syntax is checked by
  Node's built-in `node --check` (no packages).
- Matcher tests open databases with SQLite's `mode=ro` URI.
- Anything writable (bridge tree, extracted JS, policy probe files) lives in
  `tempfile.TemporaryDirectory()` and is removed automatically.
- Tests assert against the current repo state (with the generated DBs from
  `bootstrap.py --apply` present) and are deterministic: no random data, no live
  game API, no localhost 8768 traffic.
- `tests/mode_harness.js` is a supplementary Node harness (not called by
  `run_all.py`) that evaluates the userscript with stubbed GM/DOM globals and
  functionally drives both mode contracts, including advancing fake timers to
  prove the Krillocity burst submits distinct answers rapidly. Run it with
  `node tests/mode_harness.js`.
