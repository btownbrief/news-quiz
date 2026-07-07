# Btown News Quiz 🗞️

"Did you actually read this week's Btown Brief?" — a flat 5-question, 60-second
quiz on the static Btown Games stack (no build step), part of the arcade at
play.btownbrief.com/news-quiz/. Ported from the original Streamlit + Google
Sheets app; scores now live on the shared Supabase monthly leaderboard
(`GAME='news-quiz'`), same identity as every other Btown game.

## Updating the quiz each edition
The whole `data/questions.json` file **is** the current edition's quiz — every
player gets these same 5 questions until you replace them. To publish a new set:

1. In the Google Sheet, keep the `Questions` tab updated (columns:
   `Question, Option_A, Option_B, Option_C, Option_D, Correct_Answer`;
   `Correct_Answer` is a letter A–D).
2. Download it: **File → Download → CSV**.
3. Regenerate the data file:
   ```
   node scripts/convert-csv.mjs "/path/to/Daily Trivia Database - Questions.csv"
   ```
   This bumps `edition` to today's date, which **unlocks a fresh play for
   everyone** (one play per edition).
4. Commit & push — GitHub Actions redeploys.

Preview a new edition before shipping with `?preview=1` (plays/replays without
saving state or touching the leaderboard).

## Scoring
200 pts per correct answer; a 5/5 sweep adds a speed bonus equal to the seconds
left on the clock. Best score per player per month stands on the leaderboard.
