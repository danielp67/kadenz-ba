'use strict';
const CFG = require('../config');
const { AppError } = require('../errors');
const { generateCode, normalizeCode } = require('../codes');
const { getOrCreateProfile } = require('./profile');

// ------------------------------------------------------------------ outils

/** Limite le nombre de tentatives par minute (anti brute-force des codes, 55.7). */
async function checkRateLimit(ctx, key, { max, windowMs }) {
  const now = ctx.now();
  let blocked = false;
  await ctx.db.transaction(`rateLimits/${ctx.uid}/${key}`, (cur) => {
    blocked = false;
    if (!cur || now - cur.start > windowMs) return { start: now, count: 1 };
    if (cur.count >= max) { blocked = true; return cur; }
    return { start: cur.start, count: cur.count + 1 };
  });
  if (blocked) throw new AppError('resource-exhausted', 'Trop de tentatives. Réessayez dans un instant.');
}

function playersSorted(room) {
  return Object.entries(room.players || {})
    .map(([uid, p]) => ({ uid, ...p }))
    .sort((a, b) => (a.joinedAt - b.joinedAt) || (a.uid < b.uid ? -1 : 1));
}

/** Crée une room avec un code libre (réessaie en cas de collision). */
async function createRoomWithFreeCode(ctx, buildRoom) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const code = generateCode(ctx.randomInt);
    const room = buildRoom(code);
    const res = await ctx.db.transaction(`rooms/${code}`, (cur) => (cur === null ? room : undefined));
    if (res.committed) return code;
  }
  throw new AppError('internal', 'Impossible de créer la partie. Réessayez.');
}

// ------------------------------------------------------------------ quitter

/** Retire `uid` de la room. LOBBY : il disparaît (et l'hôte est transféré si besoin). Partie en cours : il est marqué "parti". */
async function leaveRoomInternal(ctx, uid, code) {
  const now = ctx.now();
  await ctx.db.transaction(`rooms/${code}`, (cur) => {
    if (cur === null) return null;
    if (!cur.players || !cur.players[uid]) return cur;
    if (cur.status === 'LOBBY') {
      delete cur.players[uid];
      const left = playersSorted(cur);
      if (left.length === 0) return null;
      if (cur.hostUid === uid) {                  // migration d'hôte : le plus ancien présent reprend la main
        cur.hostUid = left[0].uid;
        cur.players[left[0].uid].ready = true;
      }
    } else {
      cur.players[uid].left = true;
      cur.players[uid].connected = false;
    }
    cur.updatedAt = now;
    return cur;
  });
  await ctx.db.remove(`users/${uid}/currentRoom`);
}

async function leaveCurrentRoom(ctx, uid, exceptCode) {
  const current = await ctx.db.get(`users/${uid}/currentRoom`);
  if (current && current !== exceptCode) await leaveRoomInternal(ctx, uid, current);
}

// ------------------------------------------------------------------ callables

async function createRoom(ctx, data) {
  if (data.visibility !== undefined && data.visibility !== 'PRIVATE') {
    throw new AppError('invalid-argument', 'Seules les parties privées se créent à la main.');
  }
  const profile = await getOrCreateProfile(ctx);
  await leaveCurrentRoom(ctx, ctx.uid, null);
  const now = ctx.now();
  const code = await createRoomWithFreeCode(ctx, (c) => ({
    code: c, hostUid: ctx.uid, status: 'LOBBY', visibility: 'PRIVATE', ranked: false,
    maxPlayers: CFG.MAX_PLAYERS, createdAt: now, updatedAt: now,
    players: { [ctx.uid]: { name: profile.name, ready: true, connected: true, joinedAt: now } },
  }));
  await ctx.db.set(`users/${ctx.uid}/currentRoom`, code);
  return { code };
}

