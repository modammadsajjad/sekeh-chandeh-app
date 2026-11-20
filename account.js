'use strict';
// Part 4: files (upload/download), my account, user management, shared settings, stats

module.exports = ({ q, bad, str, fa, body, rate, hashPw, checkPw }) => {
  const MAX = 4 * 1024 * 1024; // 4 MB per file
  const SIG = { // allowed types, with a check of the real file content
    'image/jpeg': b => b[0] === 0xFF && b[1] === 0xD8,
    'image/png': b => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])),
    'image/webp': b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
    'application/pdf': b => b.subarray(0, 4).toString() === '%PDF',
    'text/plain': b => !b.includes(0)
  };
  const SETTING_KEYS = ['transfer_phone', 'pay_card', 'pay_card_holder', 'support_id', 'channel_link', 'channel_link2', 'faq_text', 'rules_text'];
  const PREF_KEYS = ['chat_bg', 'bubble_user', 'bubble_support', 'font_size'];
  const num = (v, min, max) => { const n = Number(fa(String(v))); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

  async function init() {
    await q("alter table users add column if not exists prefs text not null default '{}'");
    await q(`create table if not exists files(
      id serial primary key, owner_id int not null, name text not null, mime text not null,
      size int not null, data bytea not null, created_at timestamptz not null default now())`);
    await q('create index if not exists files_owner_idx on files(owner_id)');
  }

  async function settings() {
    const r = await q('select k, v from settings where k = any($1)', [SETTING_KEYS]);
    return Object.fromEntries(r.rows.map(x => [x.k, x.v]));
  }

  async function pub(req, p) {
    if (p === '/settings' && req.method === 'GET') return { settings: await settings() };
  }

  async function route(req, p, user) {
    const m = req.method; let r;
    if (p === '/files' && m === 'POST') {
      rate('up:' + user.id, 20, 600000);
      const b = await body(req, 6e6);
      const mime = str(b.mime, 60);
      if (!SIG[mime]) throw bad('نوع فایل مجاز نیست. فقط عکس (jpg, png, webp)، pdf و متن.');
      const raw = typeof b.data === 'string' ? b.data.replace(/^data:[^,]*,/, '') : '';
      const buf = Buffer.from(raw, 'base64');
      if (!buf.length) throw bad('فایل خالی است.');
      if (buf.length > MAX) throw bad('حجم فایل بیش از ۴ مگابایت است.', 413);
      if (!SIG[mime](buf)) throw bad('محتوای فایل با نوع آن نمی‌خواند.');
      const name = str(b.name, 120) || 'file';
      const f = (await q('insert into files(owner_id,name,mime,size,data) values($1,$2,$3,$4,$5) returning id,name,mime,size',
        [user.id, name, mime, buf.length, buf])).rows[0];
      return { file: f };
    }
    if ((r = /^\/files\/(\d+)$/.exec(p)) && m === 'GET') {
      const id = +r[1];
      const f = (await q('select * from files where id=$1', [id])).rows[0];
      if (!f) throw bad('پیدا نشد.', 404);
      let ok = user.role === 'admin' || f.owner_id === user.id;
      if (!ok) { // profile photos are visible to everyone logged in; chat files only to the chat owner
        ok = (await q(`select 1 where exists(select 1 from users where avatar=$1 and not deleted)
                       or exists(select 1 from support_messages where file_id=$2 and user_id=$3)`, [String(id), id, user.id])).rows.length > 0;
      }
      if (!ok) throw bad('دسترسی ندارید.', 403);
      const inline = f.mime.startsWith('image/');
      return { __raw: { status: 200, body: f.data, headers: {
        'content-type': f.mime, 'content-length': f.data.length, 'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=86400',
        'content-disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.name)
      } } };
    }
    if (p === '/me' && m === 'PUT') {
      const b = await body(req, 1e4), f = [], v = [];
      const set = (col, val) => { v.push(val); f.push(col + '=$' + v.length); };
      if (b.phone !== undefined) { const x = str(fa(b.phone), 11); if (!/^09\d{9}$/.test(x)) throw bad('شماره موبایل نامعتبر است.'); set('phone', x); }
      if (b.card !== undefined) { const x = str(fa(b.card), 16); if (!/^\d{16}$/.test(x)) throw bad('شماره کارت باید ۱۶ رقم باشد.'); set('card', x); }
      if (b.avatar_file_id !== undefined) {
        if (!b.avatar_file_id) set('avatar', '');
        else {
          const id = num(b.avatar_file_id, 1, 2147483647);
          const ok = id && (await q("select 1 from files where id=$1 and owner_id=$2 and mime like 'image/%'", [id, user.id])).rows.length;
          if (!ok) throw bad('عکس نامعتبر است.');
          set('avatar', String(id));
        }
      }
      if (!f.length) throw bad('چیزی برای تغییر نیست.');
      v.push(user.id);
      const u = (await q('update users set ' + f.join(',') + ' where id=$' + v.length + ' returning *', v)).rows[0];
      let prefs = {}; try { prefs = JSON.parse(u.prefs); } catch (e) {}
      return { user: { id: u.id, username: u.username, phone: u.phone, card: u.card, avatar: u.avatar, role: u.role, prefs } };
    }
    if (p === '/me/password' && m === 'POST') {
      rate('pw:' + user.id, 5, 600000);
      const b = await body(req, 1e4);
      if (!checkPw(b.old_password, user.pw)) throw bad('رمز فعلی اشتباه است.');
      const np = typeof b.new_password === 'string' ? b.new_password : '';
      if (np.length < 6 || np.length > 100) throw bad('رمز جدید حداقل ۶ کاراکتر باشد.');
      await q('update users set pw=$1 where id=$2', [hashPw(np), user.id]);
      return { ok: true };
    }
    if (p === '/me/prefs' && m === 'PUT') {
      const b = await body(req, 1e4);
      let cur = {}; try { cur = JSON.parse(user.prefs); } catch (e) {}
      for (const k of PREF_KEYS) if (b[k] !== undefined) {
        if (b[k] === null || b[k] === '') delete cur[k];
        else if (typeof b[k] === 'string' && b[k].length <= 40) cur[k] = b[k];
        else throw bad('مقدار ' + k + ' نامعتبر است.');
      }
      await q('update users set prefs=$1 where id=$2', [JSON.stringify(cur), user.id]);
      return { prefs: cur };
    }
    if (p === '/me' && m === 'DELETE') {
      rate('del:' + user.id, 5, 600000);
      const b = await body(req, 1e4);
      if (user.role === 'admin') throw bad('حساب مدیر حذف نمی‌شود.', 403);
      if (!checkPw(b.password, user.pw)) throw bad('رمز اشتباه است.');
      await q('update users set deleted=true where id=$1', [user.id]);
      return { ok: true };
    }
  }

  async function admin(req, p) {
    const m = req.method; let r;
    if (p === '/users' && m === 'GET') {
      const s = (new URL(req.url, 'http://x').searchParams.get('search') || '').trim().slice(0, 30);
      const x = await q(`select id, username, phone, card, avatar, disabled, created_at from users
        where role='user' and not deleted and ($1='' or position(lower($1) in lower(username))>0 or position($1 in phone)>0)
        order by id desc limit 100`, [s]);
      return { users: x.rows };
    }
    if ((r = /^\/users\/(\d+)$/.exec(p)) && m === 'PUT') {
      const b = await body(req, 1e4);
      if (typeof b.disabled !== 'boolean') throw bad('مقدار نامعتبر است.');
      const x = await q("update users set disabled=$1 where id=$2 and role='user' and not deleted returning id, username, disabled", [b.disabled, +r[1]]);
      if (!x.rows[0]) throw bad('کاربر پیدا نشد.', 404);
      return { user: x.rows[0] };
    }
    if ((r = /^\/users\/(\d+)\/password$/.exec(p)) && m === 'POST') {
      const b = await body(req, 1e4), np = typeof b.new_password === 'string' ? b.new_password : '';
      if (np.length < 6 || np.length > 100) throw bad('رمز جدید حداقل ۶ کاراکتر باشد.');
      const x = await q("update users set pw=$1 where id=$2 and role='user' and not deleted returning id", [hashPw(np), +r[1]]);
      if (!x.rows[0]) throw bad('کاربر پیدا نشد.', 404);
      return { ok: true };
    }
    if (p === '/stats' && m === 'GET') {
      const one = async sql => +(await q(sql)).rows[0].n;
      const bytes = await one('select pg_database_size(current_database())::bigint n');
      return {
        users: await one("select count(*)::int n from users where role='user' and not deleted"),
        pending_orders: await one("select count(*)::int n from orders where status='pending'"),
        pending_wallet: await one("select count(*)::int n from wallet_requests where status='pending'"),
        unread_chats: await one("select count(distinct user_id)::int n from support_messages where sender='user' and read_at is null"),
        db_mb: Math.round(bytes / 1048576), db_limit_mb: 1024
      };
    }
    if (p === '/settings' && m === 'GET') return { settings: await settings(), keys: SETTING_KEYS };
    if (p === '/settings' && m === 'PUT') {
      const b = await body(req, 1e5);
      for (const k of SETTING_KEYS) if (b[k] !== undefined) {
        const v = str(String(b[k]), 2000);
        if (!v) await q('delete from settings where k=$1', [k]);
        else await q('insert into settings(k,v) values($1,$2) on conflict (k) do update set v=excluded.v', [k, v]);
      }
      return { settings: await settings() };
    }
  }

  return { init, pub, route, admin };
};
