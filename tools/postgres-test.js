/* Runs the whole backend against a fake PostgREST, then against a fake Sheet,
   and checks the two produce the same answers.

   The fake implements only what the code actually uses — select with paging
   and ordering, insert, upsert via merge-duplicates, patch and delete with an
   in.() filter — but it enforces the schema's constraints, because the traps
   in this migration are constraint traps: '' is not a valid status, meta must
   arrive as an object rather than a JSON string, and a null score must not
   become zero.

       node tools/postgres-test.js                                         */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "Google App Script Code.gs"), "utf8");

// ------------------------------------------------------------ fake PostgREST
const STATUSES = new Set(["pending", "win", "loss", "push"]);
const ROLES = new Set(["player", "admin"]);

class FakePostgrest {
  constructor() {
    this.tables = { picks: [], results: [], users: [] };
    this.pk = { picks: "id", results: "game_id", users: "email" };
    this.requests = [];
  }

  _check(table, row) {
    if (table === "picks") {
      if (!STATUSES.has(row.status)) throw new Error(`violates check constraint "picks_status_check": "${row.status}"`);
      if (row.meta !== null && typeof row.meta !== "object") {
        throw new Error(`column "meta" is jsonb but got ${typeof row.meta}: ${JSON.stringify(row.meta)}`);
      }
      for (const c of ["id", "week", "email", "user_name", "league", "game_id", "market"]) {
        if (row[c] === null || row[c] === undefined) throw new Error(`null value in column "${c}" violates not-null constraint`);
      }
      if (row.odds !== null && typeof row.odds !== "number") throw new Error(`invalid input syntax for type numeric: "${row.odds}"`);
      // generated columns, exactly as the schema defines them
      const num = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));
      row.line = num(row.meta && row.meta.line);
      row.total = num(row.meta && row.meta.total);
    }
    if (table === "users" && !ROLES.has(row.role)) {
      throw new Error(`violates check constraint "users_role_check": "${row.role}"`);
    }
    if (table === "results") {
      for (const c of ["home_score", "away_score"]) {
        if (row[c] !== null && typeof row[c] !== "number") throw new Error(`invalid input syntax for type integer: "${row[c]}"`);
      }
    }
    return row;
  }

  _parse(qs) {
    const out = { filters: [], limit: null, offset: 0, order: null };
    for (const part of (qs || "").split("&").filter(Boolean)) {
      const eq = part.indexOf("=");
      const k = decodeURIComponent(part.slice(0, eq));
      const v = decodeURIComponent(part.slice(eq + 1));
      if (k === "select") continue;
      else if (k === "limit") out.limit = Number(v);
      else if (k === "offset") out.offset = Number(v);
      else if (k === "order") out.order = v;
      else out.filters.push([k, v]);
    }
    return out;
  }

  _match(rows, filters) {
    return rows.filter((r) =>
      filters.every(([col, expr]) => {
        if (expr.startsWith("in.")) {
          const inner = expr.slice(3).replace(/^\(|\)$/g, "");
          const vals = (inner.match(/"(?:\\.|[^"])*"/g) || [])
            .map((s) => s.slice(1, -1).replace(/\\(.)/g, "$1"));
          return vals.includes(String(r[col]));
        }
        if (expr.startsWith("eq.")) return String(r[col]) === expr.slice(3);
        throw new Error("fake postgrest: unsupported filter " + expr);
      })
    );
  }

  handle(method, url, payload, prefer) {
    const m = url.match(/\/rest\/v1\/([a-z_]+)\??(.*)$/);
    if (!m) throw new Error("fake postgrest: cannot route " + url);
    const [, table, qs] = m;
    if (!this.tables[table]) return { code: 404, body: `{"message":"relation \\"${table}\\" does not exist"}` };

    const q = this._parse(qs);
    this.requests.push({ method, table, filters: q.filters.length, prefer: prefer || null });
    const rows = this.tables[table];
    const pk = this.pk[table];

    try {
      if (method === "get") {
        let sel = this._match(rows, q.filters).slice();
        if (q.order) {
          const keys = q.order.split(",").map((s) => s.split(".")[0]);
          sel.sort((a, b) => {
            for (const k of keys) {
              if (String(a[k]) < String(b[k])) return -1;
              if (String(a[k]) > String(b[k])) return 1;
            }
            return 0;
          });
        }
        if (q.limit !== null) sel = sel.slice(q.offset, q.offset + q.limit);
        return { code: 200, body: JSON.stringify(sel) };
      }

      if (method === "post") {
        const incoming = JSON.parse(payload);
        const upsert = /merge-duplicates/.test(prefer || "");
        for (const raw of incoming) {
          const row = this._check(table, { ...raw });
          const at = rows.findIndex((r) => r[pk] === row[pk]);
          if (at >= 0) {
            if (!upsert) return { code: 409, body: `{"message":"duplicate key value violates unique constraint"}` };
            rows[at] = row;
          } else rows.push(row);
        }
        return { code: 201, body: /return=minimal/.test(prefer || "") ? "" : JSON.stringify(incoming) };
      }

      if (method === "patch") {
        const patch = JSON.parse(payload);
        const hit = this._match(rows, q.filters);
        for (const r of hit) this._check(table, Object.assign(r, patch));
        return { code: 204, body: "" };
      }

      if (method === "delete") {
        const doomed = new Set(this._match(rows, q.filters));
        this.tables[table] = rows.filter((r) => !doomed.has(r));
        return { code: 204, body: "" };
      }
    } catch (e) {
      return { code: 400, body: JSON.stringify({ message: String(e.message) }) };
    }
    return { code: 405, body: "" };
  }
}

