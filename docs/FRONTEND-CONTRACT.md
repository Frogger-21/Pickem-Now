# Frontend contract

Hand this to whoever is rebuilding the UI. It is everything the new frontend
has to honour to drop onto the existing backend without changes on either side.

The frontend is **one file**: `Deploy Front End HTML/index.html`. Markup, CSS
and JavaScript all live in it. There is no bundler, no framework and no package
manifest — Netlify's entire "build" is one `sed` substitution.

---

## 1. Non-negotiables

Break any of these and the site deploys but does not work.

### 1.1 The API URL placeholder

The file **must** contain the literal token `__APPS_SCRIPT_URL__` exactly once,
inside a block matching `const CONFIG = { ... };`, and a function
`apiConfigured()`. `tools/inject-config.sh` replaces the token at build time and
`tools/build-test.js` regexes for both shapes.

Keep this block verbatim:

```js
if (/[?&]reset=1(&|$)/.test(location.search)) {
  try { localStorage.removeItem('pg_api'); } catch (_) {}
  location.replace(location.pathname);
}

const CONFIG = {
  API: (function () {
    try { const o = localStorage.getItem('pg_api'); if (o) return o; } catch (_) {}
    return '__APPS_SCRIPT_URL__';
  })(),
  OVERRIDDEN: (function () {
    try { return !!localStorage.getItem('pg_api'); } catch (_) { return false; }
  })()
};

function apiConfigured() {
  return /^https?:\/\/\S+$/.test(String(CONFIG.API || ''));
}
```

Why each part matters:

- `localStorage.pg_api` overrides the built-in URL, for local development.
  A **stale** one silently breaks the live site with nothing but "Failed to
  fetch", which is why `?reset=1` exists as an escape hatch that needs no
  developer console. Both must survive the rebuild.
- `apiConfigured()` tests the **shape** of the value. It must never compare
  against a named placeholder constant: `sed` substitutes the token everywhere,
  including in the line defining such a constant, so both sides would become the
  real URL and the check would report failure on a *successful* build. That bug
  has already been shipped once.

### 1.2 One file, no external JavaScript

**Hard rule: no external scripts.** No CDN chart library, no framework, no
polyfill service. A script that fails to load leaves a broken page, and the page
has to keep working when something else is the flaky part. Everything inline or
as a data URI.

**External CSS: avoid.** A stylesheet that fails to load costs you every rule in
it, which is nearly as bad.

**Webfonts: allowed, but weigh it.** A font that fails to load falls back and
nobody notices, so this is a soft failure rather than a hard one - Google Fonts
will work here, since this is Netlify and not a CSP-sandboxed page. But it is
still a render-blocking request on a phone on cellular, which is the case this
build is optimising for. A system stack (`-apple-system, Segoe UI, Helvetica`
plus `ui-monospace, Menlo, Consolas`) is visually near-identical at UI sizes and
costs nothing. Prefer it unless the typeface is doing real work.

Images already in the folder (e.g. `trophy-gold-transparent-background-19.webp`)
are fine - they ship alongside.

### 1.3 Single `<script>` block

`tools/build-test.js` and `tools/frontend-test.js` both extract the page's
JavaScript with `html.match(/<script>([\s\S]*?)<\/script>/)`. Keep **one**
`<script>` element with no attributes, containing all the JS. Splitting it or
adding `type="module"` breaks both suites.

---

## 2. The API

One endpoint, `GET`/`POST` on the Apps Script `/exec` URL, with `?fn=` naming
the operation. Every response is JSON with an `ok` boolean; on failure the only
other field is `error` (a string).

All read endpoints accept an optional **`season`** parameter (see §4). Omitting
it, or passing `all`, returns every season.

### `fn=` (no parameters)

A description of the deployment. Useful for confirming which code is live.

```json
{"ok":true,"service":"Pickem Now API","version":"2026-08-17a",
 "has":["autograde","postgres","selftest","livetest","audit","backtest","weeksort","seasons","stats"],
 "storage":"postgres","fn":["odds","mine","board","weeks","week","seasons","stats","isAdmin"]}
```

### `fn=seasons`

```json
{"ok":true,"seasons":[{"season":"2025-26","picks":545,"weeks":14,"players":8}]}
```

