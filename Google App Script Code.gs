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
function checkSetup() {
  const out = [];
  for (const k of ['ODDS_API_KEY', 'SHEET_ID']) {
    const v = props_().getProperty(k);
    out.push(k + ': ' + (v ? 'set (' + v.length + ' chars)' : 'MISSING'));
  }
  try {
    const ss = SpreadsheetApp.openById(sheetId_());
    out.push('Sheet opens OK: "' + ss.getName() + '"');
  } catch (e) {
    out.push('Sheet FAILED to open: ' + e.message);
  }
  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ===== HTTP HANDLERS =========================================================
// GET: odds (league=nfl|ncaaf[,nocache=1]), mine (email), board, isAdmin (email)
function doGet(e) {
  e = e || {};
  const p = e.parameter || {};
  try {
    if (p.fn === 'odds')    return asJson(ok(getOdds_(String(p.league || ''), p.weekStart, { noCache: String(p.nocache) === '1' })));
    if (p.fn === 'mine')    return asJson(ok({ picks: getMyPicks_(String(p.email || '')) }));
    if (p.fn === 'board')   return asJson(ok({ rows: getBoard_() }));
    if (p.fn === 'weeks')   return asJson(ok({ weeks: getWeeks_() }));
    if (p.fn === 'week')    return asJson(ok(getWeek_(String(p.week || ''))));
    if (p.fn === 'isAdmin') return asJson(ok({ admin: isAdminEmail_(String(p.email || '')) }));
    return asJson(err('Unknown fn'));
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
  const sh = openSheet_('Users');
  const data = sh.getDataRange().getValues();
  if (!data || data.length < 2) return false;
  const headers = data[0];
  const idxEmail = headers.indexOf('email');
  const idxRole  = headers.indexOf('role');
  if (idxEmail < 0 || idxRole < 0) return false;
  const needle = String(email).trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][idxEmail] || '').trim().toLowerCase();
    if (rowEmail === needle) {
      return String(data[i][idxRole] || '').trim().toLowerCase() === 'admin';
    }
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

const RESULTS_SHEET   = 'Results';
const RESULTS_HEADERS = [
  'gameId','league','home_team','away_team','homeScore','awayScore',
  'completed','commence','lastUpdate','fetchedAt'
];

function leagueToSport_(league) {
  return String(league).toUpperCase() === 'NFL'
    ? 'americanfootball_nfl'
    : 'americanfootball_ncaaf';
}

/** Cached results keyed by gameId. */
function readResults_() {
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
      row:        i + 1,
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
function upsertResults_(rows) {
  if (!rows || !rows.length) return 0;
  const sh = openSheet_(RESULTS_SHEET);
  ensureHeaders_(sh, RESULTS_HEADERS);
  const existing = readResults_();
  const now = new Date();
  const appends = [];
  for (const r of rows) {
    const values = [
      r.gameId, r.league, r.home_team, r.away_team,
      r.homeScore, r.awayScore, r.completed ? 'TRUE' : 'FALSE',
      r.commence || '', r.lastUpdate || '', now
    ];
    const prev = existing[r.gameId];
    if (prev) sh.getRange(prev.row, 1, 1, RESULTS_HEADERS.length).setValues([values]);
    else appends.push(values);
  }
  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, RESULTS_HEADERS.length)
      .setValues(appends);
  }
  return rows.length;
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

function runAutoGrade_() {
  const sh = openSheet_(PICKS_SHEET);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { graded: 0, stillPending: 0, creditsUsed: 0, note: 'no picks yet' };

  const H = headerIndex_(data[0]);
  const statusCol = H.status + 1;

  const pending = [];
  for (let i = 1; i < data.length; i++) {
    const status = String(data[i][H.status] || '').toLowerCase();
    if (status && status !== 'pending') continue;      // already decided
    const gameId = String(data[i][H.gameId] || '');
    if (!gameId) continue;                              // nothing to join on
    pending.push({
      row: i + 1,
      gameId,
      league:    String(data[i][H.league] || ''),
      market:    data[i][H.market],
      kind:      data[i][H.kind],
      selection: data[i][H.selection],
      meta:      data[i][H.meta]
    });
  }
  if (!pending.length) {
    return { graded: 0, stillPending: 0, creditsUsed: 0, note: 'nothing pending — no API call made' };
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
  for (const lg of Object.keys(needByLeague)) {
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

  // Write the whole status column back in one call rather than cell by cell.
  const statusValues = sh.getRange(2, statusCol, data.length - 1, 1).getValues();
  let graded = 0, stillPending = 0;
  for (const p of pending) {
    const verdict = gradePickAgainstResult_(p, cache[p.gameId]);
    if (verdict) { statusValues[p.row - 2][0] = verdict; graded++; }
    else stillPending++;
  }
  if (graded) sh.getRange(2, statusCol, statusValues.length, 1).setValues(statusValues);

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

// ===== PICKS (Sheets) ========================================================
const PICKS_SHEET   = 'Picks';
const PICKS_HEADERS = [
  'id','week','email','user','league','gameId','matchup',
  'market','kind','selection','odds','meta','status','ts'
];

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

  const sh = openSheet_(PICKS_SHEET);
  ensureHeaders_(sh, PICKS_HEADERS);

  const week = String((picks && picks[0] && picks[0].week) || '');
  const replaced = week ? clearExistingPicks_(sh, email, week) : 0;

  const rows = picks.map(p => ([
    p.id || Utilities.getUuid(),
    p.week || '',
    email,
    user || email,
    p.league || '',
    p.gameId || '',
    p.matchup || '',
    p.market || '',
    p.kind || '',
    p.selection || '',
    p.odds ?? '',
    JSON.stringify(p.meta || {}),
    (p.status || 'pending'),
    new Date(p.ts || Date.now())
  ]));

  if (!rows.length) return { count: 0, replaced };

  const startRow = sh.getLastRow() + 1; // always >= 2 after headers
  sh.getRange(startRow, 1, rows.length, PICKS_HEADERS.length).setValues(rows);
  return { count: rows.length, replaced };
}

/**
 * Delete this user's pending picks for a week. Throws if any of them have
 * already been graded, which is what stops a resubmission from erasing a
 * result. Deletes bottom-up so earlier row numbers stay valid.
 */
function clearExistingPicks_(sh, email, week) {
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return 0;
  const H = headerIndex_(data[0]);
  const needle = String(email).trim().toLowerCase();

  const victims = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][H.email] || '').trim().toLowerCase() !== needle) continue;
    if (String(data[i][H.week] || '') !== week) continue;
    const status = String(data[i][H.status] || '').toLowerCase();
    if (status && status !== 'pending') {
      throw new Error('Week ' + week + ' has already been graded — picks are locked.');
    }
    victims.push(i + 1);
  }
  for (let k = victims.length - 1; k >= 0; k--) sh.deleteRow(victims[k]);
  return victims.length;
}

