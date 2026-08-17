// ====== Picks Game — Google Apps Script backend (Sheets + The Odds API) ======
//
// SETUP — no secrets live in this file, so it's safe in a public repo.
// In the Apps Script editor: Project Settings > Script Properties > Add,
// and create these two:
//
//   ODDS_API_KEY   your key from https://the-odds-api.com/
//   SHEET_ID       the id in your Sheet's URL, between /d/ and /edit
//
// Then run checkSetup() from the editor to confirm both are readable.

const BOOKMAKERS    = 'fanduel,draftkings,betmgm';
const CACHE_TTL_SEC = 120 * 60; // 120 minutes as only 500 api req are free a month

// Derived: preference order array for bookmaker picking
const BOOKMAKER_PREFS = BOOKMAKERS.split(',').map(s => s.trim()).filter(Boolean);

// ===== SECRETS ===============================================================
function props_() { return PropertiesService.getScriptProperties(); }

function requireProp_(key) {
  const v = props_().getProperty(key);
  if (!v) {
    throw new Error(
      'Missing Script Property "' + key + '". Apps Script editor > ' +
      'Project Settings > Script Properties > Add script property.'
    );
  }
  return v;
}

function oddsApiKey_() { return requireProp_('ODDS_API_KEY'); }
function sheetId_()    { return requireProp_('SHEET_ID'); }

/** Run this from the editor after setup. Never prints the secrets themselves. */
/**
 * Catch a property whose value is the wrong *kind* of thing.
 *
 * These all live in one list in one settings page, and pasting the web app URL
 * into SHEET_ID produces "Illegal spreadsheet id or key" from deep inside
 * SpreadsheetApp — accurate, but it names neither the property nor what a
 * right answer looks like.
 */
/**
 * The `role` claim out of a Supabase JWT, or null if it isn't one.
 *
 * Legacy Supabase keys are JWTs whose payload says which role they act as, and
 * anon and service_role look identical from the outside. Reading the claim is
 * the only way to tell them apart without making a request.
 */
function jwtRole_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const b64  = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad  = b64 + '==='.slice((b64.length + 3) % 4);
    const json = Utilities.newBlob(Utilities.base64Decode(pad)).getDataAsString();
    const m = json.match(/"role"\s*:\s*"([a-z_]+)"/);
    return m ? m[1] : null;
  } catch (_) {
    return null;   // not decodable is not a verdict
  }
}

function propWarning_(key, v) {
  if (!v) return null;
  const looksLikeUrl = /^https?:\/\//i.test(v);

  if (key === 'SHEET_ID') {
    if (looksLikeUrl || v.indexOf('/') >= 0) {
      return 'that is a URL. SHEET_ID is only the middle of the Sheet\'s address - '
        + 'the part between /d/ and /edit, around 44 characters, no slashes.';
    }
    if (v.length < 20) return 'too short for a Sheet ID (expect around 44 characters).';
  }
  if (key === 'SUPABASE_URL') {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(v)) {
      return 'expected the Project URL, like https://abcdefgh.supabase.co '
        + '(Supabase > Settings > API).';
    }
  }
  if (key === 'SUPABASE_SERVICE_KEY') {
    if (looksLikeUrl) return 'that is a URL, not a key.';
    // The publishable key is the same length and shape as the secret one, so
    // the only symptom is a 401 from PostgREST several steps later saying
    // "permission denied ... GRANT SELECT TO anon". Name it here instead.
    if (v.indexOf('sb_publishable_') === 0) {
      return 'that is the PUBLISHABLE key. RLS is on with no policies, so it can '
        + 'read nothing. Use the secret key (sb_secret_...) - Supabase warns you '
        + 'when revealing it, which is expected: it only ever lives here.';
    }
    if (jwtRole_(v) === 'anon') {
      return 'that is the anon key. RLS is on with no policies, so it can read '
        + 'nothing. Use the service_role key.';
    }
    if (v.length < 40) return 'too short for a service_role key.';
  }
  if (key === 'ODDS_API_KEY' && looksLikeUrl) return 'that is a URL, not a key.';
  return null;
}

function checkSetup() {
  const out = [];
  let bad = 0;
  for (const k of ['ODDS_API_KEY', 'SHEET_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
    const v = props_().getProperty(k);
    // The URL is not a secret and is worth seeing; the keys are, so only their
    // length is ever printed.
    const shown = !v ? 'MISSING'
      : (k === 'SUPABASE_URL' ? v : 'set (' + v.length + ' chars)');
    out.push(k.padEnd(21) + ': ' + shown);
    const warn = propWarning_(k, v);
    if (warn) { out.push(''.padEnd(21) + '  ^^ WRONG VALUE - ' + warn); bad++; }
  }

  let kind = '(invalid)';
  try { kind = storageKind_(); } catch (e) { kind = e.message; }
  out.push('STORAGE'.padEnd(21) + ': ' + kind + (props_().getProperty('STORAGE') ? '' : '  (unset, defaulting to sheets)'));

  out.push('');
  // Once STORAGE is postgres nothing reads the Sheet, so a missing SHEET_ID is
  // a finished migration rather than a fault. Reporting it as FAILED would
  // train you to ignore the line that matters.
  const sheetInUse = !usingPostgresSafe_() || !!props_().getProperty('SHEET_ID');
  if (!sheetInUse) {
    out.push('Sheet     : not in use (STORAGE is postgres)');
  } else {
    try {
      const ss = SpreadsheetApp.openById(sheetId_());
      const n = sheetReadPicks_().length;
      out.push('Sheet     : opens OK, "' + ss.getName() + '", ' + n + ' pick row(s)'
        + (n === 0 ? '  - empty, so there is nothing to migrate' : ''));
    } catch (e) {
      out.push('Sheet     : FAILED - ' + e.message);
    }
  }

  if (props_().getProperty('SUPABASE_URL')) {
    try {
      // head=true asks PostgREST for a count without shipping any rows.
      const n = pgFetch_('get', 'picks?select=id&limit=1');
      out.push('Postgres  : reachable, picks table readable'
        + (n && n.length ? '' : ' (currently empty)'));
    } catch (e) {
      out.push('Postgres  : FAILED - ' + e.message);
    }
  } else {
    out.push('Postgres  : not configured');
  }

  if (bad) {
    out.push('');
    out.push(bad === 1
      ? '1 property has the wrong kind of value in it - fix that before anything'
      : bad + ' properties have the wrong kind of value in them - fix those before anything');
    out.push('else. Project Settings > Script Properties.');
  }

  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ===== STORAGE ===============================================================
// Every read and write of pick, result and user data goes through this section
// and nothing outside it knows what a spreadsheet row is. That is the whole
// point: swapping Sheets for Postgres means reimplementing the dozen functions
// below and touching nothing else.
//
// Rows are identified by an opaque `_key`. Here it happens to be the sheet row
// number; on Postgres it will be the primary key. Callers must treat it as
// meaningless and only ever hand it back.

const PICKS_SHEET   = 'Picks';
const PICKS_HEADERS = [
  'id','week','email','user','league','gameId','matchup',
  'market','kind','selection','odds','meta','status','ts'
];

const RESULTS_SHEET   = 'Results';
const RESULTS_HEADERS = [
  'gameId','league','home_team','away_team','homeScore','awayScore',
  'completed','commence','lastUpdate','fetchedAt'
];

const USERS_SHEET = 'Users';

// ---------------------------------------------------------------- dispatch
// Which backend is live. Default 'sheets' so an unset property cannot silently
// point a working league at an empty database. Flipping this property is the
// entire cutover, and flipping it back is the entire rollback.
function storageKind_() {
  const v = String(props_().getProperty('STORAGE') || 'sheets').trim().toLowerCase();
  if (v !== 'sheets' && v !== 'postgres') {
    throw new Error('Script Property STORAGE must be "sheets" or "postgres", not "' + v + '".');
  }
  return v;
}

function usingPostgres_() { return storageKind_() === 'postgres'; }

/** For diagnostics only: never throws, so checkSetup can report a bad STORAGE
    value rather than dying before it prints anything useful. */
function usingPostgresSafe_() {
  try { return usingPostgres_(); } catch (_) { return false; }
}

function readPicks_()               { return usingPostgres_() ? pgReadPicks_()               : sheetReadPicks_(); }
function setPickStatuses_(updates)  { if (!updates || !updates.length) return 0;
                                      return usingPostgres_() ? pgSetPickStatuses_(updates)  : sheetSetPickStatuses_(updates); }
function insertPicks_(picks)        { if (!picks || !picks.length) return 0;
                                      return usingPostgres_() ? pgInsertPicks_(picks)        : sheetInsertPicks_(picks); }
function deletePickKeys_(keys)      { if (!keys || !keys.length) return 0;
                                      return usingPostgres_() ? pgDeletePickKeys_(keys)      : sheetDeletePickKeys_(keys); }
function readResults_()             { return usingPostgres_() ? pgReadResults_()             : sheetReadResults_(); }
function upsertResults_(rows)       { if (!rows || !rows.length) return 0;
                                      return usingPostgres_() ? pgUpsertResults_(rows)       : sheetUpsertResults_(rows); }
function deleteResultIds_(ids)      { if (!ids || !ids.length) return 0;
                                      return usingPostgres_() ? pgDeleteResultIds_(ids)      : sheetDeleteResultIds_(ids); }
function readUsers_()               { return usingPostgres_() ? pgReadUsers_()               : sheetReadUsers_(); }

// ---------------------------------------------------------------- sheets

/**
 * One sheet row as a pick object. `meta` and `odds` are deliberately left
 * exactly as stored rather than coerced — parseMeta_ already copes with both a
 * JSON string and a real object, so a Postgres jsonb column will drop straight
 * in here without the grader noticing.
 */
function pickFromRow_(row, H, key) {
  return {
    _key:      key,
    id:        String(row[H.id] || ''),
    week:      String(row[H.week] || ''),
    email:     String(row[H.email] || ''),
    user:      String(row[H.user] || ''),
    league:    String(row[H.league] || ''),
    gameId:    String(row[H.gameId] || ''),
    matchup:   String(row[H.matchup] || ''),
    market:    String(row[H.market] || ''),
    kind:      String(row[H.kind] || ''),
    selection: String(row[H.selection] || ''),
    odds:      row[H.odds],
    meta:      row[H.meta],
    status:    String(row[H.status] || '').toLowerCase(),
    ts:        row[H.ts]
  };
}

/** Every pick, in sheet order. Blank trailing rows come back too; callers
    filter on what they care about, exactly as they did when they read the
    grid themselves. */
function sheetReadPicks_() {
  const sh = openSheet_(PICKS_SHEET);
  ensureHeaders_(sh, PICKS_HEADERS);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  const H = headerIndex_(data[0]);
  const out = [];
  for (let i = 1; i < data.length; i++) out.push(pickFromRow_(data[i], H, i + 1));
  return out;
}

/**
 * Apply status changes. updates: [{ _key, status }].
 *
 * Written as one setValues over the whole status column rather than a call per
 * cell — a Sunday with forty pending picks would otherwise be forty round
 * trips to Sheets, which is slow enough to hit the script time limit.
 */
function sheetSetPickStatuses_(updates) {
  if (!updates || !updates.length) return 0;
  const sh = openSheet_(PICKS_SHEET);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return 0;
  const H = headerIndex_(data[0]);
  const col = sh.getRange(2, H.status + 1, data.length - 1, 1).getValues();
  let n = 0;
  for (const u of updates) {
    const ix = u._key - 2;
    if (ix < 0 || ix >= col.length) continue;
    col[ix][0] = u.status;
    n++;
  }
  if (n) sh.getRange(2, H.status + 1, col.length, 1).setValues(col);
  return n;
}

/** Append picks. Objects in, not rows. */
function sheetInsertPicks_(picks) {
  if (!picks || !picks.length) return 0;
  const sh = openSheet_(PICKS_SHEET);
  ensureHeaders_(sh, PICKS_HEADERS);
  const rows = picks.map(function (p) {
    return [
      p.id, p.week, p.email, p.user, p.league, p.gameId, p.matchup,
      p.market, p.kind, p.selection, p.odds, p.meta, p.status, p.ts
    ];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, PICKS_HEADERS.length).setValues(rows);
  return rows.length;
}

/** Delete picks by key. Bottom-up, so the earlier row numbers stay valid. */
function sheetDeletePickKeys_(keys) {
  if (!keys || !keys.length) return 0;
  const sh = openSheet_(PICKS_SHEET);
  const sorted = keys.slice().sort(function (a, b) { return b - a; });
  for (const k of sorted) sh.deleteRow(k);
  return sorted.length;
}

/** Cached results keyed by gameId. */
function sheetReadResults_() {
  const sh = openSheet_(RESULTS_SHEET);
  ensureHeaders_(sh, RESULTS_HEADERS);
  const data = sh.getDataRange().getValues();
  const out = {};
  if (data.length < 2) return out;
  const H = headerIndex_(data[0]);
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][H.gameId] || '');
    if (!id) continue;
    out[id] = {
      _key:       i + 1,
      gameId:     id,
      league:     String(data[i][H.league] || ''),
      home_team:  String(data[i][H.home_team] || ''),
      away_team:  String(data[i][H.away_team] || ''),
      homeScore:  data[i][H.homeScore],
      awayScore:  data[i][H.awayScore],
      completed:  String(data[i][H.completed]).toLowerCase() === 'true'
    };
  }
  return out;
}

