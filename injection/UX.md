# P6-B — Phase 6 UX clarity audit

**Scope.** Static audit of the shipped panel in `injection/krillion-autofill.user.js` v1.1.4
(the only user-facing surface in my ownership). Branch `feat/p6-ux`, worktree `.worktrees/p6-ux`.
No bridge restart, no JS-behaviour change, no header/footer/ID/strategy change.

**Method / substitution (stated up front, per the Impeccable subagent directive).**
The `impeccable` skill was available and loaded; its context run and `craft-floor.md` were read,
and its mechanical detector was run once on the changed target. A live rendered verification
could **not** be performed: the panel only mounts on `playdaily.org/krillion` with `bridge.py`
running, and my contract forbids restarting the bridge or driving the game. I therefore
substituted a static inspection of the shipped CSS/markup plus computed WCAG contrast ratios
and the detector result. No screenshot or live-probe claim is made below.

**Outcome.** The panel already meets the brief (lavender→peach field, white cards, one violet
accent, AA text contrast, full reduced-motion path, 16 IDs). One CSS-only craft fix was applied;
all other findings are routed to the coordinator because they require JS behaviour changes.

---

## 1. Tool inventory — clutter cap

A **tool** is a user-operable control. Counted by distinct control role, not by DOM instance
(the N answer chips are one role). Count method is fixed here and reused in §5.

### 1.1 Interactive tools (7 roles)

| # | Control | Purpose | Essential? | Notes |
|---|---|---|---|---|
| T1 | `#ka-toggle` (Hide/Show) | Collapse the panel to its header so it never blocks the game | **Yes** | Window chrome; eye glyph + text. Only 2 states. |
| T2 | `#ka-auto` — "Dive on click" Off/On | Manual workflow: click a chip to fill, optionally auto-submit | **Yes** | Core answer-fill path; disabled while bot is on. |
| T3 | `#ka-bot` — "Play for me" Off/On | Start/stop full auto-play | **Yes** | Core auto-play feature; reveals T4/T5 while on. |
| T4 | `#ka-pick` select (random / top / god) | Choose the bot's answer-selection strategy | **Yes (conditional)** | Only visible while T3 is on (`#ka-botdeps`). Persisted. |
| T5 | `#ka-mode` select (classic / krillocity / marathon5 / showoff / duel) | Choose which game mode the bot drives | **Yes (conditional)** | Only visible while T3 is on. Persisted; logs `mode-change`. |
| T6 | `.ka-chip` answer buttons (N per prompt) | Fill the on-screen input with one known 100-point answer | **Yes** | The product's primary action. One role, dynamic count. |
| T7 | `#ka-foot a` GitHub link | Attribution / source | **No** | Only removable control; left in place — footer link is out of my edit scope. |

**Persistent tools:** T1, T2, T3, T7 = 4. **Conditional:** T4, T5 = 2.
**Dynamic role:** T6 = 1. **Total = 7 tool roles.**

### 1.2 Information surfaces (not tools — excluded from the tool count)

`#ka-count` (answer-count badge), `#ka-status` (live status), `#ka-botstate` (bot progress),
`#ka-botnote` (one-line explanation), `.ka-group` (labelled bank headers + match %).
These carry state only; none accepts input, so counting them as tools would inflate the clutter
measure. They are audited in §2–§4 instead.

### 1.3 Clutter rule

> **No new control without removing an obsolete one — net-zero clutter cap.**

Actions this phase: **0 controls added, 0 controls removed → delta 0.**
The only file change is one CSS declaration inside `GM_addStyle` (§5). No control, ID, label,
tooltip, aria attribute, or markup node was added or deleted.

The layout stays at five white cards on the gradient field (header, answers, Manual, Auto-play,
footer). With the bot off, Pick/Mode are hidden, so the steady state shows only two segment
toggles plus one note — not a cluttered mess. Keeping all seven tools is justified: each is
either the core answer action, a distinct mode of operation, or removable-only-by-coordinator
attribution.

