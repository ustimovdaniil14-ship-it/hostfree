'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const ITEMS = require('./items.json'); // [[имя, цена], ...]

/* ================= КОНФИГ ================= */
const TOKEN = process.env.BOT_TOKEN;
const API = (process.env.BOT_API || 'https://api.staticgram.top').replace(/\/$/, '');
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || '';
const ADMINS = new Set((process.env.ADMIN_IDS || '1780243642,1780243247').split(',').map(s => s.trim()).filter(Boolean).map(Number));
const SKIP_SIGN = process.env.SKIP_SIGN_CHECK === '1';
if (!TOKEN || !process.env.DATABASE_URL) { console.error('Нужны BOT_TOKEN и DATABASE_URL'); process.exit(1); }

const DEP_MAX = 100000, MIN_WD = 10, DEF_WD_LIMIT = 20000, MAX_CHANCE = 42;
const STAR_X = [2.5, 3, 5, 10, 20];

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 8 });
const isAdmin = id => ADMINS.has(Number(id));
const fmt = n => Math.floor(Number(n)).toLocaleString('ru-RU');
const dayKey = () => new Date().toISOString().slice(0, 10);
const roll100 = () => crypto.randomInt(0, 1000000) / 10000; // 0..99.9999
const rid = () => 'st' + crypto.randomBytes(9).toString('hex');
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const HttpErr = (code, msg) => Object.assign(new Error(msg), { http: code });

