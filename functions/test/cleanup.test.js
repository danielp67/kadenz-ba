'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, winnableSeed } = require('./helpers');
const CFG = require('../src/config');
const R = require('../src/handlers/rooms');
const C = require('../src/handlers/cleanup');

test('ménage : une room de lobby abandonnée est supprimée et libère ses joueurs', async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  env.advance(CFG.LOBBY_IDLE_MS + 1000);
  const stats = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(stats.deleted, 1);
  assert.equal(await env.db.get(`rooms/${code}`), null);
  assert.equal(await env.db.get('users/h/currentRoom'), null);
});

test("ménage : l'hôte déconnecté passe la main à un joueur connecté (55.7)", async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  env.advance(10); await R.joinRoom(env.ctx('g'), { code });
  await env.db.set(`rooms/${code}/players/h/connected`, false);
  env.advance(CFG.HOST_MIGRATION_AFTER_MS + 5000);
  const stats = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(stats.migrated, 1);
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.hostUid, 'g'); assert.equal(room.players.g.ready, true);
});

test("ménage : une manche dont tous les clients ont disparu est clôturée avec son classement", async () => {
  const W = winnableSeed();
  const env = makeEnv({ seed: W.seed });
  const { code } = await R.createRoom(env.ctx('h'), {});
  env.advance(10); await R.joinRoom(env.ctx('g'), { code }); await R.setReady(env.ctx('g'), { code, ready: true });
  const { startAt } = await R.startGame(env.ctx('h'), { code });
  await env.db.set(`rooms/${code}/progress/h`, { remaining: 3, t: 1, seq: 1 });
  env.clock.t = startAt + CFG.ROUND_TIMEOUT_MS + CFG.PLAYING_STUCK_MS + 1000;
  const stats = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(stats.resolved, 1);
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.status, 'FINISHED');
  assert.equal(room.result.ranking[0].uid, 'h');
  assert.equal(await env.db.get('users/h/currentRoom'), null);
});

test('ménage : une clôture restée en suspens (FINALIZING) est terminée', async () => {
  const env = makeEnv();
  const { code } = await R.createRoom(env.ctx('h'), {});
  env.advance(10); await R.joinRoom(env.ctx('g'), { code }); await R.setReady(env.ctx('g'), { code, ready: true });
  await R.startGame(env.ctx('h'), { code });
  const t = env.clock.t;
  await env.db.update(`rooms/${code}`, { status: 'FINALIZING', finalizeAt: t, resolving: t, updatedAt: t - 61_000 });
  env.advance(CFG.FINALIZING_STUCK_MS + 5000);
  const stats = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(stats.resolved, 1);
  assert.equal(await env.db.get(`rooms/${code}/status`), 'FINISHED');
});

test('ménage : les manches terminées disparaissent après leur durée de conservation', async () => {
  const env = makeEnv();
  await env.db.set('rooms/AAAAA', { status: 'FINISHED', finishedAt: env.clock.t, updatedAt: env.clock.t, players: { x: { name: 'x' } } });
  env.advance(CFG.FINISHED_TTL_MS + 1000);
  const stats = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(stats.deleted, 1);
  assert.equal(await env.db.get('rooms/AAAAA'), null);
});

test("ménage : file d'attente et assignations périmées purgées", async () => {
  const env = makeEnv();
  const t = env.clock.t;
  await env.db.set('matchmaking/queue/old', { name: 'x', rating: 1000, rd: 200, queuedAt: t - 999999, lastPing: t - 999999 });
  await env.db.set('matchmaking/matches/old', { code: 'AAAAA', at: t - CFG.MATCH_ASSIGN_PURGE_MS - 1 });
  const stats = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(stats.purged, 2);
  assert.equal(await env.db.get('matchmaking/queue'), null);
  assert.equal(await env.db.get('matchmaking/matches'), null);
});

