'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, rejects } = require('./helpers');
const CFG = require('../src/config');
const { ensureProfile } = require('../src/handlers/profile');
const R = require('../src/handlers/rooms');

test('ensureProfile : pseudo par défaut puis changement, pseudo invalide refusé', async () => {
  const env = makeEnv();
  const p = await ensureProfile(env.ctx('u1'), {});
  assert.match(p.name, /^Player\d{4}$/);
  assert.equal(p.level, 1); assert.equal(p.league, 'BRONZE');
  const q = await ensureProfile(env.ctx('u1'), { name: 'Daniel' });
  assert.equal(q.name, 'Daniel');
  await rejects(ensureProfile(env.ctx('u1'), { name: '<b>' }), 'invalid-argument');
});

test("createRoom : code de 5 caractères sans caractères ambigus, l'hôte est prêt", async () => {
  const env = makeEnv();
  await ensureProfile(env.ctx('host'), { name: 'Daniel' });
  const { code } = await R.createRoom(env.ctx('host'), {});
  assert.match(code, /^[A-HJKMNP-Z2-9]{5}$/);
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.status, 'LOBBY'); assert.equal(room.hostUid, 'host'); assert.equal(room.ranked, false);
  assert.equal(room.players.host.ready, true); assert.equal(room.players.host.name, 'Daniel');
  assert.equal(await env.db.get('users/host/currentRoom'), code);
});

test('createRoom : une collision de code est résolue automatiquement', async () => {
  let calls = 0;
  const env = makeEnv({ randomInt: () => { calls++; return calls <= 5 ? 0 : calls; } });   // 1er code = "AAAAA" pour l'hôte 1
  const a = await R.createRoom(env.ctx('h1'), {});
  calls = 0;
  const b = await R.createRoom(env.ctx('h2'), {});          // tire de nouveau "AAAAA" -> occupé -> réessaie
  assert.notEqual(a.code, b.code);
});

test("createRoom : on ne crée pas de partie publique à la main", async () => {
  await rejects(R.createRoom(makeEnv().ctx('h'), { visibility: 'PUBLIC' }), 'invalid-argument');
});

test('joinRoom : le code se tape comme on veut (minuscules, espaces, tirets)', async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  env.advance(10);
  const typed = ` ${code.slice(0, 2).toLowerCase()}-${code.slice(2)} `;
  const r = await R.joinRoom(env.ctx('g'), { code: typed });
  assert.equal(r.code, code);
  assert.equal((await env.db.get(`rooms/${code}/players/g/ready`)), false);
});

test("joinRoom : messages d'erreur explicites (introuvable, invalide, pleine, déjà commencée)", async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  const nf = await rejects(R.joinRoom(env.ctx('x'), { code: 'ZZZZZ' }), 'not-found');
  assert.match(nf.message, /introuvable/i);
  await rejects(R.joinRoom(env.ctx('x'), { code: 'AB' }), 'invalid-argument');
  await rejects(R.joinRoom(env.ctx('x'), { code: 'ABCD0' }), 'invalid-argument');     // 0 n'existe pas dans l'alphabet
  for (const u of ['p2', 'p3', 'p4']) { env.advance(5); await R.joinRoom(env.ctx(u), { code }); }
  const full = await rejects(R.joinRoom(env.ctx('p5'), { code }), 'resource-exhausted');
  assert.match(full.message, /pleine/i);
  await R.setReady(env.ctx('p2'), { code, ready: true });
  await R.setReady(env.ctx('p3'), { code, ready: true });
  await R.setReady(env.ctx('p4'), { code, ready: true });
  await R.startGame(env.ctx('h'), { code });
  const late = await rejects(R.joinRoom(env.ctx('late'), { code }), 'failed-precondition');
  assert.match(late.message, /commencé/i);
});

test('joinRoom : rejoindre deux fois ne duplique pas le joueur', async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  await R.joinRoom(env.ctx('g'), { code });
  await R.joinRoom(env.ctx('g'), { code });
  assert.equal(Object.keys((await env.db.get(`rooms/${code}`)).players).length, 2);
});

test('joinRoom : anti brute-force, 10 tentatives par minute', async () => {
  const env = makeEnv();
  for (let i = 0; i < CFG.JOIN_RATE_LIMIT.max; i++) await rejects(R.joinRoom(env.ctx('bot'), { code: 'ZZZZZ' }), 'not-found');
  await rejects(R.joinRoom(env.ctx('bot'), { code: 'ZZZZZ' }), 'resource-exhausted');
  env.advance(CFG.JOIN_RATE_LIMIT.windowMs + 1);
  await rejects(R.joinRoom(env.ctx('bot'), { code: 'ZZZZZ' }), 'not-found');           // la fenêtre est repartie
});