Newest first. Drives the season selector.

### `fn=odds&league=nfl|ncaaf[&weekStart=YYYY-MM-DD][&nocache=1]`

```json
{"ok":true,"games":[{
  "id":"8c94552d022acec4a0458d70c19d3da9",
  "kickoff":"2026-09-10T00:15:00Z",
  "home_team":"Seattle Seahawks",
  "away_team":"New England Patriots",
  "spread":{"fav":"home","line":-3.5,"favPrice":-112,"dogPrice":-108},
  "totals":{"total":44.5,"overPrice":-115,"underPrice":-105},
  "moneyline":{"home":-190,"away":160}
}]}
```

`spread.fav` is `"home"` or `"away"`; `spread.line` is the favourite's number
(negative). Any of `spread`, `totals`, `moneyline` may be `null` when no book
has priced that market.

The page calls this **twice**, once per league, and concatenates.

### `fn=board[&season=]`

```json
{"ok":true,"rows":[{"user":"Whit Payne","weeksWon":6,"wins":41,"losses":29,
  "pushes":0,"pending":5,"total":75,"weeksPlayed":14,"pct":0.586}]}
```

Already sorted: **total wins descending, then win percentage**. Render in the
order given.

`pct` counts decided picks only — pushes and pending do not drag it down.

> **The trophy is not row zero.** It marks whoever has the most `weeksWon`,
> which need not be the top row now that the table sorts on wins. Compute
> `max(weeksWon)` and mark everyone equal to it.

### `fn=weeks[&season=]`

```json
{"ok":true,"weeks":[{"week":"2025-12-03","decided":true,
  "winners":["Reid"],"players":7}]}
```

Newest first. `decided` is false while any pick in that week is pending, and
`winners` is then empty. Ties share a week, so `winners` can hold several names.

### `fn=week&week=<label>`

```json
{"ok":true,"week":"2025-11-19","decided":true,
 "winners":["Ivan","Grant Brooks","Whit Payne","Rish Basu"],
 "rows":[{"user":"Grant Brooks","wins":3,"losses":2,"pushes":0,"pending":0,"winner":true}]}
```

Pass the `week` value exactly as `fn=weeks` returned it.

### `fn=mine&email=<email>[&season=]`

```json
{"ok":true,"picks":[{
  "id":"0wpsf47","week":"2025-12-03","email":"ivanday9@gmail.com","user":"Ivan",
  "league":"NFL","gameId":"c86a...","matchup":"Miami Dolphins @ New York Jets",
  "market":"total","kind":"under","selection":"Under","odds":-120,
  "meta":{"price":-120,"total":41.5},"status":"loss",
  "ts":"2026-08-17T22:43:20.577Z","line":41.5
}]}
```

`line` is precomputed for display: the spread number for a spread, the total for
a total, blank otherwise. `status` is `pending` | `win` | `loss` | `push`.

### `fn=stats[&season=]`

Everything the Queries tab draws.

```json
{"ok":true,"season":"2025-26",
 "players":["Ben","Clarke Wood","..."],
 "stats":{
   "__all__":{
     "overall":{"w":287,"l":257,"p":1,"n":545,"pct":0.528,"units":-8.67},
     "markets":{
       "moneyline":{"w":64,"l":45,"p":0,"n":109,"pct":0.587,"units":1.2},
       "spread_fav":{...},"spread_dog":{...},"spread_pk":{...},
       "over":{...},"under":{...}
     },
     "weeks":[{"week":"2025-09-03","w":21,"l":19,"p":0,"n":40,"pct":0.525,"units":-0.7}],
     "teams":[{"team":"Buffalo Bills","w":9,"l":2,"p":0,"n":11,"pct":0.818,"units":4.89}]
   },
   "Ivan":{ ...same shape... }
 }}
```

- `__all__` is the league combined; the rest are keyed by player name.
- `weeks` is oldest first. `teams` is sorted by wins descending.
- `leagues` is keyed by `NFL` / `NCAAF`, uppercased. Two different sports to
  handicap, so worth separating.
- `teams` covers **spread and moneyline picks only** — a total's selection is
  the word "Over" or "Under", which is not a team anyone picked.
- `units` is profit on one unit staked, at the real price. Unpriced picks are
  treated as −110.

