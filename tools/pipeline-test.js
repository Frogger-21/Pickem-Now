/* End-to-end test of runAutoGrade_ and submitPicks_ against a fake Sheet.
   The pure grading rules are covered by grading-test.js; what this checks is
   the plumbing around them - that grades land on the right rows, that the
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

function harness(sheets, scoresByLeague, extraProps, creditsLeft) {
  if (creditsLeft === undefined) creditsLeft = 400;
  const store = {};
  for (const [k, v] of Object.entries(sheets)) store[k] = new FakeSheet(k, v);
  const calls = [];
  const sent = [];
  const props = Object.assign({ ODDS_API_KEY: "test-key", SHEET_ID: "test-sheet" }, extraProps || {});

  const env = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; }
      })
    },
    MailApp: { sendEmail: (o) => { sent.push(o); } },
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
        /* "fail" makes the scores endpoint return a 500, so the grader's
           error path can be exercised. */
        if (scoresByLeague === "fail") {
          return { getResponseCode: () => 500, getContentText: () => "upstream is down",
                   getHeaders: () => ({}) };
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(scoresByLeague[league] || []),
          getHeaders: () => ({ "x-requests-remaining": String(creditsLeft) })
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
    SRC + "return { runAutoGrade_, submitPicks_, getBoard_, getWeek_, getWeeks_, tallies_, seasonRoster_, currentSeason_, notifyWeekResults, notifyPickReminder, previewNotifications, leagueMembers_, notifyAdmin_, warnOnLowCredits_, autoGrade, weekBrief_, askClaude_, recapEnabled_, streakEndingAt_, getSeasons_, getStats_, getMyPicks_, unitPnl_, marketBucket_," +
          " runSelfTest, selfTestPicks_, SELFTEST_WEEK };"
  )(...names.map((n) => env[n]));

  return { api, store, calls, sent, props };
}


/* The existing harness answers the scores endpoint; the kickoff lock reads the
   odds endpoint instead. `oddsFeed = null` simulates the feed being down. */
