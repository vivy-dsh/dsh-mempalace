/**
 * Recall scoring: the four signals are cosine similarity, lexical overlap, stored
 * importance and recency. Weights are fixed so a ranking can be explained, and the
 * lexical fallback renormalizes the three signals that survive without a query vector
 * instead of inventing a cosine of zero.
 */

export const RECALL_WEIGHTS = Object.freeze({ cosine: 0.65, lexical: 0.15, importance: 0.1, recency: 0.1 })

/** Same three signals, renormalized to sum to 1 (0.15 + 0.10 + 0.10 = 0.35). */
export const KEYWORD_WEIGHTS = Object.freeze({
  cosine: 0,
  lexical: 0.15 / 0.35,
  importance: 0.1 / 0.35,
  recency: 0.1 / 0.35,
})

const RECENCY_HALF_LIFE_DAYS = 60
const PUNCTUATION = /[\s，。！？、；：""''（）()【】[\]{}·,.!?;:"'`~@#$%^&*+=|\\/<>-]+/g

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(PUNCTUATION, '')
}

/** Character bigrams; CJK text has no word boundaries, so bigrams are the cheap unit. */
export function bigrams(text) {
  const value = normalize(text)
  const grams = new Set()
  if (value.length === 1) grams.add(value)
  for (let index = 0; index + 1 < value.length; index += 1) grams.add(value.slice(index, index + 2))
  return grams
}

/** Jaccard overlap of character bigrams in `[0, 1]`. */
export function lexicalSimilarity(query, text) {
  const left = bigrams(query)
  if (left.size === 0) return 0
  const right = bigrams(text)
  if (right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** Exponential decay with a 60-day half-life; an unparseable date scores 0. */
export function recencyScore(timestamp, now = Date.now(), halfLifeDays = RECENCY_HALF_LIFE_DAYS) {
  const then = Date.parse(timestamp)
  if (!Number.isFinite(then)) return 0
  const days = Math.max(0, (now - then) / 86_400_000)
  return Math.exp(-days / halfLifeDays)
}

/**
 * @param signals - `{cosine, lexical, importance, recency}`, each clamped to `[0, 1]`.
 * @param weights - `RECALL_WEIGHTS` when a query vector exists, else `KEYWORD_WEIGHTS`.
 * @returns the weighted score in `[0, 1]`.
 */
export function scoreCandidate(signals, weights = RECALL_WEIGHTS) {
  const clamp = value => {
    const number = Number(value)
    if (!Number.isFinite(number)) return 0
    return Math.min(1, Math.max(0, number))
  }
  return clamp(
    clamp(signals.cosine) * weights.cosine
    + clamp(signals.lexical) * weights.lexical
    + clamp(signals.importance) * weights.importance
    + clamp(signals.recency) * weights.recency,
  )
}