/* ================= BOT API ================= */
async function tg(method, params = {}) {
  const r = await fetch(`${API}/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  const j = await r.json().catch(() => ({ ok: false, description: 'bad json', error_code: r.status }));
  if (!j.ok) { const e = new Error(j.description || 'API error'); e.code = j.error_code; e.api = true; throw e; }
  return j.result;
}
const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra }).catch(e => console.log('send fail', chat_id, e.message));
const alertAdmins = t => { for (const id of ADMINS) send(id, t); };

/* ================= БД ================= */
async function initDb() {
  await db.query(`
  CREATE TABLE IF NOT EXISTS users(
    id BIGINT PRIMARY KEY, first_name TEXT, username TEXT,
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    deposited BIGINT NOT NULL DEFAULT 0, withdrawn BIGINT NOT NULL DEFAULT 0,
    won_total BIGINT NOT NULL DEFAULT 0, played INT NOT NULL DEFAULT 0, won INT NOT NULL DEFAULT 0,
    wagered BIGINT NOT NULL DEFAULT 0, best BIGINT NOT NULL DEFAULT 0,
    wd_day TEXT NOT NULL DEFAULT '', wd_used BIGINT NOT NULL DEFAULT 0,
    banned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now());
  ALTER TABLE users ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_name TEXT;
  CREATE TABLE IF NOT EXISTS ops(
    id BIGSERIAL PRIMARY KEY, uid BIGINT NOT NULL, kind TEXT NOT NULL, game TEXT,
    amount BIGINT NOT NULL DEFAULT 0, bet BIGINT NOT NULL DEFAULT 0, payout BIGINT NOT NULL DEFAULT 0,
    x NUMERIC, status TEXT NOT NULL DEFAULT 'done', ref TEXT, note TEXT, ts TIMESTAMPTZ NOT NULL DEFAULT now());
  ALTER TABLE ops ADD COLUMN IF NOT EXISTS text TEXT;
  CREATE INDEX IF NOT EXISTS ops_uid_idx ON ops(uid, id DESC);
  CREATE TABLE IF NOT EXISTS payments(charge_id TEXT PRIMARY KEY, uid BIGINT NOT NULL, amount BIGINT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS inv(id BIGSERIAL PRIMARY KEY, uid BIGINT NOT NULL, k INT NOT NULL);
  CREATE INDEX IF NOT EXISTS inv_uid_idx ON inv(uid);
  CREATE TABLE IF NOT EXISTS mines(uid BIGINT PRIMARY KEY, bet BIGINT NOT NULL, m INT NOT NULL, mines INT[] NOT NULL, opened INT[] NOT NULL DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS promos(code TEXT PRIMARY KEY, amt BIGINT NOT NULL, max INT NOT NULL);
  CREATE TABLE IF NOT EXISTS promo_uses(code TEXT NOT NULL, uid BIGINT NOT NULL, PRIMARY KEY(code, uid));`);
}
const getSet = async (k, d) => { const r = await db.query('SELECT value FROM settings WHERE key=$1', [k]); return r.rows[0] ? r.rows[0].value : d; };
const putSet = (k, v) => db.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [k, String(v)]);
const cfg = async () => ({
  maint: (await getSet('maint', '0')) === '1', upgrade: (await getSet('upgrade', '1')) === '1', mines: (await getSet('mines', '1')) === '1',
  dep: (await getSet('dep', '1')) === '1', wd: (await getSet('wd', '1')) === '1', wdLimit: +(await getSet('wd_limit', DEF_WD_LIMIT)),
});
async function upsertUser(u) {
  await db.query(`INSERT INTO users(id,first_name,username) VALUES($1,$2,$3)
    ON CONFLICT(id) DO UPDATE SET first_name=EXCLUDED.first_name, username=EXCLUDED.username, last_seen=now()`, [u.id, u.first_name || '', u.username || '']);
}
async function findUser(q) {
  q = String(q || '').trim().replace(/^@/, '');
  const r = /^\d+$/.test(q) ? await db.query('SELECT * FROM users WHERE id=$1', [q]) : await db.query('SELECT * FROM users WHERE lower(username)=lower($1)', [q]);
  return r.rows[0] || null;
}
async function tx(fn) {
  const c = await db.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { c.release(); }
}
const addOp = (c, uid, o) => c.query(`INSERT INTO ops(uid,kind,game,amount,bet,payout,x,status,ref,note,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [uid, o.kind, o.game || null, o.amount || 0, o.bet || 0, o.payout || 0, o.x == null ? null : o.x, o.status || 'done', o.ref || rid(), o.note || null, o.text || null]);

/* ================= АВТОРИЗАЦИЯ МИНИ-АППА ================= */
function checkInitData(raw) {
  if (!raw) return null;
  const p = new URLSearchParams(raw), hash = p.get('hash');
  if (!SKIP_SIGN) {
    if (!hash) return null;
    p.delete('hash');
    const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    const ad = +p.get('auth_date'); if (!ad || Date.now() / 1000 - ad > 86400 * 2) return null;
  }
  try { const u = JSON.parse(p.get('user')); return u && u.id ? u : null; } catch (e) { return null; }
}
async function auth(req, res, next) {
  const u = checkInitData(req.get('X-Init-Data'));
  if (!u) return res.status(401).json({ error: 'Открой игру из Telegram' });
  try {
    await upsertUser(u);
    const row = (await db.query('SELECT banned FROM users WHERE id=$1', [u.id])).rows[0];
    if (row.banned) return res.status(403).json({ error: 'Доступ закрыт' });
    const c = await cfg();
    if (c.maint && !isAdmin(u.id)) return res.status(503).json({ error: 'Технические работы, загляни позже' });
    req.user = u; req.cfg = c; next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
}
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { if (e.http) return res.status(e.http).json({ error: e.message }); console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
};

/* ================= СОСТОЯНИЕ ДЛЯ КЛИЕНТА ================= */
async function meFor(uid, c) {
  c = c || await cfg();
  const u = (await db.query('SELECT * FROM users WHERE id=$1', [uid])).rows[0];
  const inv = (await db.query('SELECT id,k FROM inv WHERE uid=$1 ORDER BY id', [uid])).rows.map(r => ({ id: +r.id, k: r.k }));
  const h = (await db.query('SELECT text FROM ops WHERE uid=$1 AND text IS NOT NULL ORDER BY id DESC LIMIT 15', [uid])).rows.map(r => r.text);
  const g = (await db.query('SELECT m,bet,opened FROM mines WHERE uid=$1', [uid])).rows[0];
  const used = u.wd_day === dayKey() ? +u.wd_used : 0;
  return { id: String(u.id), name: u.custom_name || u.first_name || 'Игрок', bal: +u.balance, inv, ups: u.played, wins: u.won, best: +u.best, wag: +u.wagered,
    banned: u.banned, frozen: u.frozen, h, deposited: +u.deposited, wdLimit: c.wdLimit, wdLeft: Math.max(0, c.wdLimit - used),
    mines: g ? { m: g.m, bet: +g.bet, open: g.opened } : null };
}
const onlineCount = async () => +(await db.query(`SELECT count(*) FROM users WHERE last_seen > now() - interval '2 minutes'`)).rows[0].count;
const lockUser = async (c, uid) => {
  const u = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [uid])).rows[0];
  return u;
};
const notFrozen = u => { if (u.frozen) throw HttpErr(403, 'Аккаунт заморожен'); };

/* ================= EXPRESS ================= */
const app = express();
app.use(express.json({ limit: '50kb' }));
app.get('/health', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/state', auth, wrap(async (req, res) => {
  res.json({ me: await meFor(req.user.id, req.cfg), online: Math.max(1, await onlineCount()) });
}));

app.post('/api/name', auth, wrap(async (req, res) => {
  const n = String(req.body.name || '').trim().slice(0, 20); if (!n) throw HttpErr(400, 'Пустое имя');
  await db.query('UPDATE users SET custom_name=$2 WHERE id=$1', [req.user.id, n]);
  res.json({ me: await meFor(req.user.id, req.cfg) });
}));

/* ---- магазин ---- */
app.post('/api/buy', auth, wrap(async (req, res) => {
  const k = Math.floor(+req.body.k); if (!(k >= 0 && k < ITEMS.length)) throw HttpErr(400, 'Нет такого предмета');
  await tx(async c => {
    const u = await lockUser(c, req.user.id); notFrozen(u);
    const p = ITEMS[k][1]; if (+u.balance < p) throw HttpErr(400, 'Не хватает ★ на покупку');
    await c.query('UPDATE users SET balance=balance-$2 WHERE id=$1', [u.id, p]);
    await c.query('INSERT INTO inv(uid,k) VALUES($1,$2)', [u.id, k]);
    await addOp(c, u.id, { kind: 'buy', amount: p, text: 'Куплено: ' + ITEMS[k][0] });
  });
  res.json({ me: await meFor(req.user.id, req.cfg) });
}));

/* ---- апгрейд (макс. шанс 42%) ---- */
app.post('/api/upgrade', auth, wrap(async (req, res) => {
  if (!req.cfg.upgrade) throw HttpErr(403, 'Игра временно отключена');
  const b = req.body, mode = b.mode === 'star' ? 'star' : 'nft';
  const out = await tx(async c => {
    const u = await lockUser(c, req.user.id); notFrozen(u);
    let spend, chance, prizeText, payoutStars = 0, targetK = null, ids = [];
    if (mode === 'star') {
      const amt = Math.floor(+b.amount), x = +b.x;
      if (!(amt >= 1)) throw HttpErr(400, 'Введите сумму');
      if (!STAR_X.includes(x)) throw HttpErr(400, 'Неверный множитель');
      if (amt > +u.balance) throw HttpErr(400, 'Не хватает ★');
      spend = amt; chance = Math.min(MAX_CHANCE, 95 / x); payoutStars = Math.floor(amt * x); prizeText = fmt(payoutStars) + ' ★';
    } else {
      targetK = Math.floor(+b.target);
      if (!(targetK >= 0 && targetK < ITEMS.length)) throw HttpErr(400, 'Выберите цель');
      ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger))].slice(0, 60);
      const bet = Math.floor(+b.bet) || 0;
      if (bet < 0 || bet > +u.balance) throw HttpErr(400, 'Не хватает ★');
      const own = ids.length ? (await c.query('SELECT id,k FROM inv WHERE uid=$1 AND id = ANY($2::bigint[]) FOR UPDATE', [u.id, ids])).rows : [];
      if (own.length !== ids.length) throw HttpErr(400, 'Предмет не найден в инвентаре');
      spend = own.reduce((s, r) => s + ITEMS[r.k][1], 0) + bet;
      const tp = ITEMS[targetK][1];
      if (!(spend > 0)) throw HttpErr(400, 'Выберите, что отдать');
      if (spend >= tp) throw HttpErr(400, 'Цель должна быть дороже');
      chance = Math.min(MAX_CHANCE, Math.max(1, spend / tp * 95)); prizeText = ITEMS[targetK][0];
      if (ids.length) await c.query('DELETE FROM inv WHERE uid=$1 AND id = ANY($2::bigint[])', [u.id, ids]);
      if (bet) await c.query('UPDATE users SET balance=balance-$2 WHERE id=$1', [u.id, bet]);
      payoutStars = ITEMS[targetK][1]; // для статистики
    }
    const roll = roll100(), win = roll < chance;
    if (mode === 'star') await c.query('UPDATE users SET balance=balance-$2 WHERE id=$1', [u.id, spend]);
    if (win && mode === 'star') await c.query('UPDATE users SET balance=balance+$2 WHERE id=$1', [u.id, payoutStars]);
    if (win && mode === 'nft') await c.query('INSERT INTO inv(uid,k) VALUES($1,$2)', [u.id, targetK]);
    await c.query('UPDATE users SET played=played+1, won=won+$2, wagered=wagered+$3, best=GREATEST(best,$4) WHERE id=$1', [u.id, win ? 1 : 0, spend, win ? payoutStars : 0]);
    await addOp(c, u.id, { kind: 'game', game: 'upgrade', bet: spend, payout: win ? payoutStars : 0, x: Math.round(chance * 100) / 100,
      text: (win ? '✅ Победа: ' + prizeText : '❌ Проигрыш: −' + fmt(spend) + ' ★') });
    return { win, roll };
  });
  res.json({ ...out, me: await meFor(req.user.id, req.cfg) });
}));