// ------------------------------------------------------------- fake Sheets
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

function harness(sheets, props, scores) {
  const store = {};
  for (const [k, v] of Object.entries(sheets)) store[k] = new FakeSheet(k, v);
  const pg = new FakePostgrest();
  const oddsCalls = [];

  const env = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    SpreadsheetApp: { openById: () => ({
      getName: () => "test",
      getSheetByName: (n) => store[n] || null,
      insertSheet: (n) => (store[n] = new FakeSheet(n, []))
    }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        if (url.indexOf("the-odds-api.com") >= 0) {
          oddsCalls.push(url);
          const lg = url.indexOf("americanfootball_nfl") >= 0 ? "NFL" : "NCAAF";
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify((scores || {})[lg] || []), getHeaders: () => ({}) };
        }
        const r = pg.handle((opts.method || "get").toLowerCase(), url, opts.payload,
                            (opts.headers || {}).Prefer);
        return { getResponseCode: () => r.code, getContentText: () => r.body, getHeaders: () => ({}) };
      }
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Logger: { log() {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ScriptApp: {},
    Utilities: {
      getUuid: () => "uuid-" + Math.random().toString(36).slice(2, 8),
      base64Decode: (b64) => Array.from(Buffer.from(b64, "base64")),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") })
    },
    ContentService: {}
  };

  const names = Object.keys(env);
  const api = new Function(...names, SRC + `return {
    migrateSheetsToPostgres, compareBackends, readPicks_, readResults_, readUsers_,
    pgReadPicks_, sheetReadPicks_, getBoard_, runAutoGrade_, runSelfTest,
    submitPicks_, getMyPicks_, isAdminEmail_, storageKind_, checkSetup,
    upsertResults_, setPickStatuses_, gradePick_
  };`)(...names.map((n) => env[n]));

  return { api, pg, store, oddsCalls };
}

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) pass++;
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? " :: " + detail : "")); }
};
const section = (t) => console.log("\n" + t);

const SUPA = { SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_KEY: "svc-key",
               SHEET_ID: "sheet", ODDS_API_KEY: "odds" };
const PG_ON = { ...SUPA, STORAGE: "postgres" };

const HEAD = ['id','week','email','user','league','gameId','matchup',
  'market','kind','selection','odds','meta','status','ts'];
const row = (id, user, gameId, market, kind, sel, meta, status, week = "2025-11-09", odds = "") =>
  [id, week, user.toLowerCase() + "@x.com", user, "NFL", gameId, "Buffalo Bills @ Kansas City Chiefs",
   market, kind, sel, odds, JSON.stringify(meta), status, new Date("2025-11-09T12:00:00Z")];