function oddsHarness(pickRows, oddsFeed) {
  const store = { Picks: new FakeSheet("Picks", pickRows), Results: new FakeSheet("Results", []) };
  const env = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => ({ ODDS_API_KEY: "k", SHEET_ID: "s" }[k] || null) }) },
    SpreadsheetApp: { openById: () => ({
      getName: () => "test",
      getSheetByName: (n) => store[n] || null,
      insertSheet: (n) => (store[n] = new FakeSheet(n, [])) }) },
    UrlFetchApp: { fetch: (url) => {
      if (oddsFeed === null) throw new Error("odds feed unavailable");
      const lg = url.indexOf("americanfootball_nfl") >= 0 ? "NFL" : "NCAAF";
      const games = (oddsFeed[lg] || []).map((g) => Object.assign({
        bookmakers: [] }, g));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(games) };
    } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Logger: { log() {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ScriptApp: {}, Utilities: { getUuid: () => "uuid" }, ContentService: {}
  };
  const names = Object.keys(env);
  const api = new Function(...names,
    SRC + "return { checkKickoffLock_, pickSignature_, kickoffMap_, getWeekPicks_, pickIsPublic_, submitPicks_, readSubmissions_, appendSubmission_, submissionsForWeek_ };")(...names.map((n) => env[n]));
  return { api, store };
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

// ---------------------------------------------------------------- self test
// runSelfTest() is what gets run inside Apps Script when there are no live
// games. Running it here too means a broken self-test is caught on the laptop
// rather than discovered halfway through a football Sunday.
section("runSelfTest grades its own fixtures");
{
  // A real week already in the sheet, to check the self-test leaves it alone.
  const picks = [PICK_HEADERS,
    row("real1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "win"),
    row("real2", "b@x.com", "Bob", "NFL", "g9", "moneyline", "ml", "Some Team", {}, "pending")
  ];
  const { api, store, calls } = harness({ Picks: picks, Results: [] }, SCORES);

  const msg = api.runSelfTest();
  ok(/^SELF TEST PASSED/.test(msg), "self test passes", msg);
  ok(calls.length === 0, "and never touched the Odds API", calls.length);

  // Every branch of the grader is covered, not just the easy ones.
  const fx = api.selfTestPicks_();
  const kinds = fx.reduce((m, p) => (m[p.expect] = (m[p.expect] || 0) + 1, m), {});
  ok(kinds.win >= 3 && kinds.loss >= 3 && kinds.push >= 4, "wins, losses and pushes all covered", JSON.stringify(kinds));
  ok(kinds.pending >= 5, "and the refuse-to-grade cases", kinds.pending);
  ok(new Set(fx.map(p => p.market)).size >= 3, "spread, total and moneyline all present");

  // It has to clean up after itself, in the real sheet.
  const H = PICK_HEADERS;
  const leftover = store.Picks.rows.slice(1).filter(r => String(r[H.indexOf("week")]) === api.SELFTEST_WEEK);
  ok(leftover.length === 0, "no self-test picks left behind", leftover.length);
  const junkResults = store.Results.rows.slice(1).filter(r => String(r[0]).indexOf("__selftest_") === 0);
  ok(junkResults.length === 0, "no self-test results left behind", junkResults.length);

  // And it must not have disturbed the real rows.
  ok(store.Picks.rows.length === 3, "the real picks are still there", store.Picks.rows.length - 1);
  ok(String(store.Picks.rows[1][H.indexOf("status")]) === "win", "an already-graded pick is untouched");
  ok(String(store.Picks.rows[2][H.indexOf("status")]) === "pending", "an unrelated pending pick stays pending");
}

section("a self-test week can never reach the scoreboard");
{
  // Simulates the self-test dying before cleanup: its rows are still in the
  // sheet. The board must ignore them anyway.
  const picks = [PICK_HEADERS,
    row("real1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "win"),
    row("st0", "selftest@example.invalid", "Selftest", "NFL", "x", "moneyline", "ml", "X", {}, "win", "__selftest__")
  ];
  const { api } = harness({ Picks: picks, Results: [] }, SCORES);

  const board = api.getBoard_();
  ok(board.length === 1, "only the real user is on the board", board.map(r => r.user).join());
  ok(board[0].user === "Ann", "and it is the right one", board[0].user);
  ok(api.getWeeks_().every(w => w.week !== "__selftest__"), "the fake week is not listed");
}

// ---------------------------------------------------------------- board sort
section("the season table ranks on wins, then win percentage");
{
  // Deliberately arranged so every ordering rule has to fire: two people tied
  // on wins with different percentages, and the weeks-won leader NOT the wins
  // leader, which is the case that used to decide the order.
  const mk = (user, week, results) => results.map((s, i) =>
    row(user + week + i, user + "@x.com", user, "NFL", "g" + i, "moneyline", "ml",
        "Kansas City Chiefs", {}, s, week));

  const picks = [PICK_HEADERS,
    // Amy: 5 wins, 1 loss  -> most wins, best pct
    ...mk("Amy", "w1", ["win", "win", "win", "loss"]),
    ...mk("Amy", "w2", ["win"]),
    // Bob: 3 wins, 1 loss  -> .750
    ...mk("Bob", "w1", ["win", "win", "loss"]),
    ...mk("Bob", "w2", ["win"]),
    // Cid: 3 wins, 3 losses -> .500, same wins as Bob, worse pct
    ...mk("Cid", "w1", ["win", "loss", "loss"]),
    ...mk("Cid", "w2", ["win", "win", "loss"])
  ];

  const { api } = harness({ Picks: picks, Results: [] }, SCORES);
  const board = api.getBoard_();
  const order = board.map((r) => r.user);

  ok(order[0] === "Amy", "most wins goes top", order.join(" > "));
  ok(order.indexOf("Bob") < order.indexOf("Cid"),
     "equal wins broken by percentage, not alphabetically", order.join(" > "));

  const bob = board.find((r) => r.user === "Bob"), cid = board.find((r) => r.user === "Cid");
  ok(bob.wins === cid.wins, "and those two really are level on wins", bob.wins + " vs " + cid.wins);
  ok(bob.pct > cid.pct, "with Bob ahead on percentage", bob.pct + " vs " + cid.pct);

  // Weeks won is still reported; it just no longer drives the order.
  ok(board.every((r) => typeof r.weeksWon === "number"), "weeks won is still on every row");
}

// ---------------------------------------------------------------- layering
// The point of the STORAGE section is that nothing outside it knows what a
// spreadsheet is. That property is invisible at runtime and easy to erode one
// convenient getDataRange() at a time, so it is asserted on the source text.
// When the Postgres backend lands, this is what says the swap is complete.
section("nothing outside the STORAGE section touches Sheets");
{
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) => l.startsWith("// ===== STORAGE"));
  const end   = lines.findIndex((l) => l.startsWith("// ===== HTTP HANDLERS"));
  ok(start > 0 && end > start, "the STORAGE section exists and is delimited", `${start}..${end}`);

  // Whole bodies, not just the declaration line. openSheet_ and ensureHeaders_
  // are the sanctioned door onto Sheets; checkSetup deliberately proves the
  // spreadsheet opens, and becomes a connection check when Postgres lands.
  const exempt = new Set();
  for (const fn of ["openSheet_", "ensureHeaders_", "checkSetup"]) {
    const at = lines.findIndex((l) => l.startsWith("function " + fn));
    if (at < 0) continue;
    for (let i = at; i < lines.length; i++) { exempt.add(i); if (lines[i] === "}") break; }
  }

  const SHEETS_ONLY = /getDataRange|getRange\(|deleteRow|setValues|insertSheet|SpreadsheetApp|setFrozenRows/;
  const leaks = [];
  lines.forEach((l, i) => {
    if (i >= start && i <= end) return;               // inside the section, fine
    if (exempt.has(i)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;         // comments describe, they don't do
    if (SHEETS_ONLY.test(l)) leaks.push(`${i + 1}: ${l.trim()}`);
  });
  ok(leaks.length === 0, "no direct spreadsheet access outside STORAGE", leaks.slice(0, 4).join(" | "));

  // The interface the Postgres implementation has to satisfy, all in one place.
  for (const fn of ["readPicks_", "setPickStatuses_", "insertPicks_", "deletePickKeys_",
                    "readResults_", "upsertResults_", "deleteResultIds_", "readUsers_"]) {
    const at = lines.findIndex((l) => l.startsWith("function " + fn));
    ok(at >= start && at <= end, fn + " lives in the STORAGE section", at);
  }

  // _key is opaque: callers may pass it back but must never do arithmetic on it.
  const outside = lines.slice(0, start).concat(lines.slice(end)).join("\n");
  ok(!/_key\s*[-+*/]|[-+*/]\s*_key/.test(outside), "no caller does arithmetic on _key");
}


// ------------------------------------------------------------ seasons + stats
section("seasons are derived from week dates, newest first");
{
  const mk = (id, user, week, market, kind, sel, meta, status, odds) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     market, kind, sel, odds === undefined ? "" : odds, JSON.stringify(meta), status, ""];

  const picks = [PICK_HEADERS,
    mk("a1", "Ann", "2025-09-03", "moneyline", "ml", "KC", {}, "win"),
    mk("a2", "Ann", "2025-12-10", "moneyline", "ml", "KC", {}, "loss"),
    mk("a3", "Ann", "2026-01-05", "moneyline", "ml", "KC", {}, "win"),   // bowl, same season
    mk("a4", "Ann", "2026-09-02", "moneyline", "ml", "KC", {}, "win"),   // next season
    mk("a5", "Bob", "2026-09-09", "moneyline", "ml", "KC", {}, "loss")
  ];
  const { api } = harness({ Picks: picks, Results: [] }, SCORES);

  const seasons = api.getSeasons_();
  ok(seasons.length === 2, "two seasons found", seasons.map((s) => s.season).join());
  ok(seasons[0].season === "2026-27", "newest first", seasons[0].season);
  ok(seasons[1].season === "2025-26", "then the older one", seasons[1].season);
  ok(seasons[1].picks === 3, "a January bowl counts in the season that started in August",
     seasons[1].picks);
  ok(seasons[0].players === 2, "players counted per season", seasons[0].players);
}

section("everything can be scoped to one season");
{
  const mk = (id, user, week, status) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     "moneyline", "ml", "KC", "", "{}", status, ""];
  const picks = [PICK_HEADERS,
    mk("o1", "Ann", "2025-09-03", "win"), mk("o2", "Ann", "2025-09-10", "win"),
    mk("n1", "Ann", "2026-09-02", "loss"), mk("n2", "Bob", "2026-09-02", "win")
  ];
  const { api } = harness({ Picks: picks, Results: [] }, SCORES);

  const old = api.getBoard_("2025-26");
  ok(old.length === 1 && old[0].wins === 2, "the board is filtered", JSON.stringify(old.map((r) => [r.user, r.wins])));
  const now = api.getBoard_("2026-27");
  ok(now.length === 2, "a different season, different board", now.length);
  ok(api.getBoard_().length === 2, "no season means everything", api.getBoard_().length);
  ok(api.getWeeks_("2025-26").length === 2, "weeks too", api.getWeeks_("2025-26").length);
  ok(api.getMyPicks_("ann@x.com", "2026-27").length === 1, "and my picks",
     api.getMyPicks_("ann@x.com", "2026-27").length);
}

section("stats bucket by the line's sign, not the label on the form");
{
  const mk = (id, user, market, kind, sel, meta, status, odds) =>
    [id, "2025-09-03", user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     market, kind, sel, odds === undefined ? "" : odds, JSON.stringify(meta), status, ""];

  const picks = [PICK_HEADERS,
    mk("s1", "Ann", "spread", "favorite", "KC",  { line: -6.5 }, "win"),
    mk("s2", "Ann", "spread", "underdog", "BUF", { line:  6.5 }, "loss"),
    // kind says favourite but the line is a dog: the line is what was taken.
    mk("s3", "Ann", "spread", "favorite", "BUF", { line:  3   }, "win"),
    mk("t1", "Ann", "total",  "over",  "Over",  { total: 45.5 }, "win"),
    mk("t2", "Ann", "total",  "under", "Under", { total: 45.5 }, "loss"),
    mk("m1", "Ann", "moneyline", "ml", "KC", {}, "win", 150),
    mk("m2", "Bob", "moneyline", "ml", "KC", {}, "loss", -200)
  ];
  const { api } = harness({ Picks: picks, Results: [] }, SCORES);
  const s = api.getStats_();

  ok(s.players.join() === "Ann,Bob", "players listed", s.players.join());
  const ann = s.stats["Ann"];
  ok(ann.markets.spread_dog.n === 2, "a mislabelled favourite counts as a dog",
     JSON.stringify([ann.markets.spread_fav.n, ann.markets.spread_dog.n]));
  ok(ann.markets.spread_fav.n === 1, "and the real favourite stays one");
  ok(ann.markets.over.w === 1 && ann.markets.under.l === 1, "totals split over and under");
  ok(ann.markets.moneyline.n === 1, "moneyline counted");

  // +150 winner returns 1.5 units; the pushless loss is -1.
  ok(ann.markets.moneyline.units === 1.5, "a plus-money winner pays its price",
     ann.markets.moneyline.units);
  ok(s.stats["Bob"].markets.moneyline.units === -1, "a loser is -1 whatever the price",
     s.stats["Bob"].markets.moneyline.units);

  const all = s.stats["__all__"];
  ok(all.overall.n === 7, "the league total covers everyone", all.overall.n);
}

section("stats: pushes never move a win rate");
{
  const mk = (id, status) => [id, "2025-09-03", "a@x.com", "Ann", "NFL", "g" + id, "A @ B",
    "moneyline", "ml", "KC", "", "{}", status, ""];
  const { api } = harness({ Picks: [PICK_HEADERS,
    mk("p1", "win"), mk("p2", "loss"), mk("p3", "push"), mk("p4", "push")
  ], Results: [] }, SCORES);
  const o = api.getStats_().stats["Ann"].overall;
  ok(o.pct === 0.5, "two pushes leave 1-1 at .500", o.pct);
  ok(o.p === 2 && o.n === 4, "but they are still counted", o.p + "/" + o.n);
  // 1 win at -110 (+0.909) and 1 loss (-1) net -0.09; the two pushes add zero.
  ok(o.units === -0.09, "and add nothing to units either", o.units);
}

section("stats: teams come from spreads and moneylines only");
{
  const mk = (id, market, kind, sel, status) =>
    [id, "2025-09-03", "a@x.com", "Ann", "NFL", "g" + id, "A @ B",
     market, kind, sel, "", "{}", status, ""];
  const { api } = harness({ Picks: [PICK_HEADERS,
    mk("t1", "moneyline", "ml", "Kansas City Chiefs", "win"),
    mk("t2", "spread", "favorite", "Kansas City Chiefs", "win"),
    mk("t3", "spread", "favorite", "Buffalo Bills", "loss"),
    mk("t4", "total", "over", "Over", "win")
  ], Results: [] }, SCORES);
  const teams = api.getStats_().stats["Ann"].teams;
  const names = teams.map((t) => t.team);
  ok(names.indexOf("Over") < 0, "Over is not a team", names.join());
  ok(names[0] === "Kansas City Chiefs", "most wins first", names.join());
  ok(teams[0].w === 2, "counted across both markets", teams[0].w);
  ok(names.indexOf("Buffalo Bills") === 1, "and the loser is there too", names.join());
}


section("stats split NFL from college");
{
  const mk = (id, league, status) =>
    [id, "2025-09-03", "a@x.com", "Ann", league, "g" + id, "A @ B",
     "moneyline", "ml", "KC", "", "{}", status, ""];
  const { api } = harness({ Picks: [PICK_HEADERS,
    mk("n1", "NFL", "win"), mk("n2", "NFL", "win"), mk("n3", "NFL", "loss"),
    mk("c1", "NCAAF", "loss"), mk("c2", "NCAAF", "loss"), mk("c3", "ncaaf", "win")
  ], Results: [] }, SCORES);
  const lg = api.getStats_().stats["Ann"].leagues;

  ok(lg.NFL.w === 2 && lg.NFL.l === 1, "NFL counted", JSON.stringify(lg.NFL));
  ok(lg.NCAAF.w === 1 && lg.NCAAF.l === 2, "college counted, case-insensitively",
     JSON.stringify(lg.NCAAF));
  ok(Object.keys(lg).length === 2, "and lowercase ncaaf is not a third league",
     Object.keys(lg).join());
  ok(lg.NFL.pct > lg.NCAAF.pct, "percentages differ as they should",
     lg.NFL.pct + " vs " + lg.NCAAF.pct);
}


// ------------------------------------------------------------- kickoff lock
// The rule: a pick is legal until its own game starts. Because a submission
// replaces the whole week, the check is not "no picks on started games" but
// "the picks on started games are exactly what they already were". Both
// failure directions matter - blocking a legitimate Sunday edit is as wrong as
// letting a Thursday pick be changed at half time.
section("kickoff lock: legitimate edits still go through");
{
  const T0 = Date.parse("2025-09-04T18:00:00Z");   // Thursday evening
  const EARLY = "2025-09-04T23:00:00Z";            // Thursday night game
  const LATE  = "2025-09-07T17:00:00Z";            // Sunday game

  const odds = {
    NFL: [{ id: "thu", commence_time: EARLY, home_team: "Kansas City Chiefs", away_team: "Buffalo Bills" },
          { id: "sun", commence_time: LATE,  home_team: "Dallas Cowboys",     away_team: "Philadelphia Eagles" }],
    NCAAF: []
  };

  const mk = (gameId, market, kind, sel, meta) => ({
    week: "2025-09-03", league: "NFL", gameId, matchup: gameId + " game",
    market, kind, selection: sel, odds: -110, meta
  });

  // Before anything starts, anything goes.
  const h = oddsHarness([], odds);
  ok(h.api.checkKickoffLock_("a@x.com", [mk("thu", "spread", "favorite", "Kansas City Chiefs", { line: -3 })],
     Date.parse("2025-09-04T12:00:00Z")) === null,
     "a pick before kickoff is fine");

  // Thursday has kicked off; a fresh pick on it is refused.
  const late = h.api.checkKickoffLock_("a@x.com",
    [mk("thu", "spread", "favorite", "Kansas City Chiefs", { line: -3 })],
    Date.parse("2025-09-05T02:00:00Z"));
  ok(/Too late/.test(late || ""), "a pick after kickoff is refused", late);
  ok(/thu game/.test(late || ""), "and names the game", late);

  // A Sunday pick is still fine even though Thursday is over.
  ok(h.api.checkKickoffLock_("a@x.com",
      [mk("sun", "spread", "favorite", "Dallas Cowboys", { line: -3 })],
      Date.parse("2025-09-05T02:00:00Z")) === null,
     "a later game is unaffected by an earlier one having started");
}

section("kickoff lock: an unchanged pick survives a resubmission");
{
  const EARLY = "2025-09-04T23:00:00Z", LATE = "2025-09-07T17:00:00Z";
  const odds = { NFL: [
    { id: "thu", commence_time: EARLY, home_team: "KC", away_team: "BUF" },
    { id: "sun", commence_time: LATE,  home_team: "DAL", away_team: "PHI" }], NCAAF: [] };

  const row = (id, gameId, market, kind, sel, meta) =>
    [id, "2025-09-03", "a@x.com", "Ann", "NFL", gameId, gameId + " game",
     market, kind, sel, -110, JSON.stringify(meta), "pending", ""];

  const stored = [PICK_HEADERS,
    row("e1", "thu", "spread", "favorite", "KC", { line: -3 }),
    row("e2", "sun", "total", "over", "Over", { total: 44.5 })];

  const h = oddsHarness(stored, odds);
  const AFTER_THU = Date.parse("2025-09-05T02:00:00Z");

  const mk = (gameId, market, kind, sel, meta) => ({
    week: "2025-09-03", league: "NFL", gameId, matchup: gameId + " game",
    market, kind, selection: sel, odds: -110, meta
  });

  // Changing only the Sunday pick, resending Thursday untouched.
  const okEdit = h.api.checkKickoffLock_("a@x.com", [
    mk("thu", "spread", "favorite", "KC", { line: -3 }),        // identical
    mk("sun", "total", "under", "Under", { total: 44.5 })       // changed
  ], AFTER_THU);
  ok(okEdit === null, "the Sunday pick can still be changed", okEdit);

  // Changing the Thursday pick after kickoff.
  const badEdit = h.api.checkKickoffLock_("a@x.com", [
    mk("thu", "spread", "underdog", "BUF", { line: 3 }),        // flipped sides
    mk("sun", "total", "over", "Over", { total: 44.5 })
  ], AFTER_THU);
  ok(/Too late/.test(badEdit || ""), "flipping the started game is refused", badEdit);

  // Same side, moved line - a different bet, so also refused.
  const movedLine = h.api.checkKickoffLock_("a@x.com", [
    mk("thu", "spread", "favorite", "KC", { line: -6.5 }),
    mk("sun", "total", "over", "Over", { total: 44.5 })
  ], AFTER_THU);
  ok(/Too late/.test(movedLine || ""), "moving the line on a started game is refused", movedLine);

  // Dropping it entirely is a change too.
  const dropped = h.api.checkKickoffLock_("a@x.com", [
    mk("sun", "total", "over", "Over", { total: 44.5 })
  ], AFTER_THU);
  ok(/cannot change or remove/.test(dropped || ""), "withdrawing it is refused", dropped);
}

section("kickoff lock: it does not overreach");
{
  const odds = { NFL: [{ id: "g1", commence_time: "2025-09-07T17:00:00Z", home_team: "A", away_team: "B" }], NCAAF: [] };
  const h = oddsHarness([], odds);
  const p = { week: "2025-09-03", league: "NFL", gameId: "unknown-to-the-feed",
              matchup: "X @ Y", market: "spread", kind: "favorite",
              selection: "X", odds: -110, meta: { line: -3 } };

  ok(h.api.checkKickoffLock_("a@x.com", [p], Date.now()) === null,
     "a game the feed has never heard of is allowed, not blocked");

  ok(h.api.checkKickoffLock_("a@x.com", [], Date.now()) === null, "an empty submission is not an error");

  // A feed outage must not stop the league submitting.
  const broken = oddsHarness([], null);
  ok(broken.api.checkKickoffLock_("a@x.com", [
      { week: "2025-09-03", league: "NFL", gameId: "g1", market: "spread",
        kind: "favorite", selection: "A", odds: -110, meta: { line: -3 } }
    ], Date.now()) === null,
    "an odds outage fails open rather than locking everyone out");
}

section("kickoff lock: signatures compare the right things");
{
  const h = oddsHarness([], { NFL: [], NCAAF: [] });
  const sig = h.api.pickSignature_;
  const base = { gameId: "g1", market: "spread", kind: "favorite",
                 selection: "Kansas City Chiefs", meta: { line: -3 } };

  ok(sig(base) === sig({ ...base, meta: { line: -3, price: -110 } }),
     "an unrelated meta field does not make it a different pick");
  ok(sig(base) === sig({ ...base, selection: "Kansas City  Chiefs!" }),
     "punctuation and spacing in the team name do not");
  ok(sig(base) !== sig({ ...base, meta: { line: -6.5 } }), "a moved line does");
  ok(sig(base) !== sig({ ...base, kind: "underdog" }), "the other side does");
  ok(sig(base) !== sig({ ...base, gameId: "g2" }), "a different game does");
  ok(sig({ ...base, meta: '{"line":-3}' }) === sig(base),
     "meta as a JSON string reads the same as an object");
}


section("the week view says who has not picked yet");
{
  /* Reading a week off the picks alone lists only the people who turned up,
     which answers "how is everyone doing" but not "who still owes me picks" -
     and on a Friday that is the question. */
  const mk = (id, user, week, status) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     "moneyline", "ml", "KC", "", "{}", status, ""];

  const rows = [PICK_HEADERS];
  // Three players established the season in an earlier week.
  for (const u of ["Ann", "Bob", "Cid"])
    for (let i = 0; i < 5; i++) rows.push(mk(u + "old" + i, u, "2025-09-03", "win"));
  // This week only Ann is complete; Bob got halfway; Cid never showed.
  for (let i = 0; i < 5; i++) rows.push(mk("ann" + i, "Ann", "2025-09-10", "win"));
  for (let i = 0; i < 2; i++) rows.push(mk("bob" + i, "Bob", "2025-09-10", "pending"));

  const { api } = harness({ Picks: rows, Results: [] }, SCORES);
  const w = api.getWeek_("2025-09-10");
  const by = {};
  for (const r of w.rows) by[r.user] = r;

  ok(w.rows.length === 3, "everyone in the season is listed, not just who played",
     w.rows.map(r => r.user).join());
  ok(by.Ann.complete === true && by.Ann.picks === 5, "a full slip is complete");
  ok(by.Bob.complete === false && by.Bob.picks === 2, "a half slip is not", by.Bob.picks);
  ok(by.Cid.picks === 0, "somebody who never picked shows zero, not absent");
  ok(w.expected === 5, "the target is stated rather than assumed by the page");
  ok(w.missing.join() === "Bob,Cid", "and both are named", w.missing.join());

  // Anyone who picked outranks anyone who did not, so an 0-5 week is not
  // filed next to a week somebody skipped.
  ok(w.rows[w.rows.length - 1].user === "Cid", "the no-show sorts last",
     w.rows.map(r => r.user).join());
}