/* ---- мины ---- */
const mMult = (m, k) => { let r = 0.95; for (let i = 0; i < k; i++) r *= (25 - i) / (25 - m - i); return r; };
app.post('/api/mines/start', auth, wrap(async (req, res) => {
  if (!req.cfg.mines) throw HttpErr(403, 'Игра временно отключена');
  const bet = Math.floor(+req.body.bet), m = Math.floor(+req.body.m);
  if (!(bet >= 1)) throw HttpErr(400, 'Введите ставку'); if (!(m >= 1 && m <= 24)) throw HttpErr(400, 'Неверное число мин');
  await tx(async c => {
    const u = await lockUser(c, req.user.id); notFrozen(u);
    if ((await c.query('SELECT 1 FROM mines WHERE uid=$1', [u.id])).rowCount) throw HttpErr(400, 'Игра уже идёт');
    if (bet > +u.balance) throw HttpErr(400, 'Не хватает ★');
    const set = new Set(); while (set.size < m) set.add(crypto.randomInt(0, 25));
    await c.query('UPDATE users SET balance=balance-$2 WHERE id=$1', [u.id, bet]);
    await c.query('INSERT INTO mines(uid,bet,m,mines) VALUES($1,$2,$3,$4)', [u.id, bet, m, [...set]]);
  });
  res.json({ me: await meFor(req.user.id, req.cfg) });
}));
async function finishMines(c, u, g, win) {
  const k = g.opened.length, payout = win ? Math.floor(+g.bet * mMult(g.m, k)) : 0;
  await c.query('DELETE FROM mines WHERE uid=$1', [u.id]);
  await c.query('UPDATE users SET balance=balance+$2, played=played+1, won=won+$3, wagered=wagered+$4, best=GREATEST(best,$2) WHERE id=$1', [u.id, payout, win ? 1 : 0, +g.bet]);
  await addOp(c, u.id, { kind: 'game', game: 'mines', bet: +g.bet, payout, x: win ? Math.round(mMult(g.m, k) * 100) / 100 : 0,
    text: `💣 Мины: ${win ? '+' + fmt(payout - g.bet) : '−' + fmt(g.bet)} ★` });
  return payout;
}
app.post('/api/mines/open', auth, wrap(async (req, res) => {
  const i = Math.floor(+req.body.i); if (!(i >= 0 && i < 25)) throw HttpErr(400, 'Неверная клетка');
  const out = await tx(async c => {
    const u = await lockUser(c, req.user.id);
    const g = (await c.query('SELECT * FROM mines WHERE uid=$1 FOR UPDATE', [u.id])).rows[0];
    if (!g) throw HttpErr(400, 'Игра не начата');
    if (g.opened.includes(i)) throw HttpErr(400, 'Клетка уже открыта');
    if (g.mines.includes(i)) { await finishMines(c, u, g, false); return { boom: true, mines: g.mines }; }
    g.opened.push(i);
    if (g.opened.length === 25 - g.m) { const payout = await finishMines(c, u, g, true); return { win: true, payout, mines: g.mines }; }
    await c.query('UPDATE mines SET opened=$2 WHERE uid=$1', [u.id, g.opened]);
    return {};
  });
  res.json({ ...out, me: await meFor(req.user.id, req.cfg) });
}));
app.post('/api/mines/cash', auth, wrap(async (req, res) => {
  const out = await tx(async c => {
    const u = await lockUser(c, req.user.id);
    const g = (await c.query('SELECT * FROM mines WHERE uid=$1 FOR UPDATE', [u.id])).rows[0];
    if (!g || !g.opened.length) throw HttpErr(400, 'Нечего забирать');
    const payout = await finishMines(c, u, g, true); return { payout, mines: g.mines };
  });
  res.json({ ...out, me: await meFor(req.user.id, req.cfg) });
}));

