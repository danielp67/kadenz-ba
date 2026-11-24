'use strict';
const CFG = require('../config');
const { getOrCreateProfile } = require('./profile');
const { leaveCurrentRoom, createRoomWithFreeCode } = require('./rooms');
const P = require('../progress');

const windowFor = (entry, now) =>
  Math.min(CFG.MM.MAX_WINDOW, CFG.MM.BASE_WINDOW + CFG.MM.GROWTH_PER_SEC * ((now - entry.queuedAt) / 1000));

/**
 * Cherche un groupe dans la file. Pur et testable.
 * - 4 joueurs de niveau proche : on lance tout de suite ;
 * - sinon, après FILL_WAIT_MS d'attente, on lance avec 2 ou 3 joueurs humains (jamais de bot en classé, 55.4) ;
 * - la fourchette de niveau accepté s'élargit avec l'attente.
 * @returns {{uid:string}[] | null}
 */
function findGroup(queue, now) {
  const entries = Object.entries(queue || {})
    .map(([uid, e]) => ({ uid, ...e }))
    .sort((a, b) => (a.queuedAt - b.queuedAt) || (a.uid < b.uid ? -1 : 1));
  for (const anchor of entries) {
    const wa = windowFor(anchor, now);
    const candidates = entries
      .filter((e) => e.uid !== anchor.uid && Math.abs(e.rating - anchor.rating) <= Math.min(wa, windowFor(e, now)))
      .sort((a, b) => (Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating)) || (a.queuedAt - b.queuedAt));
    const group = [anchor, ...candidates.slice(0, CFG.MM.MAX_GROUP - 1)];
    if (group.length >= CFG.MM.MAX_GROUP) return group;
    if (group.length >= 2 && now - anchor.queuedAt >= CFG.MM.FILL_WAIT_MS) return group;
  }
  return null;
}

/** Room classée créée par le serveur : pas de lobby, le compte à rebours démarre tout de suite. */
async function createMatchRoom(ctx, group) {
  const now = ctx.now();
  const seed = ctx.randomSeed();
  const code = await createRoomWithFreeCode(ctx, (c) => {
    const players = {};
    group.forEach((e, i) => {
      players[e.uid] = { name: e.name, ready: true, connected: true, joinedAt: now + i, playerIndex: i };
    });
    return {
      code: c, hostUid: group[0].uid, status: 'PLAYING', visibility: 'PUBLIC', ranked: true,
      maxPlayers: CFG.MAX_PLAYERS, createdAt: now, updatedAt: now,
      seed, startAt: now + CFG.MATCH_COUNTDOWN_MS, rulesVersion: CFG.RULES_VERSION, players,
    };
  });
  return code;
}

/**
 * Appelé toutes les ~2-3 s par le client tant qu'il cherche une partie ("ping" de présence + tentative de match).
 * @returns {{status:'WAITING', waitedMs:number, window:number} | {status:'MATCHED', code:string}}
 */
async function quickMatch(ctx) {
  const uid = ctx.uid;
  const now = ctx.now();
  const profile = P.applySeason(await getOrCreateProfile(ctx), P.seasonId(now));

  // 1) Un autre appel nous a peut-être déjà placés dans une partie
  const assigned = await ctx.db.get(`matchmaking/matches/${uid}`);
  if (assigned && now - assigned.at < CFG.MM.ASSIGN_TTL_MS) return { status: 'MATCHED', code: assigned.code };

  await leaveCurrentRoom(ctx, uid, null);

  // 2) On entre (ou on reste) dans la file et on tente de former un groupe, de façon atomique
  let group = null;
  const res = await ctx.db.transaction('matchmaking/queue', (cur) => {
    group = null;
    const queue = { ...(cur || {}) };
    const prev = queue[uid];
    queue[uid] = { name: profile.name, rating: profile.rating, rd: profile.rd, queuedAt: prev ? prev.queuedAt : now, lastPing: now };
    for (const [id, e] of Object.entries(queue)) if (now - e.lastPing > CFG.MM.ALIVE_MS) delete queue[id];
    const found = findGroup(queue, now);
    if (found) {
      group = found.map((e) => ({ uid: e.uid, name: e.name, rating: e.rating }));
      for (const e of found) delete queue[e.uid];
    }
    return Object.keys(queue).length ? queue : null;
  });

  if (group) {
    const code = await createMatchRoom(ctx, group);
    for (const e of group) {
      await ctx.db.set(`matchmaking/matches/${e.uid}`, { code, at: now });
      await ctx.db.set(`users/${e.uid}/currentRoom`, code);
    }
    if (group.some((e) => e.uid === uid)) return { status: 'MATCHED', code };
  }
  const mine = (res.value || {})[uid] || { queuedAt: now };
  return { status: 'WAITING', waitedMs: now - mine.queuedAt, window: Math.round(windowFor(mine, now)) };
}

async function cancelQuickMatch(ctx) {
  await ctx.db.transaction('matchmaking/queue', (cur) => {
    if (!cur) return null;
    const queue = { ...cur };
    delete queue[ctx.uid];
    return Object.keys(queue).length ? queue : null;
  });
  await ctx.db.remove(`matchmaking/matches/${ctx.uid}`);
  return { ok: true };
}

module.exports = { quickMatch, cancelQuickMatch, findGroup, windowFor };
