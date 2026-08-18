/* Exercises the page's own JavaScript against a stub DOM and a fake API.

   The frontend has no build step and no test framework, so nothing else would
   notice a typo in it until somebody opened the site. This pulls the real
   <script> out of index.html, runs it, and drives the season selector and the
   Queries tab the way a person would.

       node tools/frontend-test.js                                          */
const fs = require("fs");
const path = require("path");

const HTML = fs.readFileSync(
  path.join(__dirname, "..", "Deploy Front End HTML", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) pass++;
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? " :: " + detail : "")); }
};
const section = (t) => console.log("\n" + t);

// ------------------------------------------------------------------ stub DOM
function makeEl(id) {
  const e = {
    id, value: "", textContent: "", innerHTML: "", dataset: {},
    _handlers: {}, _children: [], classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    fire(ev, arg) { (this._handlers[ev] || []).forEach((f) => f(arg || { target: this })); },
    appendChild(c) { this._children.push(c); }
  };
  return e;
}

function harness(apiResponses) {
  const els = {};
  const get = (sel) => (els[sel] = els[sel] || makeEl(sel));

  // Tabs the page queries by class.
  const tabs = ["picks", "mine", "board", "queries", "hof"].map((name) => {
    const t = makeEl("tab-" + name);
    t.dataset.tab = name;
    return t;
  });
  tabs[0].classList.add("active");

  const store = {};
  const session = {};
  const fetched = [];

  const win = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    sessionStorage: {
      getItem: (k) => (k in session ? session[k] : null),
      setItem: (k, v) => { session[k] = String(v); },
      removeItem: (k) => { delete session[k]; }
    },
    location: { protocol: "https:", hostname: "quinton4mvp.com", origin: "https://quinton4mvp.com",
                search: "", pathname: "/", replace() {} },
    console: { log() {}, error() {}, warn() {} },
    document: {
      addEventListener(ev, fn) { if (ev === "DOMContentLoaded") this._boot = fn; },
      querySelector: (sel) => get(sel),
      querySelectorAll: (sel) => (sel === ".tab" ? tabs : []),
      createElement: () => makeEl("created")
    },
    fetch: async (url) => {
      fetched.push(url);
      const fn = (String(url).match(/[?&]fn=([^&]+)/) || [])[1];
      const body = apiResponses[fn];
      if (body === undefined) throw new TypeError("Failed to fetch");
      return { json: async () => body, text: async () => JSON.stringify(body) };
    }
  };

  // The page's script, minus the DOMContentLoaded body which we call directly.
  const src = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

  const exported = "return { SEASON, apiUrl, loadSeasons, buildQueries, renderQuery,"
    + " drawBars, esc, pctText, recText, unitText, Q, gameStarted, state, renderGames,"
    + " togglePick, renderPicks, validateRules, cellBlocked, shortName, sayWhy,"
    + " boot: document._boot };";

  const fn = new Function(
    "localStorage", "sessionStorage", "location", "console", "document", "fetch", "window",
    src + "\n" + exported
  );

  const api = fn(win.localStorage, win.sessionStorage, win.location, win.console,
                 win.document, win.fetch, win);
  return { api, get, tabs, fetched, session, win };
}

const SEASONS = { ok: true, seasons: [
  { season: "2026-27", picks: 40, weeks: 1, players: 8 },
  { season: "2025-26", picks: 545, weeks: 14, players: 8 }
] };