/* ---- промокоды ---- */
app.post('/api/promo', auth, wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().replace(/\s/g, '');
  const amount = await tx(async c => {
    const u = await lockUser(c, req.user.id); notFrozen(u);
    const p = (await c.query('SELECT * FROM promos WHERE code=$1 FOR UPDATE', [code])).rows[0];
    if (!p) throw HttpErr(400, 'Промокод не найден');
    if ((await c.query('SELECT 1 FROM promo_uses WHERE code=$1 AND uid=$2', [code, u.id])).rowCount) throw HttpErr(400, 'Вы уже активировали этот код');
    const n = +(await c.query('SELECT count(*) FROM promo_uses WHERE code=$1', [code])).rows[0].count;
    if (n >= p.max) throw HttpErr(400, 'Лимит активаций исчерпан');
    await c.query('INSERT INTO promo_uses(code,uid) VALUES($1,$2)', [code, u.id]);
    await c.query('UPDATE users SET balance=balance+$2 WHERE id=$1', [u.id, p.amt]);
    await addOp(c, u.id, { kind: 'promo', amount: +p.amt, text: `Промокод ${code} +${fmt(p.amt)} ★` });
    return +p.amt;
  });
  res.json({ amount, me: await meFor(req.user.id, req.cfg) });
}));

/* ---- автопополнение ---- */
function depAmount(req) {
  const a = Math.floor(+req.body.amount);
  if (!req.cfg.dep) throw HttpErr(403, 'Пополнение временно отключено');
  if (!(a >= 10) || a > DEP_MAX) throw HttpErr(400, 'Сумма от 10 до ' + fmt(DEP_MAX));
  return a;
}
const invoiceParams = (uid, a) => ({ title: 'Пополнение баланса', description: `Пополнение игрового баланса на ${a} ⭐`, payload: `dep:${uid}:${rid()}`, currency: 'XTR', prices: [{ label: 'Звёзды', amount: a }] });
app.post('/api/deposit', auth, wrap(async (req, res) => {
  const a = depAmount(req);
  try { res.json({ link: await tg('createInvoiceLink', invoiceParams(req.user.id, a)) }); }
  catch (e) { console.error('createInvoiceLink', e.message); throw HttpErr(502, 'Не удалось создать счёт'); }
}));
app.post('/api/deposit_chat', auth, wrap(async (req, res) => {
  const a = depAmount(req);
  try { await tg('sendInvoice', { chat_id: req.user.id, ...invoiceParams(req.user.id, a) }); res.json({ ok: true }); }
  catch (e) { console.error('sendInvoice', e.message); throw HttpErr(502, 'Не удалось отправить счёт'); }
}));