/** Insert or update cached results. */
function sheetUpsertResults_(rows) {
  if (!rows || !rows.length) return 0;
  const sh = openSheet_(RESULTS_SHEET);
  ensureHeaders_(sh, RESULTS_HEADERS);
  const existing = sheetReadResults_();
  const now = new Date();
  const appends = [];
  for (const r of rows) {
    const values = [
      r.gameId, r.league, r.home_team, r.away_team,
      r.homeScore, r.awayScore, r.completed ? 'TRUE' : 'FALSE',
      r.commence || '', r.lastUpdate || '', now
    ];
    const prev = existing[r.gameId];
    if (prev) sh.getRange(prev._key, 1, 1, RESULTS_HEADERS.length).setValues([values]);
    else appends.push(values);
  }
  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, RESULTS_HEADERS.length)
      .setValues(appends);
  }
  return rows.length;
}

/** Delete cached results by gameId. */
function sheetDeleteResultIds_(ids) {
  if (!ids || !ids.length) return 0;
  const want = {};
  for (const id of ids) want[id] = true;
  const sh = openSheet_(RESULTS_SHEET);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return 0;
  const H = headerIndex_(data[0]);
  let n = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (want[String(data[i][H.gameId] || '')]) { sh.deleteRow(i + 1); n++; }
  }
  return n;
}

/** [{ email, role }]. */
function sheetReadUsers_() {
  const sh = openSheet_(USERS_SHEET);
  const data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return [];
  const H = headerIndex_(data[0]);
  if (H.email === undefined || H.role === undefined) return [];
  const out = [];
  for (let i = 1; i < data.length; i++) {
    out.push({
      email: String(data[i][H.email] || '').trim().toLowerCase(),
      role:  String(data[i][H.role]  || '').trim().toLowerCase()
    });
  }
  return out;
}

// ===== POSTGRES (Supabase / PostgREST) =======================================
// The other implementation of the interface above. The browser never reaches
// this — it talks to Apps Script, which holds the service key — so the key
// lives only in Script Properties and RLS can stay closed to everyone else.

const PG_PAGE     = 1000;   // PostgREST caps a response; page past it
const PG_CHUNK    = 500;    // rows per insert request
const PG_ID_CHUNK = 200;    // ids per in.() filter, to keep URLs sane

function pgUrl_()  { return requireProp_('SUPABASE_URL').replace(/\/+$/, ''); }
function pgKey_()  { return requireProp_('SUPABASE_SERVICE_KEY'); }

/**
 * One PostgREST request. Throws with the body on any non-2xx, because a
 * silent failure here would look exactly like an empty database.
 */
