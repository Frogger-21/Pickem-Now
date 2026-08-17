/* Tests auditGrades() and backtestWeek() - the two ways to check grading
   against weeks that are too old for the scores feed.

   The audit matters most and is the easiest to get wrong in the dangerous
   direction: an audit that cries wolf on correct grades is worse than no
   audit, because you stop reading it. So most of what follows is checking
   that legitimate grades are left alone.

       node tools/backtest-test.js                                         */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "Google App Script Code.gs"), "utf8");

// Same fake Sheet as pipeline-test.js, trimmed to what these need.
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

function load(pickRows) {
  const store = { Picks: new FakeSheet("Picks", pickRows), Results: new FakeSheet("Results", []) };
  const env = {
    PropertiesService: { getScriptProperties: () => ({
      // STORAGE must be absent so it defaults to sheets; a catch-all "x" here
      // is a nonsense backend name and storageKind_ rightly refuses it.
      getProperty: (k) => (k === "STORAGE" ? null : "x")
    }) },
    SpreadsheetApp: { openById: () => ({
      getName: () => "test",
      getSheetByName: (n) => store[n] || null,
      insertSheet: (n) => (store[n] = new FakeSheet(n, []))
    }) },
    UrlFetchApp: { fetch: () => { throw new Error("the audit must never call the API"); } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Logger: { log() {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ScriptApp: {}, Utilities: { getUuid: () => "uuid" }, ContentService: {}
  };
  const names = Object.keys(env);
  return new Function(...names,
    SRC + "return { auditGrades, backtestWeek, backtestTemplate, splitMatchup_, readWeekPicks_, weekKey_, getWeeks_, seasonOf_, nearestWednesday_, weekPlanReport, applyWeekNormalization };"
  )(...names.map((n) => env[n]));
}

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) pass++;
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? " :: " + detail : "")); }
};
const section = (t) => console.log("\n" + t);

const HEAD = ['id','week','email','user','league','gameId','matchup',
  'market','kind','selection','odds','meta','status','ts'];

// Bills @ Chiefs - Chiefs are home. The audit never learns the score.
const M = "Buffalo Bills @ Kansas City Chiefs";
const KC = "Kansas City Chiefs", BUF = "Buffalo Bills";

let n = 0;
const p = (user, market, kind, selection, meta, status, gameId = "g1", matchup = M) =>
  ["p" + (++n), "2025-11-09", user + "@x.com", user, "NFL", gameId, matchup,
   market, kind, selection, "", JSON.stringify(meta), status, ""];

const audit = (rows) => load([HEAD, ...rows]).auditGrades();
const clean = (msg) => /no contradictions found/.test(msg);

// ---------------------------------------------------------------- audit: quiet
section("the audit stays quiet on grades that are consistent");
{
  ok(clean(audit([
    p("Ann", "spread", "favorite", KC,  { line: -6.5 }, "win"),
    p("Bob", "spread", "underdog", BUF, { line:  6.5 }, "loss")
  ])), "matched spread, opposite verdicts");

  ok(clean(audit([
    p("Ann", "spread", "favorite", KC,  { line: -7 }, "push"),
    p("Bob", "spread", "underdog", BUF, { line:  7 }, "push")
  ])), "both push on the same number");

  ok(clean(audit([
    p("Ann", "total", "over",  "Over",  { total: 45.5 }, "win"),
    p("Bob", "total", "under", "Under", { total: 45.5 }, "loss")
  ])), "over and under on the same total");

  ok(clean(audit([
    p("Ann", "moneyline", "ml", KC,  {}, "win"),
    p("Bob", "moneyline", "ml", BUF, {}, "loss")
  ])), "opposite moneylines");

  // Different numbers are genuinely allowed to agree - 7 covers -6.5 and pushes +7.
  ok(clean(audit([
    p("Ann", "spread", "favorite", KC,  { line: -6.5 }, "win"),
    p("Bob", "spread", "underdog", BUF, { line:  7   }, "push")
  ])), "different lines on the same game may both be right");

  ok(clean(audit([
    p("Ann", "total", "over",  "Over",  { total: 44 }, "win"),
    p("Bob", "total", "under", "Under", { total: 48 }, "win")
  ])), "different totals may both be right");

  // Same side, same view - not a contradiction.
  ok(clean(audit([
    p("Ann", "spread", "favorite", KC, { line: -6.5 }, "win"),
    p("Bob", "spread", "favorite", KC, { line: -6.5 }, "win")
  ])), "two people on the same side agree");

  ok(clean(audit([
    p("Ann", "moneyline", "ml", KC, {}, "win"),
    p("Bob", "spread", "underdog", BUF, { line: 3 }, "win")
  ])), "a dog can lose outright and still cover");

  ok(clean(audit([p("Ann", "spread", "favorite", KC, { line: -6.5 }, "win")])),
    "a single pick has nothing to contradict");

  ok(/No picks yet/.test(audit([])), "empty sheet says so rather than erroring");
}

