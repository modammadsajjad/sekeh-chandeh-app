'use strict';
// Part 3: points. The admin defines activities; points are added automatically
// only when a real event is confirmed. Also the leaderboard.

module.exports = ({ q, bad, str, fa, body, featureOn, on }) => {
  const TRIGGERS = {
    signup: { label: 'ثبت‌نام', hint: '' },
    sell_confirmed: { label: 'فروش تأییدشده', hint: 'حداقل تعداد سکه در سفارش (۰ = هر مقدار)' },
    buy_confirmed: { label: 'خرید تأییدشده', hint: 'حداقل تعداد سکه در سفارش (۰ = هر مقدار)' },
    sell_count: { label: 'رسیدن به تعداد فروش تأییدشده', hint: 'تعداد فروش‌ها (حداقل ۱)' },
    comment_posted: { label: 'ارسال نظر', hint: '' },
    manual: { label: 'تأیید دستی توسط مدیر', hint: '' }
  };
  const num = (v, min, max) => {
    const n = Number(fa(String(v)));
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const pubAct = a => ({
    id: a.id, name: a.name, trigger: a.trigger, trigger_label: (TRIGGERS[a.trigger] || {}).label || a.trigger,
    threshold: a.threshold, points: a.points, limit_per_user: a.limit_per_user, enabled: a.enabled
  });

  async function init() {
    await q(`create table if not exists activities(
      id serial primary key, name text not null, trigger text not null,
      threshold int not null default 0, points int not null, limit_per_user int,
      enabled boolean not null default true, created_at timestamptz not null default now())`);
    await q(`create table if not exists points_ledger(
      id bigserial primary key, user_id int not null references users(id),
      activity_id int references activities(id), points int not null,
      reason text not null default '', ref text, created_at timestamptz not null default now())`);
    await q('create index if not exists ledger_user_idx on points_ledger(user_id, id desc)');
    await q('create index if not exists ledger_time_idx on points_ledger(created_at)');
    // one event can give points for one activity only once
    await q(`create unique index if not exists ledger_once on points_ledger(activity_id, user_id, ref)
             where activity_id is not null and ref is not null`);
  }

  // Add points for an activity only if its rules are met. Safe to call twice for the same event.
  async function award(trigger, userId, ref, data = {}) {
    const acts = (await q('select * from activities where enabled and trigger=$1', [trigger])).rows;
    for (const a of acts) {
      if ((trigger === 'sell_confirmed' || trigger === 'buy_confirmed') && !(data.qty >= a.threshold)) continue;
      if (trigger === 'sell_count' && data.count !== a.threshold) continue;
      if (a.limit_per_user) {
        const n = (await q('select count(*)::int n from points_ledger where user_id=$1 and activity_id=$2', [userId, a.id])).rows[0].n;
        if (n >= a.limit_per_user) continue;
      }
      await q('insert into points_ledger(user_id,activity_id,points,reason,ref) values($1,$2,$3,$4,$5) on conflict do nothing',
        [userId, a.id, a.points, a.name, ref]);
    }
  }

  // real events (sent by other parts of the server)
  on('signup', d => award('signup', d.userId, 'signup'));
  on('comment_posted', d => award('comment_posted', d.userId, 'comment:' + d.id));
  on('order_confirmed', async o => {
    await award(o.type + '_confirmed', o.user_id, 'order:' + o.id, { qty: o.qty });
    if (o.type === 'sell') {
      const n = (await q("select count(*)::int n from orders where user_id=$1 and type='sell' and status='confirmed'", [o.user_id])).rows[0].n;
      await award('sell_count', o.user_id, 'count:' + n, { count: n });
    }
  });

  // leaderboard periods (Iran time). monthly = last 30 days.
  const TEHRAN_NOW = "(now() at time zone 'Asia/Tehran')";
  const SINCE = {
    daily: `(date_trunc('day', ${TEHRAN_NOW}) at time zone 'Asia/Tehran')`,
    weekly: `((date_trunc('day', ${TEHRAN_NOW}) - ((extract(dow from ${TEHRAN_NOW})::int + 1) % 7) * interval '1 day') at time zone 'Asia/Tehran')`,
    monthly: "(now() - interval '30 days')",
    all: "'-infinity'::timestamptz"
  };

  async function route(req, p, user) {
    const m = req.method;
    if (p === '/leaderboard' && m === 'GET') {
      if (!(await featureOn('leaderboard'))) throw bad('رتبه‌بندی فعلاً غیرفعال است.', 403);
      const per = new URL(req.url, 'http://x').searchParams.get('period');
      const period = SINCE[per] ? per : 'daily';
      const base = `select u.id, u.username, u.avatar, sum(l.points)::int pts, min(l.created_at) first_at
        from points_ledger l join users u on u.id=l.user_id
        where l.created_at >= ${SINCE[period]} and u.role='user' and not u.disabled and not u.deleted
        group by u.id, u.username, u.avatar having sum(l.points) > 0`;
      const top = await q(`with t as (${base}) select username, avatar, pts, rank() over (order by pts desc)::int rk
        from t order by pts desc, first_at limit 50`);
      const me = await q(`with t as (${base}) select pts, (select count(*)::int + 1 from t t2 where t2.pts > t.pts) rk
        from t where id=$1`, [user.id]);
      return {
        period,
        top: top.rows.map(r => ({ rank: r.rk, username: r.username, avatar: r.avatar, points: r.pts })),
        me: me.rows[0] ? { rank: me.rows[0].rk, points: me.rows[0].pts } : null
      };
    }
    if (p === '/points' && m === 'GET') {
      const t = await q('select coalesce(sum(points),0)::int total from points_ledger where user_id=$1', [user.id]);
      const h = await q('select points, reason, created_at from points_ledger where user_id=$1 order by id desc limit 50', [user.id]);
      return { total: t.rows[0].total, history: h.rows };
    }
  }

  async function admin(req, p) {
    const m = req.method; let r;
    if (p === '/triggers' && m === 'GET') {
      return { triggers: Object.entries(TRIGGERS).map(([key, v]) => ({ key, label: v.label, threshold_hint: v.hint })) };
    }
    if (p === '/activities' && m === 'GET') {
      return { activities: (await q('select * from activities order by id')).rows.map(pubAct) };
    }
    if (p === '/activities' && m === 'POST') {
      const b = await body(req, 1e5), name = str(b.name, 80);
      if (!name) throw bad('نام فعالیت را وارد کنید.');
      if (!TRIGGERS[b.trigger]) throw bad('شرط انجام نامعتبر است.');
      const points = num(b.points, 1, 1e6);
      if (points === null) throw bad('تعداد امتیاز باید بین ۱ تا ۱۰۰۰۰۰۰ باشد.');
      const needs = b.trigger === 'sell_count' ? [1, 1e5] : (b.trigger === 'sell_confirmed' || b.trigger === 'buy_confirmed') ? [0, 1e5] : [0, 0];
      const th = num(b.threshold ?? needs[0], needs[0], needs[1]);
      if (th === null) throw bad('مقدار شرط نامعتبر است.');
      const lim = b.limit_per_user == null ? null : num(b.limit_per_user, 1, 1e5);
      if (b.limit_per_user != null && lim === null) throw bad('سقف برای هر کاربر نامعتبر است.');
      const a = (await q('insert into activities(name,trigger,threshold,points,limit_per_user,enabled) values($1,$2,$3,$4,$5,$6) returning *',
        [name, b.trigger, th, points, lim, b.enabled !== false])).rows[0];
      return { activity: pubAct(a) };
    }
    if ((r = /^\/activities\/(\d+)$/.exec(p)) && m === 'PUT') {
      const b = await body(req, 1e5), f = [], v = [];
      const set = (col, val) => { v.push(val); f.push(col + '=$' + v.length); };
      if (b.name !== undefined) { const n = str(b.name, 80); if (!n) throw bad('نام نامعتبر است.'); set('name', n); }
      if (b.points !== undefined) { const n = num(b.points, 1, 1e6); if (n === null) throw bad('امتیاز نامعتبر است.'); set('points', n); }
      if (b.threshold !== undefined) { const n = num(b.threshold, 0, 1e5); if (n === null) throw bad('مقدار شرط نامعتبر است.'); set('threshold', n); }
      if (b.limit_per_user !== undefined) {
        if (b.limit_per_user === null) set('limit_per_user', null);
        else { const n = num(b.limit_per_user, 1, 1e5); if (n === null) throw bad('سقف نامعتبر است.'); set('limit_per_user', n); }
      }
      if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw bad('مقدار نامعتبر است.'); set('enabled', b.enabled); }
      if (!f.length) throw bad('چیزی برای تغییر نیست.');
      v.push(+r[1]);
      const a = (await q('update activities set ' + f.join(',') + ' where id=$' + v.length + ' returning *', v)).rows[0];
      if (!a) throw bad('پیدا نشد.', 404);
      return { activity: pubAct(a) };
    }
    if ((r = /^\/activities\/(\d+)$/.exec(p)) && m === 'DELETE') {
      const used = (await q('select 1 from points_ledger where activity_id=$1 limit 1', [+r[1]])).rows.length;
      if (used) throw bad('از این فعالیت امتیاز داده شده است. به‌جای حذف، آن را خاموش کنید.');
      const x = await q('delete from activities where id=$1 returning id', [+r[1]]);
      if (!x.rows[0]) throw bad('پیدا نشد.', 404);
      return { ok: true };
    }
    // manual activity: the admin confirms that a user really did it
    if ((r = /^\/activities\/(\d+)\/grant$/.exec(p)) && m === 'POST') {
      const b = await body(req, 1e4);
      const a = (await q('select * from activities where id=$1', [+r[1]])).rows[0];
      if (!a) throw bad('پیدا نشد.', 404);
      if (a.trigger !== 'manual') throw bad('این فعالیت دستی نیست. امتیازش خودکار داده می‌شود.');
      if (!a.enabled) throw bad('این فعالیت خاموش است.');
      const u = (await q("select id from users where lower(username)=lower($1) and role='user' and not deleted", [str(b.username, 30)])).rows[0];
      if (!u) throw bad('کاربر پیدا نشد.', 404);
      if (a.limit_per_user) {
        const n = (await q('select count(*)::int n from points_ledger where user_id=$1 and activity_id=$2', [u.id, a.id])).rows[0].n;
        if (n >= a.limit_per_user) throw bad('این کاربر به سقف این فعالیت رسیده است.');
      }
      await q('insert into points_ledger(user_id,activity_id,points,reason,ref) values($1,$2,$3,$4,$5)',
        [u.id, a.id, a.points, a.name, 'manual:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)]);
      return { ok: true, points: a.points };
    }
    // free adjustment (add or remove points) with a written reason
    if (p === '/points/adjust' && m === 'POST') {
      const b = await body(req, 1e4), pts = num(b.points, -1e6, 1e6), reason = str(b.reason, 200);
      if (!pts) throw bad('امتیاز باید عددی غیر از صفر باشد.');
      if (!reason) throw bad('دلیل را بنویسید.');
      const u = (await q("select id from users where lower(username)=lower($1) and role='user' and not deleted", [str(b.username, 30)])).rows[0];
      if (!u) throw bad('کاربر پیدا نشد.', 404);
      await q('insert into points_ledger(user_id,points,reason) values($1,$2,$3)', [u.id, pts, reason]);
      return { ok: true };
    }
    if (p === '/points' && m === 'GET') {
      const un = new URL(req.url, 'http://x').searchParams.get('username') || '';
      const u = (await q("select id, username from users where lower(username)=lower($1) and not deleted", [un.trim().slice(0, 30)])).rows[0];
      if (!u) throw bad('کاربر پیدا نشد.', 404);
      const t = await q('select coalesce(sum(points),0)::int total from points_ledger where user_id=$1', [u.id]);
      const h = await q('select points, reason, created_at from points_ledger where user_id=$1 order by id desc limit 100', [u.id]);
      return { username: u.username, total: t.rows[0].total, history: h.rows };
    }
  }

  return { init, route, admin };
};
