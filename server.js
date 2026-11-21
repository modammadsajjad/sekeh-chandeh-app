'use strict';
// Sekeh Chandeh app server - core (database, accounts, feature switches) + modules
const http = require('http'), crypto = require('crypto');
const { Pool } = require('pg');

const PORT = +process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'owner';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const SECRET = process.env.TOKEN_SECRET || '';
if (SECRET.length < 24) { console.error('TOKEN_SECRET (min 24 chars) is required'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
pool.on('error', e => console.error('pg pool error:', e.message));
const q = (sql, params) => pool.query(sql, params);

// ---------- helpers ----------
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => new HttpError(s, m);
const str = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const fa = v => typeof v === 'string'
  ? v.replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)) : v;
const b64 = b => Buffer.from(b).toString('base64url');
const sig = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function sign(o, ttl) { const p = b64(JSON.stringify({ ...o, exp: Date.now() + ttl })); return p + '.' + sig(p); }
function verify(t) {
  if (typeof t !== 'string') return null;
  const [p, s] = t.split('.'); if (!p || !s) return null;
  const e = sig(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, h) {
  if (!h || typeof pw !== 'string') return false;
  const [salt, hex] = h.split(':'); if (!salt || !hex || hex.length !== 64) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(hex, 'hex'));
}
const tries = new Map();
function limit(req, n = 10) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const r = tries.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - r.t > 600000) { r.n = 0; r.t = Date.now(); }
  if (++r.n > n) throw bad('تعداد تلاش بیش از حد است. چند دقیقه بعد دوباره امتحان کنید.', 429);
  tries.set(ip, r);
}
function body(req, max = 1e6) {
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > max) { no(bad('حجم درخواست زیاد است.', 413)); req.destroy(); } else c.push(d); });
    req.on('end', () => { if (!c.length) return ok({}); try { ok(JSON.parse(Buffer.concat(c))); } catch (e) { no(bad('درخواست نامعتبر است.')); } });
    req.on('error', no);
  });
}
const parseJson = t => { try { return JSON.parse(t || '{}'); } catch (e) { return {}; } };
const pubUser = u => ({ id: u.id, username: u.username, phone: u.phone, card: u.card, avatar: u.avatar, role: u.role, prefs: parseJson(u.prefs) });
// simple in-memory limiter per key (for uploads, messages, ...)
const rl = new Map();
function rate(key, n, ms) {
  const now = Date.now(), a = (rl.get(key) || []).filter(t => now - t < ms);
  if (a.length >= n) throw bad('تعداد درخواست‌ها زیاد است. کمی صبر کنید.', 429);
  a.push(now); rl.set(key, a);
}
// run several queries in one transaction
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { try { await c.query('rollback'); } catch (_) {} throw e; }
  finally { c.release(); }
}

// ---------- database ----------
const FEATURES = [ // key, label, enabled by default
  ['sell', 'فروش سکه', true], ['buy', 'خرید سکه', false], ['wallet', 'کیف پول', true],
  ['support', 'پشتیبانی', true], ['leaderboard', 'رتبه‌بندی', true], ['comments', 'ارسال نظر', true],
  ['announcements', 'اعلان‌ها', true], ['ai_assistant', 'دستیار هوشمند', false]
];
async function init() {
  await q(`create table if not exists users(
    id serial primary key, username text not null, phone text not null default '', card text not null default '',
    pw text not null, role text not null default 'user', avatar text not null default '',
    disabled boolean not null default false, deleted boolean not null default false,
    created_at timestamptz not null default now())`);
  await q('create unique index if not exists users_username_uq on users(lower(username)) where not deleted');
  await q('create table if not exists settings(k text primary key, v text not null)');
  await q('create table if not exists features(key text primary key, label text not null, enabled boolean not null default true)');
  for (const [k, l, e] of FEATURES) await q('insert into features(key,label,enabled) values($1,$2,$3) on conflict (key) do nothing', [k, l, e]);
  const a = await q("select 1 from users where role='admin' limit 1");
  if (!a.rows.length) {
    if (ADMIN_PASS.length >= 6) {
      await q("insert into users(username,pw,role) values($1,$2,'admin')", [ADMIN_USER, hashPw(ADMIN_PASS)]);
      console.log('admin account created: ' + ADMIN_USER);
    } else console.warn('WARNING: no admin exists. Set ADMIN_USER and ADMIN_PASS (min 6 chars).');
  }
  for (const m of modules) if (m.init) await m.init();
  console.log('database ready');
}

// ---------- auth ----------
async function authUser(req) {
  const o = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
  const r = o && await q('select * from users where id=$1 and not deleted', [o.id]);
  const u = r && r.rows[0];
  if (!u) throw bad('ابتدا وارد شوید', 401);
  if (u.disabled) throw bad('حساب شما مسدود شده است.', 403);
  return u;
}

