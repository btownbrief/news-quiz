// NEWS QUIZ — did you actually read this week's BTown Brief?
// Flat 5-question quiz on a single 60-second clock (mirrors the original
// Streamlit game), on the static Btown Games stack + shared Supabase board.
import { loadEdition } from './questions.js';
import {
  lbEnabled, getName, submitScore, renamePlayer, fetchTop, monthLabel, playerId,
} from './leaderboard.js';
import {
  Duel, savedSession as duelSavedSession, clearSession as duelClearSession,
  getName as duelGetName,
} from './duel.js';
import {
  questionsForDuel, makeDuelResult, makeDuelForfeit, compareDuelResults,
} from './quiz-duel.js';

const $ = (id) => document.getElementById(id);
const QUIZ_MS = 60000;          // one clock for the whole quiz
const POINTS_PER_Q = 200;       // + up to 60 speed bonus (seconds left at finish)
const PLAYED_KEY = 'news-quiz-played';
const DUEL_GAME = 'news-quiz';

const PAGE_PARAMS = new URLSearchParams(location.search);

// ?preview=1 lets the editor play/replay the current edition without saving
// state or touching the leaderboard — for checking a new edition before it ships.
const PREVIEW = PAGE_PARAMS.has('preview');
const DUEL_REQUESTED = PAGE_PARAMS.get('duel') === '1';

const VERDICTS = [
  [1000, 'Front-Page Reader 📰 You devour the Brief.'],
  [800, 'Well-Read Local 🗞️ Barely miss a word.'],
  [600, 'Solid Skimmer 👀 You caught the headlines.'],
  [400, 'Headline Tourist 🧳 Read a little closer.'],
  [200, 'Barely Opened It 📬'],
  [0, 'Did you even read the Brief? 📭'],
];

const FRIENDLY_DUEL_ERRORS = {
  not_found: 'That challenge has expired. Head back to this week’s quiz.',
  not_seated: 'This phone no longer has a seat in that challenge.',
  room_full: 'That challenge is already full.',
  room_started: 'That challenge already started without you.',
  not_ready: 'Friend challenges are not switched on yet — check back soon.',
  offline: 'The newsroom connection dropped. Your challenge is still saved.',
  opponent_left: 'Your rival left the challenge before the scores were compared.',
  stale_challenge: 'That challenge belongs to an earlier Brief and can no longer be played.',
  bad_seed: 'That challenge code carries a damaged quiz order.',
  empty_challenge: 'There are no published questions for this challenge.',
};

let edition = 'default';
let questions = [];
let qIndex = 0;
let results = [];      // [{ correct }]
let deadline = 0;
let timerInt = null;
let answered = false;
let finished = false;
let quizStartedAt = 0;
let duel = null;
let duelSubmitted = false;
let duelPendingResult = null;
let duelPanelIntent = 'host';
let duelSeats = 2;
let preserveDuelSession = false;
let visualRunId = 0;
let visualFrame = null;
const visualTimers = new Set();
let duelCompletionObserved = false;
let duelDoneRendered = false;
let revealCompletedDuel = false;
let duelReconnecting = false;
let activeResultReveal = null;
let suppressTransitionEffects = false;
let restoreTimer = null;

function beginVisualRun() {
  visualRunId++;
  visualTimers.forEach((timer) => clearTimeout(timer));
  visualTimers.clear();
  if (visualFrame !== null) cancelAnimationFrame(visualFrame);
  visualFrame = null;
  return visualRunId;
}

function visualDelay(callback, delay, runId) {
  const timer = setTimeout(() => {
    visualTimers.delete(timer);
    if (runId === visualRunId) callback();
  }, delay);
  visualTimers.add(timer);
}

function effectsSuppressed() {
  return suppressTransitionEffects || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(restoreTimer);
  if (!document.hidden) {
    restoreTimer = setTimeout(() => { suppressTransitionEffects = false; }, 300);
    return;
  }
  suppressTransitionEffects = true;
  if (answered && !finished && !$('gameScreen').classList.contains('hidden') &&
      $('reveal').classList.contains('hidden')) {
    beginVisualRun();
    $('choices').children[questions[qIndex].answer]?.classList.add('correct');
    $('reveal').classList.remove('hidden');
  }
  if (activeResultReveal) {
    const pending = activeResultReveal;
    revealResults(pending.record, pending.verdict, false, beginVisualRun());
  }
  if (duelDoneRendered) $('duelDone').classList.remove('duel-reveal');
});

