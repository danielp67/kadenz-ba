'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, winnableSeed } = require('./helpers');
const { ensureProfile } = require('../src/handlers/profile');
const R = require('../src/handlers/rooms');
const M = require('../src/handlers/matchmaking');
const X = require('../src/handlers/rounds');
const { deleteAccount } = require('../src/handlers/account');

const withAuth = (env, uid, deleted) => env.ctx(uid, { deleteAuthUser: async (id) => { deleted.push(id); } });

test("suppression du compte : plus aucune trace du joueur (profil, classements, file, limites, room)", async () => {
  const W = winnableSeed();
  const env = makeEnv({ seed: W.seed });
  const deleted = [];
  const users = ['u1', 'u2', 'u3', 'u4'];
  for (const u of users) await ensureProfile(env.ctx(u), { name: 'J' + u });

  // une partie classée terminée : u1 gagne => entrées de classement + saison mémorisée
  let code;
  for (const u of users) { const r = await M.quickMatch(env.ctx(u)); env.advance(300); if (r.status === 'MATCHED') code = r.code; }
  const room = await env.db.get(`rooms/${code}`);
  env.clock.t = room.startAt + 60_000;
  const g = W.players[0].games[0];
  await X.reportFinish(env.ctx('u1'), { code, finishedAtMs: 30_000, actions: g.plays + g.draws, log: g.log, malus: 0 });
  assert.ok(await env.db.get('leaderboard/S6/u1'));
  await env.db.set('rateLimits/u1/join', { start: 1, count: 3 });
  await M.quickMatch(env.ctx('u1'));                                    // u1 repart dans la file d'attente

  const r = await deleteAccount(withAuth(env, 'u1', deleted));
  assert.equal(r.ok, true);
  assert.equal(await env.db.get('users/u1'), null);
  assert.equal(await env.db.get('leaderboard/S6/u1'), null);
  assert.equal(await env.db.get('rateLimits/u1'), null);
  assert.equal(await env.db.get('matchmaking/matches/u1'), null);
  const queue = (await env.db.get('matchmaking/queue')) || {};
  assert.equal(queue.u1, undefined);
  assert.deepEqual(deleted, ['u1']);
  assert.ok(await env.db.get('leaderboard/S6/u2'), 'les autres joueurs ne sont pas touchés');
  assert.ok(await env.db.get('users/u2'));
});

test("suppression du compte en plein lobby : l'hôte part, la main est transférée", async () => {
  const env = makeEnv();
  const deleted = [];
  const { code } = await R.createRoom(env.ctx('host'), {});
  env.advance(10); await R.joinRoom(env.ctx('guest'), { code });
  await deleteAccount(withAuth(env, 'host', deleted));
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.hostUid, 'guest');
  assert.equal(room.players.host, undefined);
  assert.equal(await env.db.get('users/host'), null);
});

test('suppression du compte : rejouable, et sans profil existant', async () => {
  const env = makeEnv();
  const deleted = [];
  await deleteAccount(withAuth(env, 'ghost', deleted));
  await deleteAccount(withAuth(env, 'ghost', deleted));
  assert.deepEqual(deleted, ['ghost', 'ghost']);
});