// ---------------------------------------------------------------- audit: loud
section("the audit catches grades that cannot both be right");
{
  const both = audit([
    p("Ann", "spread", "favorite", KC,  { line: -6.5 }, "win"),
    p("Bob", "spread", "underdog", BUF, { line:  6.5 }, "win")
  ]);
  ok(/1 contradiction/.test(both), "both sides of one spread cannot win", both.split("\n")[0]);
  ok(/same spread, opposite sides/.test(both), "and it says why");
  ok(/row 2/.test(both) && /row 3/.test(both), "and names both rows");

  ok(/1 contradiction/.test(audit([
    p("Ann", "total", "over",  "Over",  { total: 45.5 }, "loss"),
    p("Bob", "total", "under", "Under", { total: 45.5 }, "loss")
  ])), "over and under cannot both lose");

  ok(/1 contradiction/.test(audit([
    p("Ann", "moneyline", "ml", KC,  {}, "win"),
    p("Bob", "moneyline", "ml", BUF, {}, "push")
  ])), "a moneyline winner means the other side lost, not pushed");

  // The cross-market inference: KC won outright while getting 3 points.
  const cross = audit([
    p("Ann", "moneyline", "ml", KC, {}, "win"),
    p("Bob", "spread", "underdog", KC, { line: 3 }, "loss")
  ]);
  ok(/1 contradiction/.test(cross), "won outright while getting points must cover", cross.split("\n")[0]);
  ok(/so it covered/.test(cross), "and explains the inference");

  const cross2 = audit([
    p("Ann", "moneyline", "ml", KC, {}, "loss"),
    p("Bob", "spread", "favorite", KC, { line: -3 }, "win")
  ]);
  ok(/1 contradiction/.test(cross2), "lost outright while laying points cannot cover");

  // A push on the moneyline means a tie, which settles nothing about spreads.
  ok(clean(audit([
    p("Ann", "moneyline", "ml", KC, {}, "push"),
    p("Bob", "spread", "underdog", KC, { line: 3 }, "win")
  ])), "a tied moneyline is not used to infer anything");
}

section("the audit ignores what it should");
{
  ok(clean(audit([
    p("Ann", "spread", "favorite", KC,  { line: -6.5 }, "pending"),
    p("Bob", "spread", "underdog", BUF, { line:  6.5 }, "pending")
  ])), "ungraded picks are not audited");

  const mixed = audit([
    p("Ann", "spread", "favorite", KC,  { line: -6.5 }, "win"),
    p("Bob", "spread", "underdog", BUF, { line:  6.5 }, "pending")
  ]);
  ok(clean(mixed), "a half-graded pair is not a contradiction");

  // Different games entirely.
  ok(clean(audit([
    p("Ann", "spread", "favorite", KC,  { line: -6.5 }, "win", "g1"),
    p("Bob", "spread", "underdog", BUF, { line:  6.5 }, "win", "g2", "Buffalo Bills @ Kansas City Chiefs")
  ])), "picks on different games are unrelated");

  // Two moneyline winners on the same game is a contradiction anywhere else,
  // but in the self-test week the audit must not look at all.
  const st = (week) => audit([
    ["s1", week, "s@x", "Selftest", "NFL", "g1", M, "moneyline", "ml", KC,  "", "{}", "win", ""],
    ["s2", week, "s@x", "Selftest", "NFL", "g1", M, "moneyline", "ml", BUF, "", "{}", "win", ""]
  ]);
  ok(/1 contradiction/.test(st("2025-11-09")), "the same rows in a real week do contradict");
  ok(/across 0 graded/.test(st("__selftest__")), "but self-test rows are skipped entirely");

  // A matchup that isn't "away @ home" can't be sided, so it is left alone.
  ok(clean(audit([
    p("Ann", "spread", "favorite", KC,  { line: -6.5 }, "win", "g1", "Bills vs Chiefs"),
    p("Bob", "spread", "underdog", BUF, { line:  6.5 }, "win", "g1", "Bills vs Chiefs")
  ])), "an unparseable matchup is skipped rather than guessed at");
}