---

## 2. Clarity findings

Severity: **H**igh / **M**edium / **L**ow. Resolution: **CSS-fixed** (done here),
**Recommended (JS)** (route to coordinator — I did not make the change), or **OK** (no defect).

| ID | Finding | Sev | Resolution | Detail |
|---|---|---|---|---|
| C1 | Footer link underline had no offset; the browser default sits tight to the descenders and reads as a smudge on the lavender→peach card | L | **CSS-fixed** | Added `text-underline-offset:2px` to the `#ka-foot a:hover,:focus-visible` rule inside `GM_addStyle`. Craft-floor "browser surfaces" item. |
| C2 | "Dive on click" is disabled while the bot runs, but the *reason* is only in `title` + `aria-disabled` — a sighted keyboard/mouse user sees a dimmed control with no visible explanation | M | **Recommended (JS)** | Needs a visible one-line state (e.g. a short `Paused while Play for me is on` caption or a status echo). CSS can restyle the dim state but cannot author meaningful copy. **Route to coordinator.** |
| C3 | `#ka-count` is an unlabelled violet pill with a dot and a number — the meaning of the number is not conveyed to AT and is ambiguous at a glance | M | **Recommended (JS)** | Give it `aria-label="N answers"` / `title`. CSS `::after` text would be visual-only and add clutter. **Route to coordinator.** |
| C4 | Changing Pick has no feedback beyond the select's own value; Mode logs `mode-change` but does not echo to `#ka-botstate`, which the next 500 ms tick overwrites | L | **Recommended (JS)** | Optional brief `status()`/bot-status echo on `change`. No data is lost — both values are persisted — so this is polish, not a defect. **Route to coordinator.** |
| C5 | Bot error paths render as plain text `error: …` inside `#ka-botstate`, whose green breathing dot still says "active" — colour and text disagree | M | **Recommended (JS)** | Needs a `data-error` hook on `#ka-botstate` (or reroute bot errors to `#ka-status[data-kind="error"]`). CSS-only cannot detect the condition. **Route to coordinator.** |
| C6 | Two auto-submit concepts ("Dive on click" and "Play for me") could read as duplicates to a first-time user | L | **OK** | Mitigated by the "Manual" / "Auto-play" group heads and `.ka-botnote`. No change; do not merge — they are genuinely different scopes (one chip vs whole dive). |
| C7 | `#ka-botstate` "Off · you are playing" repeats the T3 off state | L | **OK** | Benign redundancy: the same element carries live progress (`starting…`, `answered`, `waiting…`) while on, so it is a progress surface, not a duplicate label. |
| C8 | Section head "Known answers" sits above a paragraph, not above a heading | — | **OK** | It is a section label, not an Impeccable "kicker/eyebrow above a heading"; no craft-floor ban triggered. |
| C9 | Empty and error copy | — | **OK** | `No 100-point answers recorded for this prompt yet.` and `Can't reach the local archive. Start injection/bridge.py.` both name the problem and the recovery. Good. |
| C10 | Filled chip stays visibly selected after submission | — | **OK** | `loadAnswers()` → `render()` rebuilds all chips without `data-filled`, so the tag resets on the next prompt. No stale state. |

**Summary:** 1 CSS fix applied; 4 findings routed to the coordinator (all require JS); 5 confirmed OK.

---

## 3. Responsive feedback audit

