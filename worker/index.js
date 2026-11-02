// mcgeehenry.com Worker. Static files in ./public are served directly; only /api/* reaches this code.
//
//   POST /api/feedback            a tester saves their notes (anyone; honeypot, size cap, daily limit)
//   GET  /api/feedback/responses  every saved response, newest first (Henry only: needs FEEDBACK_ADMIN_KEY)
//   DELETE /api/feedback/responses/:id   remove one response (Henry only)
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

let ready = null;
function ensureTable(env) {
  if (!ready) ready = env.DB.prepare(SCHEMA).run().catch((e) => { ready = null; throw e; });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/feedback' && request.method === 'POST') return await saveFeedback(request, env);
      if (url.pathname === '/api/feedback/responses' && request.method === 'GET') return await listFeedback(request, env);
      const m = url.pathname.match(/^\/api\/feedback\/responses\/(\d+)$/);
      if (m && request.method === 'DELETE') return await deleteFeedback(request, env, Number(m[1]));
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: 'Something went wrong saving that. Please try again.' }, 500);
    }
  },
};
