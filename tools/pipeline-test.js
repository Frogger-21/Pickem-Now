/* End-to-end test of runAutoGrade_ and submitPicks_ against a fake Sheet.
   The pure grading rules are covered by grading-test.js; what this checks is
   the plumbing around them — that grades land on the right rows, that the
   credit-saving short circuits actually fire, and that resubmitting replaces
   instead of duplicating.

       node tools/pipeline-test.js                                         */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "Google App Script Code.gs"), "utf8");

// ---------------------------------------------------------------- fake Sheets
class FakeSheet {
  constructor(name, rows) { this.name = name; this.rows = rows || []; }
  _pad(r, c) {
    while (this.rows.length < r) this.rows.push([]);
    for (const row of this.rows) while (row.length < c) row.push("");
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.rows.length, 1), Math.max(this.getLastColumn(), 1)); }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    return {
      getValues() {
        sheet._pad(r + nr - 1, c + nc - 1);
        const out = [];
        for (let i = 0; i < nr; i++) out.push(sheet.rows[r - 1 + i].slice(c - 1, c - 1 + nc));
        return out;
      },
      setValues(vals) {
        sheet._pad(r + nr - 1, c + nc - 1);
        for (let i = 0; i < vals.length; i++)
          for (let j = 0; j < vals[i].length; j++) sheet.rows[r - 1 + i][c - 1 + j] = vals[i][j];
        return this;
      },
      setValue(v) { return this.setValues([[v]]); }
    };
  }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  clear() { this.rows = []; }
  setFrozenRows() {}
}

function harness(sheets, scoresByLeague) {
  const store = {};
  for (const [k, v] of Object.entries(sheets)) store[k] = new FakeSheet(k, v);
  const calls = [];

  const env = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => ({ ODDS_API_KEY: "test-key", SHEET_ID: "test-sheet" }[k] || null)
      })
    },
    SpreadsheetApp: {
      openById: () => ({
        getName: () => "test",
        getSheetByName: (n) => store[n] || null,
        insertSheet: (n) => (store[n] = new FakeSheet(n, []))
      })
    },
    UrlFetchApp: {
      fetch: (url) => {
        calls.push(url);
        const league = url.indexOf("americanfootball_nfl") >= 0 ? "NFL" : "NCAAF";
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(scoresByLeague[league] || [])
        };
      }
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Logger: { log() {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ScriptApp: {}, Utilities: { getUuid: () => "uuid" }, ContentService: {}
  };

  const names = Object.keys(env);
  const api = new Function(
    ...names,
    SRC + "return { runAutoGrade_, submitPicks_, getBoard_, getWeek_, getWeeks_, tallies_ };"
  )(...names.map((n) => env[n]));

  return { api, store, calls };
}

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) pass++;
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? " :: " + detail : "")); }
};
const section = (t) => console.log("\n" + t);

const PICK_HEADERS = ['id','week','email','user','league','gameId','matchup',
  'market','kind','selection','odds','meta','status','ts'];

const row = (id, email, user, league, gameId, market, kind, selection, meta, status, week = "2026-01-07") =>
  [id, week, email, user, league, gameId, "A @ B", market, kind, selection, "", JSON.stringify(meta), status, ""];

// KC 27, BUF 20  |  DAL 17, PHI 24
const SCORES = {
  NFL: [
    { id: "g1", completed: true, home_team: "Kansas City Chiefs", away_team: "Buffalo Bills",
      scores: [{ name: "Kansas City Chiefs", score: "27" }, { name: "Buffalo Bills", score: "20" }],
      commence_time: "", last_update: "" },
    { id: "g2", completed: true, home_team: "Philadelphia Eagles", away_team: "Dallas Cowboys",
      scores: [{ name: "Philadelphia Eagles", score: "24" }, { name: "Dallas Cowboys", score: "17" }],
      commence_time: "", last_update: "" },
    { id: "g3", completed: false, home_team: "New York Giants", away_team: "Chicago Bears",
      scores: null, commence_time: "", last_update: "" }
  ],
  NCAAF: []
};

