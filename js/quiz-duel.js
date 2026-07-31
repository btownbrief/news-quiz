// Pure, game-specific pieces of News Quiz duels. The room payload identifies
// the current edition and pins its question order to a seed. Both phones run
// these same functions, so no device-local randomness can change the quiz.

const MAX_SEED = 0xffffffff;

export function validateDuelPayload(payload, currentEdition, questionCount) {
  if (!payload || payload.edition !== currentEdition) {
    const err = new Error('stale_challenge');
    err.code = 'stale_challenge';
    throw err;
  }
  if (!Number.isInteger(payload.seed) || payload.seed < 0 || payload.seed > MAX_SEED) {
    const err = new Error('bad_seed');
    err.code = 'bad_seed';
    throw err;
  }
  if (!Number.isInteger(questionCount) || questionCount < 1) {
    const err = new Error('empty_challenge');
    err.code = 'empty_challenge';
    throw err;
  }
  return payload;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export function questionsForDuel(allQuestions, currentEdition, payload) {
  validateDuelPayload(payload, currentEdition, allQuestions.length);
  const ordered = [...allQuestions];
  const random = seededRandom(payload.seed);
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  return ordered;
}

// Duel result contract. Timing is self-reported by each phone; that is an
// accepted friends-game tradeoff, just as it is in the fleet reference.
export function makeDuelResult(answerResults, elapsedMs) {
  const answers = answerResults.map((result) => !!result.correct);
  return {
    score: answers.filter(Boolean).length,
    total: answers.length,
    ms: Math.max(0, Math.round(elapsedMs)),
    answers,
  };
}

export function makeDuelForfeit(total) {
  return {
    score: 0,
    total,
    ms: 60000,
    answers: Array.from({ length: total }, () => false),
    forfeit: true,
  };
}

// Positive means the first result wins, negative means the second wins.
// More correct answers wins; equal scores go to the faster time; otherwise draw.
export function compareDuelResults(first, second) {
  if (!!first.forfeit !== !!second.forfeit) return first.forfeit ? -1 : 1;
  if (first.forfeit && second.forfeit) return 0;
  if (first.score !== second.score) return first.score > second.score ? 1 : -1;
  if (first.ms !== second.ms) return first.ms < second.ms ? 1 : -1;
  return 0;
}