function pgFetch_(method, path, body, prefer) {
  const key = pgKey_();
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json'
  };
  if (prefer) headers['Prefer'] = prefer;

  const opts = { method: method, headers: headers, muteHttpExceptions: true };
  if (body !== undefined && body !== null) opts.payload = JSON.stringify(body);

  const res  = UrlFetchApp.fetch(pgUrl_() + '/rest/v1/' + path, opts);
  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code < 200 || code >= 300) {
    // A 404 on a table that exists almost always means privileges, not a typo.
    const hint = code === 404
      ? ' (a 404 here usually means the table is not exposed to the API - re-run db/schema.sql, which grants service_role explicitly)'
      : '';
    throw new Error('Supabase ' + method.toUpperCase() + ' ' + path + ' -> ' + code + ': ' + text.slice(0, 300) + hint);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

/** GET everything, a page at a time. An unordered offset scan can repeat or
    skip rows, so the order is always pinned. */
function pgSelectAll_(table, orderBy, filter) {
  let out = [], offset = 0;
  for (;;) {
    const q = table + '?select=*&order=' + orderBy
      + (filter ? '&' + filter : '')
      + '&limit=' + PG_PAGE + '&offset=' + offset;
    const page = pgFetch_('get', q) || [];
    out = out.concat(page);
    if (page.length < PG_PAGE) return out;
    offset += PG_PAGE;
    if (offset > 200000) throw new Error('refusing to page past 200k rows from ' + table);
  }
}

/** value list for a PostgREST in.() filter. */
function pgInList_(values) {
  return '(' + values.map(function (v) {
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }).join(',') + ')';
}

function pgChunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------- conversion
// The sheet's column names and Postgres's differ in three ways: camelCase vs
// snake_case, `user` is reserved so the column is user_name, and blanks mean
// null rather than empty string.

/** '' -> null, so a numeric column never receives an empty string. */
function pgNum_(v) {
  const n = num_(v);
  return isFinite(n) ? n : null;
}

function pgText_(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return s === '' ? null : s;
}

/** A Date, a sheet serial or an ISO string -> ISO string, or null. */
function pgTime_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function pickToPg_(p) {
  return {
    id:        p.id,
    week:      String(p.week || ''),
    email:     String(p.email || ''),
    user_name: String(p.user || ''),
    league:    String(p.league || ''),
    game_id:   String(p.gameId || ''),
    matchup:   pgText_(p.matchup),
    market:    String(p.market || ''),
    kind:      pgText_(p.kind),
    selection: pgText_(p.selection),
    odds:      pgNum_(p.odds),
    // meta arrives as a JSON *string* from the sheet path. jsonb wants the
    // object, or it would store a quoted string and meta.line would vanish.
    meta:      parseMeta_(p.meta) || {},
    // An ungraded pick is '' in the sheet but the column is constrained.
    status:    (String(p.status || '').toLowerCase() || 'pending'),
    created_at: pgTime_(p.ts) || new Date().toISOString()
  };
}

function pickFromPg_(r) {
  return {
    _key:      r.id,
    id:        String(r.id || ''),
    week:      String(r.week || ''),
    email:     String(r.email || ''),
    user:      String(r.user_name || ''),
    league:    String(r.league || ''),
    gameId:    String(r.game_id || ''),
    matchup:   String(r.matchup || ''),
    market:    String(r.market || ''),
    kind:      String(r.kind || ''),
    selection: String(r.selection || ''),
    odds:      r.odds === null || r.odds === undefined ? '' : r.odds,
    meta:      r.meta || {},
    status:    String(r.status || '').toLowerCase(),
    ts:        r.created_at ? new Date(r.created_at) : ''
  };
}

function resultToPg_(r) {
  return {
    game_id:     String(r.gameId || ''),
    league:      String(r.league || ''),
    home_team:   String(r.home_team || ''),
    away_team:   String(r.away_team || ''),
    home_score:  pgNum_(r.homeScore),
    away_score:  pgNum_(r.awayScore),
    completed:   !!r.completed,
    commence:    pgTime_(r.commence),
    last_update: pgTime_(r.lastUpdate),
    fetched_at:  new Date().toISOString()
  };
}

function resultFromPg_(r) {
  return {
    _key:      r.game_id,
    gameId:    String(r.game_id || ''),
    league:    String(r.league || ''),
    home_team: String(r.home_team || ''),
    away_team: String(r.away_team || ''),
    // null must stay null, not become 0 — the grader refuses on a blank score
    // and would otherwise call an unplayed game nil-nil.
    homeScore: r.home_score === null || r.home_score === undefined ? '' : r.home_score,
    awayScore: r.away_score === null || r.away_score === undefined ? '' : r.away_score,
    completed: !!r.completed
  };
}

// ---------------------------------------------------------------- picks
function pgReadPicks_() {
  return pgSelectAll_('picks', 'created_at.asc,id.asc').map(pickFromPg_);
}

/** PostgREST cannot set different values across rows in one request, but it
    can set one value across many. Grouping by verdict means at most three
    calls however big the Sunday. */
function pgSetPickStatuses_(updates) {
  const byStatus = {};
  for (const u of updates) (byStatus[u.status] = byStatus[u.status] || []).push(u._key);

  let n = 0;
  for (const status of Object.keys(byStatus)) {
    for (const ids of pgChunk_(byStatus[status], PG_ID_CHUNK)) {
      pgFetch_('patch', 'picks?id=in.' + encodeURIComponent(pgInList_(ids)),
               { status: status });
      n += ids.length;
    }
  }
  return n;
}

function pgInsertPicks_(picks) {
  let n = 0;
  for (const batch of pgChunk_(picks.map(pickToPg_), PG_CHUNK)) {
    pgFetch_('post', 'picks', batch, 'return=minimal');
    n += batch.length;
  }
  return n;
}

function pgDeletePickKeys_(keys) {
  let n = 0;
  for (const ids of pgChunk_(keys, PG_ID_CHUNK)) {
    pgFetch_('delete', 'picks?id=in.' + encodeURIComponent(pgInList_(ids)));
    n += ids.length;
  }
  return n;
}

// ---------------------------------------------------------------- results
function pgReadResults_() {
  const out = {};
  for (const row of pgSelectAll_('results', 'game_id.asc')) {
    const r = resultFromPg_(row);
    out[r.gameId] = r;
  }
  return out;
}

/** merge-duplicates makes this an upsert on the primary key, so a re-fetched
    game updates in place instead of erroring. */
function pgUpsertResults_(rows) {
  let n = 0;
  for (const batch of pgChunk_(rows.map(resultToPg_), PG_CHUNK)) {
    pgFetch_('post', 'results', batch, 'resolution=merge-duplicates,return=minimal');
    n += batch.length;
  }
  return n;
}

function pgDeleteResultIds_(ids) {
  let n = 0;
  for (const batch of pgChunk_(ids, PG_ID_CHUNK)) {
    pgFetch_('delete', 'results?game_id=in.' + encodeURIComponent(pgInList_(batch)));
    n += batch.length;
  }
  return n;
}

// ---------------------------------------------------------------- users
function pgReadUsers_() {
  return pgSelectAll_('users', 'email.asc').map(function (u) {
    return {
      email: String(u.email || '').trim().toLowerCase(),
      role:  String(u.role  || '').trim().toLowerCase()
    };
  });
}

// ===== HTTP HANDLERS =========================================================
// GET: odds (league=nfl|ncaaf[,nocache=1]), mine (email), board, isAdmin (email)
const GET_FNS = ['odds', 'mine', 'board', 'weeks', 'week', 'isAdmin'];

function doGet(e) {
  e = e || {};
  const p = e.parameter || {};
  try {
    // Opening the /exec URL in a browser sends no parameters. Answering that
    // with "Unknown fn" reads like a broken deployment when it is really just
    // a request that asked for nothing, so say what this is instead.
    if (!p.fn) {
      return asJson(ok({
        service: 'Pickem Now API',
        storage: storageKind_(),
        usage:   'add ?fn=<name> to this URL',
        fn:      GET_FNS,
        example: 'https://.../exec?fn=board'
      }));
    }
    if (p.fn === 'odds')    return asJson(ok(getOdds_(String(p.league || ''), p.weekStart, { noCache: String(p.nocache) === '1' })));
    if (p.fn === 'mine')    return asJson(ok({ picks: getMyPicks_(String(p.email || '')) }));
    if (p.fn === 'board')   return asJson(ok({ rows: getBoard_() }));
    if (p.fn === 'weeks')   return asJson(ok({ weeks: getWeeks_() }));
    if (p.fn === 'week')    return asJson(ok(getWeek_(String(p.week || ''))));
    if (p.fn === 'isAdmin') return asJson(ok({ admin: isAdminEmail_(String(p.email || '')) }));
    return asJson(err('Unknown fn "' + p.fn + '". Valid: ' + GET_FNS.join(', ')));
  } catch (error) {
    return asJson(err(String(error)));
  }
}

// POST: submit (email,user,picks[...]), grade (email,id,result), also mine/board/odds passthroughs
function doPost(e) {
  e = e || {};
  const params = e.parameter || {};
  const qsFn = (e.queryString || '').match(/(?:^|&)fn=([^&]+)/);
  const fn = (params.fn || (qsFn && qsFn[1]) || '').toLowerCase();

  // Parse body even if Content-Type is text/plain
  let body = {};
  try {
    if (e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (_) { body = {}; }

  // Read from body OR query params; normalize
  const email = decodeURIComponent(String(body.email ?? params.email ?? '')).trim();
  const user  = decodeURIComponent(String(body.user  ?? params.user  ?? '')).trim();

  try {
    if (fn === 'submit') {
      if (!email) return asJson(err('email required'));
      // Validate picks server-side (4 standard + 1 ML, ML odds > -200)
      const vErr = validateSubmission_(body.picks);
      if (vErr) return asJson(err(vErr));
      return asJson(ok(submitPicks_(email, user || email, body.picks)));
    }
    if (fn === 'grade') {
      if (!email) return asJson(err('email required'));
      return asJson(ok(gradePick_(email, body.id, body.result)));
    }
    if (fn === 'autograde') {
      // Manual kick for the same routine the trigger runs. Admin only, since
      // it spends API credits.
      if (!isAdminEmail_(email)) return asJson(err('admin only'));
      return asJson(ok(autoGrade()));
    }
    if (fn === 'mine')  return asJson(ok({ picks: getMyPicks_(params.email || email) }));
    if (fn === 'board') return asJson(ok({ rows: getBoard_() }));
    if (fn === 'weeks') return asJson(ok({ weeks: getWeeks_() }));
    if (fn === 'week')  return asJson(ok(getWeek_(String(body.week ?? params.week ?? ''))));
    if (fn === 'odds')  return asJson(ok(getOdds_(params.league || '', null, { noCache: String(params.nocache) === '1' })));
    return asJson(err('Unknown fn'));
  } catch (error) {
    return asJson(err(String(error)));
  }
}

// ===== JSON/UTILITY HELPERS ==================================================
function ok(data)   { return { ok: true,  ...(data || {}) }; }
function err(msg)   { return { ok: false, error: String(msg) }; }
function asJson(obj){
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function openSheet_(name) {
  const ss = SpreadsheetApp.openById(sheetId_());
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** header name -> column index, so callers stop repeating indexOf(). */
function headerIndex_(headers) {
  const ix = {};
  (headers || []).forEach((h, i) => { ix[String(h)] = i; });
  return ix;
}

/**
 * Number(), minus the lies. Number(null), Number('') and Number(undefined)
 * all come back 0, which would grade a game with a missing score as 0-0 and
 * a pick with no line as a pick'em. Blank means unknown, so it becomes NaN
 * and the caller declines to grade. A real 0 still passes through.
 */
function num_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  return Number(v);
}

function parseMeta_(meta) {
  if (meta && typeof meta === 'object') return meta;
  if (typeof meta === 'string') { try { return JSON.parse(meta); } catch (_) { return null; } }
  return null;
}

function ensureHeaders_(sh, headers) {
  if (!headers || !headers.length) return;
  const lr = sh.getLastRow();
  const lc = sh.getLastColumn();
  let need = true;
  if (lr >= 1 && lc >= headers.length) {
    const row1 = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (String(row1[0] || '') === String(headers[0] || '')) need = false;
  }
  if (need) {
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
}

function isAdminEmail_(email) {
  if (!email) return false;
  const needle = String(email).trim().toLowerCase();
  for (const u of readUsers_()) {
    if (u.email === needle) return u.role === 'admin';
  }
  return false;
}

function makeId_() { return Math.random().toString(36).slice(2, 9); }

// ===== VALIDATION (server-side) ==============================================
// Enforces: 5 total picks (4 standard + 1 moneyline); among non-ML: 2 NFL, 2 NCAAF,
// exactly 1 Over, 1 Under, 1 Favorite, 1 Underdog.
// Moneyline: exactly 1 pick and American odds must be > -200 (e.g., -199, -110, +134 all OK).
function validateSubmission_(picks) {
  if (!Array.isArray(picks)) return 'picks must be an array';
  if (picks.length !== 5)     return 'you must submit 5 picks total (4 standard + 1 ML)';

  const mlPicks = picks.filter(p => String(p.market).toLowerCase() === 'moneyline');
  const nonML   = picks.filter(p => String(p.market).toLowerCase() !== 'moneyline');

  const nfl   = nonML.filter(p => String(p.league).toUpperCase() === 'NFL').length;
  const cfb   = nonML.filter(p => String(p.league).toUpperCase() === 'NCAAF').length;
  const over  = nonML.filter(p => String(p.kind).toLowerCase() === 'over').length;
  const under = nonML.filter(p => String(p.kind).toLowerCase() === 'under').length;
  const fav   = nonML.filter(p => String(p.kind).toLowerCase() === 'favorite').length;
  const dog   = nonML.filter(p => String(p.kind).toLowerCase() === 'underdog').length;

  if (nonML.length !== 4) return 'must have exactly 4 standard (non-moneyline) picks';
  if (mlPicks.length !== 1) return 'must have exactly 1 moneyline pick';
  if (nfl !== 2)   return 'must have exactly 2 NFL (non-ML) picks';
  if (cfb !== 2)   return 'must have exactly 2 NCAAF (non-ML) picks';
  if (over !== 1)  return 'must have exactly 1 Over (total)';
  if (under !== 1) return 'must have exactly 1 Under (total)';
  if (fav !== 1)   return 'must have exactly 1 Favorite (spread)';
  if (dog !== 1)   return 'must have exactly 1 Underdog (spread)';

  // Moneyline odds rule
  const mlPick = mlPicks[0];
  const odds = Number(mlPick && mlPick.odds);
  if (!(Number.isFinite(odds) && odds > -200)) {
    return 'moneyline odds must be greater than -200';
  }
  return null;
}

// ===== ODDS (The Odds API) ===================================================

// Name normalization + fuzzy equality
function _normName_(s){
  return String(s||'')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g,'')     // drop punctuation
    .replace(/\s+/g,' ')            // collapse spaces
    .trim();
}
function _nameMatches_(a,b){
  const A=_normName_(a), B=_normName_(b);
  return A===B || A.includes(B) || B.includes(A);
}

// Which side of a game a pick's `selection` refers to.
// Exact match first: substring matching alone would call "Texas" a match for
// "Texas A&M". Fuzzy is only a fallback, and only when exactly one side hits.
// Returns 'home' | 'away' | null, and null means "don't grade this" — a pick
// left pending is always safer than a pick graded wrong.
function sideOf_(selection, homeTeam, awayTeam) {
  const s = _normName_(selection);
  if (!s) return null;
  if (s === _normName_(homeTeam)) return 'home';
  if (s === _normName_(awayTeam)) return 'away';
  const fh = _nameMatches_(selection, homeTeam);
  const fa = _nameMatches_(selection, awayTeam);
  if (fh && !fa) return 'home';
  if (fa && !fh) return 'away';
  return null;
}

// Merge markets across allowed bookmakers; take the first available for each market
function _mergeMarkets_(ev){
  const res = { spread:null, totals:null, moneyline:null };

  // Order the list by our preferences first
  const books = (ev.bookmakers||[]).slice().sort((x,y)=>{
    const ix = BOOKMAKER_PREFS.indexOf(x.key);
    const iy = BOOKMAKER_PREFS.indexOf(y.key);
    return (ix<0?999:ix) - (iy<0?999:iy);
  });

  for (const bm of books){
    const markets = Array.isArray(bm.markets)? bm.markets : [];

// spreads  ✅ fixed
if (!res.spread) {
  const m = markets.find(mm => mm.key === 'spreads');
  if (m && Array.isArray(m.outcomes)) {
    const home = m.outcomes.find(o => _nameMatches_(o.name, ev.home_team));
    const away = m.outcomes.find(o => _nameMatches_(o.name, ev.away_team));
    if (home && away && typeof home.point === 'number' && typeof away.point === 'number') {
      let fav;
      if (home.point !== away.point) {
        // More negative point is the favorite
        fav = (home.point < away.point) ? 'home' : 'away';
      } else {
        // Pick'em or data oddity: use more negative American price as tiebreaker
        const hp = Number(home.price || 0);
        const ap = Number(away.price || 0);
        fav = (hp < ap) ? 'home' : 'away';
      }

      res.spread = {
        fav,
        // keep the feed’s native signed number for the favorite’s line
        line:    (fav === 'home' ? home.point : away.point),
        favPrice: (fav === 'home' ? home.price : away.price),
        dogPrice: (fav === 'home' ? away.price : home.price),
      };
    }
  }
}


    // totals
    if (!res.totals){
      const m = markets.find(mm => mm.key === 'totals');
      if (m && Array.isArray(m.outcomes)){
        const over  = m.outcomes.find(o => String(o.name).toLowerCase()==='over');
        const under = m.outcomes.find(o => String(o.name).toLowerCase()==='under');
        if (over && under && typeof over.point === 'number'){
          res.totals = { total: over.point, overPrice: over.price, underPrice: under.price };
        }
      }
    }

    // moneyline (h2h)
    if (!res.moneyline){
      const m = markets.find(mm => mm.key === 'h2h');
      if (m && Array.isArray(m.outcomes)){
        const home = m.outcomes.find(o => _nameMatches_(o.name, ev.home_team));
        const away = m.outcomes.find(o => _nameMatches_(o.name, ev.away_team));
        if (home && away){
          res.moneyline = { home: home.price, away: away.price };
        }
      }
    }

    // Stop early if we have all three
    if (res.spread && res.totals && res.moneyline) break;
  }

  return res;
}

// Returns shape:
// { games: [{ id, kickoff, home_team, away_team,
//             spread:{fav:'home|away', line:Number, favPrice:Number, dogPrice:Number}?,
//             totals:{total:Number, overPrice:Number, underPrice:Number}?,
//             moneyline:{home:Number, away:Number}? }] }
function getOdds_(league, weekStart, opts) {
  if (!league) throw 'league required';
  const noCache = !!(opts && opts.noCache);

  const cache = CacheService.getScriptCache();
  const key = 'odds:' + league;
  if (!noCache) {
    const cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  }

  const sport = (String(league).toLowerCase() === 'nfl')
    ? 'americanfootball_nfl'
    : 'americanfootball_ncaaf';

  const url = 'https://api.the-odds-api.com/v4/sports/' + sport + '/odds/'
    + '?regions=us'
    + '&markets=spreads,totals,h2h'
    + '&oddsFormat=american'
    + '&bookmakers=' + encodeURIComponent(BOOKMAKERS)
    + '&apiKey=' + encodeURIComponent(oddsApiKey_());

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, method: 'get' });
  if (res.getResponseCode() !== 200) {
    throw 'Odds API error: ' + res.getResponseCode() + ' ' + res.getContentText();
  }

  const data = JSON.parse(res.getContentText());

  const norm = data.map(ev => {
    const base = { id: ev.id, kickoff: ev.commence_time, home_team: ev.home_team, away_team: ev.away_team };
    const merged = _mergeMarkets_(ev);
    return Object.assign(base, merged);
  });

  const payload = { games: norm };
  if (!noCache) cache.put(key, JSON.stringify(payload), CACHE_TTL_SEC);
  return payload;
}

// ===== SCORES + AUTO-GRADING =================================================
// The Odds API's /scores endpoint returns the same event ids as /odds, so a
// pick's gameId joins straight onto a result — no team-name matching needed to
// find the game, only to work out which side was picked.
//
// Two things shape this design:
//   1. daysFrom maxes out at 3. A game older than that falls out of the feed
//      and can never be auto-graded, so the trigger has to run at least every
//      couple of days in season. Manual grading stays as the fallback.
//   2. A /scores call with daysFrom costs 2 credits against a 500/month free
//      tier. So we read the sheet first and only spend credits when something
//      is actually pending, and every completed game is cached in Results so
//      it's never fetched twice.

function leagueToSport_(league) {
  return String(league).toUpperCase() === 'NFL'
    ? 'americanfootball_nfl'
    : 'americanfootball_ncaaf';
}

/** One /scores call. Costs 2 credits. eventIds narrows it to games we need. */
function fetchScores_(league, eventIds) {
  let url = 'https://api.the-odds-api.com/v4/sports/' + leagueToSport_(league) + '/scores/'
    + '?daysFrom=3'
    + '&dateFormat=iso'
    + '&apiKey=' + encodeURIComponent(oddsApiKey_());
  if (eventIds && eventIds.length) {
    url += '&eventIds=' + encodeURIComponent(eventIds.join(','));
  }

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, method: 'get' });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('Scores API ' + code + ': ' + res.getContentText().slice(0, 300));

  const data = JSON.parse(res.getContentText());
  return (Array.isArray(data) ? data : []).map(ev => {
    let homeScore = null, awayScore = null;
    for (const s of (ev.scores || [])) {
      const side = sideOf_(s.name, ev.home_team, ev.away_team);
      const n = Number(s.score);
      if (side === 'home') homeScore = n;
      else if (side === 'away') awayScore = n;
    }
    return {
      gameId: ev.id,
      league: String(league).toUpperCase(),
      home_team: ev.home_team,
      away_team: ev.away_team,
      homeScore, awayScore,
      completed: !!ev.completed,
      commence: ev.commence_time || '',
      lastUpdate: ev.last_update || ''
    };
  });
}

