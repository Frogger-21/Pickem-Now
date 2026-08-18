# Pickem Now

A weekly pick'em league. Everyone submits five picks against the spread, the
total and the moneyline; results grade themselves; the scoreboard tracks who
won each week.

Two pieces:

- **`Deploy Front End HTML/index.html`** — the whole frontend, one file, no
  build step. Deployed to Netlify.
- **`Google App Script Code.gs`** — the backend, run from
  [script.google.com](https://script.google.com/home), storing everything in
  Google Sheets.

## Setup

### 1. Backend secrets

Nothing secret lives in this repo. In the Apps Script editor, open
**Project Settings → Script Properties** and add two:

| Property | Where it comes from |
|---|---|
| `ODDS_API_KEY` | your key from [the-odds-api.com](https://the-odds-api.com/) |
| `SHEET_ID` | the id in your Sheet's URL, between `/d/` and `/edit` |

Then run `checkSetup()` from the editor. It confirms both are readable and that
the Sheet opens, without ever printing the values.

### 2. Deploy the backend

Deploy as a **Web app**, execute as yourself, access "Anyone". Copy the
deployment URL.

### 3. Point the frontend at it

The URL is **not** committed. Netlify holds it as an environment variable and
`tools/inject-config.sh` writes it into `index.html` during the build:

**Netlify → Site configuration → Environment variables → Add a variable**

| Key | Value |
|---|---|
| `APPS_SCRIPT_URL` | the Apps Script Web App URL, ending in `/exec` |

Redeploying the Apps Script can issue a **new** `/exec` URL — if it does,
update this variable or the site will talk to the old deployment.

The build fails on a missing or malformed value rather than publishing a site
that can't reach its backend. If a bad build ever does get through, the page
says "Backend not configured" instead of failing silently.

> **Deploy by hand and this step is skipped.** Drag-and-drop uploads run no
> build command, so the placeholder stays literal and the site comes up
> unconfigured. Push to `main` instead and let Netlify build it.

To open `index.html` straight off your desktop, set the override once in the
browser console and reload:

```js
localStorage.setItem('pg_api', 'https://script.google.com/…/exec')
```

### 4. Turn on auto-grading

Run `installAutoGradeTrigger()` once from the editor. It schedules `autoGrade`
every six hours and clears its own previous triggers, so re-running it won't
stack duplicates. `removeAutoGradeTriggers()` turns it off.

## Testing grading without any games

Grading is hardest to trust in the off season, because there is nothing to
grade. Two functions cover it, and neither needs a live game.

**`runSelfTest()`** — the important one. It writes a throwaway week of sixteen
picks and a set of invented final scores into the Sheet, runs the *real*
grading pass over them, checks every verdict against what it should be, then
deletes everything it made. Run it from the editor any time; it costs **zero
API credits** and either prints

```
SELF TEST PASSED - all 16 picks graded correctly, 0 API credits used.
```

or names each pick it got wrong and what it expected instead.

The fixtures are chosen to be awkward on purpose. The invented game finishes
27-20, so a −6.5 favourite covers, a −7 favourite pushes, and the total lands
exactly on 47. There is a tied game for the moneyline push, an unfinished game,
a finished game with no scores in the feed, and a pick whose team name matches
nothing. The last four must come out **pending** — leaving a pick ungraded is
always safer than grading it wrong, and a self-test that only checked the happy
path would miss that.

It grades through `runAutoGrade_({ noFetch: true })`, the same function the
six-hourly trigger calls, so it exercises the row arithmetic and the status
write-back rather than just the arithmetic. The one thing it can't cover is
`fetchScores_`, since that needs the network.

**`checkOddsApi()`** — covers the other half. Proves the API key works and
reports how many games actually **finished in the last three days**, with their
scores and event ids, plus your remaining credits.

It asks with `daysFrom=3`, which costs 2 credits per league rather than 1. That
is not optional: without `daysFrom` the scores endpoint returns only live and
upcoming fixtures, so "0 completed" would be the answer on every day of the
year — including a Monday in November. A check that always says zero is worse
than no check.

Out of season it says there is nothing to grade and that this is not a failure.

**`testAutoGradeLive()`** — the one that joins the two together. `runSelfTest`
feeds itself invented scores, so it never exercises `fetchScores_`, the
event-id join, or the mapping of the feed's score array onto home and away.
This finds a genuinely finished game in the live feed, invents picks whose
correct verdicts are *arithmetic from the real final score*, runs the real
`autoGrade()` — network and all — checks every verdict and deletes what it
made.

Because the expectations are derived from the score rather than hardcoded, it
can't degrade into a tautology that would pass against any game. It skips tied
games, which settle no moneyline, and out of season it reports an empty feed as
expected rather than as a failure.

Costs a handful of credits, so run it once for confidence, not on a schedule.

> Its honest limit: a feed that swapped home and away *consistently* is just
> the same game seen from the other side, and no test deriving expectations
> from that feed could notice. What is guaranteed is that the score it reports
> is the score it graded from, so the two can never drift apart.

If the self-test ever dies before cleaning up, its rows carry the week
`__selftest__`, which the scoreboard ignores outright — a half-finished test
can't put a fake player on the board. Running it again clears the leftovers.

## Testing against old weeks

Old games can't be re-fetched. `daysFrom` maxes out at 3, and The Odds API's
historical endpoints are a paid add-on, so anything from last season is simply
not retrievable. Two functions work around that, and neither costs a credit.
Both are read-only — they never write to the Sheet.

### `auditGrades()` — needs no scores at all

Two people on opposite sides of the same number cannot both be right. If one
took a team at −6.5 and won, whoever took the other side at +6.5 must have
lost. Over and under on the same total, likewise. And a moneyline winner tells
you who won outright, which settles any spread pick on that team where the
points could only have helped — no score required.

So this scans every grade already in the sheet and reports the pairs that
contradict each other:

```
GRADE AUDIT — 1 contradiction(s) across 240 graded pick(s):

  2025-11-09  Buffalo Bills @ Kansas City Chiefs  [same spread, opposite sides]
    row 2  Ann  spread favorite Kansas City Chiefs (-6.5)  -> win
    row 3  Bob  spread underdog Buffalo Bills (6.5)  -> win
```

Every hit is a real mistake in the sheet — the kind hand-grading produces and
nobody notices. Run it on your whole history right now.

It's deliberately conservative: different lines on the same game are allowed to
agree (a 7-point win covers −6.5 *and* pushes +7), a tied moneyline is never
used to infer anything, and a matchup it can't parse is skipped rather than
guessed at. An audit that cries wolf is worse than no audit, because you stop
reading it.

Its blind spot: a game only one person picked has nothing to check it against.

### `backtestWeek()` — real picks, scores typed in once

The stronger test, if you'll spend two minutes looking scores up. Start with:

```js
backtestTemplate('2025-11-09')
```

which prints one line per game in that week, ready to fill in:

```js
backtestWeek('2025-11-09', {
  'a1b2c3': [0, 0],   // [home, away]  Buffalo Bills @ Kansas City Chiefs  (NFL, 3 pick(s))
});
```

Put the real finals in and run it. It grades that week's actual picks — real
lines, real selections — and compares verdict by verdict against how you graded
them at the time:

```
BACKTEST 2025-11-09 — 12 pick(s)
  auto-grader agreed with the sheet : 11
  disagreed                         : 1

DISAGREEMENTS — one of the two is wrong, worth looking at:
  Cid  Buffalo Bills @ Kansas City Chiefs  total over Over (45.5)
      sheet says loss, grader says win  (row 14)
```

Scores go in as `[home, away]`. The matchup reads "away @ home", so the second
team named is the first number.

This is the closest thing to proof that auto-grading would have got your season
right, because the answers are ones you already know.

### A third option: recent games

`daysFrom=3` does cover the last three days, so if there are completed games in
the feed — preseason counts — you can put a throwaway pick on one and watch
`autoGrade()` grade it for real, network and all. `checkOddsApi()` shows what's
currently there.

## Rebuilding the frontend

`docs/FRONTEND-CONTRACT.md` is the handoff document: every endpoint with real
response shapes, every element id the JavaScript binds to, the behaviour that
has to survive, and the handful of things that look cosmetic but are not - the
`__APPS_SCRIPT_URL__` placeholder, the `"Away @ Home"` matchup format, and why
`apiConfigured()` tests a value shape rather than comparing against a constant.

## Seasons

One selector, top left, governs every tab. Which season a pick belongs to is
**derived from its week date** rather than stored - August to July, so a January
bowl stays in the season that started the previous August. That is one less
column to keep in step, and it cannot disagree with the week it came from.

The choice lives in `sessionStorage`, not `localStorage`, deliberately: it
should survive moving between tabs and reloading, but a fresh visit should open
on the newest season rather than on whatever somebody was reading about last
month. A saved season that no longer exists falls back to the newest rather
than filtering everything down to nothing.

The selector is highlighted whenever it is *not* on the newest season, so
nobody spends ten minutes wondering where this week's games went.

## Queries

A tab of charts driven by two dropdowns - who, and what to show:

| View | Answers |
|---|---|
| Win rate by market | moneyline, favourite, underdog, over, under |
| Units won by market | the same split, in money rather than percentage |
| Record by week | wins and losses side by side |
| Cumulative wins | running total of wins minus losses |
| Most successful teams | which teams paid off when picked |
| Teams that cost the most | and which did not |
| Everyone side by side | the league on one axis |

Favourite versus underdog comes from the **sign of the line**, not from the
`kind` field. The line is what was actually laid or taken; `kind` is a label
somebody chose in a form, and the two can disagree.

Aggregation happens in Apps Script rather than the browser, so the arithmetic
is testable outside it and a new chart never means reimplementing a win rate
slightly differently. `unitPnl_()` deliberately mirrors `unit_pnl()` in
`db/schema.sql` - if those two drift, the site and your SQL will tell you
different things about the same season.

The charts are plain `div`s. The whole app is one file with no build step and
no CDN, and a charting library would be the only thing on the page capable of
failing to load.

## Storage

| Sheet | Contents |
|---|---|
| `Picks` | one row per pick: who, week, game, market, line, status |
| `Results` | cached final scores, one row per game |
| `Users` | `email` + `role`; role `admin` unlocks manual grading |

All three are created automatically on first use.

Every read and write goes through the **`STORAGE`** section of the script, and
nothing outside it knows what a spreadsheet row is:

```
readPicks_()           setPickStatuses_(updates)   insertPicks_(picks)
deletePickKeys_(keys)  readResults_()              upsertResults_(rows)
deleteResultIds_(ids)  readUsers_()
```

Rows carry an opaque `_key`. It happens to be the sheet row number today and
will be a primary key on Postgres; callers may hand it back but must never do
arithmetic on it. `pipeline-test.js` asserts all of this against the source
text, because the property is invisible at runtime and would otherwise erode
one convenient `getDataRange()` at a time.

## Moving to Postgres

### The cutover, in order

```
1. run db/schema.sql in the Supabase SQL editor
2. add SUPABASE_URL and SUPABASE_SERVICE_KEY to Script Properties
3. checkSetup()                — are both backends reachable?
4. migrateSheetsToPostgres()   — copies everything; safe to re-run
5. compareBackends()           — do they agree, row for row?
6. Script Property STORAGE = postgres     ← the cutover
7. runSelfTest()               — grading still correct on the new backend
```

The Sheet is never modified, by any step. Step 6 is one property, so the
rollback is deleting it.

`STORAGE` defaults to `sheets` when unset, so a half-finished setup can't
silently point a working league at an empty database, and any value other than
`sheets` or `postgres` is refused rather than guessed at.

**`migrateSheetsToPostgres()`** is idempotent — every write is an upsert on the
primary key, so running it twice is the same as running it once, and running it
again later picks up whatever was added since. It handles the three things that
would otherwise fail on arrival:

- an ungraded pick is `''` in the Sheet and must become `'pending'`
- `meta` is a JSON *string* in the Sheet and must arrive as an object, or jsonb
  stores a quoted string and `line` disappears
- roles are free text (`'Admin'`, `''`) and the column is constrained

It aborts without writing anything if two picks share an id, since upserting
those would silently merge two people's picks into one row. Legacy rows with no
id at all get one minted from their row number, and it says how many.

If Postgres rejects a row, the migration **re-sends that batch one row at a
time to find out which**, and reports it by id with the constraint that refused
it. Postgres names the constraint, not the row; during a migration that's the
difference between a one-line fix and an afternoon.

**`compareBackends()`** reads both and reports every difference — pick counts,
field-by-field values, `meta.line` and `meta.total`, result scores, and finally
whether the *scoreboard* comes out the same. It changes nothing. Only when it
says `IDENTICAL` is step 6 worth doing.

### The schema

`db/schema.sql` is the target — paste it into the Supabase SQL editor and run
it. It's idempotent.

Two decisions in it worth knowing. `meta` stays `jsonb` rather than being
flattened into columns, because the grader reads it as a blob and flattening
would mean rewriting the one function you least want to touch; the numbers
inside are still queryable because `line` and `total` are **generated columns**
extracted from the json and stored as real numerics. And scores are nullable
`int`, because null means "not known" — the distinction the whole grader hangs
on.

The schema also ships the views that are the actual reason to move:

| View | Answers |
|---|---|
| `season_table` | the scoreboard, plus units won |
| `record_by_side` | are you better on dogs or on chalk |
| `record_by_market` | is the moneyline pick helping or is it a tax |
| `record_by_league` | NFL vs NCAAF |
| `picks_with_results` | every pick with line, result and final margin — **join your EPA and SP+ tables onto this one** |

`unit_pnl(status, odds)` turns American odds into profit on one unit, so ROI is
a `sum()`. Unpriced picks are treated as −110.

RLS is enabled with no policies, which denies everyone except the service key.
That's correct here: the browser never talks to Postgres, it talks to Apps
Script, which holds the key.

## How auto-grading works

The Odds API's `/scores` endpoint returns the **same event ids** as `/odds`, so
a pick's `gameId` joins straight onto a result. Team names are only needed to
work out which side was picked, not to find the game.

Grading is pure arithmetic:

| Market | Rule |
|---|---|
| spread | `(yourScore - theirScore) + line`, where `line` is already signed for your side. `> 0` win, `0` push, `< 0` loss |
| total | `home + away` against the number; landing exactly on it is a push |
| moneyline | straight winner; a tie is a push |

Anything it can't resolve confidently — unfinished game, missing score,
ambiguous team name — is **left pending** rather than guessed at. Manual
grading still works as a fallback.

### Two constraints worth knowing

**`daysFrom` maxes out at 3.** A game older than three days drops out of the
scores feed and can never be auto-graded. The six-hourly trigger stays well
inside that, but if the script is disabled for a week you'll be grading that
week by hand.

**Credits.** A `/scores` call with `daysFrom` costs 2 credits against a free
tier of 500/month. Two things keep that small: `autoGrade` reads the sheet
first and returns without calling the API when nothing is pending, and every
completed game is cached in `Results` so it's never fetched twice. A normal
football week costs about 8 credits.

## Scoring

Each week has a winner — most correct picks, fewer losses breaks a tie, and a
genuine tie is shared. A week with any pick still pending has no winner yet.

The season table sorts on weeks won, then overall record. Win percentage counts
only decided picks, so pushes and pending picks don't drag it down.

## Picks are locked once graded

Submitting again replaces your picks for that week rather than adding to them —
the old code appended unconditionally, so a double submission put ten rows in
the sheet and the scoreboard counted all of them. Once any pick in a week has
been graded, that week is locked and resubmission is refused.

## Tests

The grading logic is pure JavaScript, so it runs outside Apps Script:

```
node tools/grading-test.js    # 48 assertions: spreads, totals, moneylines, edge cases
node tools/pipeline-test.js   # 60 assertions: full runs against a fake Sheet, plus layering
node tools/build-test.js      # 11 assertions: the real Netlify build
node tools/backtest-test.js   # 42 assertions: the audit and the backtest
node tools/postgres-test.js   # 118 assertions: the whole stack on a fake PostgREST
node tools/frontend-test.js   # 55 assertions: the page's own JS on a stub DOM
```

`pipeline-test.js` builds a fake spreadsheet and a fake Odds API, then checks
that grades land on the right rows, that the credit short-circuits fire, and
that resubmitting replaces rather than duplicates. It also runs `runSelfTest()`
itself, so a broken self-test shows up on the laptop rather than halfway
through a football Sunday.

`postgres-test.js` runs the backend against a fake PostgREST that enforces the
schema's constraints, then against a fake Sheet, and checks the two produce the
same scoreboard. The constraints are the point: the traps in this migration are
constraint traps, so a fake that accepted anything would prove nothing.

`backtest-test.js` spends most of its effort on the *quiet* direction — proving
`auditGrades()` stays silent on grades that are legitimately consistent. A
false alarm there costs more than a missed one.

Both are worth running after any change to grading — a sign error on spreads
would quietly hand the league to the wrong person.