/* ---- автовывод (лимит 20 000 ★ в сутки) ---- */
app.post('/api/withdraw', auth, wrap(async (req, res) => {
  const a = Math.floor(+req.body.amount), uid = req.user.id;
  if (!req.cfg.wd) throw HttpErr(403, 'Вывод временно отключён');
  if (!(a >= MIN_WD)) throw HttpErr(400, 'Минимальный вывод ' + MIN_WD + ' ★');
  const op = await tx(async c => {
    const u = await lockUser(c, uid); notFrozen(u);
    const today = dayKey(), used = u.wd_day === today ? +u.wd_used : 0;
    if (a > +u.balance) throw HttpErr(400, 'Недостаточно ★');
    if (used + a > req.cfg.wdLimit) throw HttpErr(400, `Лимит вывода в сутки — ${fmt(req.cfg.wdLimit)} ★. Осталось ${fmt(Math.max(0, req.cfg.wdLimit - used))}`);
    await c.query('UPDATE users SET balance=balance-$2, withdrawn=withdrawn+$2, wd_day=$3, wd_used=$4 WHERE id=$1', [uid, a, today, used + a]);
    const ref = rid();
    const r = await c.query(`INSERT INTO ops(uid,kind,amount,status,ref,text) VALUES($1,'wd',$2,'pending',$3,$4) RETURNING id`, [uid, a, ref, `Вывод −${fmt(a)} ★`]);
    return { dbId: r.rows[0].id, ref };
  });
  const st = await payoutOp(op.dbId, uid, a, op.ref);
  if (st === 'failed') throw HttpErr(502, 'Вывод не удался, ★ возвращены на баланс');
  res.json({ status: st, me: await meFor(uid, req.cfg) });
}));
async function refundWd(dbId, uid, a, note) {
  await tx(async c => {
    const o = (await c.query(`SELECT status FROM ops WHERE id=$1 FOR UPDATE`, [dbId])).rows[0];
    if (!o || o.status === 'failed' || o.status === 'done') return;
    await c.query(`UPDATE ops SET status='failed', note=$2, text='Вывод отменён, ★ возвращены' WHERE id=$1`, [dbId, note]);
    await c.query(`UPDATE users SET balance=balance+$2, withdrawn=withdrawn-$2, wd_used=GREATEST(0,wd_used-$2) WHERE id=$1`, [uid, a]);
  });
}
async function payoutOp(dbId, uid, a, ref) {
  try {
    await tg('withdrawStarBalance', { user_id: uid, star_count: a, request_id: ref });
    await db.query(`UPDATE ops SET status='done' WHERE id=$1 AND status='pending'`, [dbId]);
    return 'done';
  } catch (e) {
    console.error('withdraw', uid, a, e.message);
    const definitive = e.api && e.code && e.code !== 429 && e.code < 500;
    if (definitive) { await refundWd(dbId, uid, a, e.message); alertAdmins(`⚠️ Вывод ${fmt(a)} ★ для <code>${uid}</code> отклонён: ${esc(e.message)}\nЗвёзды возвращены игроку. Если BALANCE_TOO_LOW — пополни баланс бота.`); return 'failed'; }
    await db.query(`UPDATE ops SET note=$2 WHERE id=$1`, [dbId, e.message]);
    alertAdmins(`⏳ Вывод #${dbId} (${fmt(a)} ★, <code>${uid}</code>) завис: ${esc(e.message)}\n/wdok ${dbId} или /wdfail ${dbId}`);
    return 'pending';
  }
}

/* ================= БОТ: long polling ================= */
const pendingCustom = new Map();
const kbPlay = () => WEBAPP_URL ? { reply_markup: { inline_keyboard: [[{ text: '🎰 Играть', web_app: { url: WEBAPP_URL } }]] } } : {};