// ---------------------------------------------------------------- backtest
section("backtestWeek replays real picks against typed-in scores");
{
  const rows = [HEAD,
    p("Ann", "spread", "favorite", KC,  { line: -6.5 }, "win"),
    p("Bob", "spread", "underdog", BUF, { line:  6.5 }, "loss"),
    p("Cid", "total", "over", "Over", { total: 45.5 }, "loss"),      // wrong on purpose: 47 > 45.5
    p("Dee", "moneyline", "ml", KC, {}, "win")
  ];
  const api = load(rows);
  // KC 27, BUF 20 -> total 47
  const msg = api.backtestWeek("2025-11-09", { g1: [27, 20] });

  ok(/agreed with the sheet : 3/.test(msg), "three grades match", msg.split("\n")[1]);
  ok(/disagreed +: 1/.test(msg), "and the planted mistake is found");
  ok(/DISAGREEMENTS/.test(msg) && /Cid/.test(msg), "the disagreement names who and what");
  ok(/sheet says loss, grader says win/.test(msg), "and both verdicts");

  // It must not touch the sheet.
  ok(JSON.stringify(rows[3][12]) === '"loss"', "backtest writes nothing back");
}

section("backtestWeek is honest about what it could not do");
{
  const api = load([HEAD,
    p("Ann", "spread", "favorite", KC, { line: -6.5 }, "win"),
    p("Bob", "spread", "favorite", "Dallas Cowboys", { line: -3 }, "win", "g2", "Dallas Cowboys @ Philadelphia Eagles")
  ]);
  const msg = api.backtestWeek("2025-11-09", { g1: [27, 20] });
  ok(/no score supplied +: 1/.test(msg), "counts the game it had no score for");
  ok(/NO SCORE GIVEN for: Dallas Cowboys @ Philadelphia Eagles/.test(msg), "and names it");

  const api2 = load([HEAD, p("Ann", "spread", "favorite", KC, {}, "win")]);
  const msg2 = api2.backtestWeek("2025-11-09", { g1: [27, 20] });
  ok(/declined to call +: 1/.test(msg2), "a spread with no line is declined, not guessed");

  ok(/No picks found/.test(load([HEAD]).backtestWeek("nope", {})), "an unknown week says so");
}