// ------------------------------------------------------------ played-state
function loadPlayed() {
  try { return JSON.parse(localStorage.getItem(PLAYED_KEY)) || {}; } catch { return {}; }
}
function savePlayed(obj) {
  if (!PREVIEW && !DUEL_REQUESTED) {
    localStorage.setItem(PLAYED_KEY, JSON.stringify(obj));
  }
}

// ------------------------------------------------------------ boot
try {
  const ed = await loadEdition();
  edition = ed.edition;
  questions = ed.questions;
} catch (e) {
  $('introScreen').innerHTML = `<p class="load-err">Couldn't load this week's quiz (${e.message}). Try a refresh?</p>`;
  throw e;
}

if (questions.length === 0) {
  $('introScreen').innerHTML = `<p class="load-err">No questions published yet — check back after the next Brief.</p>`;
} else {
  $('qCount').textContent = questions.length;
  if (DUEL_REQUESTED) {
    const ready = await bootDuel();
    if (ready && !duelSubmitted) $('startBtn').addEventListener('click', startGame);
  } else {
    const played = loadPlayed();
    if (!PREVIEW && played.edition === edition) {
      // already played this edition — straight to results, no replay
      showResults(played, false);
    }
    $('startBtn').addEventListener('click', startGame);
  }
}

// ------------------------------------------------------------ game flow
function startGame() {
  qIndex = 0; results = []; finished = false;
  $('introScreen').classList.add('hidden');
  $('resultsScreen').classList.add('hidden');
  $('gameScreen').classList.remove('hidden');
  $('duelForfeitBtn').classList.toggle('hidden', !DUEL_REQUESTED);
  startTimer();
  showQuestion();
}

function startTimer() {
  clearInterval(timerInt);
  quizStartedAt = Date.now();
  deadline = Date.now() + QUIZ_MS;
  timerInt = setInterval(tick, 100);
  tick();
}
function tick() {
  const left = Math.max(0, deadline - Date.now());
  const fill = $('timerFill');
  fill.style.width = `${(left / QUIZ_MS) * 100}%`;
  fill.classList.toggle('hurry', left < 10000);
  const clock = $('clock');
  clock.textContent = Math.ceil(left / 1000);
  clock.classList.toggle('hurry', left < 10000);
  clock.classList.toggle('critical', left <= 3000);
  if (left <= 0 && !finished) timeUp();
}

function renderMomentum() {
  const row = $('momentum');
  row.classList.toggle('hidden', DUEL_REQUESTED);
  if (DUEL_REQUESTED) return;
  const pending = Math.max(0, questions.length - results.length);
  row.textContent = `${results.map((r) => (r.correct ? '🟩' : '🟥')).join('')}${'⬜'.repeat(pending)}`;
  row.setAttribute('aria-label', `${results.filter((r) => r.correct).length} correct after ${results.length} of ${questions.length} questions`);
}

function showQuestion() {
  beginVisualRun();
  answered = false;
  const q = questions[qIndex];
  $('reveal').classList.add('hidden');
  renderMomentum();
  $('qNum').textContent = `Q${qIndex + 1} / ${questions.length}`;
  $('qText').textContent = q.q;
  const box = $('choices');
  box.innerHTML = '';
  q.options.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'choice';
    b.textContent = c;
    b.addEventListener('click', () => answer(i));
    box.appendChild(b);
  });
}

function answer(choiceIdx) {
  if (answered || finished) return;
  answered = true;
  const runId = visualRunId;
  const q = questions[qIndex];
  const correct = choiceIdx === q.answer;
  const choices = [...$('choices').children];

  choices.forEach((b, i) => {
    b.disabled = true;
    if (i !== q.answer) b.classList.add('dim');
    if (i === choiceIdx && !correct) b.classList.add('wrong');
  });
  results.push({ correct });
  renderMomentum();

  const head = $('revealHead');
  if (correct) { head.textContent = '✅ Correct!'; head.className = 'good'; }
  else {
    head.textContent = choiceIdx === -1 ? '⏰ Skipped' : '❌ Not quite';
    head.className = 'bad';
  }
  $('revealAns').textContent = `Answer: ${q.options[q.answer]}`;
  $('nextBtn').textContent = qIndex === questions.length - 1 ? 'See your score 🏁' : 'Next question →';
  const showAnswer = () => {
    choices[q.answer].classList.add('correct', 'flare');
    $('reveal').classList.remove('hidden');
  };
  if (effectsSuppressed()) showAnswer();
  else visualDelay(showAnswer, 140, runId);
}

