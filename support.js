'use strict';
// Part 6: support chat (one private chat per user). Nothing is deleted automatically.

module.exports = ({ q, bad, str, body, featureOn, rate, tx }) => {
  const ID = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 2147483647 ? n : null; };
  const pubMsg = m => ({
    id: +m.id, from: m.sender, text: m.body, read: !!m.read_at, created_at: m.created_at,
    file: m.file_id ? { id: m.file_id, name: m.fname, mime: m.fmime, size: m.fsize } : null
  });
  const SEL = `select m.*, f.name fname, f.mime fmime, f.size fsize from support_messages m left join files f on f.id=m.file_id`;

  async function init() {
    await q(`create table if not exists support_messages(
      id bigserial primary key, user_id int not null references users(id),
      sender text not null check (sender in ('user','admin')), body text not null default '',
      file_id int, created_at timestamptz not null default now(), read_at timestamptz)`);
    await q('create index if not exists support_user_idx on support_messages(user_id, id)');
    await q('create index if not exists support_unread_idx on support_messages(sender, read_at)');
  }

  async function fileOwnedBy(fid, owner) {
    if (fid == null) return null;
    const id = ID(fid);
    if (!id || !(await q('select 1 from files where id=$1 and owner_id=$2', [id, owner])).rows.length) throw bad('فایل نامعتبر است.');
    return id;
  }
  async function add(thread, sender, owner, b) {
    const text = str(b.text, 2000), fid = await fileOwnedBy(b.file_id, owner);
    if (!text && !fid) throw bad('پیام خالی است.');
    const id = (await q('insert into support_messages(user_id,sender,body,file_id) values($1,$2,$3,$4) returning id', [thread, sender, text, fid])).rows[0].id;
    return { message: pubMsg((await q(SEL + ' where m.id=$1', [id])).rows[0]) };
  }
  async function list(uid, after, limit) {
    const x = await q(`select * from (${SEL} where m.user_id=$1 and m.id>$2 order by m.id ${after ? 'asc' : 'desc'} limit ${limit}) t order by id`, [uid, after]);
    return x.rows.map(pubMsg);
  }

  async function route(req, p, user) {
    const m = req.method;
    if (p === '/support/messages' && m === 'GET') {
      if (!(await featureOn('support'))) throw bad('پشتیبانی فعلاً غیرفعال است.', 403);
      const after = +new URL(req.url, 'http://x').searchParams.get('after') || 0;
      await q("update support_messages set read_at=now() where user_id=$1 and sender='admin' and read_at is null", [user.id]);
      const messages = await list(user.id, after, 200);
      // my messages up to this id were read by support (the app marks them as read)
      const ru = (await q("select max(id) id from support_messages where user_id=$1 and sender='user' and read_at is not null", [user.id])).rows[0].id;
      return { messages, read_upto: ru ? +ru : 0 };
    }
    if (p === '/support/unread' && m === 'GET') {
      const n = (await q("select count(*)::int n from support_messages where user_id=$1 and sender='admin' and read_at is null", [user.id])).rows[0].n;
      return { count: n };
    }
    if (p === '/support/messages' && m === 'POST') {
      if (!(await featureOn('support'))) throw bad('پشتیبانی فعلاً غیرفعال است.', 403);
      rate('sup:' + user.id, 30, 60000);
      return add(user.id, 'user', user.id, await body(req, 1e5));
    }
  }

  async function admin(req, p, adminUser) {
    const m = req.method; let r;
    if (p === '/support/threads' && m === 'GET') {
      const x = await q(`select u.id user_id, u.username, u.avatar, l.id last_id, l.body last_text, l.file_id last_file,
          l.sender last_sender, l.created_at last_at,
          (select count(*)::int from support_messages z where z.user_id=u.id and z.sender='user' and z.read_at is null) unread
        from users u join lateral (select * from support_messages s where s.user_id=u.id order by s.id desc limit 1) l on true
        where not u.deleted order by l.id desc limit 200`);
      return { threads: x.rows.map(t => ({ user_id: t.user_id, username: t.username, avatar: t.avatar, last_text: t.last_text,
        last_has_file: !!t.last_file, last_from: t.last_sender, last_at: t.last_at, unread: t.unread })) };
    }
    if ((r = /^\/support\/threads\/(\d+)\/messages$/.exec(p))) {
      const uid = +r[1];
      if (m === 'GET') {
        const u = (await q('select id, username, avatar from users where id=$1', [uid])).rows[0];
        if (!u) throw bad('کاربر پیدا نشد.', 404);
        const after = +new URL(req.url, 'http://x').searchParams.get('after') || 0;
        await q("update support_messages set read_at=now() where user_id=$1 and sender='user' and read_at is null", [uid]);
        return { user: u, messages: await list(uid, after, 500) };
      }
      if (m === 'POST') {
        if (!(await q('select 1 from users where id=$1 and not deleted', [uid])).rows.length) throw bad('کاربر پیدا نشد.', 404);
        return add(uid, 'admin', adminUser.id, await body(req, 1e5));
      }
    }
    // manual delete of a whole chat (the only way chats are ever removed)
    if ((r = /^\/support\/threads\/(\d+)$/.exec(p)) && m === 'DELETE') {
      const uid = +r[1];
      return tx(async c => {
        const ids = (await c.query('select distinct file_id from support_messages where user_id=$1 and file_id is not null', [uid])).rows.map(x => x.file_id);
        await c.query('delete from support_messages where user_id=$1', [uid]);
        if (ids.length) await c.query(`delete from files where id = any($1)
          and id not in (select proof_file from orders where proof_file is not null)
          and id not in (select proof_file from wallet_requests where proof_file is not null)
          and not exists (select 1 from users where avatar = files.id::text)`, [ids]);
        return { ok: true };
      });
    }
  }

  return { init, route, admin };
};