### `fn=isAdmin&email=<email>`

```json
{"ok":true,"admin":false}
```

### `POST fn=submit`

```js
fetch(CONFIG.API + '?fn=submit&email=' + encodeURIComponent(email)
      + '&user=' + encodeURIComponent(name || email),
  { method: 'POST', body: JSON.stringify({ email, user, picks, allowReplace: false }) });
```

No custom headers — adding `Content-Type` triggers a CORS preflight that Apps
Script does not answer, and the request fails outright.

Each pick in `picks`:

```js
{ week, league, gameId, matchup, market, kind, selection, odds, meta }
```

| Field | Values |
|---|---|
| `week` | `YYYY-MM-DD`, the Wednesday of the slate |
| `league` | `NFL` or `NCAAF` |
| `gameId` | the `id` from `fn=odds` — **this is what grading joins on** |
| `matchup` | `"Away Team @ Home Team"` — **the format is load-bearing**, see §5 |
| `market` | `spread` \| `total` \| `moneyline` |
| `kind` | `favorite` \| `underdog` \| `over` \| `under` \| `ml` |
| `selection` | the exact team name from the feed, or `Over` / `Under` |
| `odds` | American odds, a number |
| `meta` | `{line}` for spreads, `{total}` for totals, `{}` for moneyline |

Response is `{"ok":true,"count":5,"replaced":0}` or `{"ok":false,"error":"..."}`.

Submitting again **replaces** that week's picks for that email, unless any of
them are already graded, in which case the week is locked and it errors.

---

## 3. Element IDs the JavaScript binds to

If the existing JavaScript is kept and only the markup and CSS are rebuilt —
**the recommended split** — every one of these must exist with the same id.
Layout, nesting, and classes are otherwise free.

### Structural

| id / selector | What it is |
|---|---|
| `.tab` with `data-tab="picks\|mine\|board\|queries\|hof"` | tab buttons |
| `.view` with `id="view-picks"` … `id="view-hof"` | tab panels; hidden ones carry class `hidden` |
| `.seasonBar` | wrapper round the season selector; gets class `stale` when not on the newest season |
| `.game.started` | a game whose kickoff has passed; dimmed, chips disabled |

### Header

`seasonPicker` (select), `nameInput`, `emailInput`, `userBadge`, `btnLogout`

### Make Picks

`btnPrevWeek`, `btnNextWeek`, `btnThisWeek`, `weekLabel`, `sportFilter`
(select), `btnRefresh`, `games`, `picksList`, `btnSubmit`, `submitStatus`,
`weekStatus`

Rule counters: `ruleNFL`, `ruleCFB`, `ruleOU`, `ruleFD`, `ruleML`, `ruleMsg`

Game market buttons carry class `chip`, and `chip selected` when chosen.

### My Picks

`myPicksTable` — a `<table>` with a `<tbody>`. Cells are given
`data-label="Week"`, `"Sport"`, `"Matchup"`, `"Market"`, `"Selection"`,
`"Line"`, `"Odds"`, `"Status"` so the mobile card layout can use
`td::before { content: attr(data-label); }`.

### Scoreboard

`boardTable` (`<table>` with `<tbody>`), `btnRefreshBoard`, `weekPicker`
(select), `weekTable`

### Queries

`qPlayer` (select), `qView` (select), `qSummary`, `qChart`, `qNote`

`qView` option values, which the render code switches on:
`markets`, `units`, `leagues`, `weeks`, `cum`, `teamsW`, `teamsL`, `players`

---

## 4. Behaviour that has to be preserved

### Season selector

- Governs **every** tab, not just one.
- Stored in **`sessionStorage`** under `pg_season`, deliberately not
  `localStorage`: the choice should survive tab switches and reloads, but a
  fresh visit should open on the **newest** season rather than on whatever
  someone was reading last month.
- A saved season that no longer exists falls back to the newest, rather than
  filtering everything down to nothing.
- Show it as **not** on the newest season when that is the case, or people hunt
  for this week's missing games.
- Every read request appends `&season=` — route new calls through `apiUrl()`
  rather than building URLs by hand, so a new endpoint is season-aware without
  anyone remembering.

### Pick validation