/**
 * Grade one pick against one final result.
 * Returns 'win' | 'loss' | 'push', or null when it can't be graded with
 * confidence — the pick then stays pending for the next run or a manual call.
 */
function gradePickAgainstResult_(pick, r) {
  if (!r || !r.completed) return null;
  const hs = num_(r.homeScore), as = num_(r.awayScore);
  if (!isFinite(hs) || !isFinite(as)) return null;

  const market = String(pick.market || '').toLowerCase();
  const meta = parseMeta_(pick.meta);

  // Totals don't care which side was picked, only over vs under.
  if (market === 'total') {
    const total = num_(meta && meta.total);
    if (!isFinite(total)) return null;
    const sum = hs + as;
    if (sum === total) return 'push';
    const isOver = String(pick.kind || '').toLowerCase() === 'over';
    return (isOver ? sum > total : sum < total) ? 'win' : 'loss';
  }

  const side = sideOf_(pick.selection, r.home_team, r.away_team);
  if (!side) return null;
  const mine   = side === 'home' ? hs : as;
  const theirs = side === 'home' ? as : hs;

  if (market === 'moneyline') {
    if (mine === theirs) return 'push';
    return mine > theirs ? 'win' : 'loss';
  }

  if (market === 'spread') {
    // meta.line is already signed for the side that was picked:
    // -6.5 on a favourite, +6.5 on a dog. So the covered margin is just
    // (their margin) + (their line), and landing exactly on 0 is a push.
    const line = num_(meta && meta.line);
    if (!isFinite(line)) return null;
    const adj = (mine - theirs) + line;
    if (adj === 0) return 'push';
    return adj > 0 ? 'win' : 'loss';
  }

  return null;
}

/**
 * The scheduled entry point. Safe to run any time: it does nothing and spends
 * no credits when there's nothing pending.
 */
function autoGrade() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'another grading run is in progress' };
  try {
    return runAutoGrade_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * opts.noFetch skips the API entirely and grades against whatever is already
 * cached in Results. The self-test uses it to exercise this exact function
 * for zero credits; without it a self-test run would also go and fetch every
 * unrelated pending pick in the sheet.
 */
function runAutoGrade_(opts) {
  const noFetch = !!(opts && opts.noFetch);
  const all = readPicks_();
  if (!all.length) return { graded: 0, stillPending: 0, creditsUsed: 0, note: 'no picks yet' };

  const pending = all.filter(function (p) {
    if (p.status && p.status !== 'pending') return false;   // already decided
    return !!p.gameId;                                      // nothing to join on
  });
  if (!pending.length) {
    return { graded: 0, stillPending: 0, creditsUsed: 0, note: 'nothing pending - no API call made' };
  }

  // Only fetch games we don't already have a completed result for.
  const cache = readResults_();
  const needByLeague = {};
  for (const p of pending) {
    const known = cache[p.gameId];
    if (known && known.completed) continue;
    const lg = String(p.league || '').toUpperCase() || 'NFL';
    if (!needByLeague[lg]) needByLeague[lg] = {};
    needByLeague[lg][p.gameId] = true;
  }

  let creditsUsed = 0;
  const fetchErrors = [];
  for (const lg of (noFetch ? [] : Object.keys(needByLeague))) {
    const ids = Object.keys(needByLeague[lg]);
    if (!ids.length) continue;
    try {
      const rows = fetchScores_(lg, ids);
      creditsUsed += 2;
      upsertResults_(rows);
      for (const r of rows) cache[r.gameId] = r;
    } catch (e) {
      fetchErrors.push(lg + ': ' + e.message);
    }
  }

  const updates = [];
  let stillPending = 0;
  for (const p of pending) {
    const verdict = gradePickAgainstResult_(p, cache[p.gameId]);
    if (verdict) updates.push({ _key: p._key, status: verdict });
    else stillPending++;
  }
  const graded = setPickStatuses_(updates);

  const out = { graded, stillPending, creditsUsed };
  if (fetchErrors.length) out.errors = fetchErrors;
  Logger.log(JSON.stringify(out));
  return out;
}

// ===== TRIGGER ===============================================================
/** Run once from the editor to schedule grading. Safe to re-run — it clears
    its own previous triggers first rather than stacking duplicates. */
function installAutoGradeTrigger() {
  removeAutoGradeTriggers();
  ScriptApp.newTrigger('autoGrade').timeBased().everyHours(6).create();
  return 'autoGrade scheduled every 6 hours';
}

function removeAutoGradeTriggers() {
  let n = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'autoGrade') { ScriptApp.deleteTrigger(t); n++; }
  }
  return 'removed ' + n + ' trigger(s)';
}

// ===== PICKS =================================================================

/**
 * Replace this user's picks for the week, then append the new set.
 *
 * The old version appended unconditionally, so submitting twice left ten rows
 * in the sheet and the scoreboard counted all of them. Replacing also lets
 * people change their mind before kickoff — but only while the week is still
 * ungraded, so nobody can rewrite a pick after the result is in.
 */
function submitPicks_(email, user, picks) {
  if (!email) throw new Error('email required');

  const week = String((picks && picks[0] && picks[0].week) || '');
  const replaced = week ? clearExistingPicks_(email, week) : 0;

  const rows = (picks || []).map(p => ({
    id:        p.id || Utilities.getUuid(),
    week:      p.week || '',
    email:     email,
    user:      user || email,
    league:    p.league || '',
    gameId:    p.gameId || '',
    matchup:   p.matchup || '',
    market:    p.market || '',
    kind:      p.kind || '',
    selection: p.selection || '',
    odds:      p.odds ?? '',
    meta:      JSON.stringify(p.meta || {}),
    status:    p.status || 'pending',
    ts:        new Date(p.ts || Date.now())
  }));

  if (!rows.length) return { count: 0, replaced };
  insertPicks_(rows);
  return { count: rows.length, replaced };
}