| State | Visible feedback? | Where / evidence | Gap |
|---|---|---|---|
| **Hover** | Yes — all interactive tools | `#ka-toggle` bg→track-hover; `.ka-seg` track→track-hover; `.ka-chip` border `#c9bde3` + 1px lift + `var(--ka-lift)`; `select` border; footer link underline | None. |
| **Focus** | Yes — all interactive tools | `:focus-visible` 2px `var(--ka-accent)` outline, offset 2px (1px for selects) on toggle, seg, chip, select, footer link | `:focus` (pointer) is intentionally unstyled — correct modern pattern. |
| **Active / pressed** | Yes | `#ka-toggle:active` + `.ka-seg:active` scale .97; `.ka-chip:active` accent-soft + scale .985; `#ka-auto:active:not(:disabled)` / `#ka-bot:active` covered by `.ka-seg:active` | `select` has no custom `:active`; native popup supplies feedback. Low. |
| **Loading** | Yes | `#ka-status[data-kind="loading"]` violet text + pulsing dot; `#ka-botstate` text `starting…` / `loading answers` / `race: no more answers` | None. |
| **Success** | Yes | `#ka-status[data-kind="ok"]` green bold + enlarged dot; `#ka-count` violet pill + `ka-count-in`; chip check mask; `#ka-botstate[data-active=true]` green breathing dot | See C5 for the error-inside-active case. |
| **Error** | Yes in `#ka-status` | `[data-kind="error"]` red bold + enlarged dot (no-match, refused, offline, multi-bank auto pause) | Bot errors stay grey/green in `#ka-botstate` (C5). |
| **Filled (chip)** | Yes | `.ka-chip[data-filled=true]`: accent-soft bg, accent border, bold, right padding, check mask at full opacity, `ka-chip-set` 220 ms | None. |
| **Bot on** | Yes | `#ka-bot` thumb slides + `aria-pressed` + title flips; `#ka-botdeps` revealed; `#ka-auto` dimmed + `aria-disabled`; `#ka-botstate` green breathing dot | Disabled reason not visible (C2). |
| **Disabled** | Yes, but weak | `.ka-seg:disabled` opacity .55 + `cursor:not-allowed` | ≈2.2:1 effective text contrast — WCAG 1.4.3 exempts inactive controls, but legibility is poor; C2 asks for a visible reason. |
| **Empty** | Yes (extra state) | `.ka-empty` dashed track card, centred muted copy, `ka-surface-in` | None. |

**Coverage: 8/8 required states plus empty/disabled have visible feedback.** No state is silent.
All three gaps (C2, C4, C5) are JS-axis and routed to the coordinator.

---

## 4. Accessibility

### 4.1 Text contrast (computed WCAG 2.1 ratios)

Every pair below is an **actual** pairing used by the shipped CSS.

| Foreground / surface | Ratio | AA (4.5:1) |
|---|---|---|
| `--ka-ink #34313d` / card `#ffffff` | 12.71:1 | Pass |
| `--ka-muted #605d69` / card | 6.43:1 | Pass |
| `--ka-faint #66626f` / card | 5.93:1 | Pass |
| `--ka-accent-deep #5a3fa6` / card | 7.79:1 | Pass |
| `--ka-success #2e7d58` / card | 5.01:1 | Pass |
| `--ka-error #b4485a` / card | 5.23:1 | Pass |
| `--ka-muted` / accent-soft `#f4effc` | 5.69:1 | Pass |
| `--ka-faint` / accent-soft | 5.25:1 | Pass |
| `--ka-muted` / track `#eeecf3` | 5.49:1 | Pass |
| `--ka-faint` / track | 5.06:1 | Pass |
| `--ka-accent-deep` / accent-soft | 6.90:1 | Pass |

`--ka-success` on accent-soft is 4.44:1 (just under AA) **but is never rendered**: success text
appears only on the white card (5.01:1) and the green dot is a non-text indicator. No violation.

**Focus-ring contrast (non-text, needs 3:1):** accent `#7055bd` on card = 5.64:1; on track = 4.82:1. Pass.

### 4.2 Focus rings

2px solid `var(--ka-accent)` with `outline-offset:2px` (1px on selects) on every control:
`#ka-toggle`, `.ka-seg`, `.ka-chip`, `.ka-botrow select`, `#ka-foot a`.
In `@media (forced-colors: active)` all of these switch to `2px solid Highlight`. Pass.

