# Krillion scrape notes (job scrape-001)

## Investigation (2026-11-20)

- Loaded https://playdaily.org/krillion in Chrome via `browse` MCP (tab `krillion-scrape`). Page loads normally, no login/captcha.
- It is **Krillion Unlimited** by Daily Games (playdaily.org), a Next.js app. Open prompts with 25 s each, Classic = 7 prompts per dive, Endless = one at a time.
- The FAQ states each prompt has its own bank of answers graded: Plankton (10), Too Clever (15), Schooler (30), Rare (60), Deep Cut (85), **One in a Krillion (100)**. Prompt bank is "thousands" of prompts.
- The question/answer data is NOT in the page HTML. I inspected the Next.js JS bundles and found the site's own JSON API:
  - `POST /api/krillion/deal` body `{"mode":"classic"}` → `{prompts:[{id,text,level}...], tickets:{id:ticket}, lap}`. Unthrottled; each call deals 7 new prompts.
  - `GET /api/krillion/answers?prompt=<promptId>&ticket=<ticket>` → `{"answers":[[tierIndex,"answer text"], ...]}`. This is the graded bank (~60 answers per prompt). Tier indices: 0..5, where **5 = One in a Krillion (100 pts)**.
  - Rate limit: HTTP 425 `{"wait": <ms>}` — roughly 65 s between successful /answers calls; 403 `{"error":"no ticket"}` for a bad/missing ticket.
  - `POST /api/krillion/answer` gives a verdict for one guessed answer (not used for bulk harvesting).
- Harvest strategy: deal prompts via `/deal` (fast), then fetch each prompt's graded bank from `/answers` paced by the 425 `wait` value; append each graded answer as one JSONL line, `is_krillion=true` only when tierIndex===5.

## Evidence

- Verified `/answers` response for prompt `1viko16ceo9q` ("Name an animal"): 60 graded answers, including tier-5 answers Kinkajou, Nudibranch, Solenodon, Zorilla, Tenrec, Colugo, Babirusa, Tuatara, Hirola, Linsang.