// ---------------------------------------------------------------- grading
section("runAutoGrade_ writes grades to the right rows");
{
  const picks = [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "pending"),
    row("p2", "b@x.com", "Bob", "NFL", "g1", "spread", "underdog", "Buffalo Bills",      { line:  6.5 }, "pending"),
    row("p3", "c@x.com", "Cid", "NFL", "g1", "total",  "over",     "Over",               { total: 45.5 }, "pending"),
    row("p4", "a@x.com", "Ann", "NFL", "g2", "moneyline", "ml",    "Dallas Cowboys",     { },            "pending"),
    row("p5", "b@x.com", "Bob", "NFL", "g3", "spread", "favorite", "New York Giants",    { line: -3 },   "pending")
  ];
  const { api, store, calls } = harness({ Picks: picks, Results: [] }, SCORES);
  const out = api.runAutoGrade_();

  const statusOf = (id) => {
    const r = store.Picks.rows.find((x) => x[0] === id);
    return r ? r[PICK_HEADERS.indexOf("status")] : "(missing)";
  };

  ok(statusOf("p1") === "win",  "KC -6.5 wins by 7 -> win",        statusOf("p1"));
  ok(statusOf("p2") === "loss", "BUF +6.5 loses by 7 -> loss",     statusOf("p2"));
  ok(statusOf("p3") === "win",  "over 45.5 on a 47-point game",    statusOf("p3"));
  ok(statusOf("p4") === "loss", "Dallas ML lost 17-24",            statusOf("p4"));
  ok(statusOf("p5") === "pending", "unfinished game stays pending", statusOf("p5"));
  ok(out.graded === 4 && out.stillPending === 1, "counts reported", JSON.stringify(out));
  ok(calls.length === 1, "one API call for one league", calls.length + " calls");
  ok(out.creditsUsed === 2, "2 credits for a daysFrom call", out.creditsUsed);
  ok(/daysFrom=3/.test(calls[0]), "daysFrom is set");
  ok(/eventIds=/.test(calls[0]), "narrowed by eventIds");
  ok(!/apiKey=$/.test(calls[0]) && /apiKey=test-key/.test(calls[0]), "key is attached");
  ok(store.Results.rows.length === 4, "3 results cached + header", store.Results.rows.length);
}

section("no pending picks -> no API call, no credits");
{
  const picks = [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "win")];
  const { api, calls } = harness({ Picks: picks, Results: [] }, SCORES);
  const out = api.runAutoGrade_();
  ok(calls.length === 0, "made no request", calls.length + " calls");
  ok(out.creditsUsed === 0, "spent nothing");
  ok(/nothing pending/.test(out.note || ""), "says why", out.note);
}

section("a cached completed result is not re-fetched");
{
  const picks = [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "pending")];
  const results = [
    ['gameId','league','home_team','away_team','homeScore','awayScore','completed','commence','lastUpdate','fetchedAt'],
    ["g1", "NFL", "Kansas City Chiefs", "Buffalo Bills", 27, 20, "TRUE", "", "", ""]
  ];
  const { api, calls, store } = harness({ Picks: picks, Results: results }, SCORES);
  const out = api.runAutoGrade_();
  ok(calls.length === 0, "served from the Results cache", calls.length + " calls");
  ok(out.graded === 1, "still graded it", out.graded);
  ok(store.Picks.rows[1][PICK_HEADERS.indexOf("status")] === "win", "and got it right");
}

section("grading is idempotent");
{
  const picks = [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "pending")];
  const { api, calls } = harness({ Picks: picks, Results: [] }, SCORES);
  api.runAutoGrade_();
  const second = api.runAutoGrade_();
  ok(second.graded === 0, "second run grades nothing new", second.graded);
  ok(calls.length === 1, "and spends no further credits", calls.length + " calls");
}