section("a brand new season still knows who is expected");
{
  const mk = (id, user, week) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     "moneyline", "ml", "KC", "", "{}", "win", ""];
  // A whole season played, then a week in the NEXT season that nobody has
  // touched. The roster has to come from somewhere or week one can never say
  // who is missing.
  const rows = [PICK_HEADERS];
  for (const u of ["Ann", "Bob"])
    for (let i = 0; i < 5; i++) rows.push(mk(u + i, u, "2025-09-03"));

  const { api } = harness({ Picks: rows, Results: [] }, SCORES);
  const w = api.getWeek_("2026-09-09");
  ok(w.rows.length === 2, "last season's players carry over as the expected roster",
     w.rows.map(r => r.user).join());
  ok(w.missing.join() === "Ann,Bob", "and all of them are owing", w.missing.join());
  ok(w.rows.every(r => r.picks === 0), "with nothing recorded for any of them");
}


section("the current season is selectable before anyone has picked in it");
{
  /* A season derived purely from picks does not exist until somebody picks in
     it - and nobody can pick in it until they can select it. */
  const mk = (id, user, week) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     "moneyline", "ml", "KC", "", "{}", "win", ""];
  const rows = [PICK_HEADERS];
  for (let i = 0; i < 5; i++) rows.push(mk("a" + i, "Ann", "2025-09-03"));

  const { api } = harness({ Picks: rows, Results: [] }, SCORES);
  const seasons = api.getSeasons_();
  const now = api.currentSeason_();

  ok(seasons.some(s => s.season === now), "today's season is in the list", now);
  ok(seasons[0].season === now, "and is newest, so it becomes the default",
     seasons.map(s => s.season).join());
  const empty = seasons.find(s => s.season === now);
  ok(empty.picks === 0 && empty.weeks === 0,
     "reported honestly as empty rather than invented", JSON.stringify(empty));
  ok(empty.current === true, "and flagged as the current one");

  const old = seasons.find(s => s.season === "2025-26");
  ok(old && old.picks === 5, "the season with picks still reports them", old && old.picks);
  ok(old.current === false, "and is not the current one");

  /* Filtering to the empty season must return nothing, not everything - a
     silent fall-through would show last season's board under this year's name. */
  ok(api.getBoard_(now).length === 0, "its board is empty", api.getBoard_(now).length);
  ok(api.getBoard_("2025-26").length === 1, "while the played season still has one");
}


