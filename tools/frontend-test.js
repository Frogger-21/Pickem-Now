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
/* The Wednesday of the current week, mirroring the page, so a test can put
   the picking week back where it started. */
const startOfWedWeekLocal = () => {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - 3 + 7) % 7));
  return d;
};

// ------------------------------------------------------------------ stub DOM
function makeEl(id) {
  const e = {
    id, value: "", textContent: "", innerHTML: "", dataset: {}, style: {},
    rows: 0, select() {}, setAttribute() {}, removeAttribute() {},
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
    navigator: { clipboard: { writeText: async () => {} } },
    console: { log() {}, error() {}, warn() {} },
    document: {
      addEventListener(ev, fn) { if (ev === "DOMContentLoaded") this._boot = fn; },
      querySelector: (sel) => get(sel),
      querySelectorAll: (sel) => (sel === ".tab" ? tabs : []),
      createElement: () => makeEl("created"),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true
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
    + " togglePick, renderPicks, validateRules, cellBlocked, shortName, briefMatchup, sayWhy,"
    + " minPicks, setMinPicks, floorNote, seasonOfDate, alignWeekToSeason, fetchOdds,"
    + " buildWeekSlips, slipCardHtml, pickLineHtml, shareSlipText, shareSlip, MINE, tinyTeam,"
    + " boot: document._boot };";

  const fn = new Function(
    "localStorage", "sessionStorage", "location", "console", "document", "fetch", "window",
    "navigator",
    src + "\n" + exported
  );

  const api = fn(win.localStorage, win.sessionStorage, win.location, win.console,
                 win.document, win.fetch, win,
                 new Proxy({}, { get: (_, k) => win.navigator[k] }));
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

    for (const view of ["markets", "units", "leagues", "weeks", "cum", "teamsW", "teamsL", "teamsPct", "players"]) {
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
      /* Deliberately an NFL game. shortName only rewrites NFL names, so an
         abbreviation leaking into `selection` is detectable only on a team the
         map actually changes - a college name passes through untouched and the
         assertion would prove nothing. */
      const g = { id:"gs", league:"NFL", kickoff:soon,
        home_team:"Buffalo Bills", away_team:"Kansas City Chiefs",
        spread:{ fav:"home", line:-7.5, favPrice:-115, dogPrice:-105 },
        totals:{ total:52.5, overPrice:-110, underPrice:-110 },
        moneyline:{ home:-300, away:250 } };
      h.api.state.games = [g]; h.api.state.gamesAll = [g]; h.api.state.picks = [];
      h.api.togglePick(g, "spread", "underdog", "Kansas City Chiefs", { line:7.5, price:-105 }, -105);

      const p = h.api.state.picks[0];
      ok(p.matchup === "Kansas City Chiefs @ Buffalo Bills",
         "matchup is away @ home - the only record of which side was home", p.matchup);
      ok(p.selection === "Kansas City Chiefs",
         "selection is the feed's exact string, not an abbreviation", p.selection);
      ok(h.api.shortName("Kansas City Chiefs") === "Chiefs",
         "and shortName really would have changed it", h.api.shortName("Kansas City Chiefs"));
      ok(p.gameId === "gs", "gameId round-trips - it is what grading joins on");
      ok(p.league === "NFL", "league is uppercased");
      ok(p.meta.line === 7.5, "the line is frozen at pick time", p.meta.line);
      ok(/^\d{4}-\d{2}-\d{2}$/.test(p.week), "week is a plain date", p.week);
      ok(p.kickoff === soon, "kickoff travels with it for the server's lock");
    }

    section("the slot bar mirrors the rules");
    {
      h.api.state.picks = [];
      /* Both leagues on the board: the countdown only makes sense when the week
         is actually playable. A single-league board is its own case, below. */
      h.api.state.games = [
        { id:"mx1", league:"NFL",   kickoff:soon, home_team:"A", away_team:"B",
          spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
          totals:{ total:44, overPrice:-110, underPrice:-110 }, moneyline:{ home:-150, away:130 } },
        { id:"mx2", league:"NCAAF", kickoff:soon, home_team:"C", away_team:"D",
          spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
          totals:{ total:44, overPrice:-110, underPrice:-110 }, moneyline:{ home:-150, away:130 } }
      ];
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

    section("a page load does not spend API credits");
    {
      /* The odds endpoint bills markets x regions: spreads, totals and h2h
         across us is 3 credits, so a page load is 6 across two leagues. With
         nocache on every load, eight people checking a few times a week spends
         the whole 500-credit month on browsing. */
      const odds = { ok: true, games: [] };
      const hh = harness({ seasons: SEASONS, odds: odds });
      await hh.api.loadSeasons();
      hh.fetched.length = 0;

      await hh.api.fetchOdds();
      const auto = hh.fetched.filter((u) => /fn=odds/.test(u));
      ok(auto.length === 2, "one call per league", auto.length);
      ok(auto.every((u) => !/nocache/.test(u)),
         "and neither bypasses the cache", auto.join(" | "));

      hh.fetched.length = 0;
      await hh.api.fetchOdds(true);
      const forced = hh.fetched.filter((u) => /fn=odds/.test(u));
      ok(forced.every((u) => /nocache=1/.test(u)),
         "an explicit refresh does bypass it, which is the point of the button",
         forced.join(" | "));
    }

    section("no single-class rule positions absolutely");
    {
      /* The bug this catches: .bar was used for both the Queries chart bars and
         the status stripe on a pick row. The chart rule set position:absolute
         with no scope, so the stripe took it too, found no positioned ancestor,
         and stretched down the entire page as a green line against the left
         edge - clipping the header on its way past.
         A bare single-class selector that positions absolutely is a collision
         waiting for the next component that reuses the word. */
      const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
      const bare = [];
      const rule = /([^{}]+)\{([^}]*)\}/g;
      let m;
      while ((m = rule.exec(css)) !== null) {
        if (!/position\s*:\s*absolute/.test(m[2])) continue;
        const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/\s+/g, " ");
        for (const part of sel.split(",")) {
          if (/^\.[A-Za-z0-9_-]+$/.test(part.trim())) bare.push(part.trim());
        }
      }
      ok(bare.length === 0,
         "every absolutely-positioned rule names a parent", bare.join(", "));

      const track = css.slice(css.indexOf(".track .bar"), css.indexOf(".track .bar") + 120);
      ok(/position:absolute/.test(track), "the chart bar is still absolute inside its track");
      const stripe = css.slice(css.indexOf(".pickRow .bar"), css.indexOf(".pickRow .bar") + 90);
      ok(/position:static/.test(stripe),
         "and the pick stripe says outright that it is not", stripe.slice(0, 60));
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

    section("team names are not truncated in JavaScript");
    {
      /* The bug: names were cut to 15 characters before CSS ever saw the
         column, so "Virginia Cavaliers" arrived pre-shortened onto a 700px-wide
         desktop column. Only CSS knows the width. */
      const long = "Jacksonville State Gamecocks";
      ok(h.api.shortName(long) === long, "a long college name passes through whole",
         h.api.shortName(long));
      ok(h.api.shortName("Kansas City Chiefs") === "Chiefs",
         "while the NFL map still shortens, because that is a real name");
      const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
      ok(/text-overflow:ellipsis/.test(css.slice(css.indexOf(".team .abbr"), css.indexOf(".team .abbr") + 160)),
         "and the column ellipsises at whatever width it actually has");

      /* A slot barely wider than a thumb ships both forms and lets CSS pick. */
      ok(h.api.briefMatchup("San Jose State Spartans @ USC Trojans") === "USC Trojans",
         "a narrow slot falls back to the shorter team name",
         h.api.briefMatchup("San Jose State Spartans @ USC Trojans"));
      ok(h.api.briefMatchup("Kansas City Chiefs @ Buffalo Bills") === "Bills",
         "with the NFL map applied first", h.api.briefMatchup("Kansas City Chiefs @ Buffalo Bills"));
      ok(h.api.briefMatchup("no separator here") === "no separator here",
         "and an unparseable matchup is left alone");
    }

    section("a slot names the game, and the moneyline price is printed once");
    {
      const g = { id:"sl", league:"NCAAF", kickoff:soon,
        home_team:"TCU Horned Frogs", away_team:"North Carolina Tar Heels",
        spread:{ fav:"home", line:-7.5, favPrice:-110, dogPrice:-110 },
        totals:{ total:47.5, overPrice:-115, underPrice:-105 },
        moneyline:{ home:-330, away:260 } };
      h.api.state.games=[g]; h.api.state.gamesAll=[g]; h.api.state.picks=[];

      /* A total's selection is the word "Under", which names no game. A slot
         reading UNDER / Under / 47.5 tells you nothing about what you picked. */
      h.api.togglePick(g,"total","under","Under",{ total:47.5, price:-105 },-105);
      h.api.renderPicks();
      const slot = h.get("#slotRow").innerHTML;
      ok(!/>Under</.test(slot), "the slot does not just say Under", slot.slice(0,200));
      ok(/TCU/.test(slot), "it names the game instead", (slot.match(/class="pick">[^<]*/)||[])[0]);
      ok(/U 47\.5/.test(slot), "with the side and number on the sub-line",
         (slot.match(/class="sub">[^<]*/)||[])[0]);

      /* A spread and a moneyline already name a team, so they keep it. */
      h.api.state.picks=[];
      h.api.togglePick(g,"spread","underdog","North Carolina Tar Heels",{ line:7.5 },-110);
      h.api.renderPicks();
      ok(/North Carolina/.test(h.get("#slotRow").innerHTML), "a spread still names its team",
         (h.get("#slotRow").innerHTML.match(/class="pick">[^<]*/)||[])[0]);

      // The moneyline cell's value is the price; repeating it underneath
      // printed the same number twice.
      h.api.state.picks=[];
      h.api.renderGames();
      const mlCell = h.get("#games").innerHTML.split('data-market="moneyline"')[1] || "";
      const shown = (mlCell.match(/\+260/g) || []).length;
      ok(shown === 1, "the moneyline price appears once, not twice", shown);
      ok(/data-odds="260"/.test(mlCell), "and the real price still reaches the pick");
    }

    section("win % by team hides the coin flips");
    {
      const t = (team,w,l,units) => ({ team:team, w:w, l:l, p:0, n:w+l,
                                       pct:(w+l)?w/(w+l):0, units:units });
      const data = JSON.parse(JSON.stringify(STATS));
      data.stats.__all__.teams = [
        t("Buffalo Bills", 9, 2, 4.89),        // .818 over 11 - real
        t("Miami Hurricanes", 6, 0, 4.70),     // 1.000 over 6 - real
        t("Lucky Once", 1, 0, 0.91),           // 1.000 over 1 - noise
        t("Lucky Twice", 2, 0, 1.82),          // 1.000 over 2 - noise
        t("Lucky Thrice", 3, 0, 2.73),         // 1.000 over 3 - still under the floor
        t("Four Flat", 2, 2, -0.18),           // .500 over 4 - qualifies
        t("Never Picked", 0, 0, 0)             // no decided picks at all
      ];
      const hh = harness({ seasons: SEASONS, stats: data });
      await hh.api.loadSeasons();
      await hh.api.buildQueries();
      hh.get("#qView").value = "teamsPct";
      hh.api.renderQuery();
      const html = hh.get("#qChart").innerHTML, note = hh.get("#qNote").textContent;

      ok(/Miami Hurricanes/.test(html), "a 6-0 team makes it");
      ok(/Buffalo Bills/.test(html), "and so does 9-2");
      ok(!/Lucky Once/.test(html) && !/Lucky Twice/.test(html) && !/Lucky Thrice/.test(html),
         "but 1-0, 2-0 and 3-0 do not - they would all read 1.000",
         (html.match(/Lucky \w+/g) || []).join());
      ok(/Four Flat/.test(html), "four decided picks is enough to qualify");
      ok(!/Never Picked/.test(html), "a team with no decided picks is not ranked");

      // Miami is 1.000 and Buffalo .818, so Miami leads.
      ok(html.indexOf("Miami Hurricanes") < html.indexOf("Buffalo Bills"),
         "ranked by rate, highest first");
      ok(/9-2/.test(html) && /\.818/.test(html), "the record and rate are both shown");
      ok(/fewer than 4 times are left out/.test(note), "the floor is stated, not hidden", note);
      ok(/3 of 6/.test(note), "along with how many teams it removed", note);
    }

    section("the sample floor is a control, not a constant");
    {
      const t = (team,w,l) => ({ team:team, w:w, l:l, p:0, n:w+l,
                                 pct:(w+l)?w/(w+l):0, units:0 });
      const data = JSON.parse(JSON.stringify(STATS));
      data.stats.__all__.teams = [
        t("Once", 1, 0), t("Twice", 2, 0), t("Thrice", 3, 0),
        t("Four", 4, 0), t("Eight", 8, 0)
      ];
      const hh = harness({ seasons: SEASONS, stats: data });
      await hh.api.loadSeasons();
      await hh.api.buildQueries();
      hh.get("#qView").value = "teamsPct";

      ok(hh.api.minPicks() === 4, "it defaults to four", hh.api.minPicks());
      hh.api.renderQuery();
      ok(!/Thrice/.test(hh.get("#qChart").innerHTML), "so a 3-0 team is out by default");

      hh.api.setMinPicks(1);
      hh.api.renderQuery();
      const wide = hh.get("#qChart").innerHTML;
      ok(/Once/.test(wide) && /Thrice/.test(wide), "at 1+ everything appears");
      ok(/Every team is shown/.test(hh.get("#qNote").textContent),
         "and the note says the filter is off, rather than going quiet",
         hh.get("#qNote").textContent);

      hh.api.setMinPicks(8);
      hh.api.renderQuery();
      const tight = hh.get("#qChart").innerHTML;
      ok(/Eight/.test(tight) && !/Four/.test(tight), "at 8+ only the regulars survive");
      ok(/4 of 5 here/.test(hh.get("#qNote").textContent),
         "with the count it removed", hh.get("#qNote").textContent);

      /* A floor that removes nothing must still say so - a silent filter is
         worse than a visible one. */
      ok(/No team fell below/.test(hh.api.floorNote(5, 5, 4)),
         "and says when it removed nothing", hh.api.floorNote(5, 5, 4));

      // It applies to the ranked-by-wins views too, not just the rate one.
      hh.api.setMinPicks(8);
      hh.get("#qView").value = "teamsW";
      hh.api.renderQuery();
      ok(!/Four/.test(hh.get("#qChart").innerHTML), "Best teams honours it as well");

      // And is hidden where every row already has a hundred picks.
      hh.get("#qView").value = "markets";
      hh.api.renderQuery();
      ok(hh.get("#qMinField").classList.contains("hidden"),
         "the control hides on views where it would do nothing");
      hh.get("#qView").value = "teamsPct";
      hh.api.renderQuery();
      ok(!hh.get("#qMinField").classList.contains("hidden"), "and returns on the team views");

      hh.api.setMinPicks(4);
    }

    section("equal win rates are broken by sample size");
    {
      const t = (team,w,l) => ({ team:team, w:w, l:l, p:0, n:w+l, pct:1, units:0 });
      const data = JSON.parse(JSON.stringify(STATS));
      /* Named so alphabetical order gives the WRONG answer: if the tiebreak
         fell through to localeCompare, "Alpha" would lead on 4 picks. */
      data.stats.__all__.teams = [ t("Alpha Few", 4, 0), t("Zulu Many", 9, 0) ];
      const hh = harness({ seasons: SEASONS, stats: data });
      await hh.api.loadSeasons();
      await hh.api.buildQueries();
      hh.get("#qView").value = "teamsPct";
      hh.api.renderQuery();
      const html = hh.get("#qChart").innerHTML;
      ok(html.indexOf("Zulu Many") < html.indexOf("Alpha Few"),
         "both are 1.000, so the one with more picks behind it leads - not the "
         + "one that sorts first alphabetically");
    }

    section("the season a date belongs to matches the server's rule");
    {
      const f = h.api.seasonOfDate;
      ok(f(new Date(2026, 8, 9))  === "2026-27", "September opens a season", f(new Date(2026,8,9)));
      ok(f(new Date(2026, 7, 26)) === "2026-27", "and so does late August", f(new Date(2026,7,26)));
      ok(f(new Date(2026, 6, 31)) === "2025-26", "July still belongs to the old one", f(new Date(2026,6,31)));
      ok(f(new Date(2027, 0, 5))  === "2026-27", "a January bowl stays where the season started",
         f(new Date(2027,0,5)));
    }

    section("the selector governs what gets written, not just what is read");
    {
      /* The gap this closes: a season only existed once it had picks, so the
         new one could not be selected - and even selected, it governed the
         board and the queries while a pick still landed wherever the Make
         Picks week happened to be. */
      const hh = harness({ seasons: SEASONS, stats: STATS, weeks: { ok: true, weeks: [] },
                           board: { ok: true, rows: [] } });
      await hh.api.loadSeasons();

      hh.api.SEASON.current = "2026-27";
      hh.api.state.weekStart = new Date(2025, 10, 12);   // a 2025-26 week
      await hh.api.alignWeekToSeason();
      ok(hh.api.seasonOfDate(hh.api.state.weekStart) === "2026-27",
         "choosing a season moves the picking week into it",
         hh.api.seasonOfDate(hh.api.state.weekStart));

      const before = hh.api.state.weekStart.getTime();
      await hh.api.alignWeekToSeason();
      ok(hh.api.state.weekStart.getTime() === before,
         "and leaves it alone once it already matches");

      hh.api.SEASON.current = "all";
      hh.api.state.weekStart = new Date(2025, 10, 12);
      await hh.api.alignWeekToSeason();
      ok(hh.api.state.weekStart.getTime() === new Date(2025, 10, 12).getTime(),
         "all-seasons moves nothing, because it means nothing in particular");
    }

    section("a week that cannot be played says so");
    {
      /* College opens two weeks before the NFL. The week of Aug 26 2026 has
         eight college games and zero NFL ones, so a slip requiring two NFL
         picks can never be completed - and "Pick 2 more" was telling people to
         do something impossible. */
      const cfbOnly = (id) => ({ id:id, league:"NCAAF", kickoff:soon,
        home_team:id+" Home", away_team:id+" Away",
        spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
        totals:{ total:44, overPrice:-110, underPrice:-110 },
        moneyline:{ home:-150, away:130 } });
      const a=cfbOnly("w1"), b=cfbOnly("w2");
      h.api.state.games=[a,b]; h.api.state.gamesAll=[a,b]; h.api.state.picks=[];
      h.api.togglePick(a,"spread","favorite","w1 Home",{line:-3},-110);
      h.api.togglePick(b,"total","over","Over",{total:44},-110);
      h.api.validateRules();

      ok(/No NFL games this week/.test(h.get("#btnSubmit").textContent),
         "the button names what is missing rather than counting down",
         h.get("#btnSubmit").textContent);
      ok(h.get("#btnSubmit").disabled === true, "and stays disabled");
      ok(/a slip needs two of each/.test(h.get("#weekStatus").textContent),
         "with an explanation under the grid", h.get("#weekStatus").textContent);
      ok(/season starts once both leagues are playing/.test(h.get("#weekStatus").textContent),
         "framed as the rule working, not as something broken");

      /* A week still to come is a different sentence. The NFL prices its whole
         season early and college prices about a week out, so browsing ahead to
         late October today shows no college games - which is a book being
         early, not a week that cannot be played. */
      const soonWed = new Date(Date.now() + 21 * 864e5);
      soonWed.setHours(0, 0, 0, 0);
      soonWed.setDate(soonWed.getDate() - ((soonWed.getDay() - 3 + 7) % 7));
      h.api.state.weekStart = soonWed;
      h.api.state.games = [a, b]; h.api.state.picks = [];
      h.api.togglePick(a, "spread", "favorite", "w1 Home", { line: -3 }, -110);
      h.api.togglePick(b, "total", "over", "Over", { total: 44 }, -110);
      h.api.validateRules();
      ok(/No NFL lines yet/.test(h.get("#btnSubmit").textContent),
         "a future week says the lines are not up", h.get("#btnSubmit").textContent);
      ok(/about a week out/.test(h.get("#weekStatus").textContent),
         "and explains when to come back", h.get("#weekStatus").textContent);
      ok(!/cannot be played|season starts/.test(h.get("#weekStatus").textContent),
         "without claiming the week is dead");

      h.api.state.weekStart = startOfWedWeekLocal();

      /* An empty board is not the same claim - nothing has loaded yet. */
      h.api.state.games=[]; h.api.state.picks=[];
      h.api.validateRules();
      ok(!/No NFL games/.test(h.get("#btnSubmit").textContent),
         "an unloaded board makes no claim about any league",
         h.get("#btnSubmit").textContent);
    }


    section("everyone's slips render, hidden picks included");
    {
      const WEEKPICKS = { ok: true, week: "2026-09-09", expected: 5, decided: false, winners: [],
        players: [
          { user: "Ann", picks: 5, wins: 2, losses: 1, pushes: 0, pending: 2, hidden: 1, rows: [
            { hidden:false, league:"NFL", market:"spread", kind:"favorite",
              selection:"Kansas City Chiefs", matchup:"Buffalo Bills @ Kansas City Chiefs",
              line:-3, odds:-110, status:"win", own:true },
            { hidden:false, league:"NCAAF", market:"total", kind:"under",
              selection:"Under", matchup:"Duke Blue Devils @ Virginia Cavaliers",
              line:52.5, odds:-110, status:"loss", own:true },
            { hidden:true } ] },
          { user: "Bob", picks: 2, wins: 0, losses: 0, pushes: 0, pending: 2, hidden: 2, rows: [
            { hidden:true }, { hidden:true } ] },
          { user: "Cid", picks: 0, wins: 0, losses: 0, pushes: 0, pending: 0, hidden: 0, rows: [] }
        ] };

      const hh = harness({ seasons: SEASONS, weekpicks: WEEKPICKS });
      await hh.api.loadSeasons();
      await hh.api.buildWeekSlips("2026-09-09");
      const html = hh.get("#weekSlips").innerHTML;

      ok(/Ann/.test(html) && /Bob/.test(html) && /Cid/.test(html), "all three players appear");
      ok(/Kansas City Chiefs/.test(html) || /Chiefs/.test(html), "a revealed pick shows its team");
      ok(/Hidden until kickoff/.test(html), "an unstarted one does not");
      ok((html.match(/Hidden until kickoff/g) || []).length === 3,
         "three hidden across the two players", (html.match(/Hidden until kickoff/g)||[]).length);
      ok(/Nothing in for this week/.test(html), "and an empty slip says so");

      /* A total's selection is the word Under, so the matchup is the only
         thing that identifies which game it was. */
      ok(/Duke/.test(html), "a total names its game", (html.match(/Duke[^<]*/)||[])[0]);
      ok(/class="tag">you</.test(html), "your own card is marked");
      ok(/slipCard me/.test(html), "and highlighted");
      ok(/no picks yet/.test(html), "somebody with nothing is called out");
      ok(/2 of 5/.test(html), "and a half-finished slip shows the count");
      ok(/Picks appear when their game kicks off/.test(html),
         "with one line explaining why anything is hidden");
    }

    section("nothing is hidden once every game has started");
    {
      const OPEN = { ok: true, week: "2025-12-03", expected: 5, decided: true, winners: ["Ann"],
        players: [ { user: "Ann", picks: 1, wins: 1, losses: 0, pushes: 0, pending: 0, hidden: 0,
          rows: [ { hidden:false, league:"NFL", market:"moneyline", kind:"ml",
                    selection:"Buffalo Bills", matchup:"Buffalo Bills @ Kansas City Chiefs",
                    line:"", odds:150, status:"win", own:false } ] } ] };
      const hh = harness({ seasons: SEASONS, weekpicks: OPEN });
      await hh.api.loadSeasons();
      await hh.api.buildWeekSlips("2025-12-03");
      const html = hh.get("#weekSlips").innerHTML;
      ok(!/Hidden until kickoff/.test(html), "no masked rows");
      ok(!/Picks appear when their game/.test(html),
         "and no explanation of masking, since none happened");
      ok(/WIN/.test(html), "results show through", (html.match(/class="res">[^<]*/)||[])[0]);
    }

    section("a failing weekpicks call does not blank the board");
    {
      const hh = harness({ seasons: SEASONS });      // no weekpicks endpoint
      await hh.api.loadSeasons();
      await hh.api.buildWeekSlips("2026-09-09");
      ok(/Could not load picks/.test(hh.get("#weekSlips").innerHTML),
         "it says so instead of going silent", hh.get("#weekSlips").innerHTML.slice(0, 80));
    }


    let hhShare = null;
    section("the shared slip is short enough for a message bubble");
    {
      const rows = [
        { week:"2025-12-03", market:"spread", kind:"favorite", selection:"Kansas City Chiefs",
          matchup:"Buffalo Bills @ Kansas City Chiefs", line:-3, odds:-110, status:"win", league:"NFL" },
        { week:"2025-12-03", market:"spread", kind:"underdog", selection:"Cincinnati Bengals",
          matchup:"Cincinnati Bengals @ Buffalo Bills", line:5.5, odds:-102, status:"loss", league:"NFL" },
        { week:"2025-12-03", market:"total", kind:"over", selection:"Over",
          matchup:"Chicago Bears @ Green Bay Packers", line:44.5, odds:-110, status:"win", league:"NFL" },
        { week:"2025-12-03", market:"total", kind:"under", selection:"Under",
          matchup:"Duke Blue Devils @ Virginia Cavaliers", line:52.5, odds:-110, status:"pending", league:"NCAAF" },
        { week:"2025-12-03", market:"moneyline", kind:"ml", selection:"Miami Dolphins",
          matchup:"Miami Dolphins @ New York Jets", line:"", odds:-154, status:"win", league:"NFL" }
      ];
      const hh = harness({ seasons: SEASONS });
      await hh.api.loadSeasons();
      hh.get("#nameInput").value = "Reid";
      hhShare = hh;

      const text = hh.api.shareSlipText("2025-12-03", rows);
      const lines = text.split("\n");

      ok(/^Picks Game/.test(lines[0]), "it says what it is", lines[0]);
      ok(/Reid 3-1/.test(text), "with the name and record", lines[1]);
      ok(/1 pending/.test(text), "and what is not settled yet", lines[1]);
      ok(/quinton4mvp\.com/.test(text), "and a way back to the site");

      /* The lesson from the share row that wrapped in iMessage: keep it narrow
         or the whole thing arrives as ragged nonsense. */
      const widest = Math.max.apply(null, lines.map((l) => l.length));
      ok(widest <= 32, "no line is wide enough to wrap in a bubble", widest + " chars");

      ok(/✅ Chiefs -3/.test(text), "a spread names the team and the number",
         (text.match(/.*Chiefs.*/) || [])[0]);
      ok(/❌ Bengals \+5\.5/.test(text), "a dog keeps its plus sign",
         (text.match(/.*Bengals.*/) || [])[0]);
      /* Over and Under name no game, so the matchup has to carry them. */
      ok(/Bears\/Packers o44\.5/.test(text), "a total names its game",
         (text.match(/.*Packers.*/) || [])[0]);
      ok(/Duke.*u52\.5/.test(text), "and the under side reads as under",
         (text.match(/.*Duke.*/) || [])[0]);
      ok(/⏳/.test(text), "an ungraded pick is marked pending, not as a loss");
      ok(/Dolphins ML -154/.test(text), "a moneyline shows its price",
         (text.match(/.*Dolphins.*/) || [])[0]);
    }

    section("a shared slip always reads fav, dog, over, under, ML");
    {
      /* fn=mine returns newest-first, which is whatever order the picks were
         tapped in. A slip that arrives in a different order every week is
         harder to read at a glance in a chat thread. */
      const jumbled = [
        { week:"2025-12-03", market:"moneyline", kind:"ml", selection:"Miami Dolphins",
          matchup:"Miami Dolphins @ New York Jets", line:"", odds:-154, status:"win" },
        { week:"2025-12-03", market:"total", kind:"under", selection:"Under",
          matchup:"Duke Blue Devils @ Virginia Cavaliers", line:52.5, odds:-110, status:"loss" },
        { week:"2025-12-03", market:"spread", kind:"underdog", selection:"Buffalo Bills",
          matchup:"Buffalo Bills @ Kansas City Chiefs", line:5.5, odds:-110, status:"win" },
        { week:"2025-12-03", market:"total", kind:"over", selection:"Over",
          matchup:"Chicago Bears @ Green Bay Packers", line:44.5, odds:-110, status:"win" },
        { week:"2025-12-03", market:"spread", kind:"favorite", selection:"Kansas City Chiefs",
          matchup:"Buffalo Bills @ Kansas City Chiefs", line:-3, odds:-110, status:"loss" }
      ];
      const text = hhShare.api.shareSlipText("2025-12-03", jumbled);
      const picks = text.split(String.fromCharCode(10))
        .filter((l) => /^[✅❌➖⏳]/.test(l));

      ok(picks.length === 5, "five lines", picks.length);
      ok(/Chiefs -3/.test(picks[0]),        "favourite first",  picks[0]);
      ok(/Bills \+5\.5/.test(picks[1]),     "then the dog",     picks[1]);
      ok(/o44\.5/.test(picks[2]),           "then the over",    picks[2]);
      ok(/u52\.5/.test(picks[3]),           "then the under",   picks[3]);
      ok(/ML/.test(picks[4]),               "moneyline last",   picks[4]);

      /* Reversing the input must not change the output - the order is the
         slip's, not the order they happened to be tapped in. */
      const again = hhShare.api.shareSlipText("2025-12-03", jumbled.slice().reverse());
      ok(again === text, "and the same slip always reads the same way");
    }

    section("a team name is trimmed at a word, never mid-word");
    {
      const t = hhShare.api.tinyTeam;
      ok(t("Kansas City Chiefs") === "Chiefs", "the NFL map still wins", t("Kansas City Chiefs"));
      ok(t("Duke Blue Devils") === "Duke Blue", "a long college name keeps whole words",
         t("Duke Blue Devils"));
      ok(t("Virginia Cavaliers") === "Virginia", "dropping the mascot", t("Virginia Cavaliers"));
      ok(t("North Carolina Tar Heels") === "North Carolina", "and keeping a two-word school",
         t("North Carolina Tar Heels"));
      ok(t("TCU Horned Frogs") === "TCU Horned", "short names are left as they are",
         t("TCU Horned Frogs"));
      /* Cutting mid-word gives "Jacksonvi", which helps nobody. */
      ok(t("Jacksonville State Gamecocks") === "Jacksonville",
         "never mid-word", t("Jacksonville State Gamecocks"));
      ok(t("") === "", "and an empty name stays empty");
    }

    section("sharing copies, and says so when it cannot");
    {
      const rows = [{ week:"2025-12-03", market:"moneyline", kind:"ml", selection:"Miami Dolphins",
        matchup:"Miami Dolphins @ New York Jets", line:"", odds:-154, status:"win", league:"NFL" }];

      const hh = harness({ seasons: SEASONS });
      await hh.api.loadSeasons();
      hh.api.MINE.byWeek = { "2025-12-03": rows };

      let copied = null;
      hh.win.navigator = { clipboard: { writeText: async (t) => { copied = t; } } };
      await hh.api.shareSlip("2025-12-03");
      ok(copied && /Dolphins/.test(copied), "the text reaches the clipboard",
         (copied || "").slice(0, 40));
      ok(/Copied/.test(hh.get("#shareStatus").textContent), "and it says so",
         hh.get("#shareStatus").textContent);

      /* Both paths refused. Disabling only the modern one proves nothing - the
         execCommand fallback picks it up and the copy genuinely succeeds. */
      hh.win.navigator = { clipboard: { writeText: async () => { throw new Error("denied"); } } };
      hh.win.document.execCommand = () => false;
      hh.get("#shareStatus").textContent = "";
      await hh.api.shareSlip("2025-12-03");
      ok(/select and copy/.test(hh.get("#shareStatus").textContent),
         "a refusal offers the text instead", hh.get("#shareStatus").textContent);

      hh.api.MINE.byWeek = {};
      await hh.api.shareSlip("2025-12-03");
      ok(/Nothing to share/.test(hh.get("#shareStatus").textContent),
         "and an empty week says that rather than copying a blank");
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
    /* Enough picks to clear the minimum-sample floor, or it never gets drawn
       and the escaping is not actually exercised. */
    nasty.stats.Ann.teams = [{ team: '<img src=x onerror=alert(1)>', w: 6, l: 1, p: 0, n: 7, pct: 0.857, units: 1 }];
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