// ---------------------------------------------------------------- submit
section("resubmitting replaces instead of duplicating");
{
  const picks = [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "KC", { line: -6.5 }, "pending"),
    row("p2", "b@x.com", "Bob", "NFL", "g1", "spread", "underdog", "BUF", { line: 6.5 }, "pending")];
  const { api, store } = harness({ Picks: picks, Results: [] }, SCORES);

  const fresh = [{ week: "2026-01-07", gameId: "g9", market: "total", kind: "over",
                   selection: "Over", meta: { total: 44 }, id: "n1" }];
  const out = api.submitPicks_("a@x.com", "Ann", fresh);

  const mine = store.Picks.rows.slice(1).filter((r) => r[2] === "a@x.com");
  ok(out.replaced === 1, "reported the replacement", JSON.stringify(out));
  ok(mine.length === 1, "Ann has one pick, not two", mine.length);
  ok(mine[0][5] === "g9", "and it's the new one", mine[0][5]);
  const bob = store.Picks.rows.slice(1).filter((r) => r[2] === "b@x.com");
  ok(bob.length === 1 && bob[0][0] === "p2", "Bob's pick is untouched");
}

section("a graded week is locked");
{
  const picks = [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "KC", { line: -6.5 }, "win")];
  const { api, store } = harness({ Picks: picks, Results: [] }, SCORES);
  let threw = null;
  try {
    api.submitPicks_("a@x.com", "Ann", [{ week: "2026-01-07", gameId: "g9", market: "total",
                                          kind: "over", selection: "Over", meta: { total: 44 } }]);
  } catch (e) { threw = e.message; }
  ok(threw && /already been graded/.test(threw), "refused to overwrite a result", threw);
  ok(store.Picks.rows.length === 2, "sheet unchanged", store.Picks.rows.length);
}

// ---------------------------------------------------------------- board
section("season board and weekly winners");
{
  const mk = (email, user, week, statuses) => statuses.map((s, i) =>
    row("id" + user + week + i, email, user, "NFL", "g" + i, "spread", "favorite", "T", { line: -3 }, s, week));

  const picks = [PICK_HEADERS,
    ...mk("a@x.com", "Ann", "2026-01-07", ["win", "win", "win", "loss", "loss"]),   // 3-2
    ...mk("b@x.com", "Bob", "2026-01-07", ["win", "win", "loss", "loss", "loss"]),  // 2-3
    ...mk("a@x.com", "Ann", "2026-01-14", ["win", "loss", "loss", "loss", "loss"]), // 1-4
    ...mk("b@x.com", "Bob", "2026-01-14", ["win", "win", "win", "win", "push"]),    // 4-0-1
    ...mk("a@x.com", "Ann", "2026-01-21", ["win", "win", "pending", "win", "win"])  // in progress
  ];
  const { api } = harness({ Picks: picks, Results: [] }, SCORES);

  const board = api.getBoard_();
  const ann = board.find((r) => r.user === "Ann");
  const bob = board.find((r) => r.user === "Bob");
  ok(ann.weeksWon === 1 && bob.weeksWon === 1, "one week each",
     `Ann ${ann.weeksWon} / Bob ${bob.weeksWon}`);
  ok(ann.wins === 8 && ann.losses === 6, "Ann season record", `${ann.wins}-${ann.losses}`);
  // 2-3 in week 1, then 4-0-1 in week 2
  ok(bob.wins === 6 && bob.losses === 3 && bob.pushes === 1, "Bob season record",
     `${bob.wins}-${bob.losses}-${bob.pushes}`);
  ok(ann.pending === 1, "Ann has a pending pick", ann.pending);
  // pct ignores pushes and pendings: 6 wins from 9 decided picks
  ok(bob.pct === 0.667, "pct counts only decided picks", bob.pct);

  const w1 = api.getWeek_("2026-01-07");
  ok(w1.decided && w1.winners.join() === "Ann", "Ann took week 1", w1.winners.join());
  const w2 = api.getWeek_("2026-01-14");
  ok(w2.decided && w2.winners.join() === "Bob", "Bob took week 2", w2.winners.join());
  const w3 = api.getWeek_("2026-01-21");
  ok(!w3.decided && w3.winners.length === 0, "week 3 is undecided while a pick is pending");

  const weeks = api.getWeeks_();
  ok(weeks.length === 3, "three weeks listed", weeks.length);
  ok(weeks[0].week === "2026-01-21", "newest week first", weeks[0].week);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
