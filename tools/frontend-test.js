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
      querySelectorAll: (sel) => (sel === ".tab" ? tabs : sel === ".view" ? [] : []),
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
    + " drawBars, esc, pctText, recText, unitText, Q, boot: document._boot };";

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
    weeks: [{ week: "2025-09-03", ...rec(3, 2, 0, 0.7) }, { week: "2025-09-10", ...rec(1, 4, 0, -2.1) }],
    teams: [{ team: "Kansas City Chiefs", ...rec(5, 1, 0, 3.2) },
            { team: "Buffalo Bills", ...rec(1, 6, 0, -4.1) }] },
  Ann: { overall: rec(6, 3, 0, 2.1),
    markets: { moneyline: rec(2, 1, 0, 0.8), spread_fav: rec(2, 1, 0, 0.6),
               spread_dog: rec(1, 1, 0, -0.1), over: rec(1, 0, 0, 0.9),
               under: rec(0, 0, 0, 0), spread_pk: rec(0, 0, 0, 0) },
    weeks: [{ week: "2025-09-03", ...rec(4, 1, 0, 2.6) }],
    teams: [{ team: "Kansas City Chiefs", ...rec(3, 0, 0, 2.7) }] },
  Bob: { overall: rec(4, 5, 1, -0.9),
    markets: { moneyline: rec(1, 1, 0, -0.3), spread_fav: rec(2, 2, 1, -0.4),
               spread_dog: rec(2, 2, 0, -0.2), over: rec(1, 1, 0, 0),
               under: rec(1, 2, 0, -1.1), spread_pk: rec(0, 0, 0, 0) },
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
    ok(/Everyone combined/.test(h.get("#qPlayer").innerHTML), "the who selector is filled",
       h.get("#qPlayer").innerHTML.slice(0, 60));
    ok(/Ann/.test(h.get("#qPlayer").innerHTML) && /Bob/.test(h.get("#qPlayer").innerHTML),
       "with every player");

    for (const view of ["markets", "units", "weeks", "cum", "teamsW", "teamsL", "players"]) {
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
    ok(/6-3/.test(summary.innerHTML), "Ann's own record", summary.innerHTML);
    h.get("#qPlayer").value = "Bob";
    h.api.renderQuery();
    ok(/4-5-1/.test(summary.innerHTML), "and Bob's, pushes included", summary.innerHTML);
    ok(/-0\.90u/.test(summary.innerHTML), "with his units", summary.innerHTML);
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