const rec = (w, l, p, units) => ({ w, l, p, n: w + l + p, pct: (w + l) ? w / (w + l) : 0, units });
const STATS = { ok: true, season: "2025-26", players: ["Ann", "Bob"], stats: {
  __all__: { overall: rec(10, 8, 1, 1.2),
    markets: { moneyline: rec(3, 2, 0, 0.5), spread_fav: rec(4, 3, 1, 0.2),
               spread_dog: rec(3, 3, 0, -0.4), over: rec(2, 1, 0, 0.9),
               under: rec(1, 2, 0, -1.1), spread_pk: rec(0, 0, 0, 0) },
    leagues: { NFL: rec(7, 4, 0, 1.9), NCAAF: rec(3, 4, 1, -0.7) },
    weeks: [{ week: "2025-09-03", ...rec(3, 2, 0, 0.7) }, { week: "2025-09-10", ...rec(1, 4, 0, -2.1) }],
    teams: [{ team: "Kansas City Chiefs", ...rec(5, 1, 0, 3.2) },
            { team: "Buffalo Bills", ...rec(1, 6, 0, -4.1) }] },
  Ann: { overall: rec(6, 3, 0, 2.1),
    markets: { moneyline: rec(2, 1, 0, 0.8), spread_fav: rec(2, 1, 0, 0.6),
               spread_dog: rec(1, 1, 0, -0.1), over: rec(1, 0, 0, 0.9),
               under: rec(0, 0, 0, 0), spread_pk: rec(0, 0, 0, 0) },
    leagues: { NFL: rec(4, 1, 0, 1.6), NCAAF: rec(2, 2, 0, 0.5) },
    weeks: [{ week: "2025-09-03", ...rec(4, 1, 0, 2.6) }],
    teams: [{ team: "Kansas City Chiefs", ...rec(3, 0, 0, 2.7) }] },
  Bob: { overall: rec(4, 5, 1, -0.9),
    markets: { moneyline: rec(1, 1, 0, -0.3), spread_fav: rec(2, 2, 1, -0.4),
               spread_dog: rec(2, 2, 0, -0.2), over: rec(1, 1, 0, 0),
               under: rec(1, 2, 0, -1.1), spread_pk: rec(0, 0, 0, 0) },
    leagues: { NFL: rec(3, 2, 1, 0.3), NCAAF: rec(1, 3, 0, -1.2) },
    weeks: [{ week: "2025-09-03", ...rec(2, 3, 0, -1.2) }],
    teams: [{ team: "Buffalo Bills", ...rec(1, 6, 0, -4.1) }] }
} };

// ------------------------------------------------------------------- season
section("the season selector defaults to the newest and remembers a change");
{
  const { api, get, session } = harness({ seasons: SEASONS, stats: STATS, board: { ok: true, rows: [] } });

  return Promise.resolve()
    .then(() => api.loadSeasons())
    .then(() => {
      ok(api.SEASON.current === "2026-27", "a fresh visit opens on the newest season",
         api.SEASON.current);
      ok(session.pg_season === "2026-27", "and that is remembered for the session",
         session.pg_season);
      ok(/2026-27/.test(get("#seasonPicker").innerHTML), "the picker is populated");
      ok(/All seasons/.test(get("#seasonPicker").innerHTML), "with an all-seasons option");

      // A person picks the older season.
      api.SEASON.current = "2025-26";
      ok(session.pg_season === "2025-26", "a change is stored", session.pg_season);
      ok(api.apiUrl("board").indexOf("season=2025-26") > 0,
         "and every request carries it", api.apiUrl("board"));

      // A brand new tab starts clean: same page code, empty sessionStorage.
      const fresh = harness({ seasons: SEASONS, stats: STATS, board: { ok: true, rows: [] } });
      return fresh.api.loadSeasons().then(() => {
        ok(fresh.api.SEASON.current === "2026-27",
           "a new session goes back to the newest, not the last choice",
           fresh.api.SEASON.current);
      });
    })
    .then(run2);
}