$('nextBtn').addEventListener('click', () => {
  if (finished) return;
  if (qIndex < questions.length - 1) { qIndex++; showQuestion(); }
  else finishQuiz();
});

function timeUp() {
  // clock ran out — count anything not yet answered as missed, then score.
  while (results.length < questions.length) results.push({ correct: false });
  finishQuiz();
}

function finishQuiz() {
  if (finished) return;
  finished = true;
  clearInterval(timerInt);
  const correctCount = results.filter((r) => r.correct).length;
  if (DUEL_REQUESTED) {
    const elapsed = Math.min(QUIZ_MS, Math.max(0, Date.now() - quizStartedAt));
    void duelSubmit(makeDuelResult(results, elapsed));
    return;
  }
  const secondsLeft = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
  // speed bonus only rewards a finished quiz; capped by the clock (≤60)
  const bonus = correctCount === questions.length ? secondsLeft : 0;
  const score = correctCount * POINTS_PER_Q + bonus;
  const squares = results.map((r) => (r.correct ? '🟩' : '🟥')).join('');

  const record = { edition, score, correct: correctCount, total: questions.length, squares, bonus, submitted: false };
  savePlayed(record);
  showResults(record, true);
}

// ------------------------------------------------------------ results
function showResults(record, justFinished) {
  const runId = beginVisualRun();
  $('introScreen').classList.add('hidden');
  $('gameScreen').classList.add('hidden');
  $('resultsScreen').classList.remove('hidden');

  const verdict = VERDICTS.find(([min]) => record.score >= min)[1];
  $('scoreDetail').textContent =
    `${record.correct} / ${record.total} correct${record.bonus ? ` · +${record.bonus} speed bonus` : ''}`;
  revealResults(record, verdict, justFinished, runId);

  startCountdownNote();
  updateLeaderboard(justFinished ? record : loadPlayed());
}

function revealResults(record, verdict, animate, runId) {
  const score = $('finalScore');
  const squares = $('squares');
  const verdictBox = $('verdict');
  verdictBox.classList.remove('verdict-in');
  if (!animate || effectsSuppressed()) {
    activeResultReveal = null;
    score.textContent = record.score;
    squares.textContent = record.squares || '';
    verdictBox.textContent = verdict;
    return;
  }

  score.textContent = '0';
  squares.textContent = '';
  verdictBox.textContent = '';
  activeResultReveal = { record, verdict };
  const started = performance.now();
  const count = (now) => {
    if (runId !== visualRunId) return;
    const progress = Math.min(1, (now - started) / 650);
    score.textContent = Math.round(record.score * (1 - ((1 - progress) ** 3)));
    if (progress < 1) {
      visualFrame = requestAnimationFrame(count);
      return;
    }
    visualFrame = null;
    revealResultSquare(record.squares || '', 0, verdict, runId);
  };
  visualFrame = requestAnimationFrame(count);
}

function revealResultSquare(resultSquares, index, verdict, runId) {
  if (runId !== visualRunId) return;
  const marks = [...resultSquares];
  if (index >= marks.length) {
    activeResultReveal = null;
    $('verdict').textContent = verdict;
    $('verdict').classList.add('verdict-in');
    return;
  }
  const mark = document.createElement('span');
  mark.className = 'result-square';
  mark.textContent = marks[index];
  $('squares').appendChild(mark);
  visualDelay(() => revealResultSquare(resultSquares, index + 1, verdict, runId), 95, runId);
}

$('shareBtn').addEventListener('click', async () => {
  const r = loadPlayed();
  const text = `Btown News Quiz 🗞️\n${r.squares} ${r.score} pts\nDid you read the Brief? play.btownbrief.com/news-quiz/`;
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      $('shareDone').classList.remove('hidden');
      setTimeout(() => $('shareDone').classList.add('hidden'), 1600);
    }
  } catch { /* cancelled */ }
});

function startCountdownNote() {
  $('nextNote').textContent = 'New quiz every edition — Mondays & Fridays with the Brief.';
}

// ------------------------------------------------------------ leaderboard
const lbBox = $('lb'), lbList = $('lbList'), lbStatus = $('lbStatus');
const lbForm = $('lbForm'), lbNameInput = $('lbNameInput');
const lbThisBtn = $('lbThisBtn'), lbLastBtn = $('lbLastBtn'), lbRenameBtn = $('lbRenameBtn');
let lbMonthOffset = 0;

