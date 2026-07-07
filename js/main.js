// NEWS QUIZ — did you actually read this week's Btown Brief?
// Flat 5-question quiz on a single 60-second clock (mirrors the original
// Streamlit game), on the static Btown Games stack + shared Supabase board.
import { loadEdition } from './questions.js';
import {
  lbEnabled, getName, submitScore, renamePlayer, fetchTop, monthLabel, playerId,
} from './leaderboard.js';

const $ = (id) => document.getElementById(id);
const QUIZ_MS = 60000;          // one clock for the whole quiz
const POINTS_PER_Q = 200;       // + up to 60 speed bonus (seconds left at finish)
const PLAYED_KEY = 'news-quiz-played';

// ?preview=1 lets the editor play/replay the current edition without saving
// state or touching the leaderboard — for checking a new edition before it ships.
const PREVIEW = new URLSearchParams(location.search).has('preview');

const VERDICTS = [
  [1000, 'Front-Page Reader 📰 You devour the Brief.'],
  [800, 'Well-Read Local 🗞️ Barely miss a word.'],
  [600, 'Solid Skimmer 👀 You caught the headlines.'],
  [400, 'Headline Tourist 🧳 Read a little closer.'],
  [200, 'Barely Opened It 📬'],
  [0, 'Did you even read the Brief? 📭'],
];

let edition = 'default';
let questions = [];
let qIndex = 0;
let results = [];      // [{ correct }]
let deadline = 0;
let timerInt = null;
let answered = false;
let finished = false;

// ------------------------------------------------------------ played-state
function loadPlayed() {
  try { return JSON.parse(localStorage.getItem(PLAYED_KEY)) || {}; } catch { return {}; }
}
function savePlayed(obj) { if (!PREVIEW) localStorage.setItem(PLAYED_KEY, JSON.stringify(obj)); }

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
  const played = loadPlayed();
  if (!PREVIEW && played.edition === edition) {
    // already played this edition — straight to results, no replay
    showResults(played, false);
  }
  $('startBtn').addEventListener('click', startGame);
}

// ------------------------------------------------------------ game flow
function startGame() {
  qIndex = 0; results = []; finished = false;
  $('introScreen').classList.add('hidden');
  $('resultsScreen').classList.add('hidden');
  $('gameScreen').classList.remove('hidden');
  startTimer();
  showQuestion();
}

function startTimer() {
  clearInterval(timerInt);
  deadline = Date.now() + QUIZ_MS;
  timerInt = setInterval(tick, 100);
  tick();
}
function tick() {
  const left = Math.max(0, deadline - Date.now());
  const fill = $('timerFill');
  fill.style.width = `${(left / QUIZ_MS) * 100}%`;
  fill.classList.toggle('hurry', left < 10000);
  $('clock').textContent = Math.ceil(left / 1000);
  if (left <= 0 && !finished) timeUp();
}

function showQuestion() {
  answered = false;
  const q = questions[qIndex];
  $('reveal').classList.add('hidden');
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
  const q = questions[qIndex];
  const correct = choiceIdx === q.answer;

  [...$('choices').children].forEach((b, i) => {
    b.disabled = true;
    if (i === q.answer) b.classList.add('correct');
    else if (i === choiceIdx) b.classList.add('wrong');
    else b.classList.add('dim');
  });

  const head = $('revealHead');
  if (correct) { head.textContent = '✅ Correct!'; head.className = 'good'; }
  else {
    head.textContent = choiceIdx === -1 ? '⏰ Skipped' : '❌ Not quite';
    head.className = 'bad';
  }
  $('revealAns').textContent = `Answer: ${q.options[q.answer]}`;
  $('nextBtn').textContent = qIndex === questions.length - 1 ? 'See your score 🏁' : 'Next question →';
  $('reveal').classList.remove('hidden');
  results.push({ correct });
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
  const secondsLeft = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
  // speed bonus only rewards a finished quiz; capped by the clock (≤60)
  const bonus = correctCount === questions.length ? secondsLeft : 0;
  const score = correctCount * POINTS_PER_Q + bonus;
  const squares = results.map((r) => (r.correct ? '🟩' : '🟥')).join('');

  const record = { edition, score, correct: correctCount, total: questions.length, squares, bonus, submitted: false };
  const played = loadPlayed();
  if (!PREVIEW) { savePlayed(record); }
  showResults(record, true);
}

// ------------------------------------------------------------ results
function showResults(record, justFinished) {
  $('introScreen').classList.add('hidden');
  $('gameScreen').classList.add('hidden');
  $('resultsScreen').classList.remove('hidden');

  $('verdict').textContent = VERDICTS.find(([min]) => record.score >= min)[1];
  $('finalScore').textContent = record.score;
  $('scoreDetail').textContent =
    `${record.correct} / ${record.total} correct${record.bonus ? ` · +${record.bonus} speed bonus` : ''}`;
  $('squares').textContent = record.squares || '';

  startCountdownNote();
  updateLeaderboard(justFinished ? record : loadPlayed());
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

if (lbEnabled()) {
  lbBox.classList.remove('hidden');
  lbThisBtn.textContent = `🏆 ${monthLabel(0)}`;
  lbLastBtn.textContent = monthLabel(-1);
}

async function submitOnce(record) {
  if (PREVIEW || !record) return;
  const played = loadPlayed();
  if (!played || played.submitted || played.score <= 0 || !getName()) return;
  await submitScore(played.score);
  played.submitted = true;
  savePlayed(played);
}

async function updateLeaderboard(record) {
  if (!lbEnabled()) return;
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
