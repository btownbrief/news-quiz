# Btown News Quiz — agent instructions

Read `README.md` first. This is a plain static ES-module site with no build
step. `data/questions.json` is the entire current edition; replacing it and
changing `edition` unlocks the next weekly play.

## Weekly result is sacred

Players get one saved result per edition in `news-quiz-played`, and that result
may be submitted to the shared monthly leaderboard. Preview mode and duel mode
must never write, replace, submit, or mark that weekly result as played.

## Duels (⚔️ challenge a friend)

Async duels use the current edition on both phones. The room payload is
`{ edition, seed }`: edition identifies the quiz and seed deterministically
pins question order. Results are write-once room data shaped as
`{ score, total, ms, answers }` (plus `forfeit: true` for an explicit
abandonment); higher score wins, then faster time, otherwise the duel is a
draw. A forfeit loses to any completed run. Correctness dots appear only on
the completed compare screen, after both players submit.

`js/duel.js` is vendored byte-for-byte from
`maple-scramble/js/duel.js`. `js/rooms.js` and
`scripts/rooms-shim.mjs` are vendored byte-for-byte from
`four-in-a-rowboat`; change their canonical copies and re-vendor rather than
forking them here.

## Before you finish

Run `node scripts/test-duel.mjs`, run any other test scripts in `scripts/`,
and run `node --check` on every touched JavaScript file. If the UI changed,
also inspect the normal weekly path and the duel overlays at a phone-sized
viewport. Leave generated duel integration changes uncommitted for review.
