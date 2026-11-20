'use strict';
// Part 5: wallet (balance is the sum of its ledger; every change is a ledger row)

module.exports = ({ q, bad, str, fa, body, featureOn, on, tx, rate }) => {
  const num = (v, min, max) => { const n = Number(fa(String(v))); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
  const pubReq = r => ({ id: r.id, type: r.type, amount: +r.amount, card: r.card, proof_file: r.proof_file,
    status: r.status, admin_note: r.admin_note, created_at: r.created_at });
  const lock = (c, u) => c.query('select pg_advisory_xact_lock($1::bigint)', [u]);
  const balance = async (c, u) => +(await c.query('select coalesce(sum(amount),0)::bigint b from wallet_tx where user_id=$1', [u])).rows[0].b;
  const refund = (c, x) => c.query("insert into wallet_tx(user_id,amount,kind,ref) values($1,$2,'withdraw_refund',$3) on conflict do nothing", [x.user_id, x.amount, 'req:' + x.id]);
  const need = async () => { if (!(await featureOn('wallet'))) throw bad('کیف پول فعلاً غیرفعال است.', 403); };

  async function init() {
    await q(`create table if not exists wallet_tx(
      id bigserial primary key, user_id int not null references users(id), amount bigint not null,
      kind text not null, ref text, note text not null default '', created_at timestamptz not null default now())`);
    await q('create index if not exists wallet_tx_user_idx on wallet_tx(user_id, id desc)');
    await q('create unique index if not exists wallet_tx_once on wallet_tx(kind, ref) where ref is not null');
    await q(`create table if not exists wallet_requests(
      id serial primary key, user_id int not null references users(id),
      type text not null check (type in ('topup','withdraw')), amount bigint not null,
      card text not null default '', proof_file int, status text not null default 'pending',
      admin_note text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
    await q('create index if not exists wallet_req_idx on wallet_requests(status, id desc)');
  }

  // a confirmed sell order paid to the wallet adds its total once
  on('order_confirmed', async o => {
    if (o.type === 'sell' && o.payout === 'wallet')
      await q("insert into wallet_tx(user_id,amount,kind,ref,note) values($1,$2,'sell_payout',$3,$4) on conflict do nothing",
        [o.user_id, o.total, 'order:' + o.id, 'فروش ' + o.coin_name]);
  });

  async function route(req, p, user) {
    const m = req.method; let r;
    if (p === '/wallet' && m === 'GET') {
      await need();
      const bal = +(await q('select coalesce(sum(amount),0)::bigint b from wallet_tx where user_id=$1', [user.id])).rows[0].b;
      const reqs = await q('select * from wallet_requests where user_id=$1 order by id desc limit 50', [user.id]);
      const txs = await q('select amount, kind, note, created_at from wallet_tx where user_id=$1 order by id desc limit 50', [user.id]);
      return { balance: bal, requests: reqs.rows.map(pubReq), history: txs.rows.map(t => ({ ...t, amount: +t.amount })) };
    }
    if (p === '/wallet/topup' && m === 'POST') {
      await need(); rate('wt:' + user.id, 10, 600000);
      const b = await body(req, 1e4), amount = num(b.amount, 1000, 1e11);
      if (!amount) throw bad('مبلغ نامعتبر است.');
      let proof = null;
      if (b.proof_file != null) {
        proof = num(b.proof_file, 1, 2147483647);
        if (!proof || !(await q('select 1 from files where id=$1 and owner_id=$2', [proof, user.id])).rows.length) throw bad('فایل نامعتبر است.');
      }
      const n = (await q("select count(*)::int n from wallet_requests where user_id=$1 and status='pending'", [user.id])).rows[0].n;
      if (n >= 5) throw bad('شما ۵ درخواست در انتظار دارید.', 429);
      const x = (await q("insert into wallet_requests(user_id,type,amount,proof_file) values($1,'topup',$2,$3) returning *", [user.id, amount, proof])).rows[0];
      return { request: pubReq(x) };
    }
    if (p === '/wallet/withdraw' && m === 'POST') {
      await need(); rate('ww:' + user.id, 10, 600000);
      const b = await body(req, 1e4), amount = num(b.amount, 1000, 1e11);
      if (!amount) throw bad('مبلغ نامعتبر است.');
      const card = str(fa(b.card || ''), 16) || user.card;
      if (!/^\d{16}$/.test(card)) throw bad('شماره کارت باید ۱۶ رقم باشد.');
      return tx(async c => {
        await lock(c, user.id);
        const n = (await c.query("select count(*)::int n from wallet_requests where user_id=$1 and status='pending' and type='withdraw'", [user.id])).rows[0].n;
        if (n >= 5) throw bad('شما ۵ درخواست برداشت در انتظار دارید.', 429);
        const bal = await balance(c, user.id);
        if (bal < amount) throw bad('موجودی کافی نیست.');
        const x = (await c.query("insert into wallet_requests(user_id,type,amount,card) values($1,'withdraw',$2,$3) returning *", [user.id, amount, card])).rows[0];
        await c.query("insert into wallet_tx(user_id,amount,kind,ref) values($1,$2,'withdraw_hold',$3)", [user.id, -amount, 'req:' + x.id]);
        return { request: pubReq(x), balance: bal - amount };
      });
    }
    if ((r = /^\/wallet\/requests\/(\d+)\/cancel$/.exec(p)) && m === 'POST') {
      await need();
      return tx(async c => {
        await lock(c, user.id);
        const x = (await c.query("update wallet_requests set status='cancelled', updated_at=now() where id=$1 and user_id=$2 and status='pending' returning *", [+r[1], user.id])).rows[0];
        if (!x) throw bad('این درخواست قابل لغو نیست.');
        if (x.type === 'withdraw') await refund(c, x);
        return { request: pubReq(x) };
      });
    }
  }

  async function admin(req, p) {
    const m = req.method; let r;
    if (p === '/wallet/requests' && m === 'GET') {
      const sp = new URL(req.url, 'http://x').searchParams, st = sp.get('status'), ty = sp.get('type');
      const cond = [], v = [];
      if (['pending', 'confirmed', 'rejected', 'cancelled'].includes(st)) { v.push(st); cond.push('w.status=$' + v.length); }
      if (['topup', 'withdraw'].includes(ty)) { v.push(ty); cond.push('w.type=$' + v.length); }
      const x = await q(`select w.*, u.username, u.phone from wallet_requests w join users u on u.id=w.user_id
        ${cond.length ? 'where ' + cond.join(' and ') : ''} order by w.id desc limit 200`, v);
      return { requests: x.rows.map(w => ({ ...pubReq(w), username: w.username, phone: w.phone })) };
    }
    if ((r = /^\/wallet\/requests\/(\d+)\/(confirm|reject)$/.exec(p)) && m === 'POST') {
      const b = await body(req, 1e4), act = r[2], status = act === 'confirm' ? 'confirmed' : 'rejected';
      return tx(async c => {
        const x = (await c.query("update wallet_requests set status=$1, admin_note=$2, updated_at=now() where id=$3 and status='pending' returning *",
          [status, str(b.note, 300), +r[1]])).rows[0];
        if (!x) throw bad('این درخواست در انتظار بررسی نیست.');
        await lock(c, x.user_id);
        if (act === 'confirm' && x.type === 'topup')
          await c.query("insert into wallet_tx(user_id,amount,kind,ref) values($1,$2,'topup',$3) on conflict do nothing", [x.user_id, x.amount, 'req:' + x.id]);
        if (act === 'reject' && x.type === 'withdraw') await refund(c, x);
        return { request: pubReq(x) };
      });
    }
    if (p === '/wallet/adjust' && m === 'POST') {
      const b = await body(req, 1e4), amount = num(b.amount, -1e11, 1e11), note = str(b.note, 200);
      if (!amount) throw bad('مبلغ باید عددی غیر از صفر باشد.');
      if (!note) throw bad('دلیل را بنویسید.');
      const u = (await q("select id from users where lower(username)=lower($1) and role='user' and not deleted", [str(b.username, 30)])).rows[0];
      if (!u) throw bad('کاربر پیدا نشد.', 404);
      return tx(async c => {
        await lock(c, u.id);
        const bal = await balance(c, u.id);
        if (bal + amount < 0) throw bad('موجودی کاربر منفی می‌شود.');
        await c.query("insert into wallet_tx(user_id,amount,kind,note) values($1,$2,'admin_adjust',$3)", [u.id, amount, note]);
        return { balance: bal + amount };
      });
    }
    if (p === '/wallet/user' && m === 'GET') {
      const un = (new URL(req.url, 'http://x').searchParams.get('username') || '').trim().slice(0, 30);
      const u = (await q('select id, username from users where lower(username)=lower($1) and not deleted', [un])).rows[0];
      if (!u) throw bad('کاربر پیدا نشد.', 404);
      const bal = +(await q('select coalesce(sum(amount),0)::bigint b from wallet_tx where user_id=$1', [u.id])).rows[0].b;
      const h = await q('select amount, kind, note, created_at from wallet_tx where user_id=$1 order by id desc limit 100', [u.id]);
      return { username: u.username, balance: bal, history: h.rows.map(t => ({ ...t, amount: +t.amount })) };
    }
  }

  return { init, route, admin };
};
