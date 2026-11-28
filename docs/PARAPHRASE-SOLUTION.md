# Solving the paraphrase problem

## The problem

A player typed what Krillion shows, and the webapp failed to surface the right answer.
My investigation showed two distinct causes:

1. **Near-duplicate prompts are distinct games.** Krillion's bank contains separate prompt
   IDs such as `Name a Mario character` and `Name a character from Mario`, each with its own
   answer bank. Both were stored in the DB, but literal search could rank the wrong one first —
   or return nothing when the typed wording differed slightly.
2. **User-typed paraphrases.** Wording such as `Name any one famous park` or
   `Name a movie with a one word title` was not stored verbatim anywhere in the DB.

I confirmed the game itself does **not** paraphrase at display time: the bundle renders `prompt.text`
verbatim (module `981714`), and a live capture confirmed the DOM text equals the deal API's
`text` field byte for byte. So the fix had to live in the search layer, not in the data.

The site's own placeholder was a working reproduction of cause 2:

| What the player typed | What the DB stored | Old result |
| --- | --- | --- |
| `Name any one famous park` | `Name a famous park` | **no result** |
| `Give an example of a well-known park` | `Name a famous park` | **no result** |

`index.html`'s old `score()` required *every* typed word to be a substring of the stored
question, and the local webapp used FTS5 phrase/prefix matching. Both were
order-sensitive, gave no partial credit, and treated `name` and `park` as equally informative.

The archive itself contained evidence of natural variant wording, e.g.
`Name a clothing item for winter` / `Name an item of winter clothing`,
`Name a Mario character` / `Name a character from Mario`.

Near-duplicate pairs I found in the bank itself (finite, already in the DB):
`Name a clothing item for winter` / `Name an item of winter clothing`,
`Name a Mario character` / `Name a character from Mario`,
`Name a film with a one-word title` / `Name a film with a single-word title`,
`Name a sport played with a ball` / `Name a sport played without a ball`,
`Name a chemical element ending in -ium` / `not ending in -ium`, and others. The matcher
kept such look-alikes visibly separate via quoted-term matching and the negation guard, and
returned both answers when they were genuine aliases.

## Options investigated

| Approach | Fit for a static GitHub Pages site | Verdict |
| --- | --- | --- |
| **IDF-weighted token overlap + synonyms + trigrams** (zero deps, ~120 lines) | ~1–2 ms/search, no download, no key | ✅ **Chosen** |
| MiniSearch 7.2.0 (17.7 KB min / 5.7 KB gzip, BM25, `processTerm` hook) | Turnkey alternative; synonym handling must sit inside tokenization anyway | Viable, but hand-rolled gives tighter control over quoted terms and negation |
| Fuse.js 7.5.0 (9.4 KB gzip, token search) | No `processTerm` hook → preprocess needed; typo-focused rather than paraphrase-focused | Not needed |
| fuzzball 2.2.6 / fast-fuzzy 1.12.0 | Token-set ratios help word order, but no IDF and stale/heavier deps | Not needed |
| **In-browser sentence embeddings** (`@huggingface/transformers@4.3.2` + MiniLM q8) | Handles arbitrary semantic paraphrases, but first load ≈ **55 MB** (23 MB model + 27 MB ORT WASM + 3.9 MB embeddings + JS); tens–hundreds of ms inference per query | Optional fallback only — see below |
| Hosted embedding APIs (Gemini/Jina/HF) | Public API key in client JS, quota/privacy/latency issues | ❌ |

Verified sources: [transformers.js docs](https://huggingface.co/docs/transformers.js/index),
[dtypes](https://huggingface.co/docs/transformers.js/en/guides/dtypes),
[`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2),
[MiniSearch](https://lucaong.github.io/minisearch/),
[BM25](https://en.wikipedia.org/wiki/Okapi_BM25),
[soft TF-IDF (Cohen et al.)](https://www.cs.cmu.edu/~wcohen/postscript/kdd-2003-match-ws.pdf).

## The solution I shipped

I wrote `scripts/paraphrase_match.py` as the dependency-free reference implementation. I
mirrored the same algorithm in `scripts/build_static.py` (static site) and used it directly
in `webapp/app.py` (local server). The rule I applied was that the player's text is never
rewritten — only the *internal comparison form* was normalised.

I scored in this order:

1. **Normalisation** — lowercase, Unicode quotes/dashes, contractions (`you'd → you would`),
   punctuation, multi-word phrases (`one word → oneword`, `well known → wellknown`).
2. **Tokenisation** — quoted terms became `q:<term>` so `Name a word that can follow "star"`
   could not be confused with `Name a rock star`; light stemming; a small domain stop list
   (`a`, `an`, `any`, `one`, `of`, `name`, `give`, …) that removed paraphrase filler.
3. **Synonym canonicalisation** — `give/list/state → name`, `movie → film`,
   `well-known/notable → famous`, `item/thing → item`, `one-word/single-word`, `3D/three-dimensional`.
4. **IDF-weighted overlap** — `name` appeared in ~all 2,512 questions (low weight);
   `park` was rare (high weight). The score was the harmonic mean of query coverage and
   candidate precision, so a candidate with extra words was penalised.
5. **Trigram Dice** (12%) — typo/inflection rescue.
6. **Quote cross-match + negation guard** — `star` could match `"star"`, but `with` must not
   match `without`; a negation mismatch applied a 0.7 penalty.
7. **Relative cut-off** — I kept the best hit and genuine aliases (≥72% of the best score)
   and dropped loosely related questions.

## Verification

I ran the harness:

```powershell
python scripts/paraphrase_match.py
```

| Scorer | top-1 on `data/paraphrase_tests.json` (36 paraphrases + hard negatives) |
| --- | --- |
| Old literal `score()` | **26 / 36** |
| New paraphrase-tolerant matcher | **36 / 36** |

I verified in the browser on the rebuilt static page (Chrome, no console errors):

- `Name any one famous park` → single result `Name a famous park → Tsavo`
- `Give an example of a well-known park` → `Name a famous park → Tsavo`
- `Name a movie with a one word title` → `Name a film with a one-word title → Gummo`
- `Name a word after star` → `Name a word that can follow "star" → Fort`
- `Name a sport played without a ball` → correct hit only; `with a ball` is excluded
- `Name a DC villain` and `Name a DC superhero` remained distinct

The local webapp (`http://127.0.0.1:8765/api/search`) returned the same results.

## Optional: true semantic fallback

I noted that if Krillion later uses open-ended paraphrases that share no content words, the
lexical layer could be backed by embeddings:

- Build time: `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })`,
  embedding all 2,512 questions (`pooling: 'mean', normalize: true`, 384 dims), storing a
  `Float32Array` of **3,858,432 bytes** (`2512 × 384 × 4`).
- Runtime: import `@huggingface/transformers@4.3.2` from jsDelivr, embed the typed query
  lazily on first search, brute-force cosine (≈965k multiply-adds, single-digit ms), reuse
  the cached pipeline. I would prefer `Xenova/paraphrase-MiniLM-L3-v2` (17.4 MB) for mobile.
- I did **not** make this the default: first visit downloads ≈55 MB and inference is far
  slower than the lexical path. I would load it only when the lexical matcher has no
  confident hit.

I found no ANN library was needed at this corpus size (`hnswlib-wasm`, `faiss-wasm`, `usearch`
were evaluated and rejected as overkill / Node-only). Hosted embedding APIs were worse here
because a static site cannot hide an API key.