// -------------------------------------------------------------- notifications
section("nothing is sent until it is switched on");
{
  const mk = (id, user, week, status) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     "moneyline", "ml", "KC", "", "{}", status, ""];
  const rows = [PICK_HEADERS];
  for (const u of ["Ann", "Bob"]) for (let i = 0; i < 5; i++) rows.push(mk(u + i, u, "2025-09-03", "win"));

  const off = harness({ Picks: rows, Results: [] }, SCORES);
  ok(off.api.notifyWeekResults() === "skipped", "results stays quiet with NOTIFY unset");
  ok(off.sent.length === 0, "and sends nothing", off.sent.length);

  const on = harness({ Picks: rows, Results: [] }, SCORES, { NOTIFY: "on" });
  on.api.notifyWeekResults();
  ok(on.sent.length === 2, "switched on, everybody hears about it", on.sent.length);
  ok(/takes it/.test(on.sent[0].subject), "the subject names the winner", on.sent[0].subject);
  ok(/Ann/.test(on.sent[0].body) && /Bob/.test(on.sent[0].body), "the body lists the week");
  ok(/Season so far/.test(on.sent[0].body), "and where the season stands");

  /* A trigger that fires twice, or a hand re-run, must not mean two emails. */
  on.sent.length = 0;
  const again = on.api.notifyWeekResults();
  ok(/already sent/.test(again), "a second run is a no-op", again);
  ok(on.sent.length === 0, "and stays silent");
}

