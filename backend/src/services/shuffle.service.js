// Dedicated Deterministic Shuffling Service for Aspire.
// Implements unbiased Fisher-Yates shuffling powered by a cryptographically seeded
// deterministic pseudo-random number generator (SHA-256 Counter DRNG).
// Guarantees 100% reproducible question and option permutations for attempts.

const crypto = require('crypto');

/**
 * Generate a cryptographically secure random seed.
 * Never exposed to candidate clients; persisted on the attempt record.
 * @returns {string} 64-character hex seed
 */
function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a deterministic PRNG using SHA-256 in counter mode.
 * Given identical seed, always emits the exact same sequence of floats in [0, 1).
 *
 * @param {string} seed
 * @returns {() => number} deterministic generator
 */
function createPrng(seed) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('Deterministic PRNG requires a valid seed string');
  }

  let counter = 0;
  let buffer = Buffer.alloc(0);
  let offset = 0;

  return function prng() {
    if (offset + 4 > buffer.length) {
      buffer = crypto.createHash('sha256')
        .update(seed)
        .update(':')
        .update(String(counter++))
        .digest();
      offset = 0;
    }
    const val = buffer.readUInt32BE(offset);
    offset += 4;
    return val / 0x100000000;
  };
}

/**
 * Pure Fisher-Yates (Knuth) shuffle algorithm.
 * Guarantees unbiased permutations without modifying the source array.
 *
 * @template T
 * @param {T[]} array
 * @param {() => number} prng
 * @returns {T[]} new shuffled array
 */
function fisherYatesShuffle(array, prng) {
  if (!Array.isArray(array)) return [];
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr;
}

/**
 * Generate complete deterministic shuffle metadata for an attempt.
 *
 * @param {Object} params
 * @param {Array<{id: number, type: string, options?: Array, section_id?: number}>} params.questions
 * @param {boolean} [params.shuffleQuestions=true]
 * @param {boolean} [params.shuffleOptions=true]
 * @param {string} [params.seed]
 * @returns {{
 *   seed: string,
 *   questions: number[],
 *   options: Record<string, number[]>,
 *   sections: Record<string, number[]>
 * }}
 */
function generateShuffleMap({ questions = [], shuffleQuestions = true, shuffleOptions = true, seed = null }) {
  const chosenSeed = seed || generateSeed();
  const prng = createPrng(chosenSeed);

  // Group questions by section if available
  const sectionGroups = new Map();
  for (const q of questions) {
    const secKey = String(q.section_id || 'default');
    if (!sectionGroups.has(secKey)) sectionGroups.set(secKey, []);
    sectionGroups.get(secKey).push(q.id);
  }

  const sectionsMap = {};
  const orderedQuestionIds = [];

  for (const [secKey, qids] of sectionGroups.entries()) {
    const shuffledSecQids = shuffleQuestions ? fisherYatesShuffle(qids, prng) : qids.slice();
    sectionsMap[secKey] = shuffledSecQids;
    orderedQuestionIds.push(...shuffledSecQids);
  }

  // If questions weren't grouped by section, shuffle globally
  const finalQuestionIds = sectionGroups.size <= 1 && shuffleQuestions
    ? fisherYatesShuffle(questions.map(q => q.id), prng)
    : orderedQuestionIds;

  // Build option permutation map for MCQs
  const optionsMap = {};
  for (const q of questions) {
    const isMcq = q.type === 'mcq' || q.type === 'MCQ';
    if (isMcq) {
      let optCount = 0;
      if (Array.isArray(q.options)) {
        optCount = q.options.length;
      } else if (typeof q.options_json === 'string') {
        try { optCount = JSON.parse(q.options_json).length; } catch {}
      }

      if (optCount > 0) {
        const indices = Array.from({ length: optCount }, (_, i) => i);
        const perm = shuffleOptions ? fisherYatesShuffle(indices, prng) : indices;
        optionsMap[String(q.id)] = perm;
        // Also map numeric id for seamless lookup
        optionsMap[q.id] = perm;
      }
    }
  }

  return {
    seed: chosenSeed,
    questions: finalQuestionIds,
    options: optionsMap,
    sections: sectionsMap,
    ...optionsMap
  };
}

/**
 * Translates candidate's display option index back to original logical question index.
 *
 * Example:
 * Original options: ["A", "B", "C", "D"], correct_index = 1 ("B")
 * Permutation map: [2, 0, 3, 1] => display order: ["C", "A", "D", "B"]
 * Candidate selects display index 3 ("B").
 * reverseOptionIndex(3, [2, 0, 3, 1]) returns 1 => matches correct_index!
 *
 * @param {number|string} displayIndex
 * @param {number[]} optionPermutationMap
 * @returns {number} original zero-based index
 */
function reverseOptionIndex(displayIndex, optionPermutationMap) {
  const idx = Number(displayIndex);
  if (isNaN(idx)) return -1;
  if (!Array.isArray(optionPermutationMap) || idx < 0 || idx >= optionPermutationMap.length) {
    return idx; // fallback if no permutation applied
  }
  return optionPermutationMap[idx];
}

module.exports = {
  generateSeed,
  createPrng,
  fisherYatesShuffle,
  generateShuffleMap,
  reverseOptionIndex
};
