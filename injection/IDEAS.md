# Idea parking lot

Ideas I recorded but **did not start**. Nothing here was implemented as part of that parking lot.

## Auto-play / coin-farming companion script

**Status:** IMPLEMENTED 2026-11-21 — see the "Auto-play bot" section of `README.md`. I kept the spec below as the original request record.
**Owner when started:** I assigned the same `injection/` layer as the autofill userscript.

### The idea, restated from voice dictation

I imagined a second, toggleable script that played Krillion automatically. When switched on,
it would behave according to a selected mode:

- **Classic** — start a dive and play straight through with no human input.
- **1 vs 1** — same: start and play straight through.
- **Multiplayer** — join the most populated open room/lobby it could find, then play.

For each prompt it would detect the question, resolve all available answers, and
pick **one random answer from the best set — specifically a 100-point
("One in a Krillion") answer**, not a whole list.

I planned for it to reuse the correction logic from the current autofill script:

- if a chosen answer scored less than 100, record the mismatch (demote it out of
  the rare tier, timestamped changelog);
- if Classic, after the dive fetch/expand the new answer banks and check for
  differences or data inconsistencies;
- log every change it made.

My point was twofold: **farm depth tokens/coins** while **improving the answer
database** from real play.

### Notes I left for when this was picked up

- I built on `injection/bridge.py` (answer lookup, corrections, bank import,
  changelog) and `injection/krillion-autofill.user.js` (`SEL` selectors,
  prompt detection, score observer, queued writes). I did not duplicate them.
- "Most populated room" needed a source: the live room list endpoint or the
  lobby DOM. I verified which existed before designing.
- Picking a random 100-point answer needed the full rare-answer list for the
  detected prompt; I had the grouped/near-duplicate handling already in the bridge
  feed it so it never mixed two prompts' banks.
- I decided failure behaviour: no 100-point answers for a prompt, answer refused,
  timer expiry, disconnect. I would fall back to a known 85-point answer or pass.
- I kept within the site's rate limits and fair-play/terms expectations — auto-play
  could look like botting. I kept the toggle explicit and human-controlled.
- I gave it an on/off control in the injected panel plus a mode selector, and a
  visible "auto" state so I always knew it was driving.

### Questions I left open

- Random pick: uniform over all 100-point answers, or weighted by something?
- Stop conditions: number of dives, time limit, token target, or manual only?
- Should 1v1/multiplayer skip bank capture (no expandable results) as the
  current script already did?
- Coin farming goal: is there a target balance, or run until stopped?