section("the reminder goes only to people who owe picks");
{
  const mk = (id, user, week) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     "moneyline", "ml", "KC", "", "{}", "win", ""];
  const rows = [PICK_HEADERS];
  // Three players in the season; this week Ann is done, Bob half, Cid absent.
  for (const u of ["Ann", "Bob", "Cid"])
    for (let i = 0; i < 5; i++) rows.push(mk(u + "o" + i, u, "2025-09-03"));
  for (let i = 0; i < 5; i++) rows.push(mk("a" + i, "Ann", "2025-09-10"));
  for (let i = 0; i < 2; i++) rows.push(mk("b" + i, "Bob", "2025-09-10"));

  const h = harness({ Picks: rows, Results: [] }, SCORES, { NOTIFY: "on" });
  const members = h.api.leagueMembers_();
  ok(members.length === 3, "three people in the league", members.length);

  const detail = h.api.getWeek_("2025-09-10");
  const short = detail.rows.filter((r) => !r.complete).map((r) => r.user).sort();
  ok(short.join() === "Bob,Cid", "two of them are short", short.join());
  /* Telling somebody who has already picked that they have not is how a
     mailing list gets muted. */
  ok(short.indexOf("Ann") < 0, "and the one who is done is not among them");
}

section("a silent failure becomes a loud one");
{
  const rows = [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "pending")];

  // No ADMIN_EMAIL: nothing to send to, and that must not itself throw.
  const quiet = harness({ Picks: rows, Results: [] }, SCORES);
  ok(quiet.api.notifyAdmin_("x", "y") === false, "with no admin address it reports false");
  ok(quiet.sent.length === 0, "and sends nothing");

  const h = harness({ Picks: rows, Results: [] }, SCORES, { ADMIN_EMAIL: "me@x.com" });
  ok(h.api.notifyAdmin_("something broke", "details") === true, "with one, it sends");
  ok(/Picks Game: something broke/.test(h.sent[0].subject), "prefixed so it is filterable",
     h.sent[0].subject);
}

