// mcgeehenry.com Worker. Static files in ./public are served directly; only /api/* reaches this code.
//
//   POST /api/feedback            a tester saves their notes (anyone; honeypot, size cap, daily limit)
//   GET  /api/feedback/responses  every saved response, newest first (Henry only: signed in through Cloudflare Access)
//   DELETE /api/feedback/responses/:id   remove one response (Henry only)
//   POST /api/t                   the hub's visit path log: a batch of decisions from one visit (anyone; capped)
//   GET  /api/insights?days=30    every logged visit with its events, for /insights/ (Henry only)
//   DELETE /api/insights/:sid     drop one visit, e.g. a test run (Henry only)
//   GET  /api/insights/heat?days=30&ctx=AI-HUB&wc=laptop   mouse heatmap cells for one screen (Henry only)
//   GET  /api/t/on                whether recording is switched on (anyone; the hub and the Clarity tag ask first)
//   PUT  /api/insights/recording  {"on": true|false} switch recording for the whole site (Henry only)
//
// Storage is the D1 database bound as DB. The table is created on first use, so there is no migration step.
// Henry's pages and endpoints sit behind Cloudflare Access (Zero Trust > Access > Applications), which asks for an
// emailed one-time code and then adds a signed token (Cf-Access-Jwt-Assertion) to every request. The Worker checks that
// token's signature, issuer, audience and expiry itself, so a forged header (say on the workers.dev URL, which Access
// does not cover) gets nothing. ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.jsonc say which Access app to trust;
// until both are set, the admin endpoints refuse every request.

const MAX_TEXT = 20000;      // characters per response
const MAX_NAME = 120;
const PER_VISITOR_DAY = 20;  // saves per visitor per day

const SCHEMA = `CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT,
  body TEXT NOT NULL,
  page TEXT,
  visitor TEXT,
  day TEXT
)`;

// One row per visit (a browser tab's session) and one row per decision in it. A visit id is random and made in the
// browser; nothing ties it to a person. Country comes from Cloudflare; the address itself is never stored.
const VISIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS visits (
    sid TEXT PRIMARY KEY, started_at TEXT NOT NULL, last_at TEXT NOT NULL, day TEXT,
    w INTEGER, h INTEGER, touch INTEGER, ret INTEGER, ref TEXT, utm TEXT, country TEXT, build TEXT,
    n INTEGER NOT NULL DEFAULT 0, visitor TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS visit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, t INTEGER NOT NULL, name TEXT NOT NULL, data TEXT, via TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS visit_events_sid ON visit_events (sid, t)`,
  `CREATE INDEX IF NOT EXISTS visits_started ON visits (started_at)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  // mouse heatmap: per day, screen and window size, how often the pointer was in each cell of an 80 x 45 grid
  // (moves = tenths of a second of movement) and how many clicks landed there. Totals only, nothing per visit.
  `CREATE TABLE IF NOT EXISTS heat (
    day TEXT NOT NULL, ctx TEXT NOT NULL, wc TEXT NOT NULL, cell INTEGER NOT NULL,
    moves INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, ctx, wc, cell)
  )`,
];
const HEAT_CTX = new Set(['Home', 'AI-HUB', 'About me', 'Video', 'AI fluency', 'Leadership', 'Get in touch', 'Walkthrough', 'GitHub list', 'Tutorial']);
const HEAT_WC = new Set(['small', 'laptop', 'wide']);
const EVENTS_PER_VISIT = 600;
const VISITS_PER_ADDRESS_DAY = 60;
const EVENT_NAMES = new Set(['land', 'screen', 'channel', 'step', 'walk_close', 'close', 'app', 'app_close', 'zoom', 'video',
  'tut_start', 'tut_end', 'music', 'contact', 'repo', 'out', 'end']);

