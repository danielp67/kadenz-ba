'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, deferred, rejects, winnableSeed } = require('./helpers');
const CFG = require('../src/config');
const { ensureProfile } = require('../src/handlers/profile');
const R = require('../src/handlers/rooms');
const M = require('../src/handlers/matchmaking');
const X = require('../src/handlers/rounds');

const W = winnableSeed();                    // graine où les joueurs 0, 1, 2 ont une victoire jouable
const game = (player, k = 0) => W.players[player].games[k];
const actionsOf = (g) => g.plays + g.draws;
const finishData = (code, player, k, atMs, over = {}) => {
  const g = game(player, k);
  return { code, finishedAtMs: atMs, actions: actionsOf(g), log: g.log, malus: g.malus, ...over };
};

/** Room privée démarrée : les joueurs se voient attribuer l'index 0, 1, 2... dans l'ordre d'arrivée. */
async function startedRoom(env, users) {
  const { code } = await R.createRoom(env.ctx(users[0]), {});
  for (const u of users.slice(1)) {
    env.advance(10);
    await R.joinRoom(env.ctx(u), { code });
    await R.setReady(env.ctx(u), { code, ready: true });
  }
  env.advance(10);
  const { startAt } = await R.startGame(env.ctx(users[0]), { code });
  return { code, startAt };
}

test('la graine choisie permet bien des victoires jouables', () => {
  assert.ok(actionsOf(game(0)) > 5);
  assert.equal(game(0).remaining, 0);
});

// ------------------------------------------------------------------ victoire & classement

test('une victoire valide termine la manche et publie le classement officiel', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B', 'C']);
  env.clock.t = startAt + 60_000;
  await env.db.set(`rooms/${code}/progress/B`, { remaining: 4, t: 50_000, seq: 9 });
  await env.db.set(`rooms/${code}/progress/C`, { remaining: 7, t: 50_000, seq: 9 });

  const r = await X.reportFinish(env.ctx('A'), finishData(code, 0, 0, 30_000));
  assert.equal(r.ok, true);
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.status, 'FINISHED');
  assert.equal(room.result.timedOut, false);
  assert.deepEqual(room.result.ranking.map((e) => e.uid), ['A', 'B', 'C']);   // A gagne, puis B (4 restantes), puis C (7)
  assert.equal(room.result.ranking[0].finished, true);
  assert.equal(room.result.ranking[1].remaining, 4);
  assert.equal(room.result.ranked, false);                                   // partie entre amis : jamais classée
  assert.ok(room.result.ranking.every((e) => e.ratingDelta === 0));
  assert.ok(room.result.ranking[0].xp > room.result.ranking[2].xp);
  assert.equal((await env.db.get('users/A')).wins, 1);
  assert.equal(await env.db.get('users/A/currentRoom'), null);
  assert.equal(await env.db.get('leaderboard'), null);                       // pas de classement hors partie classée
});

test("arrivées quasi simultanées : le classement suit le TEMPS DE JEU, pas l'ordre d'arrivée réseau (51.7)", async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B']);
  env.clock.t = startAt + 60_000;

  const gate = deferred(); const reached = deferred();
  const sleepA = () => { reached.resolve(); return gate.promise; };
  const pA = X.reportFinish(env.ctx('A', { sleep: sleepA }), finishData(code, 0, 0, 30_000));   // arrive en premier, temps de jeu 30,0 s
  await reached.promise;
  assert.equal(await env.db.get(`rooms/${code}/status`), 'FINALIZING');
  const rB = await X.reportFinish(env.ctx('B'), finishData(code, 1, 0, 29_400));                // arrive 2e, mais a fini à 29,4 s
  assert.equal(rB.ok, true);
  gate.resolve();
  await pA;

  const result = (await env.db.get(`rooms/${code}`)).result;
  assert.deepEqual(result.ranking.map((e) => e.uid), ['B', 'A']);
  assert.equal(result.ranking[0].finishedAt, 29_400);
});

test('victoire refusée : journal falsifié (coups d’un autre paquet)', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B']);
  env.clock.t = startAt + 60_000;
  const cheat = finishData(code, 0, 0, 30_000);            // B envoie le journal du joueur 0
  const e = await rejects(X.reportFinish(env.ctx('B'), cheat), 'permission-denied');
  assert.match(e.message, /refusée/);
  assert.ok(await env.db.get(`rooms/${code}/flags/B`));
  assert.equal(await env.db.get(`rooms/${code}/status`), 'PLAYING');       // la manche continue
});

