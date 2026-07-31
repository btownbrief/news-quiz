// News Quiz duel wiring test: drives the real vendored duel client
// (js/duel.js → js/rooms.js) against the local rooms shim as two phones.
//
//   node scripts/test-duel.mjs

import { readFile } from 'node:fs/promises';
import { createRooms } from './rooms-shim.mjs';
import {
  questionsForDuel, makeDuelResult, makeDuelForfeit, compareDuelResults,
} from '../js/quiz-duel.js';

const GAME = 'news-quiz';
const editionData = JSON.parse(
  await readFile(new URL('../data/questions.json', import.meta.url), 'utf8'),
);
const mainSource = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

/* ------------------------------------------------- two-phone environment */

const stores = new Map();
let current = 'A';
globalThis.localStorage = {
  getItem: (key) => (stores.get(current).has(key) ? stores.get(current).get(key) : null),
  setItem: (key, value) => stores.get(current).set(key, String(value)),
  removeItem: (key) => stores.get(current).delete(key),
};
function device(id) {
  if (!stores.has(id)) stores.set(id, new Map());
  current = id;
}
device('A');
device('B');

let passed = 0;
function t(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok — ${label}`);
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    t(false, `${label} (no error thrown)`);
  } catch (error) {
    t(error && error.code === code, `${label} (got ${error && error.code})`);
  }
}

const shim = createRooms();
globalThis.BTOWN_ROOMS_URL = 'http://rooms.test';
globalThis.fetch = async (url, init = {}) => {
  const match = String(url).match(/\/rest\/v1\/rpc\/(\w+)$/);
  if (!match || !shim.rpcs[match[1]]) {
    return new Response(JSON.stringify({ message: 'not a room rpc' }), { status: 404 });
  }
  try {
    const body = shim.rpcs[match[1]](JSON.parse(init.body || '{}')) ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ message: error.message }), {
      status: error.rpc ? 400 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
const { Duel, savedSession } = await import('../js/duel.js');

/* ------------------------------------------------------------ the tests */

const PAYLOAD = { edition: editionData.edition, seed: 0x5eed2026 };
const phoneAQuestions = questionsForDuel(
  structuredClone(editionData.questions), editionData.edition, PAYLOAD,
);
const phoneBQuestions = questionsForDuel(
  structuredClone(editionData.questions), editionData.edition, PAYLOAD,
);
t(
  JSON.stringify(phoneAQuestions) === JSON.stringify(phoneBQuestions),
  'same edition + seed produces identical question content and order on both phones',
);
t(
  phoneAQuestions.length === editionData.questions.length,
  'duel contains every question from the current edition',
);
t(
  /function savePlayed\(obj\)[\s\S]*!DUEL_REQUESTED[\s\S]*localStorage\.setItem\(PLAYED_KEY/.test(mainSource),
  'weekly played-record write is gated out of duel mode',
);
t(
  /async function submitOnce\(record\)[\s\S]*DUEL_REQUESTED[\s\S]*await submitScore/.test(mainSource),
  'monthly score submission is gated out of duel mode',
);
t(
  /if \(DUEL_REQUESTED\) \{[\s\S]*duelSubmit\(makeDuelResult[\s\S]*return;[\s\S]*savePlayed\(record\)/.test(mainSource),
  'duel finish returns before the weekly record is saved',
);
t(
  /function showDuelDone\(\) \{\s*if \(!duel \|\| !duel\.isComplete\(\)\) return;/.test(mainSource),
  'rival correctness rows cannot render until both results are complete',
);
const requiredIds = [
  'duelBtn', 'hostBtn', 'joinBtn', 'rejoinBtn', 'onlinePanel', 'opTitle',
  'opName', 'opCodeWrap', 'opCode', 'opError', 'opGo', 'opCancel', 'lobby',
  'lobbyCode', 'lobbyCancel', 'duelBar', 'duelDone', 'duelDoneHead',
  'duelDoneRows', 'duelRematchBtn', 'duelExitBtn',
];
t(
  requiredIds.every((id) => htmlSource.includes(`id="${id}"`)),
  'fleet smoke-test element ids are all present',
);

device('A');
const host = await Duel.create({ game: GAME, name: 'Ada', payload: PAYLOAD });
t(/^[A-Z2-9]{4}$/.test(host.code) && host.status === 'waiting', 'host opens a challenge');
t(savedSession(GAME)?.roomId === host.match.roomId, 'host session saved');

device('B');
const guest = await Duel.join({ game: GAME, code: host.code.toLowerCase(), name: 'Bea' });
t(
  guest.status === 'playing' &&
    guest.payload.edition === PAYLOAD.edition &&
    guest.payload.seed === PAYLOAD.seed,
  'guest joins with the identical edition and shuffle seed',
);

device('A');
await host.match._fetch();
t(host.status === 'playing' && host.others()[0].name === 'Bea', 'host sees the challenge start');

const hostResult = makeDuelResult(
  [{ correct: true }, { correct: true }, { correct: false }, { correct: true }, { correct: true }],
  41782,
);
const guestResult = makeDuelResult(
  [{ correct: true }, { correct: true }, { correct: false }, { correct: true }, { correct: true }],
  46301,
);
t(
  JSON.stringify(Object.keys(hostResult)) === JSON.stringify(['score', 'total', 'ms', 'answers']),
  'result shape is score, total, milliseconds, and per-question correctness',
);
t(compareDuelResults(hostResult, guestResult) > 0, 'equal score is decided by faster time');
t(
  compareDuelResults(
    makeDuelResult([{ correct: true }], 59000),
    makeDuelResult([{ correct: false }], 1000),
  ) > 0,
  'higher score beats a faster lower score',
);
t(compareDuelResults(hostResult, { ...hostResult }) === 0, 'equal score and time is a draw');
t(
  compareDuelResults(makeDuelForfeit(editionData.questions.length), guestResult) < 0,
  'an explicit forfeit is always a losing result',
);

// Submit concurrently: the version lock forces one phone to retry and merge.
device('A');
const pushA = host.submitResult(hostResult);
device('B');
const pushB = guest.submitResult(guestResult);
await Promise.all([pushA, pushB]);
device('A');
await host.match._fetch();
device('B');
await guest.match._fetch();
t(host.isComplete() && guest.isComplete(), 'both results merge despite concurrent submission');
t(host.status === 'over' && guest.status === 'over', 'completed duel is marked over');
t(
  host.others()[0].result.answers.join(',') === guestResult.answers.join(',') &&
    guest.others()[0].result.answers.join(',') === hostResult.answers.join(','),
  'each phone receives the rival correctness dots only in the completed result',
);

// Results are write-once.
await host.submitResult(makeDuelResult(
  editionData.questions.map(() => ({ correct: true })),
  1,
));
device('B');
await guest.match._fetch();
t(guest.others()[0].result.ms === hostResult.ms, 'results are write-once');

// Rematch keeps the current edition but deals a new deterministic order.
const REMATCH = { edition: editionData.edition, seed: 0x12345678 };
device('B');
await guest.rematch(REMATCH);
device('A');
await host.match._fetch();
t(
  host.payload.seed === REMATCH.seed &&
    host.payload.edition === editionData.edition &&
    Object.keys(host.results).length === 0 &&
    host.status === 'playing',
  'rematch deals a new seed for the same current edition and clears results',
);

// Racing rematches converge on exactly one payload.
device('A');
const dealA = host.rematch({ edition: editionData.edition, seed: 111 });
device('B');
const dealB = guest.rematch({ edition: editionData.edition, seed: 222 });
await Promise.all([dealA, dealB]);
device('A');
await host.match._fetch();
device('B');
await guest.match._fetch();
t(JSON.stringify(host.payload) === JSON.stringify(guest.payload), 'racing rematches converge');

// Resume after a refresh.
device('A');
const resumed = await Duel.resume({ game: GAME });
t(
  resumed.match.roomId === host.match.roomId &&
    JSON.stringify(resumed.payload) === JSON.stringify(host.payload),
  'resume reattaches to the same challenge',
);

// Leaving clears the session and strands the rival with a friendly code.
await resumed.leave();
t(savedSession(GAME) === null, 'leave clears the session');
device('B');
await guest.match._fetch();
t(guest.others()[0].left === true, 'rival sees that the host left');
await expectCode(
  guest.submitResult(guestResult),
  'opponent_left',
  'submission into an abandoned challenge explains the dead end',
);

console.log(`\nALL DUEL TESTS PASSED (${passed} checks)`);
process.exit(0);