let ready = null;
function ensureTable(env) {
  if (!ready) ready = env.DB.batch([SCHEMA, ...VISIT_SCHEMA].map((q) => env.DB.prepare(q))).catch((e) => { ready = null; throw e; });
  return ready;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Cloudflare Access ----------
const b64url = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)), (c) => c.charCodeAt(0));
let certCache = { url: '', at: 0, keys: null };
async function accessKeys(team) {
  const url = `https://${team}/cdn-cgi/access/certs`;
  if (certCache.url === url && certCache.keys && Date.now() - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch(url);
  if (!r.ok) throw new Error('certs ' + r.status);
  const { keys } = await r.json();
  certCache = { url, at: Date.now(), keys: keys || [] };
  return certCache.keys;
}
function teamHost(env) { return String(env.ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }

// Returns the signed-in email when the request carries a valid Access token for this app, otherwise null.
async function accessUser(request, env) {
  const team = teamHost(env), auds = String(env.ACCESS_AUD || '').split(',').map((x) => x.trim()).filter(Boolean);
  const token = request.headers.get('cf-access-jwt-assertion') || '';
  const parts = token.split('.');
  if (!team || !auds.length || parts.length !== 3) return null;
  let header, claims;
  try { header = JSON.parse(new TextDecoder().decode(b64url(parts[0]))); claims = JSON.parse(new TextDecoder().decode(b64url(parts[1]))); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp < now || (claims.nbf && claims.nbf > now + 60)) return null;
  if (claims.iss !== `https://${team}`) return null;
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).some((a) => auds.includes(a))) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const keys = await accessKeys(team);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) { certCache.keys = null; continue; }   // keys rotate: refetch once
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    return ok ? (claims.email || 'signed in') : null;
  }
  return null;
}

// null when the request may continue, otherwise the response to send
async function adminGuard(request, env) {
  // local testing only: .dev.vars DEV_ADMIN=1, and only for requests to localhost
  if (env.DEV_ADMIN === '1' && /^(localhost|127\.0\.0\.1)$/.test(new URL(request.url).hostname)) return null;
  if (!teamHost(env) || !String(env.ACCESS_AUD || '').trim()) return json({ error: 'Cloudflare Access is not connected yet (ACCESS_TEAM_DOMAIN and ACCESS_AUD).' }, 503);
  let user = null;
  try { user = await accessUser(request, env); } catch { return json({ error: 'Could not check the sign-in. Try again.' }, 502); }
  return user ? null : json({ error: 'Your sign-in has expired. Reload the page to sign in again.', signin: true }, 401);
}

async function saveFeedback(request, env) {
  let data;
  try { data = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400); }
  if (data && data.website) return json({ ok: true });            // honeypot: filled by bots, silently dropped
  const body = String((data && data.body) || '').trim();
  const name = String((data && data.name) || '').trim().slice(0, MAX_NAME);
  const page = String((data && data.page) || '').slice(0, 200);
  if (!body) return json({ error: 'Write something first.' }, 400);
  if (body.length > MAX_TEXT) return json({ error: `Keep it under ${MAX_TEXT.toLocaleString()} characters.` }, 400);

  await ensureTable(env);
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  // only a salted hash of the address is kept, and only to enforce the daily limit
  const visitor = (await sha256(`${env.FEEDBACK_SALT || 'mcgeehenry-feedback'}|${ip}`)).slice(0, 32);
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE visitor = ? AND day = ?').bind(visitor, day).first();
  if (used && used.n >= PER_VISITOR_DAY) return json({ error: 'That is a lot of notes for one day. Try again tomorrow.' }, 429);

  await env.DB.prepare('INSERT INTO feedback (created_at, name, body, page, visitor, day) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), name || null, body, page || null, visitor, day).run();
  return json({ ok: true });
}

async function listFeedback(request, env) {
  const deny = await adminGuard(request, env); if (deny) return deny;
  await ensureTable(env);
  const { results } = await env.DB.prepare('SELECT id, created_at, name, body, page FROM feedback ORDER BY id DESC LIMIT 1000').all();
  return json({ responses: results });
}