The backend enforces all of this and returns a plain-English error, so the UI
copy can mirror it. Exactly **5** picks:

- 4 non-moneyline + 1 moneyline
- among the 4: exactly 2 NFL and 2 NCAAF
- among the 4: exactly 1 Over, 1 Under, 1 Favorite, 1 Underdog
- the moneyline's odds must be **greater than −200**

The submit button stays disabled until all of that holds. Do not relax it
client-side; the server will refuse anyway and the error is worse UX than a
disabled button.

### Kickoff lock

**A pick is legal until its own game starts.** Not one deadline for the slate -
each game locks itself, so a Sunday pick can still be made after Thursday night
is over.

The server enforces it in `checkKickoffLock_`, reading kickoffs from the odds
feed (cached, so it costs nothing). The page must **dim games whose kickoff has
passed and stop their chips responding** - that is a courtesy, not the
enforcement, because the request can be replayed by hand.

The subtle part: a submission **replaces the whole week**, so somebody changing
their Sunday pick on Saturday re-sends all five, including the Thursday one
whose game is long over. The rule is therefore not "no picks on started games"
but *"the picks on started games must be exactly what they already were"*:

| Situation | Result |
|---|---|
| Editing a pick whose game has not started | fine, even if other games have |
| Re-sending an unchanged pick on a started game | fine |
| Changing side, or moving the line, on a started game | refused |
| Removing a pick on a started game | refused |
| A first submission on a game already under way | refused |

A game the feed has never heard of, or an odds outage, **fails open** - an
outage must not stop the whole league submitting. Use `gameStarted(game)` on
the page; it deliberately treats a missing or unparseable kickoff as *not*
started, matching the server.

### Weeks

A slate is keyed to its **Wednesday**. The Make Picks tab walks in 7-day steps
from the Wednesday of the current week.

---

## 5. Things that look cosmetic but are not

**`matchup` must stay `"Away Team @ Home Team"`.** It is the only place home and
away are recorded, and `splitMatchup_()` on the backend parses it to work out
which side a pick was on when grading old weeks and when auditing. "Away vs
Home", "Home v Away", or a prettier separator silently disables both.

**Team names must be the feed's exact strings**, passed through from `fn=odds`
untouched. Grading matches a pick's `selection` against the scores feed's team
names. Shortening "Kansas City Chiefs" to "KC" for display is fine; sending it
is not.

**`gameId` is the join key** between a pick and its result. It comes from
`fn=odds` and must round-trip unchanged.

**No custom request headers on the submit POST.** See §2.

---

## 6. What the test suites check

Six suites, 416 assertions, run with `node tools/<name>-test.js`. Two touch the
frontend:

**`build-test.js`** runs the real `inject-config.sh` and evaluates the output.
It needs `const CONFIG = { … };` and `function apiConfigured() { … }` to exist
as text, and the placeholder to be gone after a build.

**`frontend-test.js`** extracts the `<script>` and runs it against a stub DOM
and a fake API. It currently expects these names to exist:

```
SEASON, apiUrl, loadSeasons, buildQueries, renderQuery, drawBars,
esc, pctText, recText, unitText, Q
```

It drives: the season default and fallback, `sessionStorage` persistence, all
seven `qView` values, missing players, a failing stats endpoint, an empty season
list, and HTML escaping of team names.

> If the rebuild replaces the JavaScript wholesale rather than restyling around
> it, these two suites need rewriting to match. That is fine — say so and it
> will be done — but a silently broken test is worse than a deleted one.

---

## 7. Recommended split

**Best outcome for the least risk:** rebuild the **markup and CSS**, keep the
JavaScript. The JS is tested; the CSS is not, and does not need to be. Honour
the ids in §3 and everything keeps working with no backend change at all.

If markup structure needs to change more than that allows, the next safest step
is to keep the **function names and the API calls** and rewrite only how they
render — `drawBars()`, `buildBoard()`, `renderQuery()` and friends can produce
entirely different HTML as long as they are still called the same way.

Mobile is the priority. Worth knowing about the current page:

- `#myPicksTable` already collapses to cards under 640px using
  `data-label` attributes; that pattern is worth keeping for any wide table.