function run2() {
  section("a saved season that no longer exists falls back to the newest");
  return (async () => {
    const h = harness({ seasons: SEASONS, stats: STATS });
    h.session.pg_season = "2019-20";        // a season since removed
    await h.api.loadSeasons();
    ok(h.api.SEASON.current === "2026-27", "it does not filter everything to nothing",
       h.api.SEASON.current);

    section("'all seasons' sends no season filter");
    const h2 = harness({ seasons: SEASONS, stats: STATS });
    await h2.api.loadSeasons();
    h2.api.SEASON.current = "all";
    ok(h2.api.apiUrl("board").indexOf("season=") < 0,
       "so the backend returns every season", h2.api.apiUrl("board"));

    section("apiUrl builds and escapes properly");
    const h3 = harness({ seasons: SEASONS });
    await h3.api.loadSeasons();
    const u = h3.api.apiUrl("mine", { email: "a b@x.com" });
    ok(u.indexOf("fn=mine") > 0, "names the function", u);
    ok(u.indexOf("a%20b%40x.com") > 0, "escapes parameters", u);
    ok(u.indexOf("&season=2026-27") > 0, "and appends the season", u);
    const u2 = h3.api.apiUrl("board", { week: "", nope: null });
    ok(u2.indexOf("week=") < 0 && u2.indexOf("nope") < 0, "blank parameters are dropped", u2);
  })().then(run3);
}

function run3() {
  section("the Queries tab renders every view without throwing");
  return (async () => {
    const h = harness({ seasons: SEASONS, stats: STATS });
    await h.api.loadSeasons();
    await h.api.buildQueries();

    const chart = h.get("#qChart"), summary = h.get("#qSummary"), note = h.get("#qNote");
    ok(/All players/.test(h.get("#qPlayer").innerHTML), "the who selector is filled",
       h.get("#qPlayer").innerHTML.slice(0, 60));
    ok(/Ann/.test(h.get("#qPlayer").innerHTML) && /Bob/.test(h.get("#qPlayer").innerHTML),
       "with every player");

    for (const view of ["markets", "units", "leagues", "weeks", "cum", "teamsW", "teamsL", "players"]) {
      h.get("#qView").value = view;
      let threw = null;
      try { h.api.renderQuery(); } catch (e) { threw = e; }
      ok(!threw, "view renders: " + view, threw && threw.message);
      ok(chart.innerHTML.length > 0, "view draws something: " + view);
      ok(note.textContent.length > 0, "view explains itself: " + view);
    }

    section("the charts say the right things");
    h.get("#qView").value = "markets";
    h.api.renderQuery();
    ok(/Moneyline/.test(chart.innerHTML), "markets are named", chart.innerHTML.slice(0, 80));
    ok(!/Spread - pick em/.test(chart.innerHTML), "an empty bucket is left out entirely");
    ok(/\.524/.test(note.textContent), "and break-even is spelled out", note.textContent);

    h.get("#qView").value = "units";
    h.api.renderQuery();
    ok(/zero/.test(chart.innerHTML), "a chart with negatives draws a zero line");
    ok(/bar neg/.test(chart.innerHTML), "and marks the negative bars");
    ok(/-1\.10u/.test(chart.innerHTML), "with signed unit values", (chart.innerHTML.match(/-1\.\d\du/) || [])[0]);

    h.get("#qView").value = "leagues";
    h.api.renderQuery();
    ok(/College \(NCAAF\)/.test(chart.innerHTML), "college is spelled out, not left as a code",
       (chart.innerHTML.match(/College[^<]*/) || [])[0]);
    ok(chart.innerHTML.indexOf("NFL") < chart.innerHTML.indexOf("College"),
       "NFL first, as the picks are ordered");

    h.get("#qView").value = "teamsW";
    h.api.renderQuery();
    ok(/Kansas City Chiefs/.test(chart.innerHTML), "top teams by wins");
    ok(chart.innerHTML.indexOf("Kansas City") < chart.innerHTML.indexOf("Buffalo"),
       "best first");

    h.get("#qView").value = "teamsL";
    h.api.renderQuery();
    ok(chart.innerHTML.indexOf("Buffalo") < chart.innerHTML.indexOf("Kansas City"),
       "and worst first when asking about losses");

    section("switching player changes the numbers");
    h.get("#qView").value = "markets";
    h.get("#qPlayer").value = "Ann";
    h.api.renderQuery();
    ok(/6-3/.test(summary.textContent), "Ann's own record", summary.textContent);
    h.get("#qPlayer").value = "Bob";
    h.api.renderQuery();
    ok(/4-5-1/.test(summary.textContent), "and Bob's, pushes included", summary.textContent);
    ok(/-0\.90u/.test(summary.textContent), "with his units", summary.textContent);
  })().then(run4);
}