test('ménage PAR LOTS : 60 rooms abandonnées partent en une seule écriture groupée, pas une par room', async () => {
  const env = makeEnv();
  const t = env.clock.t;
  for (let i = 0; i < 60; i++) {
    const code = 'R' + String(i).padStart(4, '0');
    await env.db.set(`rooms/${code}`, { status: 'LOBBY', hostUid: `h${i}`, updatedAt: t - CFG.LOBBY_IDLE_MS - 1000,
      players: { [`h${i}`]: { name: 'h', joinedAt: t }, [`g${i}`]: { name: 'g', joinedAt: t } } });
    await env.db.set(`users/h${i}/currentRoom`, code);
    await env.db.set(`users/g${i}/currentRoom`, code);
  }
  Object.keys(env.db.stats).forEach((k) => { env.db.stats[k] = 0; });
  const stats = await C.cleanupRooms(env.ctx('cron'));

  assert.equal(stats.deleted, 60);
  assert.equal(await env.db.get('rooms'), null);
  assert.equal(await env.db.get('users'), null);                      // les 120 pointeurs "currentRoom" aussi
  assert.equal(env.db.stats.remove, 0, 'aucune suppression unitaire');
  assert.equal(env.db.stats.update, 1, '180 chemins en UNE écriture groupée');
  assert.equal(stats.writes, 1);
});

test('ménage par lots : au-delà de 400 chemins, plusieurs écritures groupées (pas une par chemin)', async () => {
  const env = makeEnv();
  const t = env.clock.t;
  for (let i = 0; i < 300; i++) {
    await env.db.set(`rooms/R${String(i).padStart(4, '0')}`, { status: 'FINISHED', finishedAt: t - CFG.FINISHED_TTL_MS - 5000,
      updatedAt: t - CFG.FINISHED_TTL_MS - 5000, players: { x: { name: 'x', joinedAt: 1 } } });
  }
  for (let i = 0; i < 200; i++) await env.db.set(`matchmaking/matches/m${i}`, { code: 'AAAAA', at: t - CFG.MATCH_ASSIGN_PURGE_MS - 1 });
  Object.keys(env.db.stats).forEach((k) => { env.db.stats[k] = 0; });
  const stats = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(stats.deleted, 300);
  assert.equal(stats.purged, 200);
  assert.equal(env.db.stats.update, 2);                               // 500 chemins = 2 écritures de 400 max
  assert.equal(await env.db.get('rooms'), null);
  assert.equal(await env.db.get('matchmaking/matches'), null);
});

test('ménage : un passage est borné, le reste est traité au suivant', async () => {
  const env = makeEnv();
  const t = env.clock.t;
  for (let i = 0; i < CFG.CLEANUP_ROOMS_PER_RUN + 20; i++) {
    await env.db.set(`rooms/R${String(i).padStart(5, '0')}`, { status: 'FINISHED', finishedAt: t - CFG.FINISHED_TTL_MS - 1000,
      updatedAt: t - CFG.FINISHED_TTL_MS - 1000 - i, players: { x: { name: 'x', joinedAt: 1 } } });
  }
  const first = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(first.deleted, CFG.CLEANUP_ROOMS_PER_RUN);
  assert.equal(first.more, true);
  const second = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(second.deleted, 20);
  assert.equal(second.more, false);
});

test('ménage : les manches bloquées sont clôturées en parallèle, par groupes', async () => {
  const env = makeEnv();
  const t = env.clock.t;
  for (let i = 0; i < 25; i++) {
    await env.db.set(`rooms/P${String(i).padStart(4, '0')}`, { status: 'PLAYING', startAt: t - CFG.ROUND_TIMEOUT_MS - CFG.PLAYING_STUCK_MS - 5000,
      updatedAt: t - CFG.ROUND_TIMEOUT_MS - 60_000, ranked: false,
      players: { a: { name: 'a', joinedAt: 1, playerIndex: 0 }, b: { name: 'b', joinedAt: 2, playerIndex: 1 } } });
  }
  const stats = await C.cleanupRooms(env.ctx('cron'));
  assert.equal(stats.resolved, 25);
  const rooms = await env.db.get('rooms');
  assert.ok(Object.values(rooms).every((r) => r.status === 'FINISHED' && r.result));
});