const KC = "Kansas City Chiefs", BUF = "Buffalo Bills";
const SHEET_PICKS = () => [HEAD,
  row("p1", "Ann", "g1", "spread", "favorite", KC,  { line: -6.5 }, "win"),
  row("p2", "Bob", "g1", "spread", "underdog", BUF, { line:  6.5 }, "loss"),
  row("p3", "Ann", "g1", "total",  "over",     "Over", { total: 45.5 }, ""),      // ungraded: '' not 'pending'
  row("p4", "Bob", "g2", "moneyline", "ml",    KC,  {}, "pending", "2025-11-16", -145)
];
const SHEET_RESULTS = () => [
  ['gameId','league','home_team','away_team','homeScore','awayScore','completed','commence','lastUpdate','fetchedAt'],
  ["g1", "NFL", KC, BUF, 27, 20, "TRUE", "", "", ""],
  ["g2", "NFL", KC, BUF, "", "", "FALSE", "", "", ""]        // no scores yet
];
const SHEET_USERS = () => [["email","role"], ["ann@x.com","Admin"], ["bob@x.com",""]];

const full = (props) => harness(
  { Picks: SHEET_PICKS(), Results: SHEET_RESULTS(), Users: SHEET_USERS() }, props || SUPA);

// ------------------------------------------------------------------- basics
section("the backend switch");
{
  ok(harness({}, {}).api.storageKind_() === "sheets", "unset defaults to sheets");
  ok(harness({}, { STORAGE: "postgres", ...SUPA }).api.storageKind_() === "postgres", "postgres is selectable");
  let threw = "";
  try { harness({}, { STORAGE: "mysql" }).api.storageKind_(); } catch (e) { threw = e.message; }
  ok(/must be "sheets" or "postgres"/.test(threw), "anything else is refused loudly", threw);
}

section("migration copies the Sheet into Postgres");
{
  const { api, pg } = full();
  const msg = api.migrateSheetsToPostgres();
  ok(/picks   : 4 copied/.test(msg), "all four picks copied", msg.split("\n")[0]);
  ok(pg.tables.picks.length === 4, "and they are in the table", pg.tables.picks.length);
  ok(/results : 2 copied/.test(msg), "results copied");
  ok(/users   : 2 copied/.test(msg), "users copied");
}

section("the constraint traps are handled");
{
  const { api, pg } = full();
  api.migrateSheetsToPostgres();

  const p3 = pg.tables.picks.find((p) => p.id === "p3");
  ok(p3.status === "pending", "an ungraded '' becomes pending, not a constraint error", p3.status);

  ok(typeof p3.meta === "object", "meta arrives as jsonb, not a JSON string", typeof p3.meta);
  ok(p3.total === 45.5, "so the generated total column is populated", p3.total);

  const p1 = pg.tables.picks.find((p) => p.id === "p1");
  ok(p1.line === -6.5, "and the generated line column too", p1.line);
  ok(p1.odds === null, "a blank odds becomes null, never 0", p1.odds);

  const p4 = pg.tables.picks.find((p) => p.id === "p4");
  ok(p4.odds === -145, "a real price survives", p4.odds);
  ok(p4.user_name === "Bob", "user maps to user_name (user is reserved)", p4.user_name);

  const ann = pg.tables.users.find((u) => u.email === "ann@x.com");
  ok(ann.role === "admin", '"Admin" is normalised to admin', ann.role);
  const bob = pg.tables.users.find((u) => u.email === "bob@x.com");
  ok(bob.role === "player", "a blank role becomes player", bob.role);

  const g2 = pg.tables.results.find((r) => r.game_id === "g2");
  ok(g2.home_score === null, "an unknown score is null, NOT zero", g2.home_score);
}

section("migration is idempotent");
{
  const { api, pg } = full();
  api.migrateSheetsToPostgres();
  const first = JSON.stringify(pg.tables.picks);
  const msg = api.migrateSheetsToPostgres();
  ok(pg.tables.picks.length === 4, "running twice does not duplicate", pg.tables.picks.length);
  ok(JSON.stringify(pg.tables.picks) === first, "and does not change anything");
  ok(!/ABORTED/.test(msg), "and does not abort");
}