section("backtestTemplate lists a week's games once each");
{
  const api = load([HEAD,
    p("Ann", "spread", "favorite", KC, { line: -6.5 }, "win"),
    p("Bob", "moneyline", "ml", BUF, {}, "loss"),
    p("Cid", "spread", "favorite", "Dallas Cowboys", { line: -3 }, "win", "g2", "Dallas Cowboys @ Philadelphia Eagles")
  ]);
  const t = api.backtestTemplate("2025-11-09");
  ok((t.match(/'g1':/g) || []).length === 1, "one line per game, not per pick");
  ok(/'g2':/.test(t), "every game appears");
  ok(/2 pick\(s\)/.test(t), "shows how many picks ride on it");
  ok(/backtestWeek\('2025-11-09'/.test(t), "and is a runnable call");
}

section("splitMatchup_ reads the frontend's format");
{
  const api = load([HEAD]);
  const s = api.splitMatchup_("Buffalo Bills @ Kansas City Chiefs");
  ok(s && s.away === "Buffalo Bills", "away team is first", s && s.away);
  ok(s && s.home === "Kansas City Chiefs", "home team is second", s && s.home);
  ok(api.splitMatchup_("Bills vs Chiefs") === null, "anything else is refused");
  ok(api.splitMatchup_("") === null, "blank is refused");
}

// ---------------------------------------------------------------- week order
// The Sheet's week column was a date cell, so it stringified to "Wed Sep 24
// 2025 00:00:00 GMT-0500 (Central Daylight Time)". Sorted as text that orders
// by day name and then month name, which put September above October in the
// week dropdown for the whole of last season.
section("weeks come back newest first, whatever the label looks like");
{
  const api = load([HEAD]);
  const k = api.weekKey_;

  ok(k("Wed Sep 24 2025 00:00:00 GMT-0500 (Central Daylight Time)") === "2025-09-24",
     "a stringified Date becomes a sortable key", k("Wed Sep 24 2025 00:00:00 GMT-0500 (CDT)"));
  ok(k("2025-09-24") === "2025-09-24", "an ISO date is already one");
  ok(k("2025-09-24T00:00:00Z") === "2025-09-24", "an ISO timestamp is trimmed to the date");
  ok(k("Sep 24 2025") === "2025-09-24", "with or without the day name");
  ok(k("9/24/2025") === "2025-09-24", "and a US-format date");
  ok(k("Wed Oct 08 2025 00:00:00") === "2025-10-08", "single-digit days are padded");
  ok(k("Week 3") === "Week 3", "an unrecognised label sorts as itself rather than being guessed at");
  ok(k("") === "" && k(null) === "", "blank stays blank");

  // Parsed by pattern, not through Date: new Date() on a midnight-with-offset
  // string re-interprets it in the local zone and can land on the day before.
  ok(k("Wed Jan 01 2026 00:00:00 GMT-0600 (Central Standard Time)") === "2026-01-01",
     "midnight with an offset does not slip a day",
     k("Wed Jan 01 2026 00:00:00 GMT-0600 (CST)"));
}

section("the dropdown order is actually chronological");
{
  const D = (s) => s;   // labels exactly as the Sheet produced them
  const rows = [HEAD];
  let i = 0;
  for (const wk of ["Wed Sep 03 2025 00:00:00 GMT-0500 (Central Daylight Time)",
                    "Wed Oct 08 2025 00:00:00 GMT-0500 (Central Daylight Time)",
                    "Wed Nov 12 2025 00:00:00 GMT-0600 (Central Standard Time)",
                    "Wed Sep 24 2025 00:00:00 GMT-0500 (Central Daylight Time)"]) {
    rows.push(["w" + (++i), D(wk), "a@x.com", "Ann", "NFL", "g" + i, M,
               "moneyline", "ml", KC, "", "{}", "win", ""]);
  }
  const weeks = load(rows).getWeeks_().map((w) => w.week.slice(4, 15));
  ok(weeks[0].indexOf("Nov 12") === 0, "newest week first", weeks.join(" | "));
  ok(weeks[3].indexOf("Sep 03") === 0, "oldest week last", weeks.join(" | "));
  ok(weeks[1].indexOf("Oct 08") === 0 && weeks[2].indexOf("Sep 24") === 0,
     "and the middle is right too", weeks.join(" | "));
}

// ------------------------------------------------------- week normalisation
section("seasons run August to July");
{
  const api = load([HEAD]);
  const s = api.seasonOf_;
  ok(s("2025-09-03") === "2025-26", "September opens a season", s("2025-09-03"));
  ok(s("2025-12-10") === "2025-26", "December is the same season", s("2025-12-10"));
  ok(s("2026-01-05") === "2025-26", "a January bowl stays in it", s("2026-01-05"));
  ok(s("2026-08-26") === "2026-27", "August opens the next one", s("2026-08-26"));
  ok(s("2026-07-31") === "2025-26", "July is still the old one", s("2026-07-31"));
}

section("dates snap to the NEAREST Wednesday");
{
  const api = load([HEAD]);
  const w = api.nearestWednesday_;
  ok(w("2025-10-01") === "2025-10-01", "a Wednesday is already home", w("2025-10-01"));
  // The real bug: Rish submitted Tue Sep 30 for the Oct 1 slate.
  ok(w("2025-09-30") === "2025-10-01", "a day early joins the slate it meant", w("2025-09-30"));
  ok(w("2025-10-02") === "2025-10-01", "and so does a day late", w("2025-10-02"));
  ok(w("2025-10-04") === "2025-10-01", "Saturday belongs to the Wednesday behind it", w("2025-10-04"));
  ok(w("2025-10-05") === "2025-10-08", "Sunday to the one ahead", w("2025-10-05"));
  // Month and year boundaries, where naive arithmetic goes wrong.
  ok(w("2025-12-31") === "2025-12-31", "a Wednesday on new year's eve", w("2025-12-31"));
  ok(w("2026-01-01") === "2025-12-31", "and the day after crosses the year", w("2026-01-01"));
  ok(w("2025-11-30") === "2025-12-03", "crossing a month end", w("2025-11-30"));
}

section("the plan merges a split slate and leaves the rest alone");
{
  // Your real shape: 8 players a week, with one person a day early.
  const rows = [HEAD];
  let n = 0;
  const add = (week, user) => rows.push(["p" + (++n), week, user + "@x.com", user,
    "NFL", "g" + n, M, "moneyline", "ml", KC, "", "{}", "win", ""]);

  const users = ["Ann","Bob","Cid","Dee","Eve","Fay","Gil","Hal"];
  for (const u of users) add("Wed Sep 24 2025 00:00:00 GMT-0500 (Central Daylight Time)", u);
  for (const u of users.slice(0, 7)) add("Wed Oct 01 2025 00:00:00 GMT-0500 (Central Daylight Time)", u);
  add("Tue Sep 30 2025 00:00:00 GMT-0500 (Central Daylight Time)", "Hal");   // a day early

  const api = load(rows);
  const msg = api.weekPlanReport();

  ok(/DRY RUN\. Nothing has been changed/.test(msg), "it announces itself as a dry run");
  ok(/MERGE of 2 labels into one slate, 8 player\(s\) total/.test(msg),
     "the split slate merges back to a full field", (msg.match(/\^\^ MERGE[^\n]*/) || [])[0]);
  ok(/2025-26  01  2025-09-24/.test(msg), "the first slate is week 1", (msg.match(/2025-09-24[^\n]*/) || [])[0]);
  ok(/2025-26  02  2025-10-01/.test(msg), "and the merged one is week 2", (msg.match(/2025-10-01[^\n]*/) || [])[0]);

  // Read-only.
  const before = JSON.stringify(rows);
  api.weekPlanReport();
  ok(JSON.stringify(rows) === before, "and wrote nothing");
}

section("applying it needs saying so on purpose");
{
  const rows = [HEAD,
    ["p1", "Tue Sep 30 2025 00:00:00 GMT-0500 (Central Daylight Time)", "a@x.com", "Ann",
     "NFL", "g1", M, "moneyline", "ml", KC, "", "{}", "win", ""]];
  const api = load(rows);

  ok(/^Refusing to run/.test(api.applyWeekNormalization()), "a bare call refuses",
     api.applyWeekNormalization().split("\n")[0]);
  ok(/^Refusing to run/.test(api.applyWeekNormalization(false)), "so does false");
  ok(rows[1][1].indexOf("Tue Sep 30") === 0, "and neither touched the data", rows[1][1].slice(0, 15));

  const done = api.applyWeekNormalization(true);
  ok(/Rewrote the week label on 1 pick/.test(done), "the explicit call applies it", done.split("\n")[0]);
  ok(rows[1][1] === "2025-10-01", "and the label is normalised", rows[1][1]);

  ok(/^Nothing to change/.test(api.applyWeekNormalization(true)), "running again is a no-op");
}

section("an unparseable label is left alone rather than guessed at");
{
  const rows = [HEAD,
    ["p1", "Week 3", "a@x.com", "Ann", "NFL", "g1", M, "moneyline", "ml", KC, "", "{}", "win", ""],
    ["p2", "Wed Oct 01 2025 00:00:00 GMT-0500 (Central Daylight Time)", "b@x.com", "Bob",
     "NFL", "g2", M, "moneyline", "ml", KC, "", "{}", "win", ""]];
  const api = load(rows);
  const msg = api.weekPlanReport();
  ok(/UNPARSED - left exactly as they are/.test(msg), "it is reported, not silently dropped");
  ok(/"Week 3" \(1 pick\(s\)\)/.test(msg), "and named", (msg.match(/"Week 3"[^\n]*/) || [])[0]);

  api.applyWeekNormalization(true);
  ok(rows[1][1] === "Week 3", "and survives the write untouched", rows[1][1]);
  ok(rows[2][1] === "2025-10-01", "while the parseable one is normalised", rows[2][1]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