/**
 * Delete this user's pending picks for a week. Throws if any of them have
 * already been graded, which is what stops a resubmission from erasing a
 * result. Deletes bottom-up so earlier row numbers stay valid.
 */
function clearExistingPicks_(email, week) {
  const needle = String(email).trim().toLowerCase();
  const victims = [];
  for (const p of readPicks_()) {
    if (p.email.trim().toLowerCase() !== needle) continue;
    if (p.week !== week) continue;
    if (p.status && p.status !== 'pending') {
      throw new Error('Week ' + week + ' has already been graded - picks are locked.');
    }
    victims.push(p._key);
  }
  return deletePickKeys_(victims);
}

// Read picks for an email (used by "My Picks" UI)
function getMyPicks_(email) {
  if (!email) throw new Error('email required');
  const needle = String(email).trim().toLowerCase();
  const picks = [];

  for (const p of readPicks_()) {
    if (p.email.trim().toLowerCase() !== needle) continue;
    const meta = parseMeta_(p.meta);

    // The UI shows one number per pick, whichever the market makes relevant.
    let line = '';
    if (p.market === 'spread' && meta && meta.line  !== undefined) line = meta.line;
    else if (p.market === 'total' && meta && meta.total !== undefined) line = meta.total;

    picks.push({
      id: p.id || ('row_' + p._key),
      week: p.week, email: p.email, user: p.user, league: p.league,
      gameId: p.gameId, matchup: p.matchup, market: p.market, kind: p.kind,
      selection: p.selection, odds: p.odds, meta: p.meta,
      status: p.status, ts: p.ts, line: line
    });
  }
  picks.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return picks;
}

// ===== SCOREBOARD ============================================================
// One pass over the sheet builds week -> user -> record. Everything else
// (weekly winners, the season table, a single week's detail) reads off that.

function tallies_() { return talliesFrom_(readPicks_()); }

/** Split out from tallies_ so the same arithmetic can be run over either
    backend's rows when comparing the two. */
function talliesFrom_(picks) {
  const weeks = {};   // week -> { user -> {wins,losses,pushes,pending,total} }
  const users = {};   // user -> season totals

  for (const p of picks) {
    const user = p.user.trim();
    if (!user) continue;
    const week = p.week;
    // Belt and braces: runSelfTest deletes its own rows, but if it ever dies
    // mid-run (script timeout, say) its fake week must not reach the board.
    if (week === SELFTEST_WEEK) continue;
    const status = p.status;

    if (!users[user]) users[user] = { wins:0, losses:0, pushes:0, pending:0, total:0, weeksPlayed:{} };
    if (week) users[user].weeksPlayed[week] = true;

    if (!weeks[week]) weeks[week] = {};
    if (!weeks[week][user]) weeks[week][user] = { wins:0, losses:0, pushes:0, pending:0, total:0 };

    const key = status === 'win' ? 'wins' : status === 'loss' ? 'losses'
              : status === 'push' ? 'pushes' : 'pending';

    weeks[week][user][key]++; weeks[week][user].total++;
    users[user][key]++;       users[user].total++;
  }
  return { weeks, users };
}

/** Winners of a single week: most wins, fewer losses breaks a tie, and a
    genuine tie shares the week. A week with anything still pending has no
    winner yet. */
function weekWinners_(perUser) {
  const names = Object.keys(perUser || {});
  if (!names.length) return { decided: false, winners: [] };
  if (names.some(u => perUser[u].pending > 0)) return { decided: false, winners: [] };

  let best = null;
  for (const u of names) {
    const r = perUser[u];
    if (!best || r.wins > best.wins || (r.wins === best.wins && r.losses < best.losses)) {
      best = { wins: r.wins, losses: r.losses };
    }
  }
  const winners = names.filter(u =>
    perUser[u].wins === best.wins && perUser[u].losses === best.losses);
  return { decided: true, winners };
}

/** Season table: weeks won is the headline, record behind it. */
function getBoard_() {
  const { weeks, users } = tallies_();

  const won = {};
  for (const wk of Object.keys(weeks)) {
    if (!wk) continue;
    for (const u of weekWinners_(weeks[wk]).winners) won[u] = (won[u] || 0) + 1;
  }

  return Object.keys(users).map(u => {
    const r = users[u];
    const decided = r.wins + r.losses;   // pushes and pendings don't move a pct
    return {
      user:        u,
      weeksWon:    won[u] || 0,
      wins:        r.wins,
      losses:      r.losses,
      pushes:      r.pushes,
      pending:     r.pending,
      total:       r.total,
      weeksPlayed: Object.keys(r.weeksPlayed).length,
      pct:         decided ? Math.round((r.wins / decided) * 1000) / 1000 : 0
    };
  }).sort((a, b) =>
      (b.weeksWon - a.weeksWon) ||
      (b.wins - a.wins) ||
      (a.losses - b.losses) ||
      a.user.localeCompare(b.user));
}

const MONTH_NUM = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                    jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };

/**
 * A sortable YYYY-MM-DD key for a week label.
 *
 * The Sheet's week column was a date cell, so it stringified into things like
 * "Wed Sep 24 2025 00:00:00 GMT-0500 (Central Daylight Time)". Sorting those
 * as text orders them by day name and then month name, which is how the week
 * dropdown ended up showing September above October.
 *
 * Parsed by pattern rather than through Date, deliberately: `new Date(str)`
 * would re-interpret the offset in the script's timezone and can land a
 * midnight date on the previous day.
 */
function weekKey_(v) {
  const s = String(v || '').trim();
  if (!s) return '';

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];

  // "Wed Sep 24 2025 ..." and "Sep 24 2025 ..."
  const m = s.match(/^(?:\w{3}\s+)?(\w{3})\s+(\d{1,2})\s+(\d{4})/);
  if (m) {
    const mo = MONTH_NUM[m[1].toLowerCase()];
    if (mo) return m[3] + '-' + mo + '-' + ('0' + m[2]).slice(-2);
  }

  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);      // 9/24/2025
  if (us) return us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2);

  return s;   // unrecognised: sort it as itself rather than guess
}

/** Every week that has picks, newest first. */
function getWeeks_() {
  const { weeks } = tallies_();
  return Object.keys(weeks).filter(Boolean)
    .sort(function (a, b) {
      const ka = weekKey_(a), kb = weekKey_(b);
      return ka < kb ? 1 : ka > kb ? -1 : 0;      // newest first
    })
    .map(wk => {
    const w = weekWinners_(weeks[wk]);
    return { week: wk, decided: w.decided, winners: w.winners, players: Object.keys(weeks[wk]).length };
  });
}

/** One week in detail, for the weekly panel on the board tab. */
function getWeek_(week) {
  const { weeks } = tallies_();
  const perUser = weeks[String(week)] || {};
  const w = weekWinners_(perUser);
  const rows = Object.keys(perUser).map(u => ({
    user: u,
    wins: perUser[u].wins,
    losses: perUser[u].losses,
    pushes: perUser[u].pushes,
    pending: perUser[u].pending,
    winner: w.winners.indexOf(u) >= 0
  })).sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || a.user.localeCompare(b.user));

  return { week: String(week), decided: w.decided, winners: w.winners, rows };
}

// Admin-only grading
function gradePick_(email, id, result) {
  if (!isAdminEmail_(email)) throw new Error('admin only');
  if (!id) throw new Error('id required');
  for (const p of readPicks_()) {
    if (p.id === String(id)) {
      setPickStatuses_([{ _key: p._key, status: String(result || '').toLowerCase() }]);
      return { id, result };
    }
  }
  throw new Error('pick not found');
}

// ===== SELF TEST =============================================================
// There is rarely a live game when you want to check that grading works, so
// this proves it without one. It writes a throwaway week of picks and a set of
// invented final scores into the real Sheet, runs the real grading pass over
// them, checks every verdict, and deletes everything it made.
//
// It never calls the Odds API, so it costs zero credits and can be run as
// often as you like. What it does NOT cover is fetchScores_ — for that, run
// checkOddsApi() once when games are actually on.

const SELFTEST_WEEK   = '__selftest__';
const SELFTEST_EMAIL  = 'selftest@example.invalid';
const SELFTEST_PREFIX = '__selftest_';

/**
 * Invented games. Deliberately awkward: a tie, an unfinished game, and a
 * finished game with no scores attached — the two cases that must stay
 * pending rather than be guessed at.
 */
function selfTestResults_() {
  return [
    // 27-20 home. Margin +7, total 47.
    { gameId: SELFTEST_PREFIX + 'g1', league: 'NFL',
      home_team: 'Selftest Home Alpha', away_team: 'Selftest Away Alpha',
      homeScore: 27, awayScore: 20, completed: true },
    // 21-21. A tie, so the moneyline is a push.
    { gameId: SELFTEST_PREFIX + 'g2', league: 'NFL',
      home_team: 'Selftest Home Bravo', away_team: 'Selftest Away Bravo',
      homeScore: 21, awayScore: 21, completed: true },
    // Not finished.
    { gameId: SELFTEST_PREFIX + 'g3', league: 'NFL',
      home_team: 'Selftest Home Delta', away_team: 'Selftest Away Delta',
      homeScore: 10, awayScore: 3, completed: false },
    // Finished but scoreless in the feed - this is the Number('') === 0 trap.
    { gameId: SELFTEST_PREFIX + 'g4', league: 'NFL',
      home_team: 'Selftest Home Echo', away_team: 'Selftest Away Echo',
      homeScore: '', awayScore: '', completed: true }
  ];
}