section("migration refuses to merge rows that share an id");
{
  const picks = SHEET_PICKS();
  picks.push(row("p1", "Cid", "g1", "moneyline", "ml", KC, {}, "win"));   // duplicate id
  const { api, pg } = harness({ Picks: picks, Results: SHEET_RESULTS(), Users: SHEET_USERS() }, SUPA);
  const msg = api.migrateSheetsToPostgres();
  ok(/^ABORTED/.test(msg), "it aborts rather than silently losing a pick", msg.split("\n")[0]);
  ok(/p1/.test(msg), "and says which id");
  ok(pg.tables.picks.length === 0, "and writes nothing");
}

section("legacy rows with no id are given one");
{
  const picks = SHEET_PICKS();
  picks.push(row("", "Cid", "g1", "moneyline", "ml", KC, {}, "win"));
  const { api, pg } = harness({ Picks: picks, Results: SHEET_RESULTS(), Users: SHEET_USERS() }, SUPA);
  const msg = api.migrateSheetsToPostgres();
  ok(/1 had no id and were given one/.test(msg), "reported honestly", msg.split("\n")[0]);
  ok(pg.tables.picks.some((p) => p.id === "legacy_6"), "and keyed off the row it came from",
     pg.tables.picks.map((p) => p.id).join());
}

section("a row Postgres rejects is named, not buried in a stack trace");
{
  // A pick the schema will not accept: 'graded' is not one of the four statuses.
  const picks = SHEET_PICKS();
  picks.push(row("bad1", "Cid", "g1", "moneyline", "ml", KC, {}, "graded"));
  const { api, pg } = harness({ Picks: picks, Results: SHEET_RESULTS(), Users: SHEET_USERS() }, SUPA);

  let msg = "", crashed = false;
  try { msg = api.migrateSheetsToPostgres(); } catch (e) { crashed = true; msg = e.message; }

  ok(!crashed, "the migration reports rather than throwing", msg.slice(0, 80));
  ok(/REJECTED — 1 pick/.test(msg), "the bad row is counted", (msg.match(/REJECTED[^\n]*/) || [])[0]);
  ok(/bad1:/.test(msg), "and named by id");
  ok(/picks_status_check/.test(msg), "with the constraint that refused it");
  ok(/picks   : 4 copied/.test(msg), "the other four still went through", (msg.match(/picks +:[^\n]*/) || [])[0]);
  ok(pg.tables.picks.length === 4, "and are really there", pg.tables.picks.length);
}

// -------------------------------------------------------------- comparison
section("compareBackends only passes when they really match");
{
  const { api } = full();
  const before = api.compareBackends();
  ok(/NOT READY/.test(before), "before migrating, it says so", before.split("\n").pop());

  api.migrateSheetsToPostgres();
  const after = api.compareBackends();
  ok(/IDENTICAL/.test(after), "after migrating, it agrees", after.split("\n").slice(-3)[0]);
  ok(/both backends agree on every pick, result and record/.test(after), "on picks, results and records");
}

section("compareBackends notices a real divergence");
{
  const { api, pg } = full();
  api.migrateSheetsToPostgres();

  pg.tables.picks.find((p) => p.id === "p1").status = "loss";
  const msg = api.compareBackends();
  ok(/NOT READY/.test(msg), "a changed status is caught", msg.split("\n").pop());
  ok(/p1\.status: "win" vs "loss"/.test(msg), "and pinpointed", (msg.match(/p1\.status[^\n]*/) || [])[0]);
  ok(/Ann wins: 1 vs 0/.test(msg), "and traced to the scoreboard", (msg.match(/Ann wins[^\n]*/) || [])[0]);
}

section("compareBackends notices a missing row");
{
  const { api, pg } = full();
  api.migrateSheetsToPostgres();
  pg.tables.picks = pg.tables.picks.filter((p) => p.id !== "p4");
  const msg = api.compareBackends();
  ok(/NOT READY/.test(msg), "a dropped pick is caught");
  ok(/1 pick\(s\) missing from Postgres/.test(msg), "and counted");
}