async function joinRoom(ctx, data) {
  await checkRateLimit(ctx, 'join', CFG.JOIN_RATE_LIMIT);
  const code = normalizeCode(data.code);
  if (!code) throw new AppError('invalid-argument', 'Code invalide : 5 caractères attendus.');
  const profile = await getOrCreateProfile(ctx);
  await leaveCurrentRoom(ctx, ctx.uid, code);

  const now = ctx.now();
  let failure = null;
  const res = await ctx.db.transaction(`rooms/${code}`, (cur) => {
    failure = null;
    if (cur === null) { failure = ['not-found', 'Code introuvable. Vérifiez-le auprès de votre ami.']; return null; }
    if (cur.players && cur.players[ctx.uid]) return cur;                 // déjà dedans : on laisse faire
    if (cur.status !== 'LOBBY') { failure = ['failed-precondition', 'La partie a déjà commencé.']; return cur; }
    if (Object.keys(cur.players || {}).length >= cur.maxPlayers) { failure = ['resource-exhausted', 'La partie est pleine.']; return cur; }
    cur.players[ctx.uid] = { name: profile.name, ready: false, connected: true, joinedAt: now };
    cur.updatedAt = now;
    return cur;
  });
  if (failure) throw new AppError(failure[0], failure[1]);
  if (!res.value) throw new AppError('not-found', 'Code introuvable. Vérifiez-le auprès de votre ami.');
  await ctx.db.set(`users/${ctx.uid}/currentRoom`, code);
  return { code };
}

async function leaveRoom(ctx, data) {
  const code = normalizeCode(data.code);
  if (!code) throw new AppError('invalid-argument', 'Code invalide.');
  await leaveRoomInternal(ctx, ctx.uid, code);
  return { ok: true };
}

async function setReady(ctx, data) {
  const code = normalizeCode(data.code);
  if (!code) throw new AppError('invalid-argument', 'Code invalide.');
  let failure = null;
  await ctx.db.transaction(`rooms/${code}`, (cur) => {
    failure = null;
    if (cur === null) { failure = ['not-found', 'Partie introuvable.']; return null; }
    if (!cur.players || !cur.players[ctx.uid]) { failure = ['permission-denied', "Vous n'êtes pas dans cette partie."]; return cur; }
    if (cur.status !== 'LOBBY') { failure = ['failed-precondition', 'La partie a déjà commencé.']; return cur; }
    cur.players[ctx.uid].ready = cur.hostUid === ctx.uid ? true : !!data.ready;
    cur.updatedAt = ctx.now();
    return cur;
  });
  if (failure) throw new AppError(failure[0], failure[1]);
  return { ok: true };
}

/** L'hôte lance la partie : le serveur tire la graine et fixe l'instant du GO (horloge serveur unique pour tous). */
async function startGame(ctx, data) {
  const code = normalizeCode(data.code);
  if (!code) throw new AppError('invalid-argument', 'Code invalide.');
  const now = ctx.now();
  const seed = ctx.randomSeed();
  let failure = null; let startAt = null;
  await ctx.db.transaction(`rooms/${code}`, (cur) => {
    failure = null;
    if (cur === null) { failure = ['not-found', 'Partie introuvable.']; return null; }
    if (cur.hostUid !== ctx.uid) { failure = ['permission-denied', "Seul l'hôte peut lancer la partie."]; return cur; }
    if (cur.status !== 'LOBBY') { failure = ['failed-precondition', 'La partie a déjà commencé.']; return cur; }
    const list = playersSorted(cur);
    if (list.length < CFG.MIN_PLAYERS_TO_START) { failure = ['failed-precondition', 'Il faut au moins 2 joueurs.']; return cur; }
    if (list.some((p) => p.uid !== cur.hostUid && !p.ready)) { failure = ['failed-precondition', 'Tous les joueurs doivent être prêts.']; return cur; }
    list.forEach((p, i) => { cur.players[p.uid].playerIndex = i; });
    cur.status = 'PLAYING';
    cur.seed = seed;
    cur.startAt = now + CFG.LOBBY_COUNTDOWN_MS;
    cur.rulesVersion = CFG.RULES_VERSION;
    cur.updatedAt = now;
    startAt = cur.startAt;
    return cur;
  });
  if (failure) throw new AppError(failure[0], failure[1]);
  return { startAt };
}

module.exports = {
  createRoom, joinRoom, leaveRoom, setReady, startGame,
  // utilisés par les autres modules
  leaveRoomInternal, leaveCurrentRoom, createRoomWithFreeCode, playersSorted, checkRateLimit,
};
