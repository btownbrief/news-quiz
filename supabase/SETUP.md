# Leaderboard setup (Supabase)

The Local Trivia Ladder keeps a **monthly** public leaderboard on a free
[Supabase](https://supabase.com) project. There are no accounts: each browser
mints a random `player_id` + secret `token` in `localStorage`, and the server
stores only each player's **best score per month**. Past months stay frozen.

One-time setup, ~5 minutes.

## 1. Create the project

1. Sign in at [supabase.com](https://supabase.com) → **New project**.
2. Pick any name/region and a database password (you won't need it again here).
3. Wait for it to finish provisioning.

## 2. Load the schema

1. In the dashboard, open **SQL Editor → New query**.
2. Paste the entire contents of [`schema.sql`](./schema.sql) and click **Run**.
   It creates the `players` and `scores` tables, the three RPCs, and locks the
   tables down so only the RPCs are reachable. It's safe to re-run.

## 3. Wire up the front-end

1. Go to **Project Settings → API**.
2. Copy the **Project URL** and the **anon / public** API key.
   - The `anon` key is meant to be shipped in client code — it's safe to commit.
   - Never use the `service_role` key here; it bypasses every check.
3. Paste both into the top of [`../js/leaderboard.js`](../js/leaderboard.js):

   ```js
   const SUPABASE_URL      = 'https://YOURPROJECT.supabase.co';
   const SUPABASE_ANON_KEY = 'your-anon-public-key';
   ```

   Leave either blank to disable the leaderboard entirely — the game hides all
   leaderboard UI and every leaderboard call quietly no-ops.

> New-style keys (`sb_publishable_…`) and legacy JWT keys (`eyJ…`) are both
> supported; `leaderboard.js` only sends the `Authorization: Bearer` header for
> the legacy ones, as required.

## 4. Verify

Open the game, finish a ladder with a score above 0, and enter a name. Then in
Supabase **Table Editor** you should see a row in `players` and one in `scores`.
You can also test the read path directly in the SQL Editor:

```sql
select * from get_leaderboard('trivia-ladder', to_char(now() at time zone 'America/New_York', 'YYYY-MM'));
```

## How it holds up

- **Tables are private.** RLS is on with no policies, so the public anon key
  can't read or write the tables directly — only through the `SECURITY DEFINER`
  functions in `schema.sql`.
- **Light identity.** The first write for a `player_id` claims it with its
  token; later writes must present the same token or they're rejected
  (`bad token`). This stops casual name/score spoofing, not a determined
  attacker — appropriate for a small-town trivia game.
- **Best-score-only.** `submit_score` keeps `greatest(existing, new)` per month,
  so replaying or resubmitting never inflates a score.
- **Monthly rollover.** `month_key` is derived server-side in
  `America/New_York` (`YYYY-MM`), matching the "This Month / Last Month" tabs.
- **Read cap.** `get_leaderboard` returns at most 100 rows.