// ------------------------------------------------- the app on the new backend
section("the app behaves identically on postgres");
{
  const sheetsRun = full({ ...SUPA });
  sheetsRun.api.migrateSheetsToPostgres();
  const sheetBoard = JSON.stringify(sheetsRun.api.getBoard_());

  const pgRun = full(PG_ON);
  // migrate reads the Sheet and writes Postgres regardless of the switch
  pgRun.api.migrateSheetsToPostgres();
  const pgBoard = JSON.stringify(pgRun.api.getBoard_());

  ok(sheetBoard === pgBoard, "the scoreboard is byte-identical either way",
     sheetBoard === pgBoard ? "" : sheetBoard + "\n vs \n" + pgBoard);

  ok(pgRun.api.isAdminEmail_("ann@x.com") === true, "admin lookup works on postgres");
  ok(pgRun.api.isAdminEmail_("bob@x.com") === false, "and non-admins are not admins");

  const mine = pgRun.api.getMyPicks_("ann@x.com");
  ok(mine.length === 2, "my picks reads back", mine.length);
  ok(mine.some((p) => p.line === -6.5), "with the line extracted for display",
     JSON.stringify(mine.map((p) => p.line)));
}

section("grading works on postgres");
{
  const { api, pg } = full(PG_ON);
  api.migrateSheetsToPostgres();

  // p3 is the only pending pick with a completed result behind it.
  const out = api.runAutoGrade_({ noFetch: true });
  ok(out.graded === 1, "the pending pick is graded", JSON.stringify(out));
  ok(out.creditsUsed === 0, "and no credits spent");
  ok(pg.tables.picks.find((p) => p.id === "p3").status === "win",
     "27+20=47 is over 45.5", pg.tables.picks.find((p) => p.id === "p3").status);
  ok(pg.tables.picks.find((p) => p.id === "p4").status === "pending",
     "the unfinished game stays pending");

  // The graded ones must be untouched.
  ok(pg.tables.picks.find((p) => p.id === "p1").status === "win", "an existing grade is not disturbed");
}

section("status updates are grouped, not one request per pick");
{
  const { api, pg } = full(PG_ON);
  api.migrateSheetsToPostgres();
  pg.requests.length = 0;

  api.setPickStatuses_([
    { _key: "p1", status: "win" },  { _key: "p2", status: "win" },
    { _key: "p3", status: "loss" }, { _key: "p4", status: "win" }
  ]);
  const patches = pg.requests.filter((r) => r.method === "patch");
  ok(patches.length === 2, "three wins and one loss is two requests, not four", patches.length);
  ok(pg.tables.picks.filter((p) => p.status === "win").length === 3, "and all of them landed");
}

section("the self test passes on postgres and cleans up after itself");
{
  const { api, pg } = full(PG_ON);
  api.migrateSheetsToPostgres();
  const before = pg.tables.picks.length;

  const msg = api.runSelfTest();
  ok(/^SELF TEST PASSED/.test(msg), "grading is correct on the new backend", msg.split("\n")[0]);
  ok(pg.tables.picks.length === before, "no self-test rows left behind", pg.tables.picks.length - before);
  ok(!pg.tables.results.some((r) => String(r.game_id).indexOf("__selftest_") === 0),
     "and no self-test results either");
}

section("submitting picks works on postgres");
{
  const { api, pg } = full(PG_ON);
  api.migrateSheetsToPostgres();

  const res = api.submitPicks_("cid@x.com", "Cid", [
    { week: "2025-11-23", league: "NFL", gameId: "g9", matchup: "A @ B",
      market: "spread", kind: "favorite", selection: KC, odds: -110, meta: { line: -3 } }
  ]);
  ok(res.count === 1, "the pick is stored", JSON.stringify(res));
  const stored = pg.tables.picks.find((p) => p.user_name === "Cid");
  ok(stored.status === "pending", "as pending", stored && stored.status);
  ok(stored.line === -3, "with the generated line column filled in", stored && stored.line);

  // resubmitting replaces rather than duplicating
  api.submitPicks_("cid@x.com", "Cid", [
    { week: "2025-11-23", league: "NFL", gameId: "g9", matchup: "A @ B",
      market: "spread", kind: "underdog", selection: BUF, odds: -110, meta: { line: 3 } }
  ]);
  ok(pg.tables.picks.filter((p) => p.user_name === "Cid").length === 1,
     "resubmitting replaces, it does not duplicate",
     pg.tables.picks.filter((p) => p.user_name === "Cid").length);
}

