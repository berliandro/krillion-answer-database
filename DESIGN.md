# Design

## Visual world

A matte graphite answer desk. The page reads like an uncoated, well-made scorecard: low sheen, fine paper grain, no glass, no neon, no glow. The surface is a deep neutral with the slight warmth of graphite rather than a blue-black screen. It is used beside a live game, so the world stays quiet and the state does the talking.

## Color strategy

Restrained: neutrals tinted from the world, plus a single brass accent. The accent appears only where something is chosen, rare, or actionable — the focused result, the rare tier, links between the two sites, and the copy confirmation. Success uses a desaturated sage so brass stays the only attention color.

| Role | OKLCH | Hex fallback | Job |
| --- | --- | --- | --- |
| canvas | `oklch(0.24 0.012 250)` | `#15181c` | matte ground |
| surface | `oklch(0.29 0.014 250)` | `#1d2228` | elevated panel |
| surface-2 / hover | `oklch(0.35 0.016 250)` / `oklch(0.41 0.018 250)` | `#262d34` / `#313a43` | chips and controls |
| text / text-2 | `oklch(0.94 0.01 90)` / `oklch(0.78 0.018 250)` | `#eceee9` / `#b4bcc0` | primary and secondary |
| action / focus / rare | `oklch(0.82 0.10 75)` | `#e0ae6a` | the single brass accent (lifted so hover text clears 4.5:1) |
| success | `oklch(0.84 0.07 155)` | `#9fc6a8` | copy confirmation |
| line / line-strong | `oklch(0.38 0.014 250)` / `oklch(0.49 0.016 250)` | `#343c44` / `#4d5a63` | separators and borders |

Every token has a hex fallback inside an `@supports (color: oklch(...))` guard, so older browsers keep the same world.

## Matte finish

The background carries a fine grain made with SVG `feTurbulence` (fractal noise, `baseFrequency=0.85`, three octaves, `stitchTiles=stitch`) encoded as a data URI. It is a fixed, non-interactive overlay blended with `mix-blend-mode: soft-light` at `opacity: .055`. No animated texture, no blur, no gloss layer. Elevation is a single soft, low-alpha shadow — never a hard offset block. Research basis: [MDN feTurbulence](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feTurbulence) and [MDN mix-blend-mode](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/mix-blend-mode).

## Type and motion

One system stack, one fixed role scale; display 1.9rem/650, answers 1rem/600, prompt heads 1rem/650, metadata .8rem with tabular numerals. Motion is limited to the copy confirmation and the bounded "Show more" stagger; reduced motion removes spatial movement while retaining color feedback.

## Adaptation

## Switching system

The two sites remain separate pages and data sets, but the switch button never navigates. Both datasets are fetched once into an in-memory `CACHE`; switching swaps the rendered view, title, heading, subhead, examples and URL (`history.pushState`), so returning to the first view is instant and makes no second request. Browser Back/Forward is handled by `popstate` without a reload. The local webapp hides the switch because it is a different shell. A view-specific query is kept in the cache, so returning restores what the user was searching for.

Phone-first details: no `autofocus` (the keyboard stays closed until the player taps), the search field carries `enterkeyhint="search"` and disables autocapitalise/correct/spellcheck, and it sticks to the top while results scroll. On coarse pointers every control is at least 44px, the view switch is fixed near the bottom in thumb reach, touch `:active` feedback is explicit, and the safe-area inset is reserved. Verified at 320, 390 and 844×390 with touch emulation; physical-device touch remains untested.

Base styles target the narrow phone. At 560px the pages tighten padding and the display steps down to 1.65rem. From 768px the rare-answers list becomes two reading columns; from 1024px the container grows to 1080px so those columns keep a comfortable measure. The grid uses `minmax(0, 1fr)` tracks so a long answer can never widen the page — this fixed a real overflow at 320px. Under `(pointer: coarse)` every interactive target — copy icon, answer row, example chip, dismiss, button, input — is at least 44px. Viewports use `viewport-fit=cover` and the shell reserves `env(safe-area-inset-*)` for notches and home indicators.