section("running out of credits is reported before it stops grading");
{
  /* A fresh set per harness. FakeSheet holds the array by reference and
     grading writes statuses into it, so a shared fixture leaves the second run
     with nothing pending - no fetch, no credit check, and a test that passes
     for the wrong reason. */
  const fresh = () => [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "pending")];

  const plenty = harness({ Picks: fresh(), Results: [] }, SCORES, { ADMIN_EMAIL: "me@x.com" }, 400);
  plenty.api.runAutoGrade_();
  ok(plenty.sent.length === 0, "a healthy balance says nothing", plenty.sent.length);

  const thin = harness({ Picks: fresh(), Results: [] }, SCORES, { ADMIN_EMAIL: "me@x.com" }, 12);
  thin.api.runAutoGrade_();
  ok(thin.sent.length === 1, "a thin one warns", thin.sent.length);
  ok(/low on API credits/.test(thin.sent[0].subject), "and says so", thin.sent[0].subject);
  ok(/12 credits left/.test(thin.sent[0].body), "with the number", thin.sent[0].body.slice(0, 60));

  /* Once per crossing, not once per call - the grader runs every six hours. */
  thin.sent.length = 0;
  thin.api.warnOnLowCredits_(12);
  ok(thin.sent.length === 0, "it does not warn again at the same level");
  thin.api.warnOnLowCredits_(400);
  thin.api.warnOnLowCredits_(12);
  ok(thin.sent.length === 1, "but does after recovering and dropping again", thin.sent.length);
}

section("preview says what would happen and sends nothing");
{
  const mk = (id, user, week) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g" + id, "A @ B",
     "moneyline", "ml", "KC", "", "{}", "win", ""];
  const rows = [PICK_HEADERS];
  for (let i = 0; i < 5; i++) rows.push(mk("a" + i, "Ann", "2025-09-03"));

  const h = harness({ Picks: rows, Results: [] }, SCORES);
  const msg = h.api.previewNotifications();
  ok(/NOTIFY {8}: OFF/.test(msg), "it leads with the switch being off", msg.split("\n")[0]);
  ok(/failures go unreported/.test(msg), "and that failures are unreported");
  ok(/recipients {4}: 1/.test(msg), "counts who would hear", (msg.match(/recipients[^\n]*/) || [])[0]);
  ok(h.sent.length === 0, "and sends nothing at all", h.sent.length);
}


section("grading that fails tells somebody");
{
  /* Removing this block is invisible to every other test: grading still
     "works", it just stops reporting that it did not. */
  const rows = [PICK_HEADERS,
    row("p1", "a@x.com", "Ann", "NFL", "g1", "spread", "favorite", "Kansas City Chiefs", { line: -6.5 }, "pending")];

  const h = harness({ Picks: rows, Results: [] }, "fail", { ADMIN_EMAIL: "me@x.com" });
  const out = h.api.autoGrade();

  ok(out.graded === 0, "nothing graded, as expected", out.graded);
  ok((out.errors || []).length > 0, "the run records the failure", JSON.stringify(out.errors));
  ok(h.sent.length === 1, "and somebody is told", h.sent.length);
  ok(/grading hit errors/.test(h.sent[0].subject), "with a subject you can filter on",
     h.sent[0].subject);
  ok(/three days/.test(h.sent[0].body),
     "and the reason it is urgent - scores expire", h.sent[0].body.slice(-120));

  /* With no admin address there is nobody to tell, and that must not itself
     break the run. */
  const quiet = harness({ Picks: rows, Results: [] }, "fail");
  const out2 = quiet.api.autoGrade();
  ok((out2.errors || []).length > 0, "the failure is still recorded");
  ok(quiet.sent.length === 0, "just not sent anywhere", quiet.sent.length);
}


section("everyone's picks are revealed at kickoff, not before");
{
  const soon = new Date(Date.now() + 864e5).toISOString();   // tomorrow
  const past = new Date(Date.now() - 864e5).toISOString();   // yesterday
  const WK = "2099-01-07";   // far future, so the week-has-passed fallback stays out of it

  const p = (id, user, gameId, status, kickoff) =>
    [id, WK, user.toLowerCase() + "@x.com", user, "NFL", gameId, "Bills @ Chiefs",
     "spread", "favorite", "Kansas City Chiefs", -110,
     JSON.stringify({ line: -3, kickoff: kickoff }), status, ""];

  const odds = { NFL: [
    { id: "started", commence_time: past, home_team: "Kansas City Chiefs", away_team: "Buffalo Bills" },
    { id: "later",   commence_time: soon, home_team: "Kansas City Chiefs", away_team: "Buffalo Bills" }
  ], NCAAF: [] };

  const rows = [PICK_HEADERS,
    p("a1", "Ann", "started", "pending"),   // game under way -> public
    p("a2", "Ann", "later",   "pending"),   // not started    -> hidden
    p("b1", "Bob", "later",   "pending"),   // not started    -> hidden
    p("b2", "Bob", "started", "win")        // graded         -> public
  ];

  const h = oddsHarness(rows, odds);
  const out = h.api.getWeekPicks_(WK, "");
  const by = {};
  for (const pl of out.players) by[pl.user] = pl;

  ok(by.Ann.picks === 2, "the count is visible even when the picks are not", by.Ann.picks);
  ok(by.Ann.hidden === 1, "one of Ann's is still hidden", by.Ann.hidden);
  const shown = by.Ann.rows.filter((r) => !r.hidden);
  ok(shown.length === 1, "and one is shown");
  ok(shown[0].selection === "Kansas City Chiefs", "with the actual pick", shown[0].selection);
  ok(shown[0].line === -3, "and the line it was taken at", shown[0].line);
  ok(by.Ann.rows.filter((r) => r.hidden)[0].selection === undefined,
     "a hidden row carries no selection at all - not even to be un-hidden client side");

  ok(by.Bob.hidden === 1, "a graded pick is public whatever the feed says", by.Bob.hidden);
}

section("you can always see your own picks");
{
  const soon = new Date(Date.now() + 864e5).toISOString();
  const WK = "2099-01-07";
  const p = (id, user, gameId) =>
    [id, WK, user.toLowerCase() + "@x.com", user, "NFL", gameId, "Bills @ Chiefs",
     "spread", "favorite", "Kansas City Chiefs", -110, JSON.stringify({ line: -3 }), "pending", ""];
  const odds = { NFL: [{ id: "later", commence_time: soon,
                         home_team: "Kansas City Chiefs", away_team: "Buffalo Bills" }], NCAAF: [] };

  const h = oddsHarness([PICK_HEADERS, p("a1", "Ann", "later"), p("b1", "Bob", "later")], odds);
  const out = h.api.getWeekPicks_(WK, "ann@x.com");
  const by = {}; for (const pl of out.players) by[pl.user] = pl;

  ok(by.Ann.hidden === 0, "your own are visible - you made them", by.Ann.hidden);
  ok(by.Ann.rows[0].own === true, "and flagged as yours");
  ok(by.Bob.hidden === 1, "somebody else's are not", by.Bob.hidden);
}

section("old picks do not stay hidden forever");
{
  /* The odds feed only carries upcoming games, so a pick from last month has
     no kickoff to check. Without a fallback it would be masked permanently. */
  const p = (id, user) =>
    [id, "2025-09-03", user.toLowerCase() + "@x.com", user, "NFL", "gone", "Bills @ Chiefs",
     "spread", "favorite", "Kansas City Chiefs", -110, JSON.stringify({ line: -3 }), "pending", ""];
  const h = oddsHarness([PICK_HEADERS, p("a1", "Ann")], { NFL: [], NCAAF: [] });
  const out = h.api.getWeekPicks_("2025-09-03", "");
  ok(out.players[0].hidden === 0, "a week that has been and gone is public",
     out.players[0].hidden);
  ok(out.players[0].rows[0].selection === "Kansas City Chiefs", "with the pick readable");
}