/** Each pick carries the verdict it must end up with. */
function selfTestPicks_() {
  const g1 = SELFTEST_PREFIX + 'g1', g2 = SELFTEST_PREFIX + 'g2';
  const g3 = SELFTEST_PREFIX + 'g3', g4 = SELFTEST_PREFIX + 'g4';
  const HA = 'Selftest Home Alpha', AA = 'Selftest Away Alpha';

  return [
    // --- spreads. Home won by 7, so the number 7 is the pivot.
    { why: 'favourite covers',       gameId: g1, market: 'spread', kind: 'favorite', selection: HA, meta: { line: -6.5 }, expect: 'win'  },
    { why: 'dog fails to cover',     gameId: g1, market: 'spread', kind: 'underdog', selection: AA, meta: { line:  6.5 }, expect: 'loss' },
    { why: 'favourite lands on it',  gameId: g1, market: 'spread', kind: 'favorite', selection: HA, meta: { line: -7   }, expect: 'push' },
    { why: 'dog lands on it',        gameId: g1, market: 'spread', kind: 'underdog', selection: AA, meta: { line:  7   }, expect: 'push' },

    // --- totals. 27 + 20 = 47.
    { why: 'over hits',              gameId: g1, market: 'total', kind: 'over',  selection: 'Over',  meta: { total: 45.5 }, expect: 'win'  },
    { why: 'under misses',           gameId: g1, market: 'total', kind: 'under', selection: 'Under', meta: { total: 45.5 }, expect: 'loss' },
    { why: 'total lands exactly',    gameId: g1, market: 'total', kind: 'over',  selection: 'Over',  meta: { total: 47   }, expect: 'push' },

    // --- moneylines.
    { why: 'moneyline winner',       gameId: g1, market: 'moneyline', kind: 'ml', selection: HA, meta: {}, expect: 'win'  },
    { why: 'moneyline loser',        gameId: g1, market: 'moneyline', kind: 'ml', selection: AA, meta: {}, expect: 'loss' },
    { why: 'moneyline on a tie',     gameId: g2, market: 'moneyline', kind: 'ml', selection: 'Selftest Home Bravo', meta: {}, expect: 'push' },

    // --- everything below must be REFUSED, not guessed.
    { why: 'game not finished',      gameId: g3, market: 'spread',    kind: 'favorite', selection: 'Selftest Home Delta', meta: { line: -3 }, expect: 'pending' },
    { why: 'finished, no scores',    gameId: g4, market: 'moneyline', kind: 'ml',       selection: 'Selftest Home Echo',  meta: {},           expect: 'pending' },
    { why: 'team name unrecognised', gameId: g1, market: 'moneyline', kind: 'ml',       selection: 'Zzz Nobody',          meta: {},           expect: 'pending' },
    { why: 'spread with no line',    gameId: g1, market: 'spread',    kind: 'favorite', selection: HA,                    meta: {},           expect: 'pending' },
    { why: 'total with no number',   gameId: g1, market: 'total',     kind: 'over',     selection: 'Over',                meta: {},           expect: 'pending' },
    { why: 'unknown market',         gameId: g1, market: 'parlay',    kind: '',         selection: HA,                    meta: {},           expect: 'pending' }
  ];
}

/** Remove every trace of a previous run. Returns how many rows went. */
function selfTestCleanup_() {
  const victims = readPicks_()
    .filter(function (p) { return p.week === SELFTEST_WEEK; })
    .map(function (p) { return p._key; });

  const cache = readResults_();
  const junk = Object.keys(cache)
    .filter(function (id) { return id.indexOf(SELFTEST_PREFIX) === 0; });

  return deletePickKeys_(victims) + deleteResultIds_(junk);
}

/**
 * Run this from the editor whenever you want to know grading still works.
 * Returns a readable report; the execution log has the same thing.
 */
function runSelfTest() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return 'FAILED: a grading run is in progress, try again in a minute';

  try {
    selfTestCleanup_();                    // in case an earlier run died halfway

    const fixtures = selfTestPicks_();
    upsertResults_(selfTestResults_());

    insertPicks_(fixtures.map(function (p, i) {
      return {
        id: SELFTEST_PREFIX + i, week: SELFTEST_WEEK, email: SELFTEST_EMAIL,
        user: 'Selftest', league: 'NFL', gameId: p.gameId, matchup: 'selftest',
        market: p.market, kind: p.kind, selection: p.selection,
        odds: '', meta: JSON.stringify(p.meta), status: 'pending', ts: new Date()
      };
    }));

    // The real thing - the same function the six-hourly trigger calls.
    const run = runAutoGrade_({ noFetch: true });

    // Read back what it actually wrote.
    const got = {};
    for (const p of readPicks_()) {
      if (p.week === SELFTEST_WEEK) got[p.id] = p.status;
    }

    const failures = [];
    fixtures.forEach(function (p, i) {
      const actual = got[SELFTEST_PREFIX + i];
      if (actual !== p.expect) {
        failures.push('  ' + p.market + ' / ' + p.why + ': expected ' + p.expect + ', got ' + actual);
      }
    });
    if (run.creditsUsed !== 0) {
      failures.push('  spent ' + run.creditsUsed + ' API credits - it should spend none');
    }

    const msg = failures.length
      ? 'SELF TEST FAILED - ' + failures.length + ' of ' + fixtures.length + ' wrong:\n' + failures.join('\n')
      : 'SELF TEST PASSED - all ' + fixtures.length + ' picks graded correctly, 0 API credits used.\n'
        + '  graded ' + run.graded + ', left pending ' + run.stillPending + ' (both expected).';

    Logger.log(msg);
    return msg;
  } finally {
    selfTestCleanup_();                    // runs even if something threw
    lock.releaseLock();
  }
}

/**
 * The other half: proves the Odds API key works and shows what the scores feed
 * currently holds. Costs 1 credit (no daysFrom). Run it on a game day - out of
 * season it will correctly report an empty feed, which is not a failure.
 */
function checkOddsApi() {
  const out = [];
  let anyFinished = 0;

  for (const league of ['NFL', 'NCAAF']) {
    try {
      // daysFrom is what makes finished games visible at all. Without it the
      // endpoint returns only live and upcoming fixtures, so "0 completed"
      // would be the answer on every day of the year — including a Monday in
      // November — and the check would be worthless. Costs 2 credits, not 1.
      const url = 'https://api.the-odds-api.com/v4/sports/' + leagueToSport_(league)
        + '/scores/?daysFrom=3&dateFormat=iso&apiKey=' + encodeURIComponent(oddsApiKey_());
      const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true, method: 'get' });
      const code = res.getResponseCode();
      if (code !== 200) {
        out.push(league + ': HTTP ' + code + ' - ' + res.getContentText().slice(0, 200));
        continue;
      }

      const games = JSON.parse(res.getContentText()) || [];
      const done  = games.filter(function (g) { return g.completed; });
      anyFinished += done.length;

      out.push(league + ': OK - ' + games.length + ' game(s) in the feed, '
        + done.length + ' finished in the last 3 days');
      done.slice(0, 3).forEach(function (g) {
        const s = (g.scores || []).map(function (x) { return x.name + ' ' + x.score; }).join(', ');
        out.push('    ' + g.away_team + ' @ ' + g.home_team + ' - ' + (s || 'no scores') + '  [' + g.id + ']');
      });
      out.push('    credits left this month: ' + (res.getHeaders()['x-requests-remaining'] || 'unknown'));
    } catch (e) {
      out.push(league + ': FAILED - ' + e.message);
    }
  }

  out.push('');
  out.push(anyFinished
    ? anyFinished + ' finished game(s) available - testAutoGradeLive() can run an '
      + 'end-to-end check against a real result right now.'
    : 'No finished games in the last 3 days, so there is nothing for auto-grading to '
      + 'do and testAutoGradeLive() has nothing to work with. Not a failure - the API '
      + 'key works, the season just has not started. Try again after the first slate.');

  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ===== TESTING AGAINST OLD WEEKS =============================================
// The scores feed only reaches back three days (daysFrom maxes at 3) and the
// historical endpoints are a paid add-on, so old games cannot be re-fetched.
// These two work anyway, and neither spends a credit.
//
//   auditGrades()               finds contradictions in grades you already
//                               have. Needs no scores at all.
//   backtestTemplate(week)      prints a fill-in-the-blanks list of that
//                               week's games.
//   backtestWeek(week, scores)  grades that week's real picks against the
//                               scores you filled in and compares the verdicts
//                               to how the week was graded by hand.
//
// Both are read-only. Neither writes a thing to the Sheet.

/** "Away Team @ Home Team" back into its two sides, the way the frontend
    builds it. Returns null if it isn't that shape. */
function splitMatchup_(matchup) {
  const parts = String(matchup || '').split('@');
  if (parts.length !== 2) return null;
  const away = parts[0].trim(), home = parts[1].trim();
  if (!away || !home) return null;
  return { away: away, home: home };
}

/** Every pick in one week, with meta already parsed. */
function readWeekPicks_(week) {
  const want = String(week);
  return readPicks_()
    .filter(function (p) { return p.week === want; })
    .map(function (p) {
      const o = {};
      for (const k of Object.keys(p)) o[k] = p[k];
      o.row  = p._key;              // what to look at if something is wrong
      o.meta = parseMeta_(p.meta);
      return o;
    });
}

/**
 * Print a ready-to-edit call for backtestWeek. Look the final scores up, type
 * them in, and run the result.
 */
function backtestTemplate(week) {
  const picks = readWeekPicks_(week);
  if (!picks.length) return 'No picks found for week "' + week + '". Try getWeeks_() for the list.';

  const games = {};
  for (const p of picks) {
    if (!p.gameId) continue;
    if (!games[p.gameId]) games[p.gameId] = { matchup: p.matchup, league: p.league, picks: 0 };
    games[p.gameId].picks++;
  }

  const lines = Object.keys(games).map(function (id) {
    const g = games[id];
    return "  '" + id + "': [0, 0],   // [home, away]  " + g.matchup + '  (' + g.league + ', ' + g.picks + ' pick(s))';
  });

  const msg = 'Fill in the real final scores and run this:\n\n'
    + "backtestWeek('" + week + "', {\n" + lines.join('\n') + '\n});\n\n'
    + 'Scores go in as [home, away] - the matchup reads "away @ home", so the\n'
    + 'second team named is the first number.';
  Logger.log(msg);
  return msg;
}

/**
 * Grade a past week's real picks against scores you supply, then compare with
 * how it was graded at the time. Writes nothing.
 *
 * scores: { gameId: [homeScore, awayScore] }
 */
