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

In `index.html`, set `CONFIG.API` to that deployment URL, then deploy the
`Deploy Front End HTML` folder to Netlify.

### 4. Turn on auto-grading

Run `installAutoGradeTrigger()` once from the editor. It schedules `autoGrade`
every six hours and clears its own previous triggers, so re-running it won't
stack duplicates. `removeAutoGradeTriggers()` turns it off.

## Sheets

| Sheet | Contents |
|---|---|
| `Picks` | one row per pick: who, week, game, market, line, status |
| `Results` | cached final scores, one row per game |
| `Users` | `email` + `role`; role `admin` unlocks manual grading |

All three are created automatically on first use.

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
node tools/pipeline-test.js   # 36 assertions: full runs against a fake Sheet
```

`pipeline-test.js` builds a fake spreadsheet and a fake Odds API, then checks
that grades land on the right rows, that the credit short-circuits fire, and
that resubmitting replaces rather than duplicates.

Both are worth running after any change to grading — a sign error on spreads
would quietly hand the league to the wrong person.
