# PROCESS REPORT — paraphrase-duplicate audit

Generated: 2026-11-28T01:57:04.645969+00:00

I ran a read-only audit. I rewrote no raw JSONL, demoted no answer, and applied no alias.

## Counts

- Full DB rows: 127135; distinct stored prompts: 6154
- Graded-bank prompt strings (learned source api/own): 3698
- TRIVIAL prompt pairs (same normalised key, different stored wording): 0
  - of which both strings are game-graded: 0
- ANSWER-VARIANT pairs (same prompt, same normalised answer): 0
- PARAPHRASE pairs from aliases: 10187
  - both strings game-graded: 477
  - negation traps flagged: 0
- alias pairs already trivial after normalisation: 29
- tier disagreements (100 vs <100) under paraphrase groups: 2
- proposed paraphrase groups (link only): 477

## TRIVIAL prompt examples (up to 20)

| key | stored A | stored B | both graded |
| --- | --- | --- | --- |

## ANSWER-VARIANT examples (up to 20)

| prompt | normalised answer | stored A | stored B |
| --- | --- | --- | --- |

## PARAPHRASE examples (up to 20)

| canonical | variant | score | both graded | negation trap |
| --- | --- | --- | --- | --- |
| What's an example of a movie with a single-word title? | Name an example of a film with a one-word title | 0.9079 | False | False |
| What's an example of a movie with a single-word title? | Name an example of a film with a single-word title | 0.9356 | False | False |
| What's an example of a movie with a single-word title? | Name an example of a movie with a one-word title | 0.9395 | False | False |
| What's an example of a movie with a single-word title? | Name an example of a movie with a single-word title | 0.9665 | False | False |
| What's an example of a movie with a single-word title? | Name any film with a one-word title | 0.8559 | False | False |
| What's an example of a movie with a single-word title? | Name any film with a single-word title | 0.8879 | False | False |
| What's an example of a movie with a single-word title? | Name any movie with a one-word title | 0.8853 | False | False |
| What's an example of a movie with a single-word title? | Name any movie with a single-word title | 0.9167 | False | False |
| What's an example of a movie with a single-word title? | Name any one film with a one-word title | 0.8547 | False | False |
| What's an example of a movie with a single-word title? | Name any one film with a single-word title | 0.8819 | False | False |
| What's an example of a movie with a single-word title? | Name any one movie with a one-word title | 0.8837 | False | False |
| What's an example of a movie with a single-word title? | Name any one movie with a single-word title | 0.9093 | False | False |
| What's an example of a movie with a single-word title? | Name one film with a one-word title | 0.8598 | False | False |
| What's an example of a movie with a single-word title? | Name one film with a single-word title | 0.8879 | False | False |
| What's an example of a movie with a single-word title? | Name one movie with a one-word title | 0.8902 | False | False |
| What's an example of a movie with a single-word title? | Name one movie with a single-word title | 0.9167 | False | False |
| What's an example of a movie with a single-word title? | What's an example of a film with a one-word title? | 0.9439 | False | False |
| What's an example of a movie with a single-word title? | What's an example of a film with a single-word title? | 0.97 | False | False |
| What's an example of a movie with a single-word title? | What's an example of a movie with a one-word title? | 0.9745 | False | False |
| What's an example of a Christmas movie? | Name an example of a Christmas film | 0.9189 | False | False |

## Tier disagreements (I reported them only — I never demoted)

- `What's something you find in a living room?` ↔ `Name one thing you find in a living room` answer `Name one thing you find in a living room` tiers [0, 1]
- `What's an example of a one-word band name?` ↔ `Name an example of a one-word band name` answer `What's an example of a one-word band name?` tiers [0, 1]

## Proposed paraphrase groups (graded pairs, link only)

| group_id | canonical | variant | score | negation |
| --- | --- | --- | --- | --- |
| pg-0001 | What's an example of a Christmas movie? | Name one Christmas film | 0.8306 | False |
| pg-0002 | What's an example of a Marvel movie? | Name one Marvel film | 0.8125 | False |
| pg-0003 | What's an example of a country located in Africa? | Name one country located in Africa | 0.9066 | False |
| pg-0004 | What's an example of a movie about a wedding? | Name one movie about a wedding | 0.8986 | False |
| pg-0005 | What's an example of a movie about space? | Name any one film about space | 0.8429 | False |
| pg-0006 | What's an example of a movie character? | Name an example of a movie character | 0.9567 | False |
| pg-0007 | What's an example of a movie that has a sequel? | What's an example of a film that has a sequel? | 0.9618 | False |
| pg-0008 | What's an example of a movie villain? | What's an example of a film villain? | 0.9555 | False |
| pg-0009 | What's an example of a river located in North America? | Name one river located in North America | 0.9185 | False |
| pg-0010 | What's an example of a romantic movie? | Name an example of a romantic film | 0.9167 | False |
| pg-0011 | What's an example of a romantic movie? | Name any romantic movie | 0.873 | False |
| pg-0012 | What's an example of a vehicle that doesn't travel on whe... | Name any vehicle that doesn't travel on wheels | 0.9357 | False |
| pg-0013 | What's an example of an animal that can fly but isn't a b... | Name any animal that can fly but isn't a bird | 0.9388 | False |
| pg-0014 | What's an example of an item of clothing? | Name an example of an article of clothing | 0.9097 | False |
| pg-0015 | What's an example of a city? | Name any US city | 0.8068 | False |
| pg-0016 | What's an example of a novel? | Name an example of a novel | 0.9409 | False |
| pg-0017 | What's an example of a novel? | Name one book | 0.7619 | False |
| pg-0018 | What's an example of a novel? | What's an example of a book? | 0.9518 | False |
| pg-0019 | What's an example of a plant? | Name an example of a flower | 0.8839 | False |
| pg-0020 | What's an example of a plant? | Name an example of a plant | 0.9409 | False |
| … | (457 more in the JSON artifact) | | | |

## Decisions I left to the user (STOP)

- I left open whether to merge PARAPHRASE banks (NOT done here — the game treats them as separate banks).
- I left open whether Search DB should hold one answer per paraphrase group (NOT done here).
- I left open whether to apply any alias to the matcher (NOT done here; aliases stay log-only).

I allowed automatic applications per the directive: TRIVIAL prompt and ANSWER-VARIANT
cleanup, non-destructively in the import/derive layer, preserving original strings.