test('un joueur signalé ne peut plus gagner, même arrivé le premier', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B']);
  env.clock.t = startAt + 60_000;
  await rejects(X.reportFinish(env.ctx('B'), finishData(code, 0, 0, 20_000)), 'permission-denied');
  await X.reportFinish(env.ctx('A'), finishData(code, 0, 0, 30_000));
  const result = (await env.db.get(`rooms/${code}`)).result;
  assert.deepEqual(result.ranking.map((e) => e.uid), ['A', 'B']);
  assert.equal(result.ranking[1].flagged, true);
  assert.equal(result.ranking[1].xp, 0);                                    // pas de récompense pour un tricheur présumé
});

test('cadence impossible et temps de jeu impossible sont refusés', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B']);
  env.clock.t = startAt + 10_000;
  await rejects(X.reportFinish(env.ctx('A'), finishData(code, 0, 0, 300)), 'permission-denied');          // des dizaines d'actions en 0,3 s
  await rejects(X.reportFinish(env.ctx('B'), finishData(code, 1, 0, 10_000 + CFG.FINISH_TIME_TOLERANCE_MS + 500)), 'permission-denied');
});

test('rapporter deux fois la même victoire est sans effet ; après la fin, c’est refusé', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B']);
  env.clock.t = startAt + 60_000;
  const gate = deferred(); const reached = deferred();
  const p = X.reportFinish(env.ctx('A', { sleep: () => { reached.resolve(); return gate.promise; } }), finishData(code, 0, 0, 30_000));
  await reached.promise;
  const dup = await X.reportFinish(env.ctx('A'), finishData(code, 0, 0, 30_000));
  assert.equal(dup.duplicate, true);
  gate.resolve(); await p;
  await rejects(X.reportFinish(env.ctx('B'), finishData(code, 1, 0, 31_000)), 'failed-precondition');
});

// ------------------------------------------------------------------ attaques et Malus

test('attaques : recharge imposée par le serveur, cibles contrôlées', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B', 'C']);
  env.clock.t = startAt + 10_000;
  await X.sendAttack(env.ctx('A'), { code, to: 'B' });
  const e = await rejects(X.sendAttack(env.ctx('A'), { code, to: 'C' }), 'failed-precondition');
  assert.match(e.message, /recharge/i);
  env.advance(CFG.ATTACK_COOLDOWN_MS);
  await X.sendAttack(env.ctx('A'), { code, to: 'C' });
  await rejects(X.sendAttack(env.ctx('A'), { code, to: 'A' }), 'invalid-argument');
  await rejects(X.sendAttack(env.ctx('A'), { code, to: 'zzz' }), 'invalid-argument');
  await rejects(X.sendAttack(env.ctx('stranger'), { code, to: 'B' }), 'permission-denied');
  const events = Object.values(await env.db.get(`rooms/${code}/events`));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((x) => x.to), ['B', 'C']);
});

test("les Malus déclarés doivent correspondre aux attaques réellement reçues", async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B']);
  env.clock.t = startAt + 10_000; await X.sendAttack(env.ctx('A'), { code, to: 'B' });
  env.clock.t = startAt + 19_000; await X.sendAttack(env.ctx('A'), { code, to: 'B' });
  env.clock.t = startAt + 40_000;

  // B a reçu 2 Malus (un journal valide existe pour ce cas) : omettre les Malus est refusé
  const e = await rejects(X.reportFinish(env.ctx('B'), finishData(code, 1, 0, 30_000, { malus: 0 })), 'permission-denied');
  assert.match(e.message, /Malus/);
  env.advance(1000);
  const ok = await X.reportFinish(env.ctx('B'), finishData(code, 1, 1, 30_000));
  assert.equal(ok.ok, true);
  assert.equal((await env.db.get(`rooms/${code}`)).result.ranking[0].uid, 'B');
});

