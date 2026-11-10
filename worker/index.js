// mcgeehenry.com Worker. Static files in ./public are served directly; only /api/* reaches this code.
//
//   POST /api/feedback            a tester saves their notes (anyone; honeypot, size cap, daily limit)
//   GET  /api/feedback/responses  every saved response, newest first (Henry only: needs FEEDBACK_ADMIN_KEY)
//   DELETE /api/feedback/responses/:id   remove one response (Henry only)
//   POST /api/t                   the hub's visit path log: a batch of decisions from one visit (anyone; capped)
//   GET  /api/insights?days=30    every logged visit with its events, for /insights/ (Henry only)
//   DELETE /api/insights/:sid     drop one visit, e.g. a test run (Henry only)
//   GET  /api/t/on                whether recording is switched on (anyone; the hub and the Clarity tag ask first)
//   PUT  /api/insights/recording  {"on": true|false} switch recording for the whole site (Henry only)
//
// Storage is the D1 database bound as DB. The table is created on first use, so there is no migration step.
// FEEDBACK_ADMIN_KEY is a Worker secret (Cloudflare dashboard > resume-website > Settings > Variables and Secrets).
// Until it is set, the responses endpoints refuse every request.

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
];
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

// constant-time comparison of two strings
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function isHenry(request, env) {
  const auth = request.headers.get('authorization') || '';
  return sameKey(auth.replace(/^Bearer\s+/i, ''), env.FEEDBACK_ADMIN_KEY || '');
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
  if (!env.FEEDBACK_ADMIN_KEY) return json({ error: 'The admin key is not set up yet.' }, 503);
  if (!isHenry(request, env)) return json({ error: 'Wrong key.' }, 401);
  await ensureTable(env);
  const { results } = await env.DB.prepare('SELECT id, created_at, name, body, page FROM feedback ORDER BY id DESC LIMIT 1000').all();
  return json({ responses: results });
}

async function deleteFeedback(request, env, id) {
  if (!env.FEEDBACK_ADMIN_KEY) return json({ error: 'The admin key is not set up yet.' }, 503);
  if (!isHenry(request, env)) return json({ error: 'Wrong key.' }, 401);
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
  if (!env.FEEDBACK_ADMIN_KEY) return json({ error: 'The admin key is not set up yet.' }, 503);
  if (!isHenry(request, env)) return json({ error: 'Wrong key.' }, 401);
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
  if (!ev.length) return json({ ok: true });
  if (!(await recordingOn(env))) return json({ ok: true, off: true });   /* switched off: drop silently */
  const now = new Date().toISOString(), day = now.slice(0, 10);
  let visit = await env.DB.prepare('SELECT n FROM visits WHERE sid = ?').bind(sid).first();
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
  if (!keep.length) return json({ ok: true });
  const ins = env.DB.prepare('INSERT INTO visit_events (sid, t, name, data, via) VALUES (?, ?, ?, ?, ?)');
  await env.DB.batch([
    ...keep.map((e) => ins.bind(sid, Math.max(0, Math.min(864e5, Math.round(e.t))), e.n, e.d ? clip(JSON.stringify(e.d), 300) : null, clip(e.via, 40))),
    env.DB.prepare('UPDATE visits SET n = n + ?, last_at = ? WHERE sid = ?').bind(keep.length, now, sid),
  ]);
  return json({ ok: true });
}

async function listVisits(request, env, url) {
  if (!env.FEEDBACK_ADMIN_KEY) return json({ error: 'The admin key is not set up yet.' }, 503);
  if (!isHenry(request, env)) return json({ error: 'Wrong key.' }, 401);
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

async function deleteVisit(request, env, sid) {
  if (!env.FEEDBACK_ADMIN_KEY) return json({ error: 'The admin key is not set up yet.' }, 503);
  if (!isHenry(request, env)) return json({ error: 'Wrong key.' }, 401);
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
