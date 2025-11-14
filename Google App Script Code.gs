// ====== Picks Game — Google Apps Script backend (Sheets + The Odds API) ======
// !!! Replace these with your own values in production !!!
const ODDS_API_KEY  = 'Odds API Key';  // keep private on server
const BOOKMAKERS    = 'fanduel,draftkings,betmgm';
const SHEET_ID      = 'Google Sheets ID- this links entries to the google sheet';
const CACHE_TTL_SEC = 120 * 60; // 120 minutes as only 500 api req are free a month 

// Derived: preference order array for bookmaker picking
const BOOKMAKER_PREFS = BOOKMAKERS.split(',').map(s => s.trim()).filter(Boolean);

// ===== HTTP HANDLERS =========================================================
// GET: odds (league=nfl|ncaaf[,nocache=1]), mine (email), board, isAdmin (email)
function doGet(e) {
  e = e || {};
  const p = e.parameter || {};
  try {
    if (p.fn === 'odds')    return asJson(ok(getOdds_(String(p.league || ''), p.weekStart, { noCache: String(p.nocache) === '1' })));
    if (p.fn === 'mine')    return asJson(ok({ picks: getMyPicks_(String(p.email || '')) }));
    if (p.fn === 'board')   return asJson(ok({ rows: getBoard_() }));
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
    if (fn === 'mine')  return asJson(ok({ picks: getMyPicks_(params.email || email) }));
    if (fn === 'board') return asJson(ok({ rows: getBoard_() }));
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
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(name) || ss.insertSheet(name);
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
    + '&apiKey=' + encodeURIComponent(ODDS_API_KEY);

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

// ===== PICKS (Sheets) ========================================================
const PICKS_SHEET   = 'Picks';
const PICKS_HEADERS = [
  'id','week','email','user','league','gameId','matchup',
  'market','kind','selection','odds','meta','status','ts'
];

// Append submitted picks (already validated server-side)
function submitPicks_(email, user, picks) {
  if (!email) throw new Error('email required');

  const sh = openSheet_(PICKS_SHEET);
  ensureHeaders_(sh, PICKS_HEADERS);

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

  if (!rows.length) return { count: 0 };

  const startRow = sh.getLastRow() + 1; // always >= 2 after headers
  sh.getRange(startRow, 1, rows.length, PICKS_HEADERS.length).setValues(rows);
  return { count: rows.length };
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

// Aggregate scoreboard
function getBoard_() {
  const sh = openSheet_('Picks');
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers   = data[0];
  const idxUser   = headers.indexOf('user');
  const idxStatus = headers.indexOf('status');
  const idxWeek   = headers.indexOf('week');

  const agg = {}; // user -> {wins, losses, pushes, total, weeks:Set}
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const user = String(row[idxUser] || '').trim();
    if (!user) continue;
    const status = String(row[idxStatus] || '').toLowerCase();
    const week   = String(row[idxWeek] || '');

    if (!agg[user]) agg[user] = { wins:0, losses:0, pushes:0, total:0, weeks:new Set() };

    if (status === 'win')  agg[user].wins++;
    else if (status === 'loss') agg[user].losses++;
    else if (status === 'push') agg[user].pushes++;

    agg[user].total++;
    if (week) agg[user].weeks.add(week);
  }

  const rows = Object.keys(agg).map(u => ({
    user:   u,
    wins:   agg[u].wins,
    losses: agg[u].losses,
    pushes: agg[u].pushes,
    total:  agg[u].total,
    weeks:  agg[u].weeks.size
  }))
  .sort((a,b) => (b.wins - a.wins) || (a.losses - b.losses) || a.user.localeCompare(b.user));

  return rows;
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
