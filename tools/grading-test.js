/* Exercises the pure grading logic out of the Apps Script file, in Node.
   Apps Script can't be run locally, but gradePickAgainstResult_, sideOf_ and
   weekWinners_ touch no Google services, so they can be loaded with the
   platform globals stubbed and tested properly.

       node tools/grading-test.js                                          */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "Google App Script Code.gs"), "utf8");

// None of these are called by the functions under test; they only need to
// exist so the file evaluates.
const STUBS = ["PropertiesService", "SpreadsheetApp", "CacheService", "UrlFetchApp",
  "Logger", "LockService", "ScriptApp", "Utilities", "ContentService"];

const G = new Function(
  STUBS.map((s) => `var ${s} = {};`).join("") +
  SRC +
  "return { gradePickAgainstResult_, sideOf_, weekWinners_, parseMeta_, _normName_ };"
)();

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) pass++;
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? " :: got " + detail : "")); }
};
const section = (t) => console.log("\n" + t);

// A finished game: home 27, away 20 -> home wins by 7, total 47.
const GAME = {
  completed: true,
  home_team: "Kansas City Chiefs",
  away_team: "Buffalo Bills",
  homeScore: 27,
  awayScore: 20
};
const grade = (pick, r = GAME) => G.gradePickAgainstResult_(pick, r);
const spread = (team, line) => ({ market: "spread", selection: team, meta: { line } });
const total  = (kind, t)    => ({ market: "total", kind, meta: { total: t } });
const ml     = (team)       => ({ market: "moneyline", selection: team });

const HOME = GAME.home_team, AWAY = GAME.away_team;

// ---------------------------------------------------------------- spreads
section("spreads (home wins 27-20, margin 7)");
ok(grade(spread(HOME, -6.5)) === "win",   "fav -6.5 covers a 7-point win",      grade(spread(HOME, -6.5)));
ok(grade(spread(HOME, -7.5)) === "loss",  "fav -7.5 does not cover by 7",       grade(spread(HOME, -7.5)));
ok(grade(spread(HOME, -7))   === "push",  "fav -7 lands exactly on the number", grade(spread(HOME, -7)));
ok(grade(spread(AWAY, 7.5))  === "win",   "dog +7.5 covers a 7-point loss",     grade(spread(AWAY, 7.5)));
ok(grade(spread(AWAY, 6.5))  === "loss",  "dog +6.5 loses by 7",                grade(spread(AWAY, 6.5)));
ok(grade(spread(AWAY, 7))    === "push",  "dog +7 is a push",                   grade(spread(AWAY, 7)));

// a dog winning outright always covers
ok(grade(spread(AWAY, 3), { ...GAME, homeScore: 20, awayScore: 27 }) === "win",
   "dog +3 winning outright");
// a favourite losing outright never covers
ok(grade(spread(HOME, -3), { ...GAME, homeScore: 20, awayScore: 27 }) === "loss",
   "fav -3 losing outright");
// pick'em
ok(grade(spread(HOME, 0)) === "win",  "pick'em on the winner");
ok(grade(spread(AWAY, 0)) === "loss", "pick'em on the loser");
ok(grade(spread(HOME, 0), { ...GAME, homeScore: 21, awayScore: 21 }) === "push",
   "pick'em on a tied game");

// ---------------------------------------------------------------- totals
section("totals (47 points scored)");
ok(grade(total("over", 45.5))  === "win",  "over 45.5 hits at 47",  grade(total("over", 45.5)));
ok(grade(total("over", 48.5))  === "loss", "over 48.5 misses at 47");
ok(grade(total("under", 48.5)) === "win",  "under 48.5 hits at 47");
ok(grade(total("under", 45.5)) === "loss", "under 45.5 misses at 47");
ok(grade(total("over", 47))    === "push", "over on the exact number is a push");
ok(grade(total("under", 47))   === "push", "under on the exact number is a push");
// totals ignore which team was picked entirely
ok(grade({ market: "total", kind: "over", selection: "nonsense", meta: { total: 45.5 } }) === "win",
   "totals don't consult the selection");