function backtestWeek(week, scores) {
  const picks = readWeekPicks_(week);
  if (!picks.length) return 'No picks found for week "' + week + '".';
  scores = scores || {};

  const agreed = [], disagreed = [], ungraded = [], noScore = [];

  for (const p of picks) {
    const s = scores[p.gameId];
    if (!s) { noScore.push(p); continue; }

    const sides = splitMatchup_(p.matchup);
    if (!sides) { ungraded.push({ pick: p, why: 'matchup "' + p.matchup + '" is not "away @ home"' }); continue; }

    const verdict = gradePickAgainstResult_(p, {
      completed: true,
      home_team: sides.home,
      away_team: sides.away,
      homeScore: s[0],
      awayScore: s[1]
    });

    if (!verdict) { ungraded.push({ pick: p, why: 'grader declined' }); continue; }
    if (!p.status || p.status === 'pending') { agreed.push({ pick: p, verdict: verdict, wasPending: true }); continue; }
    if (verdict === p.status) agreed.push({ pick: p, verdict: verdict });
    else disagreed.push({ pick: p, verdict: verdict });
  }

  const out = [];
  out.push('BACKTEST ' + week + ' - ' + picks.length + ' pick(s)');
  out.push('  auto-grader agreed with the sheet : ' + agreed.filter(function (a) { return !a.wasPending; }).length);
  out.push('  disagreed                         : ' + disagreed.length);
  out.push('  previously ungraded, now decided  : ' + agreed.filter(function (a) { return a.wasPending; }).length);
  out.push('  grader declined to call           : ' + ungraded.length);
  out.push('  no score supplied                 : ' + noScore.length);

  if (disagreed.length) {
    out.push('');
    out.push('DISAGREEMENTS - one of the two is wrong, worth looking at:');
    for (const d of disagreed) {
      out.push('  ' + d.pick.user + '  ' + d.pick.matchup + '  ' + d.pick.market + ' ' + d.pick.kind
        + ' ' + d.pick.selection + lineNote_(d.pick)
        + '\n      sheet says ' + d.pick.status + ', grader says ' + d.verdict + '  (row ' + d.pick.row + ')');
    }
  }
  if (ungraded.length) {
    out.push('');
    out.push('DECLINED - these would stay pending in a real run:');
    for (const u of ungraded) {
      out.push('  ' + u.pick.user + '  ' + u.pick.matchup + '  ' + u.pick.market + ': ' + u.why + '  (row ' + u.pick.row + ')');
    }
  }
  if (noScore.length) {
    const ids = {};
    for (const p of noScore) ids[p.gameId] = p.matchup;
    out.push('');
    out.push('NO SCORE GIVEN for: ' + Object.keys(ids).map(function (k) { return ids[k]; }).join(', '));
  }

  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

function lineNote_(p) {
  if (p.market === 'spread' && p.meta && p.meta.line !== undefined) return ' (' + p.meta.line + ')';
  if (p.market === 'total'  && p.meta && p.meta.total !== undefined) return ' (' + p.meta.total + ')';
  return '';
}

// ===== GRADE AUDIT ===========================================================
/**
 * Finds contradictions in grades that already exist, without needing a single
 * final score.
 *
 * The trick: two people on opposite sides of the same number cannot both be
 * right. If one took a team at -6.5 and won, whoever took the other side at
 * +6.5 must have lost. Over and under on the same total, likewise. A moneyline
 * winner tells you who won the game outright, which in turn settles any spread
 * pick on that team where the points can only have helped.
 *
 * Every contradiction it reports is a genuine mistake in the sheet — the sort
 * of thing hand-grading produces and nobody notices until the season is over.
 */
function auditGrades() {
  const all = readPicks_();
  if (!all.length) return 'No picks yet.';

  const byGame = {};
  let decided = 0;
  for (const raw of all) {
    if (raw.week === SELFTEST_WEEK) continue;
    if (raw.status !== 'win' && raw.status !== 'loss' && raw.status !== 'push') continue;
    if (!raw.gameId) continue;

    const sides = splitMatchup_(raw.matchup);
    decided++;
    const p = {
      row: raw._key, week: raw.week, user: raw.user, matchup: raw.matchup,
      market: raw.market.toLowerCase(),
      kind: raw.kind.toLowerCase(),
      selection: raw.selection,
      meta: parseMeta_(raw.meta) || {},
      status: raw.status,
      side: sides ? sideOf_(raw.selection, sides.home, sides.away) : null
    };
    (byGame[raw.gameId] = byGame[raw.gameId] || []).push(p);
  }

  const problems = [];
  for (const gameId of Object.keys(byGame)) {
    const ps = byGame[gameId];
    for (let a = 0; a < ps.length; a++) {
      for (let b = a + 1; b < ps.length; b++) {
        const x = ps[a], y = ps[b];

        // Opposite sides of the same spread number.
        if (x.market === 'spread' && y.market === 'spread' && x.side && y.side && x.side !== y.side) {
          const lx = num_(x.meta.line), ly = num_(y.meta.line);
          if (isFinite(lx) && isFinite(ly) && lx === -ly && y.status !== complement_(x.status)) {
            problems.push(pairNote_('same spread, opposite sides', x, y));
          }
        }
        // Over and under on the same total.
        if (x.market === 'total' && y.market === 'total' && x.kind && y.kind && x.kind !== y.kind) {
          const tx = num_(x.meta.total), ty = num_(y.meta.total);
          if (isFinite(tx) && isFinite(ty) && tx === ty && y.status !== complement_(x.status)) {
            problems.push(pairNote_('same total, over vs under', x, y));
          }
        }
        // Opposite moneylines.
        if (x.market === 'moneyline' && y.market === 'moneyline' && x.side && y.side && x.side !== y.side) {
          if (y.status !== complement_(x.status)) problems.push(pairNote_('opposite moneylines', x, y));
        }
        // A moneyline result settles some spreads outright. If a team won the
        // game and was also getting points (or laying none), it covered — no
        // score needed to know that.
        const ml = x.market === 'moneyline' ? x : (y.market === 'moneyline' ? y : null);
        const sp = x.market === 'spread'    ? x : (y.market === 'spread'    ? y : null);
        if (ml && sp && ml.side && sp.side && ml.status !== 'push') {
          const line = num_(sp.meta.line);
          const spWon = (ml.status === 'win') === (ml.side === sp.side);   // did sp's team win outright?
          if (isFinite(line)) {
            if (spWon && line >= 0 && sp.status !== 'win') {
              problems.push(pairNote_('won outright while getting ' + line + ', so it covered', ml, sp));
            }
            if (!spWon && line <= 0 && sp.status !== 'loss') {
              problems.push(pairNote_('lost outright while laying ' + line + ', so it did not cover', ml, sp));
            }
          }
        }
      }
    }
  }

  const msg = problems.length
    ? 'GRADE AUDIT - ' + problems.length + ' contradiction(s) across ' + decided + ' graded pick(s):\n\n'
      + problems.join('\n\n')
      + '\n\nEach of these is two grades that cannot both be right. Check the rows.'
    : 'GRADE AUDIT - no contradictions found across ' + decided + ' graded pick(s).\n'
      + '  Note this can only check games where two picks disagree with each other;\n'
      + '  a game only one person picked has nothing to check it against.';
  Logger.log(msg);
  return msg;
}

function complement_(status) {
  if (status === 'win')  return 'loss';
  if (status === 'loss') return 'win';
  if (status === 'push') return 'push';
  return null;
}

function pairNote_(why, x, y) {
  return '  ' + x.week + '  ' + x.matchup + '  [' + why + ']\n'
    + '    row ' + x.row + '  ' + x.user + '  ' + x.market + ' ' + x.kind + ' ' + x.selection + lineNote_(x) + '  -> ' + x.status + '\n'
    + '    row ' + y.row + '  ' + y.user + '  ' + y.market + ' ' + y.kind + ' ' + y.selection + lineNote_(y) + '  -> ' + y.status;
}

// ===== MIGRATION =============================================================
// Moving from Sheets to Postgres, and proving it worked before committing to
// it. These call the two implementations by name rather than through the
// dispatchers, so they behave the same whichever way STORAGE is set.
//
// Order of operations:
//
//   1. run db/schema.sql in the Supabase SQL editor
//   2. add SUPABASE_URL and SUPABASE_SERVICE_KEY to Script Properties
//   3. checkSetup()              — both backends reachable?
//   4. migrateSheetsToPostgres() — copies everything, safe to re-run
//   5. compareBackends()         — do they now agree, row for row?
//   6. set STORAGE = postgres    — the cutover
//   7. runSelfTest()             — grading still correct on the new backend
//
// The Sheet is left completely untouched throughout, so step 6 is reversible
// by deleting the property.

/** Upsert rather than insert, so a re-run after a partial failure repairs
    instead of colliding on the primary key. */
function pgUpsertPicks_(picks) {
  let n = 0;
  for (const batch of pgChunk_(picks.map(pickToPg_), PG_CHUNK)) {
    pgFetch_('post', 'picks', batch, 'resolution=merge-duplicates,return=minimal');
    n += batch.length;
  }
  return n;
}

/**
 * As above, but when a batch is rejected it finds out which rows are actually
 * at fault instead of reporting "400" over five hundred of them.
 *
 * Postgres names the constraint, not the row. During a migration that is the
 * difference between a one-line fix and an afternoon, so on failure this
 * re-sends the batch a row at a time and reports the offenders by id.
 */
function pgUpsertPicksNamingFailures_(picks) {
  const rows = picks.map(pickToPg_);
  const bad = [];
  let n = 0;

  for (const batch of pgChunk_(rows, PG_CHUNK)) {
    try {
      pgFetch_('post', 'picks', batch, 'resolution=merge-duplicates,return=minimal');
      n += batch.length;
    } catch (_) {
      for (const row of batch) {
        try {
          pgFetch_('post', 'picks', [row], 'resolution=merge-duplicates,return=minimal');
          n++;
        } catch (e) {
          bad.push({ id: row.id, why: String(e.message).slice(0, 160) });
        }
      }
    }
  }
  return { copied: n, rejected: bad };
}

function pgUpsertUsers_(users) {
  if (!users.length) return 0;
  let n = 0;
  for (const batch of pgChunk_(users, PG_CHUNK)) {
    pgFetch_('post', 'users', batch, 'resolution=merge-duplicates,return=minimal');
    n += batch.length;
  }
  return n;
}

/**
 * Copy the Sheet into Postgres. Idempotent: every write is an upsert keyed on
 * the primary key, so running it twice is the same as running it once, and
 * running it again later picks up anything added since.
 */
function migrateSheetsToPostgres() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return 'FAILED: another run is in progress';

  try {
    const out = [];

    // --- picks
    const picks = sheetReadPicks_().filter(function (p) {
      if (p.week === SELFTEST_WEEK) return false;      // scaffolding, not data
      return !!(p.id || p.gameId || p.email);           // drop blank trailing rows
    });

    // Legacy rows predate ids. The primary key cannot be blank, and two blank
    // ids would collide on upsert, so mint a stable one from the row.
    let minted = 0;
    for (const p of picks) {
      if (!p.id) { p.id = 'legacy_' + p._key; minted++; }
    }

    const seen = {}, dupes = [];
    for (const p of picks) {
      if (seen[p.id]) dupes.push(p.id);
      seen[p.id] = true;
    }
    if (dupes.length) {
      return 'ABORTED: ' + dupes.length + ' duplicate pick id(s) in the Sheet, e.g. '
        + dupes.slice(0, 5).join(', ') + '.\nUpserting them would silently merge rows. '
        + 'Fix the ids in the Sheet first.';
    }

    const res = pgUpsertPicksNamingFailures_(picks);
    out.push('picks   : ' + res.copied + ' copied'
      + (minted ? ' (' + minted + ' had no id and were given one)' : ''));
    if (res.rejected.length) {
      out.push('');
      out.push('REJECTED - ' + res.rejected.length + ' pick(s) Postgres would not accept:');
      for (const b of res.rejected.slice(0, 10)) out.push('  ' + b.id + ': ' + b.why);
      out.push('');
      out.push('Fix these rows in the Sheet and run the migration again. Everything');
      out.push('else was copied, and re-running only repairs what is missing.');
      const msg = out.join('\n');
      Logger.log(msg);
      return msg;
    }

    // --- results
    const cache = sheetReadResults_();
    const results = Object.keys(cache)
      .filter(function (id) { return id.indexOf(SELFTEST_PREFIX) !== 0; })
      .map(function (id) { return cache[id]; });
    out.push('results : ' + pgUpsertResults_(results) + ' copied');

    // --- users. Roles are free text in the Sheet and constrained in Postgres.
    const users = [], skipped = [];
    for (const u of sheetReadUsers_()) {
      if (!u.email) continue;
      if (u.role && u.role !== 'admin' && u.role !== 'player') skipped.push(u.email + '="' + u.role + '"');
      users.push({ email: u.email, role: u.role === 'admin' ? 'admin' : 'player' });
    }
    out.push('users   : ' + pgUpsertUsers_(users) + ' copied'
      + (skipped.length ? ' (unrecognised role defaulted to player: ' + skipped.join(', ') + ')' : ''));

    out.push('');
    out.push('Now run compareBackends(). The Sheet has not been modified.');
    const msg = out.join('\n');
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Read both backends and report every difference. This is what makes the
 * cutover a decision rather than a leap — nothing is deleted and nothing is
 * switched, it just tells you whether the two agree.
 */
function compareBackends() {
  const sheetPicks = sheetReadPicks_().filter(function (p) {
    return p.week !== SELFTEST_WEEK && !!(p.id || p.gameId || p.email);
  });
  const pgPicks = pgReadPicks_().filter(function (p) { return p.week !== SELFTEST_WEEK; });

  const out = [];
  const problems = [];

  out.push('picks : Sheet ' + sheetPicks.length + '  Postgres ' + pgPicks.length);
  if (sheetPicks.length !== pgPicks.length) problems.push('pick counts differ');

  // Field-level comparison on the rows that exist in both.
  const pgById = {};
  for (const p of pgPicks) pgById[p.id] = p;

  const missing = [], mismatched = [];
  for (const s of sheetPicks) {
    const id = s.id || ('legacy_' + s._key);
    const t = pgById[id];
    if (!t) { missing.push(id); continue; }
    for (const f of ['week', 'email', 'user', 'league', 'gameId', 'market', 'kind', 'selection']) {
      if (String(s[f] || '') !== String(t[f] || '')) {
        mismatched.push(id + '.' + f + ': "' + s[f] + '" vs "' + t[f] + '"');
        break;
      }
    }
    // status '' in the Sheet is 'pending' in Postgres, which is not a mismatch.
    const ss = s.status || 'pending', ts = t.status || 'pending';
    if (ss !== ts) mismatched.push(id + '.status: "' + ss + '" vs "' + ts + '"');

    const sm = parseMeta_(s.meta) || {}, tm = parseMeta_(t.meta) || {};
    for (const k of ['line', 'total']) {
      const a = sm[k] === undefined ? null : Number(sm[k]);
      const b = tm[k] === undefined ? null : Number(tm[k]);
      if (String(a) !== String(b)) mismatched.push(id + '.meta.' + k + ': ' + a + ' vs ' + b);
    }
  }
  if (missing.length)    problems.push(missing.length + ' pick(s) missing from Postgres');
  if (mismatched.length) problems.push(mismatched.length + ' field mismatch(es)');

  // --- results
  const sr = sheetReadResults_(), pr = pgReadResults_();
  const srIds = Object.keys(sr).filter(function (i) { return i.indexOf(SELFTEST_PREFIX) !== 0; });
  out.push('results: Sheet ' + srIds.length + '  Postgres ' + Object.keys(pr).length);
  for (const id of srIds) {
    const a = sr[id], b = pr[id];
    if (!b) { problems.push('result ' + id + ' missing from Postgres'); continue; }
    if (String(a.homeScore) !== String(b.homeScore) || String(a.awayScore) !== String(b.awayScore)) {
      problems.push('result ' + id + ' scores differ: ' + a.homeScore + '-' + a.awayScore
        + ' vs ' + b.homeScore + '-' + b.awayScore);
    }
    if (!!a.completed !== !!b.completed) problems.push('result ' + id + ' completed flag differs');
  }

  // --- the thing that actually matters: does the scoreboard come out the same?
  const st = talliesFrom_(sheetPicks).users, pt = talliesFrom_(pgPicks).users;
  const names = {};
  for (const n of Object.keys(st)) names[n] = true;
  for (const n of Object.keys(pt)) names[n] = true;
  out.push('users  : ' + Object.keys(names).length + ' on the board');

  for (const n of Object.keys(names)) {
    const a = st[n], b = pt[n];
    if (!a || !b) { problems.push(n + ' appears on only one backend'); continue; }
    for (const f of ['wins', 'losses', 'pushes', 'pending']) {
      if (a[f] !== b[f]) problems.push(n + ' ' + f + ': ' + a[f] + ' vs ' + b[f]);
    }
  }

  if (mismatched.length) {
    out.push('');
    out.push('FIELD MISMATCHES (first 10):');
    for (const m of mismatched.slice(0, 10)) out.push('  ' + m);
  }
  if (missing.length) {
    out.push('');
    out.push('MISSING FROM POSTGRES (first 10): ' + missing.slice(0, 10).join(', '));
  }

  const msg = problems.length
    ? out.join('\n') + '\n\nNOT READY - ' + problems.length + ' problem(s):\n  '
      + problems.slice(0, 15).join('\n  ')
      + '\n\nRe-run migrateSheetsToPostgres(), then compare again.'
    : out.join('\n') + '\n\nIDENTICAL - both backends agree on every pick, result and record.\n'
      + '  Safe to set Script Property STORAGE = postgres.\n'
      + '  Then run runSelfTest() to confirm grading works against it.';

  Logger.log(msg);
  return msg;
}

// ===== LIVE END-TO-END TEST ==================================================
// runSelfTest proves the grading rules and the database write-back, but it
// feeds itself invented scores, so the one thing it cannot cover is the part
// that talks to the network: fetchScores_, the event-id join, and the mapping
// of the feed's score array onto home and away.
//
// This closes that gap using a real game that has actually finished. It finds
// one in the live feed, invents picks whose correct verdicts are arithmetic
// from the real final score, runs the real autoGrade(), checks every verdict
// and deletes what it made.
//
// Costs a handful of API credits — one discovery call plus whatever autoGrade
// spends. Run it once to gain confidence, not on a schedule.

/** A completed game from the live feed, or null out of season. */
function findFinishedGame_() {
  for (const league of ['NFL', 'NCAAF']) {
    let games = [];
    try { games = fetchScores_(league, null); } catch (e) { continue; }
    for (const g of games) {
      const hs = num_(g.homeScore), as = num_(g.awayScore);
      // A tie settles nothing on the moneyline, so prefer a decisive result.
      if (g.completed && isFinite(hs) && isFinite(as) && hs !== as) {
        return { league: league, game: g, homeScore: hs, awayScore: as };
      }
    }
  }
  return null;
}

/**
 * Picks whose right answers follow from the real score, so the expectations
 * cannot drift from reality the way a hardcoded fixture can.
 */
function livePicksFor_(found) {
  const g = found.game, hs = found.homeScore, as = found.awayScore;
  const homeWon = hs > as;
  const winner  = homeWon ? g.home_team : g.away_team;
  const loser   = homeWon ? g.away_team : g.home_team;
  const margin  = Math.abs(hs - as);
  const total   = hs + as;

  return [
    { why: 'moneyline on the winner',      market: 'moneyline', kind: 'ml',
      selection: winner, meta: {}, expect: 'win' },
    { why: 'moneyline on the loser',       market: 'moneyline', kind: 'ml',
      selection: loser,  meta: {}, expect: 'loss' },

    // The winner covers a number half a point short of the real margin and
    // fails to cover one half a point beyond it.
    { why: 'winner covers ' + (margin - 0.5), market: 'spread', kind: 'favorite',
      selection: winner, meta: { line: -(margin - 0.5) }, expect: 'win' },
    { why: 'winner misses ' + (margin + 0.5), market: 'spread', kind: 'favorite',
      selection: winner, meta: { line: -(margin + 0.5) }, expect: 'loss' },
    { why: 'loser covers +' + (margin + 0.5), market: 'spread', kind: 'underdog',
      selection: loser,  meta: { line: (margin + 0.5) },  expect: 'win' },

    { why: 'over ' + (total - 0.5),  market: 'total', kind: 'over',
      selection: 'Over',  meta: { total: total - 0.5 }, expect: 'win' },
    { why: 'under ' + (total - 0.5), market: 'total', kind: 'under',
      selection: 'Under', meta: { total: total - 0.5 }, expect: 'loss' },
    { why: 'total lands on ' + total, market: 'total', kind: 'over',
      selection: 'Over',  meta: { total: total },       expect: 'push' }
  ];
}

/**
 * The end-to-end check. Run from the editor when games have been played in the
 * last three days.
 */
function testAutoGradeLive() {
  const found = findFinishedGame_();
  if (!found) {
    const msg = 'No completed game in the feed right now (daysFrom maxes at 3).\n'
      + '  Out of season this is expected, not a failure. Try again on a game day -\n'
      + '  checkOddsApi() shows what the feed currently holds.';
    Logger.log(msg);
    return msg;
  }

  const g = found.game;
  const label = g.away_team + ' @ ' + g.home_team + '  '
    + found.homeScore + '-' + found.awayScore + '  [' + g.gameId + ']';

  try {
    selfTestCleanup_();                 // clear anything a previous run left

    const fixtures = livePicksFor_(found);
    insertPicks_(fixtures.map(function (p, i) {
      return {
        id: SELFTEST_PREFIX + 'live_' + i, week: SELFTEST_WEEK, email: SELFTEST_EMAIL,
        user: 'Selftest', league: found.league, gameId: g.gameId,
        matchup: g.away_team + ' @ ' + g.home_team,
        market: p.market, kind: p.kind, selection: p.selection,
        odds: '', meta: JSON.stringify(p.meta), status: 'pending', ts: new Date()
      };
    }));

    // The real thing, network and all — the same call the trigger makes. The
    // result cache is deliberately not pre-filled, so this has to go and get
    // the score itself.
    const run = autoGrade();

    const got = {};
    for (const p of readPicks_()) {
      if (p.week === SELFTEST_WEEK) got[p.id] = p.status;
    }

    const failures = [];
    fixtures.forEach(function (p, i) {
      const actual = got[SELFTEST_PREFIX + 'live_' + i];
      if (actual !== p.expect) {
        failures.push('  ' + p.market + ' / ' + p.why + ': expected ' + p.expect + ', got ' + actual);
      }
    });

    const head = 'Real game used: ' + label;
    const msg = failures.length
      ? 'LIVE TEST FAILED - ' + failures.length + ' of ' + fixtures.length + ' wrong\n'
        + head + '\n' + failures.join('\n')
        + '\n\nThe scores came back from the API, so this is a grading or a name-matching\n'
        + 'problem rather than a connection one.'
      : 'LIVE TEST PASSED - all ' + fixtures.length + ' picks graded correctly against a real game.\n'
        + head + '\n'
        + '  credits used this run: ' + (run && run.creditsUsed !== undefined ? run.creditsUsed : '?') + '\n'
        + '  This is the only check that covers fetchScores_, the event-id join and\n'
        + '  the home/away mapping. Auto-grading is working end to end.';

    Logger.log(msg);
    return msg;
  } finally {
    selfTestCleanup_();
  }
}