if (!DUEL_REQUESTED && lbEnabled()) {
  lbBox.classList.remove('hidden');
  lbThisBtn.textContent = `🏆 ${monthLabel(0)}`;
  lbLastBtn.textContent = monthLabel(-1);
}

async function submitOnce(record) {
  if (PREVIEW || DUEL_REQUESTED || !record) return;
  const played = loadPlayed();
  if (!played || played.submitted || played.score <= 0 || !getName()) return;
  await submitScore(played.score);
  played.submitted = true;
  savePlayed(played);
}

async function updateLeaderboard(record) {
  if (DUEL_REQUESTED || !lbEnabled()) return;
  if (!getName()) {
    lbForm.classList.remove('hidden');
    lbRenameBtn.classList.add('hidden');
    lbStatus.textContent = 'Pick a name to join the monthly leaderboard!';
    lbList.innerHTML = '';
    return;
  }
  try { await submitOnce(record); } catch { /* offline */ }
  renderBoard();
}

async function renderBoard() {
  lbForm.classList.add('hidden');
  lbRenameBtn.classList.remove('hidden');
  lbStatus.textContent = 'Loading…';
  try {
    const rows = await fetchTop(lbMonthOffset);
    const me = playerId();
    lbList.innerHTML = '';
    rows.slice(0, 10).forEach((r, i) => {
      const li = document.createElement('li');
      if (r.player_id === me) li.className = 'me';
      const medal = ['🥇', '🥈', '🥉'][i];
      li.innerHTML = '<span class="rank"></span><span class="nm"></span><span class="sc"></span>';
      li.querySelector('.rank').textContent = medal || `${i + 1}.`;
      li.querySelector('.nm').textContent = r.name;
      li.querySelector('.sc').textContent = r.score;
      lbList.appendChild(li);
    });
    const myRank = rows.findIndex((r) => r.player_id === me);
    lbStatus.textContent = rows.length === 0
      ? 'No scores yet this month — be the first!'
      : myRank >= 0 ? `You're #${myRank + 1} of ${rows.length} this month` : '';
  } catch {
    lbStatus.textContent = 'Leaderboard unavailable (offline?)';
  }
}

$('lbSaveBtn').addEventListener('click', async () => {
  if (DUEL_REQUESTED) return;
  const name = lbNameInput.value.trim();
  if (!name) { lbNameInput.focus(); return; }
  try {
    await renamePlayer(name);
    await submitOnce(loadPlayed());
  } catch { /* offline */ }
  renderBoard();
});
lbNameInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') $('lbSaveBtn').click();
});
lbRenameBtn.addEventListener('click', () => {
  lbNameInput.value = getName();
  lbForm.classList.remove('hidden');
  lbRenameBtn.classList.add('hidden');
  lbNameInput.focus();
});
lbThisBtn.addEventListener('click', () => {
  lbMonthOffset = 0;
  lbThisBtn.classList.add('sel'); lbLastBtn.classList.remove('sel');
  renderBoard();
});
lbLastBtn.addEventListener('click', () => {
  lbMonthOffset = -1;
  lbLastBtn.classList.add('sel'); lbThisBtn.classList.remove('sel');
  renderBoard();
});

// ------------------------------------------------------------ keyboard
// 1-4 answer; Enter/Space advances after a reveal. Ignored while typing.
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ($('gameScreen').classList.contains('hidden')) return;
  if (!$('reveal').classList.contains('hidden')) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('nextBtn').click(); }
    return;
  }
  const n = Number(e.key);
  if (n >= 1 && n <= 4) answer(n - 1);
});

// ------------------------------------------------------------ duel mode
// The duel payload is { edition, seed }. The edition pins the current quiz
// content and the seed pins question order. Duel results are isolated room
// state only: { score, total, ms, answers }, plus a forfeit flag when someone
// explicitly leaves early. Weekly record and leaderboard paths are gated above.

function duelFriendly(err) {
  if (err && err.code === 'wrong_game') {
    const game = String(err.detail || 'another game').replace(/-/g, ' ');
    return `That code belongs to ${game}, not the News Quiz.`;
  }
  return (err && FRIENDLY_DUEL_ERRORS[err.code]) || 'The newsroom hit a snag. Please try again.';
}

function randomDuelPayload() {
  const seed = new Uint32Array(1);
  crypto.getRandomValues(seed);
  return { edition, seed: seed[0] };
}

function duelUrl() {
  return '?duel=1';
}

function duelActive() {
  return DUEL_REQUESTED && duel !== null;
}

