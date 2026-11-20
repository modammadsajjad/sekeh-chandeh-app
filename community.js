'use strict';
// Part 7: comments (with rating) and announcements

module.exports = ({ q, bad, str, fa, body, featureOn, emit, rate }) => {
  const num = (v, min, max) => { const n = Number(fa(String(v))); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

  async function init() {
    await q(`create table if not exists comments(
      id serial primary key, user_id int not null references users(id), body text not null,
      rating int check (rating between 1 and 5), hidden boolean not null default false,
      created_at timestamptz not null default now())`);
    await q('create index if not exists comments_idx on comments(id desc)');
    await q(`create table if not exists announcements(
      id serial primary key, title text not null, body text not null default '',
      active boolean not null default true, created_at timestamptz not null default now())`);
  }

  async function route(req, p, user) {
    const m = req.method;
    if (p === '/comments' && m === 'POST') {
      if (!(await featureOn('comments'))) throw bad('ارسال نظر فعلاً غیرفعال است.', 403);
      rate('cm:' + user.id, 5, 3600000);
      const b = await body(req, 1e4), text = str(b.text, 1000);
      if (!text) throw bad('متن نظر را بنویسید.');
      const rating = b.rating == null ? null : num(b.rating, 1, 5);
      if (b.rating != null && rating === null) throw bad('امتیاز باید بین ۱ تا ۵ باشد.');
      const c = (await q('insert into comments(user_id,body,rating) values($1,$2,$3) returning id', [user.id, text, rating])).rows[0];
      await emit('comment_posted', { userId: user.id, id: c.id });
      return { ok: true };
    }
    if (p === '/comments' && m === 'GET') {
      if (!(await featureOn('comments'))) throw bad('نظرات فعلاً غیرفعال است.', 403);
      const x = await q(`select c.id, c.body, c.rating, c.created_at, u.username, u.avatar from comments c
        join users u on u.id=c.user_id where not c.hidden and not u.deleted order by c.id desc limit 50`);
      return { comments: x.rows };
    }
    if (p === '/announcements' && m === 'GET') {
      if (!(await featureOn('announcements'))) throw bad('اعلان‌ها فعلاً غیرفعال است.', 403);
      return { announcements: (await q('select id, title, body, created_at from announcements where active order by id desc limit 50')).rows };
    }
  }

  async function admin(req, p) {
    const m = req.method; let r;
    if (p === '/comments' && m === 'GET') {
      const x = await q(`select c.id, c.body, c.rating, c.hidden, c.created_at, u.username from comments c
        join users u on u.id=c.user_id order by c.id desc limit 200`);
      return { comments: x.rows };
    }
    if ((r = /^\/comments\/(\d+)$/.exec(p))) {
      if (m === 'PUT') {
        const b = await body(req, 1e4);
        if (typeof b.hidden !== 'boolean') throw bad('مقدار نامعتبر است.');
        const x = await q('update comments set hidden=$1 where id=$2 returning id, hidden', [b.hidden, +r[1]]);
        if (!x.rows[0]) throw bad('پیدا نشد.', 404);
        return x.rows[0];
      }
      if (m === 'DELETE') {
        const x = await q('delete from comments where id=$1 returning id', [+r[1]]);
        if (!x.rows[0]) throw bad('پیدا نشد.', 404);
        return { ok: true };
      }
    }
    if (p === '/announcements' && m === 'GET') return { announcements: (await q('select * from announcements order by id desc limit 200')).rows };
    if (p === '/announcements' && m === 'POST') {
      const b = await body(req, 1e5), title = str(b.title, 120);
      if (!title) throw bad('عنوان را بنویسید.');
      const a = (await q('insert into announcements(title,body,active) values($1,$2,$3) returning *', [title, str(b.body, 3000), b.active !== false])).rows[0];
      return { announcement: a };
    }
    if ((r = /^\/announcements\/(\d+)$/.exec(p))) {
      if (m === 'PUT') {
        const b = await body(req, 1e5), f = [], v = [];
        const set = (col, val) => { v.push(val); f.push(col + '=$' + v.length); };
        if (b.title !== undefined) { const t = str(b.title, 120); if (!t) throw bad('عنوان نامعتبر است.'); set('title', t); }
        if (b.body !== undefined) set('body', str(b.body, 3000));
        if (b.active !== undefined) { if (typeof b.active !== 'boolean') throw bad('مقدار نامعتبر است.'); set('active', b.active); }
        if (!f.length) throw bad('چیزی برای تغییر نیست.');
        v.push(+r[1]);
        const a = (await q('update announcements set ' + f.join(',') + ' where id=$' + v.length + ' returning *', v)).rows[0];
        if (!a) throw bad('پیدا نشد.', 404);
        return { announcement: a };
      }
      if (m === 'DELETE') {
        const x = await q('delete from announcements where id=$1 returning id', [+r[1]]);
        if (!x.rows[0]) throw bad('پیدا نشد.', 404);
        return { ok: true };
      }
    }
  }

  return { init, route, admin };
};