section("paging past PostgREST's response cap");
{
  const { api, pg } = full(PG_ON);
  // 2500 rows is three pages at the 1000 cap.
  for (let i = 0; i < 2500; i++) {
    pg.tables.picks.push({
      id: "big" + String(i).padStart(5, "0"), week: "2025-01-01", email: "a@x.com",
      user_name: "Ann", league: "NFL", game_id: "g" + i, matchup: "A @ B",
      market: "spread", kind: "favorite", selection: KC, odds: null,
      meta: {}, status: "pending", created_at: "2025-01-01T00:00:00Z", line: null, total: null
    });
  }
  const got = api.pgReadPicks_();
  ok(got.length === 2500, "every row comes back, not just the first page", got.length);
  const ids = new Set(got.map((p) => p.id));
  ok(ids.size === 2500, "with no duplicates from the offset scan", ids.size);
}

section("errors are loud, not silently empty");
{
  const { api, pg } = full(PG_ON);
  delete pg.tables.picks;                       // table not exposed to the API
  let threw = "";
  try { api.pgReadPicks_(); } catch (e) { threw = e.message; }
  ok(/404/.test(threw), "a 404 throws rather than reading as an empty league", threw.slice(0, 60));
  ok(/not exposed to the API/.test(threw), "with the hint that it is usually privileges");
}

section("checkSetup reports both backends without printing secrets");
{
  const { api } = full(PG_ON);
  const msg = api.checkSetup();
  ok(/SUPABASE_SERVICE_KEY *: set \(7 chars\)/.test(msg), "the key is described, never shown", (msg.match(/SUPABASE_SERVICE_KEY[^\n]*/) || [])[0]);
  ok(msg.indexOf("svc-key") < 0, "the key itself appears nowhere in the output");
  ok(/SUPABASE_URL *: https:\/\/test\.supabase\.co/.test(msg), "the URL is shown, since it is not a secret");
  ok(/STORAGE *: postgres/.test(msg), "the live backend is stated");
  ok(/Postgres  : reachable/.test(msg), "and it is actually contacted");
}

section("checkSetup tells the publishable key from the secret one");
{
  // These are the same length and shape. The only symptom otherwise is a 401
  // from PostgREST saying "permission denied ... GRANT SELECT TO anon", which
  // arrives several steps and one confusing warning banner later.
  const jwt = (role) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return b64({ alg: "HS256" }) + "." + b64({ iss: "supabase", role: role }) + ".sig";
  };

  const pub = harness({}, { ...PG_ON, SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
                            SUPABASE_SERVICE_KEY: "sb_publishable_" + "x".repeat(31) }).api.checkSetup();
  ok(/that is the PUBLISHABLE key/.test(pub), "the new-style publishable key is named",
     (pub.match(/\^\^ WRONG VALUE[^\n]*/) || [])[0]);
  ok(/RLS is on with no policies/.test(pub), "and why it cannot possibly work");
  ok(/Supabase warns you/.test(pub), "and that the scary warning on the right key is expected");

  const anon = harness({}, { ...PG_ON, SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
                             SUPABASE_SERVICE_KEY: jwt("anon") }).api.checkSetup();
  ok(/that is the anon key/.test(anon), "the legacy anon JWT is caught by its role claim",
     (anon.match(/\^\^ WRONG VALUE[^\n]*/) || [])[0]);

  const svc = harness({}, { ...PG_ON, SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
                            SUPABASE_SERVICE_KEY: jwt("service_role") }).api.checkSetup();
  ok(!/WRONG VALUE/.test(svc), "the right JWT passes silently",
     (svc.match(/\^\^[^\n]*/) || [])[0]);

  const secret = harness({}, { ...PG_ON, SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
                               SUPABASE_SERVICE_KEY: "sb_secret_" + "x".repeat(36) }).api.checkSetup();
  ok(!/WRONG VALUE/.test(secret), "and so does the new-style secret key",
     (secret.match(/\^\^[^\n]*/) || [])[0]);
}