section("a player who has not picked is a visible blank");
{
  /* Both weeks in one season: the expected roster is per-season by design, so
     somebody who only played a different year is genuinely not owed here. */
  const WK = "2025-09-10";
  const p = (id, user, week) =>
    [id, week, user.toLowerCase() + "@x.com", user, "NFL", "g1", "Bills @ Chiefs",
     "spread", "favorite", "Kansas City Chiefs", -110, JSON.stringify({ line: -3 }), "win", ""];
  // Ann and Bob both played an earlier week; only Ann played this one.
  const rows = [PICK_HEADERS, p("o1", "Ann", "2025-09-03"), p("o2", "Bob", "2025-09-03"),
                              p("n1", "Ann", WK)];
  const h = oddsHarness(rows, { NFL: [], NCAAF: [] });
  const out = h.api.getWeekPicks_(WK, "");
  const names = out.players.map((x) => x.user);
  ok(names.indexOf("Bob") >= 0, "Bob is listed even with nothing in", names.join());
  const bob = out.players.filter((x) => x.user === "Bob")[0];
  ok(bob.picks === 0 && bob.rows.length === 0, "as an empty slip, not a missing row");
  ok(out.players[out.players.length - 1].user === "Bob", "and sorts last", names.join());
}


section("the log records the act of submitting, not just the result");
{
  const g = { id:"g1", league:"NFL", kickoff:new Date(Date.now()+864e5).toISOString(),
    home_team:"Kansas City Chiefs", away_team:"Buffalo Bills",
    spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
    totals:{ total:44, overPrice:-110, underPrice:-110 },
    moneyline:{ home:-150, away:130 } };
  const pick = (kind, sel, meta) => ({ week:"2026-09-09", league:"NFL", gameId:"g1",
    matchup:"Buffalo Bills @ Kansas City Chiefs", market:"spread", kind:kind,
    selection:sel, odds:-110, meta:meta });

  const h = oddsHarness([PICK_HEADERS], { NFL:[g], NCAAF:[] });

  h.api.submitPicks_("a@x.com", "Ann", [pick("favorite","Kansas City Chiefs",{line:-3})]);
  let log = h.api.readSubmissions_();
  ok(log.length === 1, "one submission logged", log.length);
  ok(log[0].user === "Ann" && log[0].week === "2026-09-09", "with who and which week");
  ok(log[0].picks === 1 && log[0].replaced === 0, "and nothing replaced the first time",
     log[0].picks + "/" + log[0].replaced);

  /* Resubmitting deletes the old picks, so without the log the fact that it
     happened at all would simply be gone. */
  h.api.submitPicks_("a@x.com", "Ann", [pick("underdog","Buffalo Bills",{line:3})]);
  log = h.api.readSubmissions_();
  ok(log.length === 2, "the edit is a second entry, not an overwrite", log.length);
  ok(log[1].replaced === 1, "and records what it displaced", log[1].replaced);

  const week = h.api.submissionsForWeek_("2026-09-09");
  ok(week.Ann.count === 2, "the week view counts both", week.Ann.count);
  ok(week.Ann.replaced === 1, "and the replacements");
  ok(week.Ann.lastAt >= week.Ann.firstAt, "with first and last the right way round");
}

section("a broken log never breaks a submission");
{
  /* The picks are already saved by the time the log is written. An audit note
     is worth less than the thing it audits. */
  const g = { id:"g1", league:"NFL", kickoff:new Date(Date.now()+864e5).toISOString(),
    home_team:"Kansas City Chiefs", away_team:"Buffalo Bills",
    spread:{ fav:"home", line:-3, favPrice:-110, dogPrice:-110 },
    totals:{ total:44, overPrice:-110, underPrice:-110 }, moneyline:{ home:-150, away:130 } };
  const h = oddsHarness([PICK_HEADERS], { NFL:[g], NCAAF:[] });

  /* Sabotage the log sheet itself, so appendSubmission_ really throws rather
     than the test merely asserting it does not. */
  const boom = () => { throw new Error("submissions unavailable"); };
  h.store.Submissions = { getLastRow: boom, getLastColumn: boom, getDataRange: boom,
                          getRange: boom, clear: boom, setFrozenRows: boom };

  let out = null, threw = null;
  try {
    out = h.api.submitPicks_("a@x.com", "Ann", [{ week:"2026-09-09", league:"NFL", gameId:"g1",
      matchup:"Buffalo Bills @ Kansas City Chiefs", market:"spread", kind:"favorite",
      selection:"Kansas City Chiefs", odds:-110, meta:{ line:-3 } }]);
  } catch (e) { threw = e; }

  ok(!threw, "the submission still succeeds", threw && threw.message);
  ok(out && out.count === 1, "and reports the picks saved", out && out.count);
  ok(h.store.Picks.rows.length === 2, "the picks really are in the sheet",
     h.store.Picks.rows.length - 1);

  /* Reading a broken log is the same story: a missing history must not stop a
     week rendering. */
  ok(JSON.stringify(h.api.submissionsForWeek_("2026-09-09")) === "{}",
     "and a log that cannot be read comes back empty rather than throwing");
}


section("the brief counts the outliers so the model does not have to");
{
  /* A model asked to find streaks in a table will find one that is not there,
     and eight people who watched the games notice immediately. */
  const mk = (id, user, week, status, sel, kind, market, meta) =>
    [id, week, user.toLowerCase()+"@x.com", user, "NFL", "g"+id, "Bills @ Chiefs",
     market||"spread", kind||"favorite", sel||"Kansas City Chiefs", -110,
     JSON.stringify(meta||{line:-3}), status, ""];

  const rows = [PICK_HEADERS];
  /* The first week is deliberately 2-3: a good enough week to have wins in,
     but not a good week. A fixture where every week clears the bar cannot tell
     "four or more" from "at least one", and the streak rule is the whole
     point. */
  const hist = ["2025-09-03","2025-09-10","2025-09-17"];
  hist.forEach((wk, idx) => {
    const annWins = idx === 0 ? 2 : 4;
    for (let i=0;i<annWins;i++) rows.push(mk("a"+wk+i,"Ann",wk,"win"));
    for (let i=annWins;i<5;i++) rows.push(mk("a"+wk+i,"Ann",wk,"loss"));
    for (let i=0;i<2;i++) rows.push(mk("b"+wk+i,"Bob",wk,"win"));
    for (let i=0;i<3;i++) rows.push(mk("b"+wk+(i+2),"Bob",wk,"loss"));
  });
  const WK = "2025-09-24";
  for (let i=0;i<5;i++) rows.push(mk("aw"+i,"Ann",WK,"win"));
  for (let i=0;i<5;i++) rows.push(mk("bw"+i,"Bob",WK,"loss"));

  const { api } = harness({ Picks: rows, Results: [] }, SCORES);
  const brief = api.weekBrief_(WK);

  ok(brief.outliers.perfect.join() === "Ann", "a 5-0 is named", brief.outliers.perfect.join());
  ok(brief.outliers.blank.join() === "Bob", "and so is an 0-5", brief.outliers.blank.join());

  const hot = brief.outliers.hotStreaks.filter((h) => h.user === "Ann")[0];
  /* Three: this week plus the two 4-1s. The opening 2-3 breaks it, which is
     the assertion that separates a real rule from "has been playing". */
  ok(hot && hot.weeks === 3, "the run stops at the week that was not a good one",
     hot && hot.weeks);
  ok(!brief.outliers.hotStreaks.some((h) => h.user === "Bob"),
     "and somebody losing is not credited with one");

  const ann = brief.players.filter((p) => p.user === "Ann")[0];
  ok(ann.week === "5-0", "each player's week is stated", ann.week);
  ok(ann.seasonRecord === "15-5", "against their season", ann.seasonRecord);
  ok(brief.standings.length > 0, "and the standings ride along");
}

