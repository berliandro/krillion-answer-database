# Krillion test suite

I wrote a real, committed, dependency-free test suite. It used no pytest, no npm
install, no network access, and made no writes to repository data.

**Setup I needed:** the SQLite databases were generated, not committed (they are
gitignored), and several tests opened them directly. After a fresh clone I ran:

```bat
python scripts/bootstrap.py --apply
```

before `run_all.py`. The suite itself had no third-party dependencies, but it
needed the generated DBs (`krillion_search.db`, `krillion_only.db`, ...) to exist.

I ran everything with:

```bat
python tests/run_all.py
```

I also used `python tests/run_all.py --verbose` when I wanted full tracebacks for
failures.

`run_all.py` printed one `PASS`/`FAIL` line per test, a final summary, and exited
non-zero if any test failed. I targeted a runtime under 60 seconds.

## What each test covers

| Test | File | Coverage |
| --- | --- | --- |
| `matcher.parity_recall` | `test_matcher.py` | I had it load the real `scripts/paraphrase_match.py`, build a `Matcher` from `krillion_search.db` (the same source `build.py verify` uses), and assert every one of the 36 cases in `data/paraphrase_tests.json` ranks its expected bank in the top 10. It reported recall@1/@3/@10; I required 36/36 recall@10. |
| `matcher.persisted_index_parity` | `test_matcher.py` | I had it load `data/matcher_index.json` with `Matcher.from_index()` and compare its `search()` output against a freshly built `Matcher` (questions from `krillion_only.db`) across all 36 cases and three `(limit, threshold)` combinations the bridge uses. It reported the exact comparison count (108 on the current repo). |
| `build.build_verify` | `test_build.py` | I ran `python scripts/build.py verify` as a subprocess; I required exit 0 and `[verify] RESULT: PASS`. I hashed all three DBs before and after to prove the check was read-only. |
| `bridge.bridge_endpoints` | `test_bridge.py` | Isolated bridge test. I had it copy the minimum repo files into a TemporaryDirectory, patch only the `PORT` line of the copied `bridge.py`, and start it on `127.0.0.1:8799` with `KRILLION_NO_FETCH=1`. The rule I applied was that the live bridge on **8768 is never contacted**. It asserted `/api/all` returns `version`, `etag`, and `nq` on items; `/api/answers` returns well-formed `groups[]`; `/api/answers-tier` and `/api/perf` respond; and a tokenless request returns 403. It always terminated the subprocess. |
| `userscript.userscript_static` | `test_userscript.py` | I ran `node --check injection/krillion-autofill.user.js`, confirmed all 16 DOM `id="..."` attributes were present exactly once, and confirmed the userscript header declares `@connect 127.0.0.1` and `@connect localhost`. |
| `site-js.site_inline_js_syntax` | `test_site_js.py` | I extracted every inline `<script>` block from `index.html`, `krillion/index.html`, and `webapp/index.html` into temporary `.js` files and ran `node --check` on each. |
| `policy.policy_constants_and_pure_guard` | `test_policy.py` | I checked `scripts/config.py` policy constants, that `BANK_AUTHORITATIVE_MODES` and `PLAY_MODES` are disjoint, and that `derive.is_bank_authoritative()` accepts every bank-mode/removal-action combination while rejecting play modes and non-removal actions. I also validated the real corrections log. |
| `policy.policy_demotion_probe` | `test_policy.py` | In-memory SQLite probe through `ingest.apply_bank_demotions()`: the rule I checked was that a play-mode record must not demote and a bank-mode record must demote. |
| `modes.test_modes` | `test_modes.py` | Source-level regression assertions I wrote for the two mode fixes: classic dive-end bank capture is gated before restart (bounded wait, idempotency, one gated restart in the finalize helper) and Krillocity bursts rare-then-low-tier answers without the 700 ms throttle, with per-prompt dedupe and self-scheduled re-entry. I also re-checked the shared IDs, header credit and footer link. |

## Design notes

- I used only the Python standard library. I checked JavaScript syntax with
  Node's built-in `node --check` (no packages).
- The matcher tests opened databases with SQLite's `mode=ro` URI.
- I put anything writable (bridge tree, extracted JS, policy probe files) in
  `tempfile.TemporaryDirectory()` and it was removed automatically.
- The tests asserted against the current repo state (with the generated DBs from
  `bootstrap.py --apply` present) and were deterministic: no random data, no live
  game API, no localhost 8768 traffic.
- `tests/mode_harness.js` was a supplementary Node harness (not called by
  `run_all.py`) that evaluated the userscript with stubbed GM/DOM globals and
  functionally drove both mode contracts, including advancing fake timers to
  prove the Krillocity burst submits distinct answers rapidly. I ran it with
  `node tests/mode_harness.js`.