### 4.3 Reduced motion

`@media (prefers-reduced-motion: reduce)` collapses **all seven** authored animations:
`ka-in`, `ka-surface-in`, `ka-load-pulse`, `ka-count-in`, `ka-chip-in`, `ka-chip-set`,
`ka-dot-breathe`. Transitions on toggle/seg/thumb/opt/chip/chip::after/select/status/dot are set
to `none`; hover/active transforms are reset to `none` with `box-shadow:none`.
Only `ka-in-quiet .12s` (opacity-only) remains on `#ka-root` — spatial movement is gone while
colour/state feedback (`data-kind`, `data-on`, `data-active`, `data-filled`) is retained, matching
the committed design intent. Pass.

### 4.4 Forced colors

Borders set to `CanvasText` on root, toggle, seg, chip and select; `.ka-seg-thumb` uses `Canvas`
with a `CanvasText` border and no shadow; status/bot-state dots use `Highlight`; focus rings use
`Highlight`. Pass by inspection. The monochrome mask icons inherit `currentColor`, so they should
follow `CanvasText`; this was **not** verified in a real high-contrast session (see method note).

### 4.5 ARIA names and live regions

- `#ka-root`: `role="region"`, `aria-label="Krillion rare answers"`.
- `#ka-title`: real `<h2>`; `#ka-toggle`: `aria-label` + `aria-controls="ka-body"` + `aria-expanded`, all flipped on collapse.
- `#ka-auto`: `aria-label` + `aria-pressed` + descriptive `title`; `#ka-bot`: same plus `aria-describedby="ka-botnote"`.
- `#ka-status`: `role="status"`, `aria-live="polite"`, `aria-atomic="true"` — status changes are announced.
- `#ka-pick` / `#ka-mode`: associated `<label for>` elements. Chips are `<button>`s whose text is the answer (good accessible name).
- Multi-bank headers carry `aria-label="Bank: … — N% match"`, so distinct banks are announced separately.

**Gap:** `#ka-count` has no accessible name (C3) — JS-axis, routed to the coordinator.
All other controls are named. No ARIA misuse found.

---

## 5. Before / after proof — no net increase

| Measure | Before (baseline v1.1.4) | After (this change) | Delta |
|---|---|---|---|
| Interactive tool roles (§1.1) | **7** | **7** | **0** |
| Persistent tools | 4 | 4 | 0 |
| Conditional tools | 2 | 2 | 0 |
| Dynamic tool roles (chips) | 1 | 1 | 0 |
| Controls added / removed | — | 0 / 0 | 0 |
| Registry markup IDs | 16 | 16 | 0 |
| `ka-root` (JS-assigned) | present | present | 0 |
| Header block (`@version`, credit, URLs, `@connect`, grants) | unchanged | unchanged | 0 |
| Footer link markup | unchanged | unchanged | 0 |
| `STRATEGY_CONFIG` / behaviour | unchanged | unchanged | 0 |

**Statement:** the tool count is **7 before and 7 after** — no net increase, satisfying the
clutter cap net-zero rule. No new control was introduced, so no obsolete control needed removal.

**Actual diff:** one CSS declaration inside `GM_addStyle` —
`text-decoration:underline` → `text-decoration:underline;text-underline-offset:2px`
on the footer-link hover/focus rule. Nothing else in the file changed.

**Verification evidence:**
- `node --check injection/krillion-autofill.user.js` → `NODE_CHECK=PASS`.
- Impeccable mechanical detector, run once on the changed target:
  `impeccable.cmd detect --json injection/krillion-autofill.user.js` → `[]` (clean).
- `grep` of `id="ka-…"` in markup → exactly 16 matches (the full registry set); `ka-root` is
  assigned at line 617 and untouched.
- Contrast and focus-ring ratios computed directly from the shipped token values (§4.1).
