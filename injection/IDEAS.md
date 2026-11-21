# Idea parking lot

Ideas recorded but **not started**. Nothing here is implemented.

## Auto-play / coin-farming companion script

**Status:** parked (user asked to save the idea on 2026-11-21).
**Owner when started:** same `injection/` layer as the autofill userscript.

### The idea, restated from voice dictation

A second, toggleable script that plays Krillion automatically. When switched on,
it behaves according to a selected mode:

- **Classic** — start a dive and play straight through with no human input.
- **1 vs 1** — same: start and play straight through.
- **Multiplayer** — join the most populated open room/lobby it can find, then play.

For each prompt it detects the question, resolves all available answers, and
picks **one random answer from the best set — specifically a 100-point
("One in a Krillion") answer**, not a whole list.

It reuses the correction logic from the current autofill script:

- if a chosen answer scores less than 100, record the mismatch (demote it out of
  the rare tier, timestamped changelog);
- if Classic, after the dive fetch/expand the new answer banks and check for
  differences or data inconsistencies;
- log every change it makes.

The point is twofold: **farm depth tokens/coins** while **improving the answer
database** from real play.

### Notes for when this is picked up

- Build on `injection/bridge.py` (answer lookup, corrections, bank import,
  changelog) and `injection/krillion-autofill.user.js` (`SEL` selectors,
  prompt detection, score observer, queued writes). Do not duplicate them.
- "Most populated room" needs a source: the live room list endpoint or the
  lobby DOM. Verify which exists before designing.
- Picking a random 100-point answer needs the full rare-answer list for the
  detected prompt; the grouped/near-duplicate handling already in the bridge
  should feed it so it never mixes two prompts' banks.
- Decide failure behaviour: no 100-point answers for a prompt, answer refused,
  timer expiry, disconnect. Likely fall back to a known 85-point answer or pass.
- Respect the site's rate limits and fair-play/terms expectations — auto-play
  can look like botting. Keep the toggle explicit and human-controlled.
- Needs an on/off control in the injected panel plus a mode selector, and a
  visible "auto" state so the user always knows it is driving.

### Open questions

- Random pick: uniform over all 100-point answers, or weighted by something?
- Stop conditions: number of dives, time limit, token target, or manual only?
- Should 1v1/multiplayer skip bank capture (no expandable results) as the
  current script already does?
- Coin farming goal: is there a target balance, or run until stopped?