// Read picks for an email (used by "My Picks" UI)
function getMyPicks_(email) {
  if (!email) throw new Error('email required');
  const sh = openSheet_('Picks');
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  const idxEmail = headers.indexOf('email');
  const picks = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[idxEmail] || '').trim().toLowerCase() === String(email).trim().toLowerCase()) {
      const obj = {};
      headers.forEach((h, ix) => obj[h] = row[ix]);

      // Parse meta if it’s a JSON string
      let meta = obj.meta;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch(_) { meta = null; }
      }
      // Compute line for display convenience
      let line = '';
      if (obj.market === 'spread' && meta && meta.line !== undefined) {
        line = meta.line;
      } else if (obj.market === 'total' && meta && meta.total !== undefined) {
        line = meta.total;
      }
      obj.line = line;

      obj.id = obj.id || ('row_' + (i + 1));
      picks.push(obj);
    }
  }
  picks.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return picks;
}

// ===== SCOREBOARD ============================================================
// One pass over the sheet builds week -> user -> record. Everything else
// (weekly winners, the season table, a single week's detail) reads off that.

function tallies_() {
  const sh = openSheet_(PICKS_SHEET);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { weeks: {}, users: {} };

  const H = headerIndex_(data[0]);
  const weeks = {};   // week -> { user -> {wins,losses,pushes,pending,total} }
  const users = {};   // user -> season totals

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const user = String(row[H.user] || '').trim();
    if (!user) continue;
    const week   = String(row[H.week] || '');
    const status = String(row[H.status] || '').toLowerCase();

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

/** Every week that has picks, newest first. */
function getWeeks_() {
  const { weeks } = tallies_();
  return Object.keys(weeks).filter(Boolean).sort().reverse().map(wk => {
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
  const sh = openSheet_(PICKS_SHEET);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idxId     = headers.indexOf('id');
  const idxStatus = headers.indexOf('status');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idxId]) === String(id)) {
      sh.getRange(i + 1, idxStatus + 1).setValue(String(result || '').toLowerCase());
      return { id, result };
    }
  }
  throw new Error('pick not found');
}