async function deleteFeedback(request, env, id) {
  const deny = await adminGuard(request, env); if (deny) return deny;
  await ensureTable(env);
  await env.DB.prepare('DELETE FROM feedback WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// Recording is on unless Henry switched it off on /insights. Read at most once a minute per Worker instance.
let recCache = { at: 0, on: true };
async function recordingOn(env, fresh) {
  if (!fresh && Date.now() - recCache.at < 60000) return recCache.on;
  await ensureTable(env);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'recording'").first();
  recCache = { at: Date.now(), on: !row || row.value !== 'off' };
  return recCache.on;
}

async function setRecording(request, env) {
  const deny = await adminGuard(request, env); if (deny) return deny;
  let data; try { data = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400); }
  await ensureTable(env);
  const on = !!(data && data.on);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('recording', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(on ? 'on' : 'off').run();
  recCache = { at: Date.now(), on };
  return json({ on });
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

async function logVisit(request, env) {
  let data;
  try { data = JSON.parse(await request.text()); } catch { return json({ error: 'Send JSON.' }, 400); }
  const sid = String((data && data.sid) || '');
  if (!/^[0-9a-f]{12,32}$/.test(sid)) return json({ error: 'Bad visit id.' }, 400);
  const ev = Array.isArray(data.ev) ? data.ev.slice(0, 60).filter((e) => e && EVENT_NAMES.has(e.n) && Number.isFinite(e.t)) : [];
  const heat = Array.isArray(data.heat) ? data.heat.slice(0, 400).filter((h) => Array.isArray(h) && HEAT_CTX.has(h[0]) && HEAT_WC.has(h[1])
    && Number.isInteger(h[2]) && h[2] >= 0 && h[2] < 3600 && Number.isInteger(h[3]) && Number.isInteger(h[4]) && h[3] >= 0 && h[4] >= 0 && h[3] + h[4] > 0) : [];
  if (!ev.length && !heat.length) return json({ ok: true });
  if (!(await recordingOn(env))) return json({ ok: true, off: true });   /* switched off: drop silently */
  const now = new Date().toISOString(), day = now.slice(0, 10);
  let visit = await env.DB.prepare('SELECT n FROM visits WHERE sid = ?').bind(sid).first();
  if (!visit && !ev.length) return json({ ok: true });   // heat only counts for a visit that has been logged
  if (!visit) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const visitor = (await sha256(`${env.FEEDBACK_SALT || 'mcgeehenry-feedback'}|visits|${day}|${ip}`)).slice(0, 32);
    const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM visits WHERE visitor = ? AND day = ?').bind(visitor, day).first();
    if (seen && seen.n >= VISITS_PER_ADDRESS_DAY) return json({ ok: true });
    const m = data.meta || {};
    await env.DB.prepare(`INSERT OR IGNORE INTO visits (sid, started_at, last_at, day, w, h, touch, ret, ref, utm, country, build, n, visitor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .bind(sid, now, now, day, Math.round(+m.w) || null, Math.round(+m.h) || null, m.touch ? 1 : 0, m.ret ? 1 : 0,
        clip(m.ref, 120), clip(m.utm, 60), clip(request.cf && request.cf.country, 4), clip(m.v, 20), visitor).run();
    visit = { n: 0 };
  }
  const room = Math.max(0, EVENTS_PER_VISIT - visit.n);
  const keep = ev.slice(0, room);
  const ins = env.DB.prepare('INSERT INTO visit_events (sid, t, name, data, via) VALUES (?, ?, ?, ?, ?)');
  const up = env.DB.prepare(`INSERT INTO heat (day, ctx, wc, cell, moves, clicks) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, ctx, wc, cell) DO UPDATE SET moves = moves + excluded.moves, clicks = clicks + excluded.clicks`);
  const stmts = [
    ...keep.map((e) => ins.bind(sid, Math.max(0, Math.min(864e5, Math.round(e.t))), e.n, e.d ? clip(JSON.stringify(e.d), 300) : null, clip(e.via, 40))),
    // one batch covers at most ~a minute of movement, so a cell cannot take more than 600 samples or 60 clicks from it
    ...heat.map((h) => up.bind(day, h[0], h[1], h[2], Math.min(600, h[3]), Math.min(60, h[4]))),
  ];
  if (keep.length) stmts.push(env.DB.prepare('UPDATE visits SET n = n + ?, last_at = ? WHERE sid = ?').bind(keep.length, now, sid));
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

async function listVisits(request, env, url) {
  const deny = await adminGuard(request, env); if (deny) return deny;
  await ensureTable(env);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days'), 10) || 30));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { results: visits } = await env.DB.prepare(`SELECT sid, started_at, last_at, w, h, touch, ret, ref, utm, country, build, n
    FROM visits WHERE started_at >= ? ORDER BY started_at DESC LIMIT 2000`).bind(since).all();
  const { results: events } = await env.DB.prepare(`SELECT e.sid, e.t, e.name, e.data, e.via FROM visit_events e
    JOIN (SELECT sid FROM visits WHERE started_at >= ? ORDER BY started_at DESC LIMIT 2000) v ON v.sid = e.sid
    ORDER BY e.sid, e.t, e.id`).bind(since).all();
  return json({ days, visits, events, recording: await recordingOn(env, true) });
}

async function listHeat(request, env, url) {
  const deny = await adminGuard(request, env); if (deny) return deny;
  await ensureTable(env);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days'), 10) || 30));
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const ctx = url.searchParams.get('ctx') || 'AI-HUB', wc = url.searchParams.get('wc') || 'all';
  const wcSql = HEAT_WC.has(wc) ? ' AND wc = ?' : '';
  const args = HEAT_WC.has(wc) ? [since, ctx, wc] : [since, ctx];
  const { results: cells } = await env.DB.prepare(`SELECT cell, SUM(moves) AS m, SUM(clicks) AS c FROM heat WHERE day >= ? AND ctx = ?${wcSql} GROUP BY cell`).bind(...args).all();
  const { results: totals } = await env.DB.prepare(`SELECT ctx, SUM(moves) AS m, SUM(clicks) AS c FROM heat WHERE day >= ?${wcSql.replace('?', '?')} GROUP BY ctx`)
    .bind(...(HEAT_WC.has(wc) ? [since, wc] : [since])).all();
  return json({ days, ctx, wc, cells, totals });
}

async function deleteVisit(request, env, sid) {
  const deny = await adminGuard(request, env); if (deny) return deny;
  await ensureTable(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM visit_events WHERE sid = ?').bind(sid),
    env.DB.prepare('DELETE FROM visits WHERE sid = ?').bind(sid),
  ]);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/feedback' && request.method === 'POST') return await saveFeedback(request, env);
      if (url.pathname === '/api/feedback/responses' && request.method === 'GET') return await listFeedback(request, env);
      const m = url.pathname.match(/^\/api\/feedback\/responses\/(\d+)$/);
      if (m && request.method === 'DELETE') return await deleteFeedback(request, env, Number(m[1]));
      if (url.pathname === '/api/t' && request.method === 'POST') return await logVisit(request, env);
      if (url.pathname === '/api/t/on' && request.method === 'GET') return json({ on: await recordingOn(env) });
      if (url.pathname === '/api/insights/recording' && request.method === 'PUT') return await setRecording(request, env);
      if (url.pathname === '/api/insights/heat' && request.method === 'GET') return await listHeat(request, env, url);
      if (url.pathname === '/api/insights' && request.method === 'GET') return await listVisits(request, env, url);
      const v = url.pathname.match(/^\/api\/insights\/([0-9a-f]{12,32})$/);
      if (v && request.method === 'DELETE') return await deleteVisit(request, env, v[1]);
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: 'Something went wrong saving that. Please try again.' }, 500);
    }
  },
};