section("the brief spots what everybody did, and what only one did");
{
  const mk = (id, user, gameId, sel, status) =>
    [id, "2025-10-01", user.toLowerCase()+"@x.com", user, "NFL", gameId, "Bills @ Chiefs",
     "spread", "favorite", sel, -110, JSON.stringify({line:-3}), status, ""];
  const rows = [PICK_HEADERS,
    // all three took the Chiefs, and it lost
    mk("a1","Ann","g1","Kansas City Chiefs","loss"),
    mk("b1","Bob","g1","Kansas City Chiefs","loss"),
    mk("c1","Cid","g1","Kansas City Chiefs","loss"),
    // only Cid took the Bills elsewhere, and it won
    mk("c2","Cid","g2","Buffalo Bills","win"),
    mk("a2","Ann","g3","New York Jets","loss"),
    mk("b2","Bob","g4","Miami Dolphins","loss")
  ];
  const { api } = harness({ Picks: rows, Results: [] }, SCORES);
  const o = api.weekBrief_("2025-10-01").outliers;

  ok(o.unanimous.length === 1, "the pick everybody made is found", o.unanimous.length);
  ok(/Kansas City Chiefs/.test(o.unanimous[0].pick), "named", o.unanimous[0].pick);
  ok(o.unanimous[0].result === "loss", "with how it went", o.unanimous[0].result);
  ok(o.loneWinners.some((l) => l.user === "Cid"), "and the one who went alone and won",
     JSON.stringify(o.loneWinners));
}

section("the biggest number of the week is the real one");
{
  const mk = (id, user, line, status) =>
    [id, "2025-10-08", user.toLowerCase()+"@x.com", user, "NCAAF", "g"+id, "SJSU @ USC",
     "spread", line < 0 ? "favorite" : "underdog", "San Jose State Spartans", -110,
     JSON.stringify({ line: line }), status, ""];
  /* The biggest number is a 45-point favourite, which is negative. A fixture
     whose largest line is positive cannot tell absolute size from signed. */
  const rows = [PICK_HEADERS, mk("a","Ann",-45,"win"), mk("b","Bob",38.5,"win"),
                              mk("c","Cid",-7.5,"loss")];
  const { api } = harness({ Picks: rows, Results: [] }, SCORES);
  const big = api.weekBrief_("2025-10-08").outliers.biggestSpread;
  ok(big.line === 45, "the largest spread by size, laid or taken", big.line);
  ok(big.user === "Ann", "and who had it", big.user);
  ok(big.result === "win", "and whether it came in", big.result);
}

section("generation never becomes a single point of failure");
{
  const mk = (id, user, week, status) =>
    [id, week, user.toLowerCase()+"@x.com", user, "NFL", "g"+id, "Bills @ Chiefs",
     "moneyline", "ml", "Kansas City Chiefs", -110, "{}", status, ""];
  const rows = [PICK_HEADERS];
  for (const u of ["Ann","Bob"]) for (let i=0;i<5;i++) rows.push(mk(u+i,u,"2025-09-03","win"));

  /* RECAP off: the plain email, and no API call at all. */
  const off = harness({ Picks: rows, Results: [] }, SCORES, { NOTIFY: "on" });
  const r1 = off.api.notifyWeekResults();
  ok(/\(plain\)/.test(r1), "with generation off it says which it sent", r1);
  ok(off.sent.length === 2, "and everybody still hears", off.sent.length);
  ok(off.calls.filter((u) => /anthropic/.test(u)).length === 0, "no API call made");

  /* RECAP on but the key missing: still the plain email, still delivered. */
  const noKey = harness({ Picks: rows, Results: [] }, SCORES, { NOTIFY: "on", RECAP: "on" });
  const r2 = noKey.api.notifyWeekResults();
  ok(/\(plain\)/.test(r2), "no key means the plain email, not no email", r2);
  ok(noKey.sent.length === 2, "which still arrives", noKey.sent.length);
  /* Counting the sends is not enough - an email with a null body is still an
     email. The template has to actually be in it. */
  ok(/Season so far/.test(noKey.sent[0].body || ""),
     "carrying the plain template, not an empty body",
     String(noKey.sent[0].body).slice(0, 40));
  ok(/is final/.test(off.sent[0].body || ""), "and the same with generation off",
     String(off.sent[0].body).slice(0, 40));

  /* The case that actually exercises the fallback: generation switched on, a
     key present, and the call coming back with nothing usable. Both cases
     above skip the branch entirely because recapEnabled_ is false, so neither
     can tell a working fallback from a missing one. */
  const broken = harness({ Picks: rows, Results: [] }, SCORES,
                          { NOTIFY: "on", RECAP: "on", ANTHROPIC_API_KEY: "sk-test" });
  ok(broken.api.recapEnabled_() === true, "generation is genuinely on here");
  ok(broken.api.askClaude_({ week: "x" }) === null,
     "and the call yields nothing usable", broken.api.askClaude_({ week: "x" }));

  const r3 = broken.api.notifyWeekResults();
  ok(/\(plain\)/.test(r3), "so it falls back rather than sending nothing", r3);
  ok(broken.sent.filter((m) => /takes it/.test(m.subject)).length === 2,
     "the week email still goes to everybody",
     broken.sent.filter((m) => /takes it/.test(m.subject)).length);
  const weekMail = broken.sent.filter((m) => /takes it/.test(m.subject))[0];
  ok(/Season so far/.test(weekMail.body || ""),
     "with the template in it, not an empty body",
     String(weekMail.body).slice(0, 40));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