function run4() {
  section("a missing player is handled, not crashed on");
  return (async () => {
    const h = harness({ seasons: SEASONS, stats: STATS });
    await h.api.loadSeasons();
    await h.api.buildQueries();
    h.get("#qPlayer").value = "Nobody";
    let threw = null;
    try { h.api.renderQuery(); } catch (e) { threw = e; }
    ok(!threw, "no exception", threw && threw.message);
    ok(/No graded picks/.test(h.get("#qChart").innerHTML), "it says so plainly",
       h.get("#qChart").innerHTML);


    section("started games are recognised on the page too");
    const gs = h.api.gameStarted;
    const past = new Date(Date.now() - 3600e3).toISOString();
    const soon = new Date(Date.now() + 3600e3).toISOString();
    ok(gs({ kickoff: past }) === true,  "an hour ago has started");
    ok(gs({ kickoff: soon }) === false, "an hour away has not");
    ok(gs({ commence_time: past }) === true, "commence_time is read as well as kickoff");
    ok(gs({}) === false, "no kickoff is treated as not started - the same as the server");
    ok(gs({ kickoff: "not a date" }) === false, "and so is an unparseable one");
    ok(gs(null) === false, "a missing game does not throw");


    section("the odds grid builds six cells per game");
    {
      const g = { id:"g1", league:"NFL", kickoff:soon,
        home_team:"Kansas City Chiefs", away_team:"Buffalo Bills",
        spread:{ fav:"home", line:-6.5, favPrice:-110, dogPrice:-108 },
        totals:{ total:47.5, overPrice:-112, underPrice:-108 },
        moneyline:{ home:-280, away:230 } };
      h.api.state.games = [g]; h.api.state.gamesAll = [g];
      h.api.state.picks = [];
      h.api.renderGames();
      const html = h.get("#games").innerHTML;

      ok((html.match(/class="cell/g) || []).length === 6, "six cells",
         (html.match(/class="cell/g) || []).length);
      ok(/Chiefs/.test(html) && /Bills/.test(html), "both teams named");
      // The favourite lays its number, the dog takes it.
      ok(/-6\.5/.test(html), "the favourite's line is negative");
      ok(/\+6\.5/.test(html), "and the dog's is positive");
      ok(/O 47\.5/.test(html) && /U 47\.5/.test(html), "over on the away row, under on the home row");
      ok(/\+230/.test(html), "plus money is signed");
    }

    section("illegal cells dim rather than erroring");
    {
      const mk = (id, lg, fav) => ({ id:id, league:lg, kickoff:soon,
        home_team:id+" Home", away_team:id+" Away",
        spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
        totals:{ total:44, overPrice:-110, underPrice:-110 },
        moneyline:{ home:fav, away:150 } });

      const g1 = mk("g1","NFL",-150), g2 = mk("g2","NFL",-150), g3 = mk("g3","NCAAF",-150);
      h.api.state.games = [g1,g2,g3]; h.api.state.gamesAll = [g1,g2,g3];
      h.api.state.picks = [];

      // Take the favourite on g1. Every other favourite must now be dead.
      h.api.togglePick(g1, "spread", "favorite", "g1 Home", { line:-3 }, -110);
      let html = h.get("#games").innerHTML;
      ok(h.api.state.picks.length === 1, "the pick registered", h.api.state.picks.length);
      const favCells = html.split('data-kind="favorite"');
      ok(favCells.length === 4, "three favourite cells exist", favCells.length - 1);
      // The one taken is selected; the other two dead.
      ok((html.match(/class="cell selected pickable"/g) || []).length === 1,
         "exactly one selected cell");
      ok((html.match(/class="cell dead"/g) || []).length >= 2,
         "the other favourites are dead", (html.match(/class="cell dead"/g) || []).length);

      // Two NFL non-ML picks fills the league; g3 (college) stays open.
      h.api.togglePick(g2, "total", "over", "Over", { total:44 }, -110);
      html = h.get("#games").innerHTML;
      const g3open = html.split('data-game="g3"').slice(1)
        .filter(x => x.indexOf('dead') !== 0).length;
      ok(g3open > 0, "college cells are still available once NFL is full");

      // A -280 moneyline is illegal: the rule is strictly better than -200.
      h.api.state.picks = [];
      const chalk = mk("g9","NFL",-280);
      h.api.state.games = [chalk]; h.api.state.gamesAll = [chalk];
      h.api.renderGames();
      html = h.get("#games").innerHTML;
      const mlCells = html.split('data-market="moneyline"');
      ok(/-280/.test(html), "the short price is still shown");
      ok(mlCells[1].indexOf("dead") < 0 ? false : true, "and its cell is dead",
         mlCells[1].slice(0, 40));

      /* The boundary itself. -200 exactly is illegal - the rule is strictly
         better than -200 - and only a test AT the boundary can tell > from >=. */
      h.api.state.picks = [];
      const exact = mk("g10","NFL",-200);
      h.api.state.games = [exact]; h.api.state.gamesAll = [exact];
      h.api.renderGames();
      const atBoundary = h.get("#games").innerHTML.split('data-market="moneyline"')[1] || "";
      ok(atBoundary.indexOf("dead") >= 0, "-200 exactly is refused, not allowed",
         atBoundary.slice(0, 40));
      ok(h.api.cellBlocked(exact, "moneyline", "ml", -200) === "price",
         "and cellBlocked says why");
      ok(h.api.cellBlocked(exact, "moneyline", "ml", -199) === null,
         "while -199 is fine", h.api.cellBlocked(exact, "moneyline", "ml", -199));
    }

    section("a dimmed cell says why it is dimmed");
    {
      const mk2 = (id, lg, ml) => ({ id:id, league:lg, kickoff:soon,
        home_team:id+" Home", away_team:id+" Away",
        spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
        totals:{ total:44, overPrice:-110, underPrice:-110 },
        moneyline:{ home:ml, away:150 } });
      const a = mk2("q1","NFL",-150), b = mk2("q2","NFL",-150), c = mk2("q3","NCAAF",-400);
      h.api.state.games=[a,b,c]; h.api.state.gamesAll=[a,b,c]; h.api.state.picks=[];

      h.api.togglePick(a,"spread","favorite","q1 Home",{line:-3},-110);
      let html = h.get("#games").innerHTML;
      ok(/title="You already have a favourite"/.test(html),
         "a used role explains itself", (html.match(/title="You already[^"]*"/)||[])[0]);
      ok(/title="Tap to remove"/.test(html), "and the selected cell says how to undo it");
      ok(/title="A moneyline must be priced better than -200"/.test(html),
         "a short price explains itself");

      h.api.togglePick(a,"total","over","Over",{total:44},-110);
      h.api.togglePick(b,"spread","underdog","q2 Away",{line:3},-110);
      html = h.get("#games").innerHTML;
      ok(/title="You already have two picks in this league"/.test(html),
         "and a full league does too", (html.match(/title="You already have two[^"]*"/)||[])[0]);

      const started = mk2("q4","NFL",-150); started.kickoff = past;
      h.api.state.games=[started]; h.api.state.gamesAll=[started];
      h.api.renderGames();
      ok(/title="This game has already kicked off"/.test(h.get("#games").innerHTML),
         "as does a started game");
    }

    section("tapping a dead cell says why, on a phone as well as a desktop");
    {
      /* The real case: two college picks fills CFB 2/2, so every college spread
         and total dims - while college moneylines stay live, because the ML is
         exempt from the league count. Silence there reads as a broken grid. */
      const cfb = (id) => ({ id:id, league:"NCAAF", kickoff:soon,
        home_team:id+" Home", away_team:id+" Away",
        spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
        totals:{ total:44, overPrice:-110, underPrice:-110 },
        moneyline:{ home:-150, away:150 } });
      const c1=cfb("c1"), c2=cfb("c2"), c3=cfb("c3");
      h.api.state.games=[c1,c2,c3]; h.api.state.gamesAll=[c1,c2,c3]; h.api.state.picks=[];

      h.api.togglePick(c1,"spread","favorite","c1 Home",{line:-3},-110);
      h.api.togglePick(c2,"total","over","Over",{total:44},-110);

      const html = h.get("#games").innerHTML;
      ok(/title="You already have two picks in this league"/.test(html),
         "the league-full reason is on the cells");

      // The moneyline is exempt, so it must NOT be dimmed for that reason.
      const c3block = html.split('data-game="c3"');
      const mlPart = c3block.filter(x => /data-market="moneyline"/.test(x))[0] || "";
      ok(h.api.cellBlocked(c3,"moneyline","ml",150) === null,
         "college moneylines stay live once CFB is full",
         h.api.cellBlocked(c3,"moneyline","ml",150));

      h.api.sayWhy("You already have two picks in this league");
      ok(h.get("#cellNote").textContent === "You already have two picks in this league",
         "and tapping one shows it", h.get("#cellNote").textContent);
      ok(h.get("#cellNote").classList.contains("on"), "the note is visible");
      h.api.sayWhy("");
      ok(h.get("#cellNote").textContent === "You already have two picks in this league",
         "an empty reason does not blank the note");
    }

    section("a game with no moneyline shows a blank, not a broken cell");
    {
      const g = { id:"nm", league:"NCAAF", kickoff:soon,
        home_team:"No Line Home", away_team:"No Line Away",
        spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
        totals:{ total:44, overPrice:-110, underPrice:-110 },
        moneyline:null };
      h.api.state.games=[g]; h.api.state.gamesAll=[g]; h.api.state.picks=[];
      h.api.renderGames();
      const html = h.get("#games").innerHTML;
      /* 24 of 111 real college games have no moneyline priced. */
      ok((html.match(/class="cell blank"/g)||[]).length === 2,
         "both moneyline cells are blank", (html.match(/class="cell blank"/g)||[]).length);
      ok(/title="Not priced"/.test(html), "and say so rather than looking disabled");
      ok((html.match(/pickable/g)||[]).length === 4, "the other four still work",
         (html.match(/pickable/g)||[]).length);
    }

    section("a started game is inert whatever else is true");
    {
      const g = { id:"gx", league:"NFL", kickoff:past,
        home_team:"A Home", away_team:"A Away",
        spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
        totals:{ total:44, overPrice:-110, underPrice:-110 },
        moneyline:{ home:-120, away:110 } };
      h.api.state.games = [g]; h.api.state.gamesAll = [g]; h.api.state.picks = [];
      h.api.renderGames();
      const html = h.get("#games").innerHTML;
      ok(/class="game started"/.test(html), "the card is marked started");
      ok(/Kicked off/.test(html), "and badged");
      ok((html.match(/pickable/g) || []).length === 0, "no cell is pickable",
         (html.match(/pickable/g) || []).length);

      // Even called directly, the pick is refused.
      h.api.togglePick(g, "spread", "favorite", "A Home", { line:-3 }, -110);
      ok(h.api.state.picks.length === 0, "and togglePick refuses it too",
         h.api.state.picks.length);
    }

    section("the slip carries what the server needs");
    {
      const g = { id:"gs", league:"NCAAF", kickoff:soon,
        home_team:"Georgia Bulldogs", away_team:"Alabama Crimson Tide",
        spread:{ fav:"home", line:-7.5, favPrice:-115, dogPrice:-105 },
        totals:{ total:52.5, overPrice:-110, underPrice:-110 },
        moneyline:{ home:-300, away:250 } };
      h.api.state.games = [g]; h.api.state.gamesAll = [g]; h.api.state.picks = [];
      h.api.togglePick(g, "spread", "underdog", "Alabama Crimson Tide", { line:7.5, price:-105 }, -105);

      const p = h.api.state.picks[0];
      ok(p.matchup === "Alabama Crimson Tide @ Georgia Bulldogs",
         "matchup is away @ home - the only record of which side was home", p.matchup);
      ok(p.selection === "Alabama Crimson Tide",
         "selection is the feed's exact string, not an abbreviation", p.selection);
      ok(p.gameId === "gs", "gameId round-trips - it is what grading joins on");
      ok(p.league === "NCAAF", "league is uppercased");
      ok(p.meta.line === 7.5, "the line is frozen at pick time", p.meta.line);
      ok(/^\d{4}-\d{2}-\d{2}$/.test(p.week), "week is a plain date", p.week);
      ok(p.kickoff === soon, "kickoff travels with it for the server's lock");
    }

    section("the slot bar mirrors the rules");
    {
      h.api.state.picks = [];
      h.api.renderPicks(); h.api.validateRules();
      ok((h.get("#slotRow").innerHTML.match(/class="slot"/g) || []).length === 5,
         "five empty slots");
      ok(/Pick 5 more/.test(h.get("#btnSubmit").textContent), "the button counts down",
         h.get("#btnSubmit").textContent);
      ok(h.get("#btnSubmit").disabled === true, "and is disabled");
      ok(/NFL 0\/2/.test(h.get("#leagueTally").textContent), "the tally starts empty");

      // The counter elements the contract names still carry their text.
      ok(/NFL: 0\/2/.test(h.get("#ruleNFL").textContent), "ruleNFL still says what it said");
      ok(/ML: 0\/1 \(odds > -200\)/.test(h.get("#ruleML").textContent), "and ruleML too",
         h.get("#ruleML").textContent);
    }

    section("a pick row stays on one line per field");
    {
      /* The bug this exists for: the row was a grid whose 1fr track is
         minmax(auto,1fr). Its auto minimum fought a 40-character matchup until
         every single word, including the middle dot, wrapped onto its own
         line. Flex with min-width:0 is what lets it ellipsis instead. */
      const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
      const rowCss = css.slice(css.indexOf(".pickRow{"), css.indexOf(".weekRow{"));
      ok(/display:flex/.test(rowCss), "the row is flex, not grid");
      ok(!/grid-template-columns/.test(rowCss), "no track sizing left to collapse");
      ok(/min-width:0/.test(rowCss), "and the text column may shrink below its content");
      ok(/text-overflow:ellipsis/.test(rowCss), "so long values ellipsis");
      ok(/white-space:nowrap/.test(rowCss), "rather than wrapping a word at a time");
    }

    section("a stats failure is reported, not silent");
    const dead = harness({ seasons: SEASONS });   // no stats endpoint
    await dead.api.loadSeasons();
    await dead.api.buildQueries();
    ok(/Could not load stats/.test(dead.get("#qChart").innerHTML),
       "the tab explains itself", dead.get("#qChart").innerHTML);

    section("no seasons at all does not break the page");
    const empty = harness({ seasons: { ok: true, seasons: [] } });
    await empty.api.loadSeasons();
    ok(/No data yet/.test(empty.get("#seasonPicker").innerHTML), "the picker says so",
       empty.get("#seasonPicker").innerHTML);
    ok(empty.api.apiUrl("board").indexOf("season=") < 0, "and nothing is filtered");

    section("team names are escaped, not injected");
    const nasty = JSON.parse(JSON.stringify(STATS));
    nasty.stats.Ann.teams = [{ team: '<img src=x onerror=alert(1)>', w: 1, l: 0, p: 0, n: 1, pct: 1, units: 1 }];
    const h2 = harness({ seasons: SEASONS, stats: nasty });
    await h2.api.loadSeasons();
    await h2.api.buildQueries();
    h2.get("#qPlayer").value = "Ann";
    h2.get("#qView").value = "teamsW";
    h2.api.renderQuery();
    ok(h2.get("#qChart").innerHTML.indexOf("<img") < 0, "the tag is escaped");
    ok(/&lt;img/.test(h2.get("#qChart").innerHTML), "and shown as text");

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  })();
}
