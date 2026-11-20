'use strict';
// Part 2: coins (prices) and orders (sell / buy requests)
const crypto = require('crypto');

module.exports = ({ q, bad, str, fa, body, authUser, featureOn, emit }) => {
  const num = (v, min, max) => {
    const n = Number(fa(String(v)));
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const newCode = () => crypto.randomBytes(5).toString('hex').toUpperCase();
  const pubOrder = o => ({
    id: o.id, code: o.code, type: o.type, coin_name: o.coin_name, qty: o.qty,
    unit_price: +o.unit_price, total: +o.total, payout: o.payout, card: o.card,
    status: o.status, admin_note: o.admin_note, created_at: o.created_at
  });
  const pubCoin = c => ({ id: c.id, name: c.name, buy_price: +c.buy_price, sell_price: +c.sell_price });
  const adminCoin = c => ({ ...pubCoin(c), active: c.active, sort: c.sort });

  async function init() {
    await q(`create table if not exists coins(
      id serial primary key, name text not null,
      buy_price bigint not null default 0, sell_price bigint not null default 0,
      active boolean not null default true, sort int not null default 0,
      created_at timestamptz not null default now())`);
    await q(`create table if not exists orders(
      id serial primary key, code text not null unique,
      user_id int not null references users(id),
      type text not null check (type in ('buy','sell')),
      coin_id int references coins(id), coin_name text not null,
      qty int not null, unit_price bigint not null, total bigint not null,
      payout text not null default 'card', card text not null default '',
      proof_file int, status text not null default 'pending',
      admin_note text not null default '',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
    await q('create index if not exists orders_user_idx on orders(user_id, id desc)');
    await q('create index if not exists orders_status_idx on orders(status, id desc)');
  }

  // public: coin prices
  async function pub(req, p) {
    if (p === '/coins' && req.method === 'GET') {
      const r = await q('select * from coins where active order by sort, id');
      return { coins: r.rows.map(pubCoin) };
    }
  }

  // logged-in users: their own orders
  async function route(req, p, user) {
    const m = req.method; let r;
    if (p === '/orders' && m === 'POST') {
      const b = await body(req, 1e5);
      const type = b.type === 'buy' ? 'buy' : 'sell';
      if (!(await featureOn(type))) throw bad(type === 'buy' ? 'خرید فعلاً بسته است.' : 'فروش فعلاً غیرفعال است.', 403);
      const coinId = num(b.coin_id, 1, 2147483647), qty = num(b.qty, 1, 100000);
      if (!coinId) throw bad('سکه را انتخاب کنید.');
      if (!qty) throw bad('تعداد نامعتبر است.');
      const coin = (await q('select * from coins where id=$1 and active', [coinId])).rows[0];
      if (!coin) throw bad('این سکه در دسترس نیست.');
      const price = +(type === 'sell' ? coin.sell_price : coin.buy_price);
      if (!(price > 0)) throw bad('قیمت این سکه هنوز تعیین نشده است.');
      const pending = (await q("select count(*)::int n from orders where user_id=$1 and status='pending'", [user.id])).rows[0].n;
      if (pending >= 10) throw bad('شما ۱۰ سفارش در انتظار دارید. ابتدا منتظر بررسی آن‌ها بمانید.', 429);
      let card = str(fa(b.card || ''), 16) || user.card;
      if (!/^\d{16}$/.test(card)) throw bad('شماره کارت باید ۱۶ رقم باشد.');
      const o = (await q(
        `insert into orders(code,user_id,type,coin_id,coin_name,qty,unit_price,total,card)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [newCode(), user.id, type, coin.id, coin.name, qty, price, price * qty, card])).rows[0];
      return { order: pubOrder(o) };
    }
    if (p === '/orders' && m === 'GET') {
      const x = await q('select * from orders where user_id=$1 order by id desc limit 100', [user.id]);
      return { orders: x.rows.map(pubOrder) };
    }
    if ((r = /^\/orders\/(\d+)\/cancel$/.exec(p)) && m === 'POST') {
      const x = await q(
        "update orders set status='cancelled', updated_at=now() where id=$1 and user_id=$2 and status='pending' returning *",
        [+r[1], user.id]);
      if (!x.rows[0]) throw bad('این سفارش قابل لغو نیست.');
      return { order: pubOrder(x.rows[0]) };
    }
  }

  // admin only
  async function admin(req, p) {
    const m = req.method; let r;
    if (p === '/coins' && m === 'GET') {
      return { coins: (await q('select * from coins order by sort, id')).rows.map(adminCoin) };
    }
    if (p === '/coins' && m === 'POST') {
      const b = await body(req, 1e5), name = str(b.name, 60);
      if (!name) throw bad('نام سکه را وارد کنید.');
      const buy = num(b.buy_price ?? 0, 0, 1e12), sell = num(b.sell_price ?? 0, 0, 1e12), sort = num(b.sort ?? 0, -1000, 100000);
      if (buy === null || sell === null || sort === null) throw bad('عدد نامعتبر است.');
      const c = (await q('insert into coins(name,buy_price,sell_price,sort) values($1,$2,$3,$4) returning *', [name, buy, sell, sort])).rows[0];
      return { coin: adminCoin(c) };
    }
    if ((r = /^\/coins\/(\d+)$/.exec(p)) && m === 'PUT') {
      const b = await body(req, 1e5), f = [], v = [];
      const set = (col, val) => { v.push(val); f.push(col + '=$' + v.length); };
      if (b.name !== undefined) { const n = str(b.name, 60); if (!n) throw bad('نام نامعتبر است.'); set('name', n); }
      for (const k of ['buy_price', 'sell_price']) if (b[k] !== undefined) { const n = num(b[k], 0, 1e12); if (n === null) throw bad('قیمت نامعتبر است.'); set(k, n); }
      if (b.sort !== undefined) { const n = num(b.sort, -1000, 100000); if (n === null) throw bad('ترتیب نامعتبر است.'); set('sort', n); }
      if (b.active !== undefined) { if (typeof b.active !== 'boolean') throw bad('مقدار نامعتبر است.'); set('active', b.active); }
      if (!f.length) throw bad('چیزی برای تغییر نیست.');
      v.push(+r[1]);
      const c = (await q('update coins set ' + f.join(',') + ' where id=$' + v.length + ' returning *', v)).rows[0];
      if (!c) throw bad('پیدا نشد.', 404);
      return { coin: adminCoin(c) };
    }
    if (p === '/orders' && m === 'GET') {
      const st = new URL(req.url, 'http://x').searchParams.get('status');
      const ok = ['pending', 'confirmed', 'rejected', 'cancelled'].includes(st);
      const x = await q(
        `select o.*, u.username, u.phone from orders o join users u on u.id=o.user_id
         ${ok ? 'where o.status=$1' : ''} order by o.id desc limit 200`, ok ? [st] : []);
      return { orders: x.rows.map(o => ({ ...pubOrder(o), username: o.username, phone: o.phone })) };
    }
    if ((r = /^\/orders\/(\d+)\/(confirm|reject)$/.exec(p)) && m === 'POST') {
      const b = await body(req, 1e4), status = r[2] === 'confirm' ? 'confirmed' : 'rejected';
      // only a pending order can change; a second click changes nothing (safe for points later)
      const x = await q(
        "update orders set status=$1, admin_note=$2, updated_at=now() where id=$3 and status='pending' returning *",
        [status, str(b.note, 300), +r[1]]);
      if (!x.rows[0]) throw bad('این سفارش در انتظار بررسی نیست.');
      if (status === 'confirmed') await emit('order_confirmed', x.rows[0]);
      return { order: pubOrder(x.rows[0]) };
    }
  }

  return { init, pub, route, admin };
};