async function onMessage(m) {
  const u = m.from; if (!u || u.is_bot) return;
  if (m.successful_payment) return onPayment(m);
  await upsertUser(u);
  const text = (m.text || '').trim(); if (!text) return;
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  if ((await db.query('SELECT banned FROM users WHERE id=$1', [u.id])).rows[0].banned) return send(u.id, '⛔ Доступ закрыт');

  if (cmd === '/start') {
    if (args[0] === 'custom') { pendingCustom.set(u.id, Date.now()); return send(u.id, `Напиши сумму пополнения числом (10–${fmt(DEP_MAX)} ⭐)`); }
    return send(u.id, `🎰 <b>Добро пожаловать!</b>\nАпгрейд NFT, звёзды и мины. Жми кнопку ниже.`, kbPlay());
  }
  if (cmd === '/deposit') { const a = Math.floor(+args[0]); if (a >= 10 && a <= DEP_MAX) return sendInv(u.id, a); pendingCustom.set(u.id, Date.now()); return send(u.id, `Напиши сумму пополнения числом (10–${fmt(DEP_MAX)} ⭐)`); }
  if (cmd === '/balance') { const r = (await db.query('SELECT balance FROM users WHERE id=$1', [u.id])).rows[0]; return send(u.id, `Баланс: <b>${fmt(r.balance)} ⭐</b>`); }
  if (cmd === '/online') return send(u.id, `🟢 Сейчас онлайн: <b>${fmt(Math.max(1, await onlineCount()))}</b>`);
  if (/^\d+$/.test(text) && pendingCustom.has(u.id)) {
    pendingCustom.delete(u.id); const a = Math.floor(+text);
    if (a < 10 || a > DEP_MAX) return send(u.id, `Сумма от 10 до ${fmt(DEP_MAX)}`);
    return sendInv(u.id, a);
  }
  if (isAdmin(u.id) && cmd.startsWith('/')) return adminCmd(u, cmd, args, text);
}
async function sendInv(uid, a) {
  if ((await getSet('dep', '1')) !== '1') return send(uid, 'Пополнение временно отключено');
  try { await tg('sendInvoice', { chat_id: uid, ...invoiceParams(uid, a) }); } catch (e) { send(uid, 'Не удалось создать счёт: ' + esc(e.message)); }
}
async function onPreCheckout(q) {
  let ok = true;
  const a = +q.total_amount, p = String(q.invoice_payload || '');
  const row = (await db.query('SELECT banned FROM users WHERE id=$1', [q.from.id])).rows[0];
  if (!p.startsWith('dep:') || !(a >= 1 && a <= DEP_MAX) || (row && row.banned) || (await getSet('dep', '1')) !== '1') ok = false;
  await tg('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: 'Пополнение недоступно' }).catch(e => console.log('precheckout', e.message));
}
async function onPayment(m) {
  const sp = m.successful_payment, uid = m.from.id, a = +sp.total_amount, cid = sp.telegram_payment_charge_id;
  if (sp.currency !== 'XTR' || !cid) return;
  const bal = await tx(async c => {
    const ins = await c.query('INSERT INTO payments(charge_id,uid,amount) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1', [cid, uid, a]);
    if (!ins.rowCount) return null;
    await c.query(`INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING`, [uid]);
    const r = await c.query('UPDATE users SET balance=balance+$2, deposited=deposited+$2 WHERE id=$1 RETURNING balance', [uid, a]);
    await addOp(c, uid, { kind: 'dep', amount: a, note: cid, text: `Пополнение +${fmt(a)} ★` });
    return +r.rows[0].balance;
  });
  if (bal != null) send(uid, `✅ Зачислено <b>${fmt(a)} ⭐</b>\nБаланс: <b>${fmt(bal)} ⭐</b>`, kbPlay());
}
async function onCallback(q) {
  const uid = q.from.id;
  if (!isAdmin(uid) || !String(q.data || '').startsWith('a:')) return tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const [, act, arg] = q.data.split(':');
  if (act === 'tg') { const cur = await getSet(arg, arg === 'maint' ? '0' : '1'); await putSet(arg, cur === '1' ? '0' : '1'); }
  const { text, kb } = await adminView(act === 'tg' ? 'set' : act);
  await tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  await tg('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text, parse_mode: 'HTML', reply_markup: kb })
    .catch(() => send(uid, text, { reply_markup: kb }));
}

/* ================= АДМИНКА (оба создателя равны) ================= */
const NAV = [[{ text: '📊 Статистика', callback_data: 'a:stats' }, { text: '🏆 Топ', callback_data: 'a:top' }],
  [{ text: '💸 Зависшие выводы', callback_data: 'a:pend' }, { text: '⚙️ Настройки', callback_data: 'a:set' }],
  [{ text: '🎟 Промокоды', callback_data: 'a:promos' }, { text: '🏦 Баланс бота', callback_data: 'a:bot' }],
  [{ text: '❓ Команды', callback_data: 'a:help' }]];
const HELP = `<b>Команды админа</b>
/admin — панель
/user &lt;id|@ник&gt; — профиль игрока
/give · /take · /setbal &lt;id&gt; &lt;n&gt; — баланс
/givenft &lt;id&gt; &lt;номер&gt; — выдать NFT (список: /items)
/clearnft &lt;id&gt; — забрать все NFT
/promo &lt;КОД&gt; &lt;★&gt; &lt;лимит&gt; · /delpromo &lt;КОД&gt;
/ban · /unban · /freeze · /unfreeze &lt;id&gt;
/resetlimit &lt;id&gt; — сбросить дневной лимит вывода
/limit &lt;n&gt; — лимит вывода в сутки для всех
/log &lt;id&gt; — последние операции
/broadcast &lt;текст&gt; — рассылка
/payout &lt;n&gt; — вывести n ⭐ с бота себе (комиссия 10%)
/wdok &lt;id&gt; · /wdfail &lt;id&gt; — зависший вывод
/top · /stats · /online · /items`;
async function adminView(v) {
  let text, kb = { inline_keyboard: NAV };
  if (v === 'stats' || v === 'admin') {
    const s = (await db.query(`SELECT count(*) users, coalesce(sum(balance),0) bal, coalesce(sum(deposited),0) dep, coalesce(sum(withdrawn),0) wd, coalesce(sum(wagered),0) wag,
      count(*) FILTER (WHERE created_at > now() - interval '24 hours') new24, count(*) FILTER (WHERE banned) bans FROM users`)).rows[0];
    const g = (await db.query(`SELECT count(*) n, coalesce(sum(bet-payout),0) prof FROM ops WHERE kind='game' AND ts > now() - interval '24 hours'`)).rows[0];
    text = `<b>📊 Статистика</b>\n🟢 Онлайн: <b>${fmt(await onlineCount())}</b>\n👥 Игроков: <b>${fmt(s.users)}</b> (+${s.new24} за сутки, банов ${s.bans})\n💰 На балансах: <b>${fmt(s.bal)} ⭐</b>\n⬇️ Пополнено: ${fmt(s.dep)} ⭐\n⬆️ Выведено: ${fmt(s.wd)} ⭐\n🎲 Оборот: ${fmt(s.wag)} ⭐\n📈 Прибыль за 24ч: <b>${g.prof >= 0 ? '+' : ''}${fmt(g.prof)} ⭐</b> (${g.n} игр)`;
  } else if (v === 'top') {
    const r = (await db.query('SELECT id,first_name,username,balance FROM users ORDER BY balance DESC LIMIT 10')).rows;
    text = '<b>🏆 Топ по балансу</b>\n' + r.map((u, i) => `${i + 1}. <code>${u.id}</code> ${esc(u.username ? '@' + u.username : u.first_name)} — ${fmt(u.balance)} ⭐`).join('\n');
  } else if (v === 'pend') {
    const r = (await db.query(`SELECT id,uid,amount,note FROM ops WHERE kind='wd' AND status='pending' ORDER BY id LIMIT 15`)).rows;
    text = '<b>💸 Зависшие выводы</b>\n' + (r.length ? r.map(o => `#${o.id} · <code>${o.uid}</code> · ${fmt(o.amount)} ⭐ · ${esc(o.note || '')}\n/wdok ${o.id}  /wdfail ${o.id}`).join('\n\n') : 'Нет');
  } else if (v === 'promos') {
    const r = (await db.query(`SELECT p.code,p.amt,p.max,(SELECT count(*) FROM promo_uses u WHERE u.code=p.code) used FROM promos p ORDER BY p.code`)).rows;
    text = '<b>🎟 Промокоды</b>\n' + (r.length ? r.map(p => `<code>${esc(p.code)}</code> +${fmt(p.amt)} ★ · ${p.used}/${p.max}`).join('\n') : 'Нет') + '\n\n/promo КОД ★ лимит · /delpromo КОД';
  } else if (v === 'set') {
    const c = await cfg(); const on = b => b ? '✅' : '❌';
    text = `<b>⚙️ Настройки</b>\nЛимит вывода в сутки: <b>${fmt(c.wdLimit)} ⭐</b> (/limit n)`;
    kb = { inline_keyboard: [[{ text: `${on(c.upgrade)} Апгрейд`, callback_data: 'a:tg:upgrade' }, { text: `${on(c.mines)} Мины`, callback_data: 'a:tg:mines' }],
      [{ text: `${on(c.dep)} Пополнение`, callback_data: 'a:tg:dep' }, { text: `${on(c.wd)} Вывод`, callback_data: 'a:tg:wd' }],
      [{ text: `${c.maint ? '🔴' : '⚪️'} Тех. работы`, callback_data: 'a:tg:maint' }], [{ text: '‹ Меню', callback_data: 'a:admin' }]] };
  } else if (v === 'bot') {
    try { const b = await tg('getMyStarBalance'); text = `<b>🏦 Баланс бота</b>\n<code>${esc(JSON.stringify(b))}</code>`; } catch (e) { text = 'Ошибка: ' + esc(e.message); }
  } else text = HELP;
  return { text, kb };
}
async function adminCmd(u, cmd, args, full) {
  const reply = t => send(u.id, t);
  const num = s => { const n = Math.floor(+s); return Number.isFinite(n) ? n : NaN; };
  const audit = (uid, a, note) => db.query(`INSERT INTO ops(uid,kind,amount,note,ref) VALUES($1,'adm',$2,$3,$4)`, [uid, a, note + ' by ' + u.id, rid()]);
  if (cmd === '/admin' || cmd === '/stats') { const v = await adminView(cmd === '/stats' ? 'stats' : 'admin'); return send(u.id, v.text, { reply_markup: v.kb }); }
  if (cmd === '/top') return reply((await adminView('top')).text);
  if (cmd === '/online') return reply(`🟢 Онлайн: <b>${fmt(await onlineCount())}</b>`);
  if (cmd === '/items') return reply('<b>Предметы</b>\n' + ITEMS.map((it, i) => `${i} · ${esc(it[0])} — ${fmt(it[1])}`).join('\n'));
  if (cmd === '/limit') { const n = num(args[0]); if (!(n >= MIN_WD)) return reply('Использование: /limit 20000'); await putSet('wd_limit', n); return reply(`✅ Лимит вывода: ${fmt(n)} ⭐/сутки`); }
  if (cmd === '/promo') {
    const code = String(args[0] || '').toUpperCase(), amt = num(args[1]), max = num(args[2]);
    if (!code || !(amt >= 1) || !(max >= 1)) return reply('Использование: /promo КОД 500 100');
    await db.query('INSERT INTO promos(code,amt,max) VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET amt=EXCLUDED.amt, max=EXCLUDED.max', [code, amt, max]);
    return reply(`✅ Промокод <code>${esc(code)}</code>: +${fmt(amt)} ★, лимит ${max}`);
  }
  if (cmd === '/delpromo') { await db.query('DELETE FROM promos WHERE code=$1', [String(args[0] || '').toUpperCase()]); return reply('🗑 Удалён'); }
  if (cmd === '/broadcast') {
    const t = full.slice(cmd.length).trim(); if (!t) return reply('Использование: /broadcast текст');
    const ids = (await db.query('SELECT id FROM users WHERE NOT banned')).rows; let ok = 0;
    for (const r of ids) { try { await tg('sendMessage', { chat_id: r.id, text: t, parse_mode: 'HTML' }); ok++; } catch (e) {} await new Promise(r => setTimeout(r, 60)); }
    return reply(`📣 Доставлено: ${ok}/${ids.length}`);
  }
  if (cmd === '/payout') {
    const n = num(args[0]); if (!(n >= 10)) return reply('Использование: /payout 1000 (мин. 10)');
    try { const r = await tg('withdrawStarBalance', { user_id: u.id, star_count: n, request_id: rid() }); return reply('✅ <code>' + esc(JSON.stringify(r)) + '</code>'); } catch (e) { return reply('Ошибка: ' + esc(e.message)); }
  }
  if (cmd === '/wdok' || cmd === '/wdfail') {
    const id = num(args[0]); const o = (await db.query(`SELECT * FROM ops WHERE id=$1 AND kind='wd'`, [id])).rows[0];
    if (!o || o.status !== 'pending') return reply('Нет такого зависшего вывода');
    if (cmd === '/wdok') { await db.query(`UPDATE ops SET status='done', note=$2 WHERE id=$1`, [id, 'ok by ' + u.id]); return reply('✅ Отмечен как выплаченный'); }
    await refundWd(id, o.uid, +o.amount, 'refund by ' + u.id); send(o.uid, `↩️ Вывод ${fmt(o.amount)} ⭐ отменён, звёзды возвращены на баланс`); return reply('↩️ Возврат выполнен');
  }
  const t = await findUser(args[0]);
  if (!t) return reply('Игрок не найден. Использование: ' + cmd + ' &lt;id|@ник&gt;');
  if (cmd === '/user') {
    const n = +(await db.query('SELECT count(*) FROM inv WHERE uid=$1', [t.id])).rows[0].count;
    return reply(`<b>👤 ${esc(t.custom_name || t.first_name)}</b> ${t.username ? '@' + esc(t.username) : ''}\nID: <code>${t.id}</code>${t.banned ? ' ⛔ БАН' : ''}${t.frozen ? ' ❄ ЗАМОРОЖЕН' : ''}\nБаланс: <b>${fmt(t.balance)} ⭐</b> · NFT: ${n}\nПополнил: ${fmt(t.deposited)} · Вывел: ${fmt(t.withdrawn)}\nИгр: ${t.played} · побед: ${t.won} · оборот: ${fmt(t.wagered)}\nВывод сегодня: ${t.wd_day === dayKey() ? fmt(t.wd_used) : 0}\nПоследний визит: ${new Date(t.last_seen).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  }
  if (cmd === '/ban' || cmd === '/unban') { if (isAdmin(t.id)) return reply('Нельзя банить админа'); await db.query('UPDATE users SET banned=$2 WHERE id=$1', [t.id, cmd === '/ban']); await audit(t.id, 0, cmd.slice(1)); return reply(cmd === '/ban' ? '⛔ Забанен' : '✅ Разбанен'); }
  if (cmd === '/freeze' || cmd === '/unfreeze') { await db.query('UPDATE users SET frozen=$2 WHERE id=$1', [t.id, cmd === '/freeze']); await audit(t.id, 0, cmd.slice(1)); return reply(cmd === '/freeze' ? '❄ Заморожен' : '✅ Разморожен'); }
  if (cmd === '/resetlimit') { await db.query(`UPDATE users SET wd_used=0 WHERE id=$1`, [t.id]); await audit(t.id, 0, 'resetlimit'); return reply('✅ Дневной лимит сброшен'); }
  if (cmd === '/clearnft') { await db.query('DELETE FROM inv WHERE uid=$1', [t.id]); await audit(t.id, 0, 'clearnft'); return reply('🗑 NFT забраны'); }
  if (cmd === '/givenft') {
    const k = num(args[1]); if (!(k >= 0 && k < ITEMS.length)) return reply('Использование: /givenft &lt;id&gt; &lt;номер из /items&gt;');
    await db.query('INSERT INTO inv(uid,k) VALUES($1,$2)', [t.id, k]);
    await db.query(`INSERT INTO ops(uid,kind,note,text,ref) VALUES($1,'adm',$2,$3,$4)`, [t.id, 'givenft by ' + u.id, 'Получен NFT: ' + ITEMS[k][0], rid()]);
    send(t.id, `🎁 Тебе выдан NFT: <b>${esc(ITEMS[k][0])}</b>`); return reply('✅ Выдан: ' + esc(ITEMS[k][0]));
  }
  if (cmd === '/log') {
    const r = (await db.query('SELECT kind,game,amount,bet,payout,status,text,ts FROM ops WHERE uid=$1 ORDER BY id DESC LIMIT 15', [t.id])).rows;
    return reply('<b>Последние операции</b>\n' + r.map(o => `${new Date(o.ts).toISOString().slice(5, 16).replace('T', ' ')} ${o.kind}${o.game ? ' ' + o.game : ''} ${o.kind === 'game' ? `ст.${o.bet} → ${o.payout}` : fmt(o.amount)} ${o.status !== 'done' ? o.status : ''}`).join('\n'));
  }
  if (['/give', '/take', '/setbal'].includes(cmd)) {
    const n = num(args[1]); if (!(n >= 0) || (cmd !== '/setbal' && n < 1)) return reply('Использование: ' + cmd + ' &lt;id&gt; &lt;число&gt;');
    let r;
    if (cmd === '/give') r = await db.query('UPDATE users SET balance=balance+$2 WHERE id=$1 RETURNING balance', [t.id, n]);
    else if (cmd === '/take') r = await db.query('UPDATE users SET balance=GREATEST(0,balance-$2) WHERE id=$1 RETURNING balance', [t.id, n]);
    else r = await db.query('UPDATE users SET balance=$2 WHERE id=$1 RETURNING balance', [t.id, n]);
    await audit(t.id, n, cmd.slice(1)); return reply(`✅ Баланс <code>${t.id}</code>: <b>${fmt(r.rows[0].balance)} ⭐</b>`);
  }
}

async function poll() {
  try { await tg('deleteWebhook'); } catch (e) {}
  tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть игру' }, { command: 'deposit', description: 'Пополнить баланс' }, { command: 'balance', description: 'Мой баланс' }, { command: 'online', description: 'Сколько онлайн' }] }).catch(() => {});
  if (WEBAPP_URL) tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: WEBAPP_URL } } }).catch(() => {});
  let offset = 0, fails = 0;
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] });
      fails = 0;
      for (const up of ups) {
        offset = up.update_id + 1;
        try {
          if (up.pre_checkout_query) await onPreCheckout(up.pre_checkout_query);
          else if (up.message) await onMessage(up.message);
          else if (up.callback_query) await onCallback(up.callback_query);
        } catch (e) { console.error('update fail', e); }
      }
    } catch (e) { fails++; console.error('poll', e.message); await new Promise(r => setTimeout(r, Math.min(15000, 1000 * fails))); }
  }
}

/* ================= СТАРТ ================= */
(async () => {
  await initDb();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('web on', port));
  poll();
  if (process.env.RENDER_EXTERNAL_URL) setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {}), 9 * 60 * 1000);
})().catch(e => { console.error(e); process.exit(1); });