function sameDuelPayload(first, second) {
  return first?.edition === second?.edition && first?.seed === second?.seed;
}

function prepareDuelIntro() {
  $('duelBtn').classList.add('hidden');
  document.querySelector('.kicker').textContent = 'BTOWN GAMES · HEAD-TO-HEAD EDITION';
  document.querySelector('.lede').textContent = 'Who read this week’s Brief more closely?';
  const rules = [...document.querySelectorAll('.rules li')];
  rules[0].textContent = `🗞️ ${questions.length} current questions in one shared order`;
  rules[1].textContent = '⏱️ 60 seconds — most correct wins, then fastest time';
  rules[2].textContent = '🛡️ This challenge will not use up or replace your weekly play';
  $('startBtn').textContent = 'Start the challenge';
  $('duelIntroExitBtn').classList.remove('hidden');
}

function renderDuelBar(note = '') {
  if (!duel) return;
  const rivals = duel.others();
  const who = rivals.length
    ? `vs ${rivals.map((rival) => rival.name).join(' + ')}`
    : 'waiting for your rivals';
  let status = note;
  if (!status && rivals.length && rivals.every((rival) => rival.left) && !duel.isComplete()) {
    status = ' — your rivals left';
  } else if (!status && duelSubmitted && !duel.isComplete()) {
    const out = rivals.filter((rival) => !rival.result && !rival.left).map((rival) => rival.name);
    status = out.length ? ` — waiting on ${out.join(' + ')}` : '';
  }
  $('duelBar').textContent = `⚔️ CHALLENGE ${duel.code} · ${who}${status}`;
  $('duelBar').classList.remove('hidden');
}

function duelDots(result) {
  return Array.isArray(result?.answers)
    ? result.answers.map((correct) => (correct ? '🟢' : '🔴')).join('')
    : '';
}