// ---------------------------------------------------------------- moneyline
section("moneyline");
ok(grade(ml(HOME)) === "win",  "picked the winner");
ok(grade(ml(AWAY)) === "loss", "picked the loser");
ok(grade(ml(HOME), { ...GAME, homeScore: 21, awayScore: 21 }) === "push", "a tie is a push");

// ---------------------------------------------------------------- guards
section("refuses to guess");
ok(grade(spread(HOME, -3), { ...GAME, completed: false }) === null, "unfinished game");
ok(grade(spread(HOME, -3), null) === null, "no result at all");
ok(grade(spread(HOME, -3), { ...GAME, homeScore: null }) === null, "missing score");
ok(grade(spread(HOME, -3), { ...GAME, homeScore: "" }) === null, "blank score");
ok(grade({ market: "spread", selection: HOME, meta: {} }) === null, "spread with no line");
ok(grade({ market: "total", kind: "over", meta: {} }) === null, "total with no number");
ok(grade({ market: "spread", selection: "Denver Broncos", meta: { line: -3 } }) === null,
   "a team that isn't in this game");
ok(grade({ market: "parlay", selection: HOME, meta: { line: -3 } }) === null, "unknown market");
// a zero score is real data, not missing data
ok(grade(ml(HOME), { ...GAME, homeScore: 24, awayScore: 0 }) === "win", "0-24 shutout still grades");
ok(grade(total("under", 30), { ...GAME, homeScore: 0, awayScore: 0 }) === "win", "a 0-0 game grades");

// meta arrives from the sheet as a JSON string, not an object
section("meta round-trips through the sheet as a string");
ok(grade({ market: "spread", selection: HOME, meta: JSON.stringify({ line: -6.5 }) }) === "win",
   "stringified spread meta");
ok(grade({ market: "total", kind: "over", meta: JSON.stringify({ total: 45.5 }) }) === "win",
   "stringified total meta");
ok(G.parseMeta_("not json") === null, "unparseable meta is null, not a crash");

// ---------------------------------------------------------------- sideOf_
section("sideOf_");
ok(G.sideOf_(HOME, HOME, AWAY) === "home", "exact home");
ok(G.sideOf_(AWAY, HOME, AWAY) === "away", "exact away");
ok(G.sideOf_("kansas city chiefs", HOME, AWAY) === "home", "case and spacing insensitive");
ok(G.sideOf_("Denver Broncos", HOME, AWAY) === null, "a team in neither slot");
ok(G.sideOf_("", HOME, AWAY) === null, "empty selection");
// exact match must beat substring: plain "Texas" is its own team
ok(G.sideOf_("Texas", "Texas", "Texas A&M") === "home", "exact wins over substring");
ok(G.sideOf_("Texas A&M", "Texas", "Texas A&M") === "away", "the longer name still resolves");
// genuinely ambiguous -> refuse
ok(G.sideOf_("State", "Ohio State", "Penn State") === null, "ambiguous substring refuses");

// ---------------------------------------------------------------- weeks
section("weekly winners");
const wk = (o) => Object.fromEntries(Object.entries(o).map(([u, [w, l, p = 0, pend = 0]]) =>
  [u, { wins: w, losses: l, pushes: p, pending: pend, total: w + l + p + pend }]));

let r = G.weekWinners_(wk({ Johan: [4, 1], Mike: [3, 2], Dave: [2, 3] }));
ok(r.decided && r.winners.join() === "Johan", "most wins takes the week", r.winners.join());

r = G.weekWinners_(wk({ Johan: [3, 2], Mike: [3, 2] }));
ok(r.winners.length === 2, "a genuine tie is shared", r.winners.join());

r = G.weekWinners_(wk({ Johan: [3, 1, 1], Mike: [3, 2] }));
ok(r.winners.join() === "Johan", "fewer losses breaks a tie", r.winners.join());

r = G.weekWinners_(wk({ Johan: [4, 1], Mike: [2, 2, 0, 1] }));
ok(!r.decided && r.winners.length === 0, "a week with anything pending has no winner");

r = G.weekWinners_({});
ok(!r.decided, "an empty week is not decided");

r = G.weekWinners_(wk({ Johan: [0, 5], Mike: [0, 5] }));
ok(r.decided && r.winners.length === 2, "everyone going 0-5 still resolves");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
