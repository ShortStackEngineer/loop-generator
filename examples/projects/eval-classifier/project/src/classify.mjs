// The MODEL under optimization — the only file the loop's agent should edit.
// Everything else (the eval harness, the datasets) is guarded.
//
// Goal: classify a short review as "positive" or "negative". `classify(text)`
// MUST return exactly one of those two strings for any input, and must not throw.
//
// This starting point is a lexicon classifier with an empty lexicon, so it falls
// through to the default and predicts "positive" every time — which scores a poor
// macro-F1 on the held-out set (the negative class gets an F1 of 0). That's the
// RED baseline the loop is meant to move off of.
//
// How to improve it (inspect data/train.jsonl for the vocabulary and phrasing):
//   - Grow POSITIVE and NEGATIVE with the polarity words that actually appear.
//   - Handle negation ("not good", "wouldn't recommend") by flipping the sign of
//     the following word — a few holdout items depend on it.
//   - Tune the tie-break default.
// Do NOT touch eval/ or data/ — the run guards them and will fail as
// `evaluator-tampered` if they change.

const POSITIVE = new Set([
  // e.g. "great", "love", "excellent" — fill this in from the training data.
]);

const NEGATIVE = new Set([
  // e.g. "terrible", "hate", "broken" — fill this in from the training data.
]);

const NEGATORS = new Set(["not", "no", "never", "n't"]);

/**
 * @param {string} text
 * @returns {"positive" | "negative"}
 */
export function classify(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z']+/g, " ")
    .trim()
    .split(/\s+/);

  let score = 0;
  let negate = false;
  for (const w of words) {
    if (NEGATORS.has(w)) {
      negate = true;
      continue;
    }
    let hit = 0;
    if (POSITIVE.has(w)) hit = 1;
    else if (NEGATIVE.has(w)) hit = -1;
    if (hit !== 0) {
      score += negate ? -hit : hit;
      negate = false;
    }
  }

  // Tie / no signal falls through to this default.
  return score < 0 ? "negative" : "positive";
}