test('attaquer plus que ce que le jeu permet est détecté à la victoire', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B']);
  env.clock.t = startAt + 10_000;
  for (let i = 0; i < 8; i++) { await X.sendAttack(env.ctx('A'), { code, to: 'B' }); env.advance(CFG.ATTACK_COOLDOWN_MS); }
  env.clock.t = startAt + 90_000;
  const e = await rejects(X.reportFinish(env.ctx('A'), finishData(code, 0, 0, 40_000)), 'permission-denied');
  assert.match(e.message, /attaques/);
});

// ------------------------------------------------------------------ timeout

test('timeout : personne ne finit, la manche se clôt et classe sur les cartes restantes', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B', 'C']);
  await env.db.set(`rooms/${code}/progress/A`, { remaining: 5, t: 1, seq: 1 });
  await env.db.set(`rooms/${code}/progress/B`, { remaining: 2, t: 1, seq: 1 });
  await env.db.set(`rooms/${code}/progress/C`, { remaining: 2, t: 1, seq: 1 });
  env.clock.t = startAt + 60_000;
  await rejects(X.finalizeRound(env.ctx('A'), { code }), 'failed-precondition');      // trop tôt
  env.clock.t = startAt + CFG.ROUND_TIMEOUT_MS;
  await X.finalizeRound(env.ctx('A'), { code });
  const result = (await env.db.get(`rooms/${code}`)).result;
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.ranking.map((e) => e.uid), ['B', 'C', 'A']);               // égalité B/C : ordre d'arrivée dans la room
  assert.equal((await X.finalizeRound(env.ctx('B'), { code })).finished, true);        // idempotent
});

// ------------------------------------------------------------------ partie classée

test('partie classée : Glicko-2, XP, pièces et classement saisonnier', async () => {
  const env = makeEnv({ seed: W.seed });
  const users = ['u1', 'u2', 'u3', 'u4'];
  for (const u of users) await ensureProfile(env.ctx(u), { name: 'J' + u });
  let code;
  for (const u of users) { const r = await M.quickMatch(env.ctx(u)); env.advance(300); if (r.status === 'MATCHED') code = r.code; }
  assert.ok(code);
  const room = await env.db.get(`rooms/${code}`);
  assert.equal(room.ranked, true);
  env.clock.t = room.startAt + 60_000;

  await X.reportFinish(env.ctx('u1'), finishData(code, 0, 0, 30_000));           // u1 = joueur d'index 0
  const result = (await env.db.get(`rooms/${code}`)).result;
  assert.equal(result.ranked, true);
  const delta = Object.fromEntries(result.ranking.map((e) => [e.uid, e.ratingDelta]));
  assert.equal(result.ranking[0].uid, 'u1');
  assert.ok(delta.u1 > 0, 'le vainqueur gagne des points');
  assert.ok(delta.u2 < 0 && delta.u3 < 0 && delta.u4 < 0, 'les autres en perdent');
  assert.equal(delta.u2, delta.u3);                                                // égalité de rang = même variation

  const winner = await env.db.get('users/u1');
  assert.equal(winner.wins, 1); assert.equal(winner.games, 1);
  assert.ok(winner.rating > 1000 && winner.xp >= 50 && winner.coins >= 30);
  assert.ok(winner.rd < 350);                                                      // plus de certitude après une partie
  const board = await env.db.get('leaderboard/S6');
  assert.deepEqual(Object.keys(board).sort(), users);
  assert.equal(board.u1.rating, Math.round(winner.rating));
  assert.equal(await env.db.get('matchmaking/matches/u1') !== null, true);         // nettoyé par cancelQuickMatch côté client / ménage
});

test('un joueur qui quitte en pleine manche est classé derrière ceux qui jouent encore', async () => {
  const env = makeEnv({ seed: W.seed });
  const { code, startAt } = await startedRoom(env, ['A', 'B', 'C']);
  await env.db.set(`rooms/${code}/progress/B`, { remaining: 6, t: 1, seq: 1 });
  await env.db.set(`rooms/${code}/progress/C`, { remaining: 6, t: 1, seq: 1 });
  await R.leaveRoom(env.ctx('C'), { code });
  env.clock.t = startAt + 60_000;
  await X.reportFinish(env.ctx('A'), finishData(code, 0, 0, 30_000));
  const result = (await env.db.get(`rooms/${code}`)).result;
  assert.equal(result.ranking.length, 3);
  assert.equal(result.ranking[0].uid, 'A');
});