- The Queries charts are `div`s in a three-column grid
  (`label | track | value`), which reflows to narrow screens more gracefully
  than a canvas would.
- The season selector sits above the brand rather than beside it, so it does
  not compete for width in the header on a phone.

---

---

## 8. Client state, if you are replacing the JavaScript

§3 is enough when the JavaScript is kept and only markup and CSS change — the
recommended path. This section is what you additionally need if the JS is being
rewritten.

### 8.1 Persisted state

Four keys, and the storage choice matters in each case:

| Key | Where | Holds | Why there |
|---|---|---|---|
| `pg_name` | `localStorage` | display name | survives between visits; nobody wants to retype it weekly |
| `pg_email` | `localStorage` | identity for submit and My Picks | same |
| `pg_api` | `localStorage` | backend URL override | development only; a stale one silently breaks the live site, hence `?reset=1` |
| `pg_season` | **`sessionStorage`** | selected season | must reset to newest on a fresh visit — see §4 |

There is no login. The email field *is* the identity, and the backend trusts it.
That is fine for a league of friends and worth knowing before designing anything
that looks like authentication.

### 8.2 In-memory state

```js
const state = {
  name: null, email: null,
  weekStart: startOfWedWeek(new Date()),  // Date, the slate's Wednesday
  gamesAll: [],   // every game fetched, both leagues
  games: [],      // gamesAll after the week and sport filters
  picks: []       // the working set, max 5
};
```

A pick under construction has the same shape as the submit payload in §2.

### 8.3 Selecting picks

A chip is identified by:

```
`${game.id}|${market}|${kind}|${selection}`
```

Clicking an unselected chip adds that pick; clicking a selected one removes it.
A chip carries class `selected` when its key is in `state.picks`. Chips on a
started game are `disabled` and carry no click handler at all (§4).

### 8.4 The rules bar

Live counters, recomputed on every pick change. The backend enforces the same
rules, so the copy can be shared:

| Element | Content |
|---|---|
| `ruleNFL` | `NFL: n/2` |
| `ruleCFB` | `CFB: n/2` |
| `ruleOU` | `O/U: n Over / n Under` |
| `ruleFD` | `Fav/Dog: n Fav / n Dog` |
| `ruleML` | `ML: n/1 (odds > -200)`, plus `- invalid odds` when the price fails |
| `ruleMsg` | `Ready to submit.` or the constraint reminder |

`btnSubmit` is enabled only when **all** rules pass **and** the email field is
non-empty. Do not relax that client-side; the server refuses anyway, and an
error after five taps is worse UX than a disabled button.

### 8.5 Status messages

Two classes carry the whole convention:

- `class="status alert ok"` — green, success
- `class="status alert err"` — red, failure

Used by `ruleMsg`, `submitStatus` and `weekStatus`. Keep the class names or
restyle them, but keep the two-state distinction.

### 8.6 Admin endpoints are backend-only

`fn=isAdmin` and `POST fn=grade` exist and work, but **nothing in the current
frontend calls them** — manual grading is done from the Apps Script editor.
There is no admin UI to redesign. Building one is a legitimate addition, not a
port.

---

## 9. Where the current page is weakest

Offered as a starting list rather than a specification, from having worked in it:

- **The odds grid is desktop-shaped.** `minmax(280px,1fr)` cards with market
  chips wrapping inside them. On a phone the chips wrap to three lines and the
  card gets tall, so a slate of forty games is a very long scroll with no way to
  jump.
- **No sense of progress.** Five picks with six constraints, and the only
  feedback is a row of counters above the fold that you scroll away from while
  actually picking.
- **The scoreboard is a seven-column table** on a 360px screen. `My Picks`
  already solves this with the `data-label` card pattern; the board does not.
- **Queries has no empty state worth the name** — just "Nothing to show".
- **Nothing indicates staleness.** Grading runs every six hours, so a result can
  be up to six hours behind, and the page never says when it last updated.

---

## 10. Checking the result

```
node tools/build-test.js       # the Netlify build still works
node tools/frontend-test.js    # the page's JS still behaves
```

Then, after deploying, open the `/exec` URL bare and confirm `has` lists
`seasons` and `stats` — that is the deployment reporting which code it is
actually running, which has already caught one stale deploy that looked fine
from every other angle.
