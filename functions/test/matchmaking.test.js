'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers');
const CFG = require('../src/config');
const { ensureProfile } = require('../src/handlers/profile');
const M = require('../src/handlers/matchmaking');

const entry = (rating, queuedAt) => ({ name: 'x', rating, rd: 200, queuedAt, lastPing: queuedAt });

test('findGroup : 4 joueurs de niveau proche partent tout de suite', () => {
  const q = { a: entry(1000, 0), b: entry(1030, 0), c: entry(980, 0), d: entry(1010, 0) };
  const g = M.findGroup(q, 1000);
  assert.equal(g.length, 4);
});

test('findGroup : 2 joueurs attendent, puis partent à deux après FILL_WAIT_MS (jamais de bot)', () => {
  const q = { a: entry(1000, 0), b: entry(1020, 0) };
  assert.equal(M.findGroup(q, CFG.MM.FILL_WAIT_MS - 1), null);
  assert.equal(M.findGroup(q, CFG.MM.FILL_WAIT_MS).length, 2);
});

test("findGroup : la fourchette de niveau s'élargit avec l'attente", () => {
  const q = { a: entry(1000, 0), b: entry(1400, 0) };               // 400 points d'écart
  assert.equal(M.findGroup(q, 26_000), null);                        // fenêtre ~360 : trop loin
  assert.equal(M.findGroup(q, 31_000).length, 2);                    // fenêtre ~410 : OK
});

test('findGroup : un joueur trop éloigné ne bloque pas les autres', () => {
  const q = { far: entry(1500, 0), a: entry(1000, 100), b: entry(1010, 100), c: entry(990, 100), d: entry(1005, 100) };
  const g = M.findGroup(q, 1000).map((e) => e.uid).sort();
  assert.deepEqual(g, ['a', 'b', 'c', 'd']);
});

test('quickMatch : le 4e joueur déclenche le match, les autres le récupèrent à leur prochain ping', async () => {
  const env = makeEnv();
  const users = ['u1', 'u2', 'u3', 'u4'];
  for (const u of users) await ensureProfile(env.ctx(u), { name: 'J' + u });
  const first = [];
  for (const u of users.slice(0, 3)) { first.push(await M.quickMatch(env.ctx(u))); env.advance(500); }
  assert.ok(first.every((r) => r.status === 'WAITING'));
  const last = await M.quickMatch(env.ctx('u4'));
  assert.equal(last.status, 'MATCHED');
  for (const u of users.slice(0, 3)) {
    const r = await M.quickMatch(env.ctx(u));
    assert.equal(r.status, 'MATCHED'); assert.equal(r.code, last.code);
  }
  const room = await env.db.get(`rooms/${last.code}`);
  assert.equal(room.ranked, true); assert.equal(room.visibility, 'PUBLIC'); assert.equal(room.status, 'PLAYING');
  assert.equal(Object.keys(room.players).length, 4);
  assert.deepEqual(Object.values(room.players).map((p) => p.playerIndex).sort(), [0, 1, 2, 3]);
  assert.equal(room.startAt - room.createdAt, CFG.MATCH_COUNTDOWN_MS);      // GO = création + compte à rebours serveur
  assert.ok(room.startAt > env.clock.t - 2000);                   // le GO est dans le futur proche du dernier ping
  assert.equal(await env.db.get('matchmaking/queue'), null);      // la file est vidée
  assert.equal(await env.db.get('users/u2/currentRoom'), last.code);
});

test('quickMatch : à deux joueurs, la partie part après FILL_WAIT_MS', async () => {
  const env = makeEnv();
  await M.quickMatch(env.ctx('a')); await M.quickMatch(env.ctx('b'));
  for (let i = 0; i < 10; i++) { env.advance(2500); const r = await M.quickMatch(env.ctx('a')); await M.quickMatch(env.ctx('b'));
    if (r.status === 'MATCHED') { assert.ok(i >= 9); return; } }
  const r = await M.quickMatch(env.ctx('a'));
  assert.equal(r.status, 'MATCHED');
  const room = await env.db.get(`rooms/${r.code}`);
  assert.equal(Object.keys(room.players).length, 2);
});

test("quickMatch : un joueur qui n'envoie plus de ping sort de la file", async () => {
  const env = makeEnv();
  await M.quickMatch(env.ctx('ghost'));
  env.advance(CFG.MM.ALIVE_MS + 1);
  await M.quickMatch(env.ctx('live'));
  const q = await env.db.get('matchmaking/queue');
  assert.deepEqual(Object.keys(q), ['live']);
});

test('quickMatch : repasser par la file conserve l’ancienneté (la fourchette continue de grandir)', async () => {
  const env = makeEnv();
  const a = await M.quickMatch(env.ctx('a'));
  env.advance(5000);
  const b = await M.quickMatch(env.ctx('a'));
  assert.equal(a.status, 'WAITING');
  assert.equal(b.waitedMs, 5000);
  assert.ok(b.window > a.window);
});

test('cancelQuickMatch : sort de la file et efface une assignation', async () => {
  const env = makeEnv();
  await M.quickMatch(env.ctx('a'));
  await M.cancelQuickMatch(env.ctx('a'));
  assert.equal(await env.db.get('matchmaking/queue'), null);
});