section("checkSetup stops nagging about a Sheet no longer in use");
{
  // Migration finished, SHEET_ID deleted: the Sheet is not a fault any more.
  const done = { SUPABASE_URL: SUPA.SUPABASE_URL, SUPABASE_SERVICE_KEY: "x".repeat(64),
                 ODDS_API_KEY: "odds", STORAGE: "postgres" };
  const msg = harness({}, done).api.checkSetup();
  ok(/Sheet     : not in use \(STORAGE is postgres\)/.test(msg),
     "it says so plainly", (msg.match(/Sheet[^\n]*/) || [])[0]);
  ok(!/Sheet     : FAILED/.test(msg), "rather than reporting a failure");

  // But while still on sheets, a missing SHEET_ID is very much a fault.
  const notDone = { ...done, STORAGE: "sheets" };
  const msg2 = harness({}, notDone).api.checkSetup();
  ok(/Sheet     : FAILED/.test(msg2), "on the sheets backend it is still a fault",
     (msg2.match(/Sheet[^\n]*/) || [])[0]);

  // An empty sheet is worth flagging before anyone runs a migration on it.
  const empty = harness({ Picks: [], Results: [], Users: [] },
                        { ...SUPA, SUPABASE_SERVICE_KEY: "x".repeat(64),
                          SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd" }).api.checkSetup();
  ok(/0 pick row\(s\)  — empty, so there is nothing to migrate/.test(empty),
     "an empty sheet says there is nothing to migrate", (empty.match(/Sheet[^\n]*/) || [])[0]);
}

section("checkSetup names a property holding the wrong kind of value");
{
  // The real mistake this exists for: the whole Sheets URL pasted into
  // SHEET_ID, which surfaces from SpreadsheetApp as "Illegal spreadsheet id or
  // key" — accurate, but it names neither the property nor a right answer.
  const bad = {
    ...PG_ON,
    SUPABASE_SERVICE_KEY: "x".repeat(64),      // valid, so SHEET_ID is the only fault
    SHEET_ID: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit#gid=0"
  };
  const msg = harness({}, bad).api.checkSetup();
  ok(/SHEET_ID[^\n]*\n\s+\^\^ WRONG VALUE/.test(msg), "the bad one is flagged where it sits",
     (msg.match(/\^\^ WRONG VALUE[^\n]*/) || [])[0]);
  ok(/between \/d\/ and \/edit/.test(msg), "and says what a right answer looks like");
  ok(/1 property has the wrong kind of value/.test(msg), "and it is counted at the end");

  // A correct set raises nothing.
  const good = { ...PG_ON, SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
                 SUPABASE_SERVICE_KEY: "x".repeat(64) };
  const clean = harness({}, good).api.checkSetup();
  ok(!/WRONG VALUE/.test(clean), "correct values are not nagged about",
     (clean.match(/\^\^[^\n]*/) || [])[0]);

  // Keys and URLs swapped round is the other easy slip.
  const swapped = { ...PG_ON, SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
                    SUPABASE_URL: "eyJhbGciOiJI-not-a-url",
                    SUPABASE_SERVICE_KEY: "https://glvmnlnqvugkebdeqvxh.supabase.co" };
  const sw = harness({}, swapped).api.checkSetup();
  ok(/2 propert/.test(sw) || /2 property/.test(sw), "both halves of a swap are caught",
     (sw.match(/\d+ propert[^\n]*/) || [])[0]);
  ok(/that is a URL, not a key/.test(sw), "the key says it is a URL");
  ok(/expected the Project URL/.test(sw), "the URL says what it wanted");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