function formatDuelMs(ms) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(3)}s`;
}

function hideGameScreens() {
  $('introScreen').classList.add('hidden');
  $('gameScreen').classList.add('hidden');
  $('resultsScreen').classList.add('hidden');
}

function showDuelWaiting(result, message, retry = false) {
  beginVisualRun();
  hideGameScreens();
  $('duelDone').classList.add('hidden');
  $('duelWaitHead').textContent = retry ? 'Score not filed yet' : 'Your score is filed 🗞️';
  $('duelWaitDots').textContent = '';
  const out = duel ? duel.others()
    .filter((rival) => !rival.result && !rival.left)
    .map((rival) => rival.name || 'A rival') : [];
  $('duelWaitMsg').textContent = message || (out.length
    ? `${out.join(' + ')} ${out.length === 1 ? 'is' : 'are'} still taking the quiz.`
    : 'Waiting for the other racers to finish…');
  $('duelRetryBtn').classList.toggle('hidden', !retry);
  $('duelWait').classList.remove('hidden');
}

function showDuelProblem(err) {
  beginVisualRun();
  clearInterval(timerInt);
  finished = true;
  if (duel) duel.stop();
  preserveDuelSession = ![
    'not_found', 'not_seated', 'room_started', 'stale_challenge', 'opponent_left',
  ].includes(err?.code);
  hideGameScreens();
  $('duelWait').classList.add('hidden');
  $('duelDoneHead').textContent =
    err?.code === 'opponent_left' ? 'CHALLENGE ENDED' : 'CHALLENGE PAUSED';
  const rows = $('duelDoneRows');
  rows.innerHTML = '';
  const message = document.createElement('p');
  message.textContent = duelFriendly(err);
  rows.appendChild(message);
  $('duelRematchBtn').classList.add('hidden');
  $('duelExitBtn').textContent = 'Back to the weekly quiz';
  $('duelDone').classList.remove('hidden');
}

function appendDuelRow(container, label, result, winner) {
  const row = document.createElement('div');
  row.className = `duel-row${winner ? ' win' : ''}`;
  const name = document.createElement('span');
  name.textContent = label;
  const summary = document.createElement('span');
  summary.className = 'duel-result';
  summary.textContent = !result
    ? 'Did not finish'
    : result.forfeit
    ? 'Forfeited'
    : `${result.score}/${result.total} · ${formatDuelMs(result.ms)}`;
  const dots = document.createElement('span');
  dots.className = 'duel-dots';
  dots.textContent = duelDots(result);
  row.append(name, summary, dots);
  container.appendChild(row);
}

function showDuelDone() {
  if (!duel || !duel.isComplete()) return;
  if (duelDoneRendered) return;
  duelDoneRendered = true;
  beginVisualRun();
  duel.stop();
  clearInterval(timerInt);
  hideGameScreens();
  $('duelWait').classList.add('hidden');
  preserveDuelSession = false;

  const field = [
    { label: 'You', me: true, result: duel.myResult() },
    ...duel.others().map((rival) => ({
      label: rival.name || 'Rival', me: false, result: rival.result,
    })),
  ].sort((first, second) => {
    const firstDnf = !first.result || first.result.forfeit;
    const secondDnf = !second.result || second.result.forfeit;
    if (firstDnf !== secondDnf) return firstDnf - secondDnf;
    return firstDnf ? 0 : -compareDuelResults(first.result, second.result);
  });
  const best = field.find((racer) => racer.result && !racer.result.forfeit);
  const winners = best ? field.filter((racer) =>
    racer.result && !racer.result.forfeit &&
    compareDuelResults(racer.result, best.result) === 0) : [];
  $('duelDoneHead').textContent = winners.length === 0
    ? 'NO FINISHERS — CALL IT A DRAW 🗞️'
    : winners.length > 1
      ? 'DEADLINE DRAW! 🗞️'
      : winners[0].me
        ? 'YOU WIN THE HEADLINE! 🏆'
        : `${winners[0].label} wins this edition`;

  const rows = $('duelDoneRows');
  rows.innerHTML = '';
  for (const racer of field) {
    appendDuelRow(rows, racer.label, racer.result, winners.includes(racer));
  }
  $('duelDone').classList.toggle('duel-reveal', revealCompletedDuel);
  $('duelRematchBtn').classList.remove('hidden');
  $('duelRematchBtn').disabled = false;
  $('duelExitBtn').textContent = 'Back to the weekly quiz';
  $('duelDone').classList.remove('hidden');
}

function showNewlyCompletedDuel() {
  revealCompletedDuel = !duelCompletionObserved && !effectsSuppressed();
  duelCompletionObserved = true;
  showDuelDone();
}

async function duelSubmit(result) {
  if (!duel || duelSubmitted) return false;
  duelPendingResult = result;
  renderDuelBar(' — filing your score');
  showDuelWaiting(result, 'Filing your score in the challenge…');
  try {
    await duel.submitResult(result);
  } catch (err) {
    if (err && err.code === 'opponent_left') {
      showDuelProblem(err);
      return false;
    }
    renderDuelBar(' — score needs another try');
    showDuelWaiting(result, duelFriendly(err), true);
    return false;
  }
  duelSubmitted = true;
  duelPendingResult = null;
  renderDuelBar();
  if (duel.isComplete()) showNewlyCompletedDuel();
  else showDuelWaiting(duel.myResult());
  return true;
}

async function bootDuel() {
  try {
    duel = await Duel.resume({ game: DUEL_GAME });
    questions = questionsForDuel(questions, edition, duel.payload);
  } catch (err) {
    if (err && err.code === 'stale_challenge' && duel) {
      await duel.leave();
      duel = null;
    } else if (err && ['not_found', 'not_seated', 'room_started'].includes(err.code)) {
      duelClearSession(DUEL_GAME);
    }
    showDuelProblem(err);
    return false;
  }

  prepareDuelIntro();
  if (duel.status === 'waiting') {
    hideGameScreens();
    openDuelLobby(duel);
    return false;
  }

  duelSubmitted = duel.myResult() !== null;
  duelCompletionObserved = duel.isComplete();
  renderDuelBar();
  const payloadAtBoot = duel.payload;
  duel.start({
    onChange: () => {
      if (!sameDuelPayload(duel.payload, payloadAtBoot)) {
        location.reload();
        return;
      }
      const suppressReveal = duelReconnecting;
      duelReconnecting = false;
      renderDuelBar();
      if (duel.isComplete()) {
        if (suppressReveal) duelCompletionObserved = true;
        showNewlyCompletedDuel();
      }
      else if (duel.others().some((rival) => rival.left)) showDuelProblem({ code: 'opponent_left' });
      else if (duelSubmitted && !duelPendingResult) showDuelWaiting(duel.myResult());
    },
    onError: (err) => {
      if (err && ['not_found', 'not_seated'].includes(err.code)) {
        duelClearSession(DUEL_GAME);
        showDuelProblem(err);
      } else {
        duelReconnecting = true;
        renderDuelBar(' — reconnecting');
      }
    },
  });

  if (duel.isComplete()) showDuelDone();
  else if (duel.others().some((rival) => rival.left)) showDuelProblem({ code: 'opponent_left' });
  else if (duelSubmitted) showDuelWaiting(duel.myResult());
  return true;
}

$('duelBtn').addEventListener('click', () => {
  refreshDuelRejoin();
  $('duelMenuError').classList.add('hidden');
  $('duelOverlay').classList.remove('hidden');
});
$('hostBtn').addEventListener('click', () => openDuelPanel('host'));
$('joinBtn').addEventListener('click', () => openDuelPanel('join'));
$('opCancel').addEventListener('click', () => $('onlinePanel').classList.add('hidden'));
$('opGo').addEventListener('click', duelGo);
$('lobbyCancel').addEventListener('click', cancelDuelLobby);
$('rejoinBtn').addEventListener('click', rejoinDuel);
$('duelRetryBtn').addEventListener('click', () => {
  if (duelPendingResult) void duelSubmit(duelPendingResult);
});
$('duelIntroExitBtn').addEventListener('click', forfeitDuel);
$('duelForfeitBtn').addEventListener('click', forfeitDuel);
$('duelWaitExitBtn').addEventListener('click', pauseDuel);
$('duelRematchBtn').addEventListener('click', duelRematch);
$('duelExitBtn').addEventListener('click', exitDuel);
$('opCode').addEventListener('input', () => {
  $('opCode').value = $('opCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
['opName', 'opCode'].forEach((id) => $(id).addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void duelGo();
}));
document.querySelectorAll('[data-duel-close]').forEach((button) => {
  button.addEventListener('click', () => $('duelOverlay').classList.add('hidden'));
});
document.querySelectorAll('#opSeats .seat-btn').forEach((button) => {
  button.addEventListener('click', () => {
    duelSeats = +button.dataset.seats;
    document.querySelectorAll('#opSeats .seat-btn').forEach((seatButton) => {
      const selected = seatButton === button;
      seatButton.classList.toggle('selected', selected);
      seatButton.setAttribute('aria-pressed', String(selected));
    });
  });
});

function openDuelPanel(intent) {
  duelPanelIntent = intent;
  $('duelOverlay').classList.add('hidden');
  $('opTitle').textContent = intent === 'host' ? 'Start a challenge' : 'Join a challenge';
  $('opGo').textContent = intent === 'host' ? 'Get a code' : 'Open the quiz';
  $('opCodeWrap').classList.toggle('hidden', intent === 'host');
  $('opSeatsWrap').classList.toggle('hidden', intent !== 'host');
  $('opError').classList.add('hidden');
  $('opName').value = $('opName').value || duelGetName();
  $('onlinePanel').classList.remove('hidden');
  (intent === 'join' && $('opName').value ? $('opCode') : $('opName')).focus();
}

async function duelGo() {
  if ($('opGo').disabled) return;
  const name = $('opName').value.trim();
  if (!name) {
    $('opError').textContent = 'Every byline needs a name.';
    $('opError').classList.remove('hidden');
    $('opName').focus();
    return;
  }
  if (questions.length === 0) {
    $('opError').textContent = 'This week’s questions are not published yet.';
    $('opError').classList.remove('hidden');
    return;
  }

  $('opGo').disabled = true;
  $('opError').classList.add('hidden');
  try {
    if (duelPanelIntent === 'host') {
      const created = await Duel.create({
        game: DUEL_GAME,
        name,
        payload: randomDuelPayload(),
        seats: duelSeats,
      });
      $('onlinePanel').classList.add('hidden');
      openDuelLobby(created);
    } else {
      const code = $('opCode').value.trim();
      if (code.length !== 4) {
        $('opError').textContent = 'The challenge code is 4 characters.';
        $('opError').classList.remove('hidden');
        $('opCode').focus();
        return;
      }
      const joined = await Duel.join({ game: DUEL_GAME, code, name });
      try {
        questionsForDuel(questions, edition, joined.payload);
      } catch (err) {
        await joined.leave();
        throw err;
      }
      location.href = duelUrl();
    }
  } catch (err) {
    $('opError').textContent = duelFriendly(err);
    $('opError').classList.remove('hidden');
  } finally {
    $('opGo').disabled = false;
  }
}

function openDuelLobby(openDuel) {
  if ($('lobby')._duel && $('lobby')._duel !== openDuel) $('lobby')._duel.stop();
  $('lobby')._duel = openDuel;
  $('lobbyCode').textContent = openDuel.code;
  renderLobbyRoster(openDuel);
  $('lobbyStatus').textContent =
    'They tap ⚔️, choose Join, and enter it. When the last chair fills, the current quiz opens for everyone.';
  $('lobby').classList.remove('hidden');
  const updateLobby = () => {
    renderLobbyRoster(openDuel);
    if (openDuel.status !== 'waiting') location.href = duelUrl();
  };
  // The roster changes before a group heat's status does, so listen to
  // room presence directly to show each chair filling in real time.
  openDuel.match.start({
    onStatus: updateLobby,
    onPresence: updateLobby,
    onError: (err) => {
      renderLobbyRoster(openDuel);
      $('lobbyStatus').textContent = `${duelFriendly(err)} You can call it off below.`;
    },
  });
}

function renderLobbyRoster(openDuel) {
  const box = $('lobbyList');
  box.textContent = '';
  const seated = openDuel.match.seats || [];
  const total = openDuel.match.maxSeats || seated.length || 2;
  for (let i = 0; i < total; i++) {
    const span = document.createElement('span');
    const who = seated[i];
    span.textContent = (i ? ' · ' : '') + (who ? who.name : 'open chair');
    if (!who) span.className = 'chair-empty';
    box.appendChild(span);
  }
}

function cancelDuelLobby() {
  const openDuel = $('lobby')._duel;
  if (openDuel) void openDuel.leave();
  $('lobby')._duel = null;
  $('lobby').classList.add('hidden');
}

function refreshDuelRejoin() {
  const saved = duelSavedSession(DUEL_GAME);
  const button = $('rejoinBtn');
  button.classList.toggle('hidden', !saved || duelActive());
  if (saved) button.textContent = `↩ Rejoin challenge ${saved.code}`;
}

async function rejoinDuel() {
  $('rejoinBtn').disabled = true;
  $('duelMenuError').classList.add('hidden');
  try {
    const resumed = await Duel.resume({ game: DUEL_GAME });
    try {
      questionsForDuel(questions, edition, resumed.payload);
    } catch (err) {
      await resumed.leave();
      throw err;
    }
    if (resumed.status === 'waiting') {
      $('duelOverlay').classList.add('hidden');
      openDuelLobby(resumed);
    } else {
      location.href = duelUrl();
    }
  } catch (err) {
    if (err && ['not_found', 'not_seated', 'room_started'].includes(err.code)) {
      duelClearSession(DUEL_GAME);
      refreshDuelRejoin();
    }
    $('duelMenuError').textContent = duelFriendly(err);
    $('duelMenuError').classList.remove('hidden');
  } finally {
    $('rejoinBtn').disabled = false;
  }
}

async function exitDuel() {
  if (duel && !preserveDuelSession) await duel.leave();
  // A boot-time offline error leaves duel null; keep that saved session so
  // the weekly screen can still offer Rejoin once the connection returns.
  location.replace(location.pathname);
}

function pauseDuel() {
  if (duel) duel.stop();
  location.replace(location.pathname);
}

async function forfeitDuel() {
  if (!duel || duelSubmitted) {
    pauseDuel();
    return;
  }
  clearInterval(timerInt);
  finished = true;
  const submitted = await duelSubmit(makeDuelForfeit(questions.length));
  if (submitted) pauseDuel();
}

async function duelRematch() {
  if (!duel) return;
  $('duelRematchBtn').disabled = true;
  try {
    await duel.rematch(randomDuelPayload());
    location.reload();
  } catch (err) {
    showDuelProblem(err);
  }
}

refreshDuelRejoin();

// ----------------------------------------------------- race-link invites
// Text a link instead of reading letters aloud: ?join=ABCD opens the join
// panel with the code filled in, then scrubs the URL so refreshes do not
// re-trigger it.

$('inviteBtn').addEventListener('click', async () => {
  const openDuel = $('lobby')._duel;
  if (!openDuel) return;
  const url = `${location.origin}${location.pathname}?join=${openDuel.code}`;
  const text = `Race me on this week's BTown News Quiz! 🗞️ Tap to join: ${url}`;
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(url);
      $('inviteBtn').textContent = '✓ Link copied';
      setTimeout(() => { $('inviteBtn').textContent = '📲 Send an invite'; }, 1800);
    }
  } catch { /* share sheet closed */ }
});

(() => {
  const code = new URLSearchParams(location.search).get('join');
  if (!code || !/^[A-Za-z0-9]{4}$/.test(code)) return;
  history.replaceState(null, '', location.pathname);
  openDuelPanel('join');
  $('opCode').value = code.toUpperCase();
})();