// ---------- routes ----------
async function api(req, p) {
  const m = req.method;
  if (p === '/features' && m === 'GET') {
    const r = await q('select key, enabled from features');
    return { features: Object.fromEntries(r.rows.map(x => [x.key, x.enabled])) };
  }
  if (p === '/register' && m === 'POST') {
    limit(req, 20); const b = await body(req, 1e5);
    const username = str(b.username, 30), phone = str(fa(b.phone), 11), card = str(fa(b.card), 16);
    const pw = typeof b.password === 'string' ? b.password : '';
    if (username.length < 3) throw bad('نام کاربری حداقل ۳ کاراکتر باشد.');
    if (!/^09\d{9}$/.test(phone)) throw bad('شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود.');
    if (!/^\d{16}$/.test(card)) throw bad('شماره کارت باید ۱۶ رقم باشد.');
    if (pw.length < 6 || pw.length > 100) throw bad('رمز عبور حداقل ۶ کاراکتر باشد.');
    let u;
    try { u = (await q('insert into users(username,phone,card,pw) values($1,$2,$3,$4) returning *', [username, phone, card, hashPw(pw)])).rows[0]; }
    catch (e) { if (e.code === '23505') throw bad('این نام کاربری قبلاً گرفته شده است.'); throw e; }
    await emit('signup', { userId: u.id });
    return { token: sign({ id: u.id }, 30 * 864e5), user: pubUser(u) };
  }
  if (p === '/login' && m === 'POST') {
    limit(req); const b = await body(req, 1e5);
    const r = await q('select * from users where lower(username)=lower($1) and not deleted', [str(b.username, 30)]);
    const u = r.rows[0];
    if (!u || !checkPw(b.password, u.pw)) throw bad('نام کاربری یا رمز عبور اشتباه است.', 401);
    if (u.disabled) throw bad('حساب شما مسدود شده است.', 403);
    return { token: sign({ id: u.id }, u.role === 'admin' ? 12 * 36e5 : 30 * 864e5), user: pubUser(u) };
  }
  for (const mod of modules) if (mod.pub) { const r = await mod.pub(req, p); if (r !== undefined) return r; }
  const user = await authUser(req);
  if (p === '/me' && m === 'GET') return { user: pubUser(user) };
  for (const mod of modules) if (mod.route) { const r = await mod.route(req, p, user); if (r !== undefined) return r; }
  if (p.startsWith('/admin/')) {
    if (user.role !== 'admin') throw bad('دسترسی ندارید', 403);
    return adminApi(req, p.slice(6), user);
  }
  throw bad('آدرس پیدا نشد.', 404);
}

async function adminApi(req, p, user) {
  const m = req.method; let r;
  if (p === '/features' && m === 'GET') return { items: (await q('select key,label,enabled from features order by key')).rows };
  if ((r = /^\/features\/([a-z_]+)$/.exec(p)) && m === 'PUT') {
    const b = await body(req, 1e4);
    if (typeof b.enabled !== 'boolean') throw bad('مقدار نامعتبر است.');
    const x = await q('update features set enabled=$1 where key=$2 returning key,label,enabled', [b.enabled, r[1]]);
    if (!x.rows[0]) throw bad('پیدا نشد.', 404);
    return x.rows[0];
  }
  for (const mod of modules) if (mod.admin) { const x = await mod.admin(req, p, user); if (x !== undefined) return x; }
  throw bad('آدرس پیدا نشد.', 404);
}

// ---------- modules (each file adds its own tables and routes) ----------
const featureOn = async k => { const r = await q('select enabled from features where key=$1', [k]); return !!(r.rows[0] && r.rows[0].enabled); };
const bus = {};
const on = (ev, fn) => (bus[ev] = bus[ev] || []).push(fn);
const emit = async (ev, d) => { for (const fn of bus[ev] || []) { try { await fn(d); } catch (e) { console.error('event ' + ev + ' failed:', e.message); } } };
const modules = ['./coins_orders', './points', './account', './wallet', './support', './community']
  .map(f => require(f)({ q, bad, str, fa, body, authUser, featureOn, on, emit, rate, tx, hashPw, checkPw }));

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const send = (s, o, h = {}) => { res.writeHead(s, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h }); res.end(JSON.stringify(o)); };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' };
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (p === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Sekeh Chandeh app server'); }
    if (!p.startsWith('/api/')) throw bad('آدرس پیدا نشد.', 404);
    const out = await api(req, p.slice(4));
    if (out && out.__raw) { res.writeHead(out.__raw.status || 200, { ...out.__raw.headers, ...cors }); return res.end(out.__raw.body); }
    send(200, out, cors);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('error:', e);
    send(e.status || 500, { error: e.status ? e.message : 'خطای سرور' }, cors);
  }
});
init().then(() => server.listen(PORT, () => console.log('listening on ' + PORT)))
  .catch(e => { console.error('startup failed:', e.message); process.exit(1); });