test("rejoindre une autre room quitte l'ancienne (et la supprime si elle est vide)", async () => {
  const env = makeEnv();
  const a = await R.createRoom(env.ctx('h1'), {});
  const b = await R.createRoom(env.ctx('h2'), {});
  await R.joinRoom(env.ctx('h1'), { code: b.code });
  assert.equal(await env.db.get(`rooms/${a.code}`), null);
  assert.equal(await env.db.get('users/h1/currentRoom'), b.code);
});

test('setReady : le joueur bascule, l’hôte reste prêt, un étranger est refusé', async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  await R.joinRoom(env.ctx('g'), { code });
  await R.setReady(env.ctx('g'), { code, ready: true });
  assert.equal(await env.db.get(`rooms/${code}/players/g/ready`), true);
  await R.setReady(env.ctx('g'), { code, ready: false });
  assert.equal(await env.db.get(`rooms/${code}/players/g/ready`), false);
  await R.setReady(env.ctx('h'), { code, ready: false });
  assert.equal(await env.db.get(`rooms/${code}/players/h/ready`), true);
  await rejects(R.setReady(env.ctx('stranger'), { code, ready: true }), 'permission-denied');
});

test('startGame : seul l’hôte, à 2 joueurs prêts minimum, la graine et le GO viennent du serveur', async () => {
  const env = makeEnv({ seed: 987654 });
  const { code } = await R.createRoom(env.ctx('h'), {});
  assert.match((await rejects(R.startGame(env.ctx('h'), { code }), 'failed-precondition')).message, /2 joueurs/);
  env.advance(10); await R.joinRoom(env.ctx('g'), { code });
  await rejects(R.startGame(env.ctx('g'), { code }), 'permission-denied');
  assert.match((await rejects(R.startGame(env.ctx('h'), { code }), 'failed-precondition')).message, /prêts/);
  await R.setReady(env.ctx('g'), { code, ready: true });
  const { startAt } = await R.startGame(env.ctx('h'), { code });
  assert.equal(startAt, env.clock.t + CFG.LOBBY_COUNTDOWN_MS);
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.status, 'PLAYING'); assert.equal(room.seed, 987654);
  assert.equal(room.players.h.playerIndex, 0); assert.equal(room.players.g.playerIndex, 1);   // dans l'ordre d'arrivée
  await rejects(R.startGame(env.ctx('h'), { code }), 'failed-precondition');
});

test("l'hôte qui part transfère la main au plus ancien, la room vide est supprimée", async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  env.advance(10); await R.joinRoom(env.ctx('a'), { code });
  env.advance(10); await R.joinRoom(env.ctx('b'), { code });
  await R.leaveRoom(env.ctx('h'), { code });
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.hostUid, 'a');
  assert.equal(room.players.a.ready, true);                  // le nouvel hôte est prêt d'office
  assert.equal(await env.db.get('users/h/currentRoom'), null);
  await R.leaveRoom(env.ctx('a'), { code }); await R.leaveRoom(env.ctx('b'), { code });
  assert.equal(await env.db.get(`rooms/${code}`), null);
});

test('quitter en pleine partie marque le joueur "parti" sans le retirer du classement', async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  env.advance(10); await R.joinRoom(env.ctx('g'), { code });
  await R.setReady(env.ctx('g'), { code, ready: true });
  await R.startGame(env.ctx('h'), { code });
  await R.leaveRoom(env.ctx('g'), { code });
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.players.g.left, true);
  assert.ok(room.players.h);
});

test("chaque erreur porte une clé stable que l'app traduit (le message français n'est qu'un secours)", async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  assert.equal((await rejects(R.joinRoom(env.ctx('x'), { code: 'ZZZZZ' }), 'not-found')).key, 'ROOM_NOT_FOUND');
  assert.equal((await rejects(R.joinRoom(env.ctx('x'), { code: 'AB' }), 'invalid-argument')).key, 'CODE_INVALID');
  assert.equal((await rejects(R.startGame(env.ctx('h'), { code }), 'failed-precondition')).key, 'NEED_TWO_PLAYERS');
  assert.equal((await rejects(ensureProfile(env.ctx('u'), { name: '<b>' }), 'invalid-argument')).key, 'NAME_INVALID');
  env.advance(5); await R.joinRoom(env.ctx('g'), { code });
  assert.equal((await rejects(R.startGame(env.ctx('g'), { code }), 'permission-denied')).key, 'NOT_HOST');
  assert.equal((await rejects(R.startGame(env.ctx('h'), { code }), 'failed-precondition')).key, 'NOT_ALL_READY');
  for (let i = 0; i < 10; i++) await rejects(R.joinRoom(env.ctx('spam'), { code: 'ZZZZZ' }));
  assert.equal((await rejects(R.joinRoom(env.ctx('spam'), { code: 'ZZZZZ' }), 'resource-exhausted')).key, 'TOO_MANY_ATTEMPTS');
});
