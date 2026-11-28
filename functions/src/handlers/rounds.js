'use strict';
const CFG = require('../config');
const ENGINE = require('../engine');
const { AppError } = require('../errors');
const { normalizeCode } = require('../codes');
const { replay } = require('../replay');
const { rateRound } = require('../rating');
const P = require('../progress');

async function loadRoomFor(ctx, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) throw new AppError('invalid-argument', 'Code invalide.', 'CODE_INVALID');
  const room = await ctx.db.get(`rooms/${code}`);
  if (!room) throw new AppError('not-found', 'Partie introuvable.', 'ROOM_NOT_FOUND');
  if (!room.players || !room.players[ctx.uid]) throw new AppError('permission-denied', "Vous n'êtes pas dans cette partie.", 'NOT_IN_ROOM');
  return { code, room };
}

// ------------------------------------------------------------------ attaques (51.6)

/** Le serveur impose le délai de recharge et un plafond : un client modifié ne peut pas spammer. */
async function sendAttack(ctx, data) {
  const { code, room } = await loadRoomFor(ctx, data.code);
  const now = ctx.now();
  if (room.status !== 'PLAYING' || now < room.startAt - 500) throw new AppError('failed-precondition', "La manche n'est pas en cours.", 'ROUND_NOT_RUNNING');
  const target = data.to;
  if (typeof target !== 'string' || target === ctx.uid || !room.players[target]) throw new AppError('invalid-argument', 'Cible invalide.', 'TARGET_INVALID');
  if ((room.finishes && room.finishes[target]) || room.players[target].left) throw new AppError('failed-precondition', 'Ce joueur a déjà fini.', 'TARGET_FINISHED');
  if (room.finishes && room.finishes[ctx.uid]) throw new AppError('failed-precondition', 'Vous avez déjà fini.', 'SELF_FINISHED');

  let failure = null;
  await ctx.db.transaction(`rooms/${code}/attackState/${ctx.uid}`, (cur) => {
    failure = null;
    if (cur && now - cur.last < CFG.ATTACK_COOLDOWN_MS - CFG.ATTACK_COOLDOWN_TOLERANCE_MS) {
      failure = ['failed-precondition', 'Attaque en recharge.', 'ATTACK_COOLDOWN']; return cur;
    }
    if (cur && cur.count >= CFG.MAX_ATTACKS_PER_ROUND) {
      failure = ['resource-exhausted', "Trop d'attaques pour cette manche.", 'TOO_MANY_ATTACKS']; return cur;
    }
    return { last: now, count: (cur ? cur.count : 0) + 1 };
  });
  if (failure) throw new AppError(failure[0], failure[1], failure[2]);

  const key = ctx.db.pushKey(`rooms/${code}/events`);
  await ctx.db.set(`rooms/${code}/events/${key}`, { type: 'ATTACK', from: ctx.uid, to: target, at: now });
  return { ok: true };
}

// ------------------------------------------------------------------ victoire

async function flag(ctx, code, reason) {
  await ctx.db.set(`rooms/${code}/flags/${ctx.uid}`, { reason, at: ctx.now() });
  throw new AppError('permission-denied', `Victoire refusée : ${reason}.`, 'FINISH_REJECTED');
}

/**
 * Un joueur dit avoir vidé sa pile. Il envoie son temps de jeu logique (horloge serveur partagée), le nombre d'actions,
 * le journal de ses coups et le nombre de Malus reçus. Le serveur REJOUE la manche avant de le croire (51.8).
 */
async function reportFinish(ctx, data) {
  const { code, room } = await loadRoomFor(ctx, data.code);
  if (room.status !== 'PLAYING' && room.status !== 'FINALIZING') throw new AppError('failed-precondition', 'La manche est terminée.', 'ROUND_OVER');
  if (room.finishes && room.finishes[ctx.uid]) return { ok: true, duplicate: true };

  const now = ctx.now();
  const me = room.players[ctx.uid];
  const at = Number(data.finishedAtMs);
  const actions = Number(data.actions);
  const malus = Number(data.malus);
  if (!Number.isFinite(at) || !Number.isInteger(actions) || !Number.isInteger(malus)) {
    throw new AppError('invalid-argument', 'Données de fin de manche invalides.', 'FINISH_DATA_INVALID');
  }
  const elapsed = now - room.startAt;
  if (at < 0 || at > elapsed + CFG.FINISH_TIME_TOLERANCE_MS) await flag(ctx, code, 'temps de jeu impossible');
  if (at < actions * CFG.MIN_ACTION_MS) await flag(ctx, code, 'cadence impossible');

  // Les Malus reçus doivent correspondre aux attaques réellement envoyées par le serveur
  const toMe = Object.values(room.events || {}).filter((e) => e.to === ctx.uid);
  const must = toMe.filter((e) => e.at <= room.startAt + at - CFG.MALUS_MUST_MS).length;
  const max = toMe.filter((e) => e.at <= room.startAt + at + CFG.MALUS_SLACK_MS).length;
  if (malus < must || malus > max) await flag(ctx, code, 'Malus incohérents');

  const rep = replay({ seed: room.seed, playerIndex: me.playerIndex, log: data.log, malus });
  if (!rep.ok) await flag(ctx, code, rep.reason);
  if (rep.actions !== actions) await flag(ctx, code, "nombre d'actions incohérent");
  const sent = (room.attackState && room.attackState[ctx.uid] && room.attackState[ctx.uid].count) || 0;
  if (sent > Math.floor(rep.charges / ENGINE.CFG.ATTACK_GAUGE_MAX)) await flag(ctx, code, 'attaques injustifiées');

  await ctx.db.update(`rooms/${code}`, { [`finishes/${ctx.uid}`]: { at: Math.round(at), receivedAt: now }, updatedAt: now });

  // La première victoire valide ouvre une courte fenêtre : les arrivées quasi simultanées sont départagées sur le
  // TEMPS DE JEU (at), jamais sur l'ordre d'arrivée réseau (51.7).
  let first = false;
  await ctx.db.transaction(`rooms/${code}/status`, (cur) => {
    first = false;
    if (cur === 'PLAYING') { first = true; return 'FINALIZING'; }
    return cur;
  });
  if (!first) return { ok: true };
  await ctx.db.set(`rooms/${code}/finalizeAt`, now + CFG.FINALIZE_GRACE_MS);
  await ctx.sleep(CFG.FINALIZE_GRACE_MS);
  await resolveRound(ctx, code);
  return { ok: true, resolved: true };
}

/** Le chrono de manche est écoulé : n'importe quel joueur peut demander la clôture (idempotent). */
async function finalizeRound(ctx, data) {
  const { code, room } = await loadRoomFor(ctx, data.code);
  const now = ctx.now();
  if (room.status === 'FINISHED') return { ok: true, finished: true };
  if (room.status === 'PLAYING' && now >= room.startAt + CFG.ROUND_TIMEOUT_MS - CFG.FINALIZE_SLACK_MS) {
    await ctx.db.update(`rooms/${code}`, { status: 'FINALIZING', finalizeAt: now, updatedAt: now });
  } else if (room.status === 'FINALIZING' && now >= (room.finalizeAt || 0) + CFG.FINALIZE_SLACK_MS) {
    // une clôture est restée en suspens : on la termine
  } else {
    throw new AppError('failed-precondition', 'La manche est encore en cours.', 'ROUND_IN_PROGRESS');
  }
  await resolveRound(ctx, code);
  return { ok: true, finished: true };
}

// ------------------------------------------------------------------ résultat officiel

/**
 * Calcule et publie le classement. Un seul appel "gagne" le droit de le faire (verrou `resolving`).
 * @param {{force?:boolean}} opts force : reprend un verrou resté bloqué (ménage)
 */
async function resolveRound(ctx, code, opts = {}) {
  const now = ctx.now();
  let claimed = false;
  await ctx.db.transaction(`rooms/${code}/resolving`, (cur) => {
    claimed = false;
    if (cur === null || opts.force || now - cur > CFG.FINALIZING_STUCK_MS) { claimed = true; return now; }
    return cur;
  });
  if (!claimed) return null;

  const room = await ctx.db.get(`rooms/${code}`);
  if (!room || room.status === 'FINISHED') return room ? room.result : null;

  const ids = Object.keys(room.players || {});
  const finishes = room.finishes || {};
  // Un signalement est un journal d'audit : il ne pénalise que celui qui n'a JAMAIS réussi à prouver sa victoire
  // (une victoire valide, rejouée avec succès, prime sur une tentative refusée plus tôt).
  const flags = {};
  for (const [id, f] of Object.entries(room.flags || {})) if (!finishes[id]) flags[id] = f;
  const progress = room.progress || {};
  const remainingOf = (id) => (progress[id] && Number.isFinite(progress[id].remaining) ? progress[id].remaining : ENGINE.CFG.MAIN_PILE_SIZE);

  const finishers = ids.filter((id) => finishes[id]).sort((a, b) =>
    (finishes[a].at - finishes[b].at) || (finishes[a].receivedAt - finishes[b].receivedAt) || (a < b ? -1 : 1));
  const others = ids.filter((id) => !finishers.includes(id)).sort((a, b) => {
    const fa = !!flags[a]; const fb = !!flags[b];
    if (fa !== fb) return fa ? 1 : -1;
    const ra = remainingOf(a); const rb = remainingOf(b);
    if (ra !== rb) return ra - rb;
    return (room.players[a].joinedAt - room.players[b].joinedAt) || (a < b ? -1 : 1);
  });
  const order = [...finishers, ...others];

  // rang : les finisseurs sont strictement ordonnés ; les autres à égalité de cartes restantes partagent le même rang
  const rankOf = {};
  order.forEach((id, i) => {
    const prev = order[i - 1];
    const tie = i > 0 && !finishes[id] && prev && !finishes[prev] && !flags[id] && !flags[prev] && remainingOf(id) === remainingOf(prev);
    rankOf[id] = tie ? rankOf[prev] : i;
  });

  const season = P.seasonId(now);
  const profiles = {};
  for (const id of ids) {
    const raw = (await ctx.db.get(`users/${id}`)) || P.newProfile(id, room.players[id].name || P.defaultName(id), now);
    profiles[id] = P.applySeason(raw, season);
  }

  const rewardable = ids.filter((id) => !flags[id]).length >= 2;
  const rated = room.ranked === true && rewardable;
  const newRatings = rated
    ? rateRound(order.map((id) => ({ uid: id, rating: profiles[id].rating, rd: profiles[id].rd, vol: profiles[id].vol, rank: rankOf[id] })))
    : null;

  const updates = {};
  const ranking = [];
  order.forEach((id, i) => {
    const won = i === 0 && !!finishes[id] && !flags[id];
    const reward = rewardable && !flags[id] ? P.rewardsFor({ rank: i, players: ids.length, won }) : { xp: 0, coins: 0 };
    const p = profiles[id];
    const before = p.rating;
    const after = newRatings ? newRatings[id] : { rating: p.rating, rd: p.rd, vol: p.vol };
    const delta = Math.round(after.rating - before);

    updates[`users/${id}`] = {
      ...p,
      xp: p.xp + reward.xp, coins: p.coins + reward.coins,
      rating: after.rating, rd: after.rd, vol: after.vol,
      games: (p.games || 0) + (rewardable ? 1 : 0), wins: (p.wins || 0) + (won ? 1 : 0),
      lastGameAt: now,
      ...(rated ? { seasons: { ...(p.seasons || {}), [season]: true } } : {}),
    };
    if (rated) {
      updates[`leaderboard/${season}/${id}`] = {
        name: p.name, rating: Math.round(after.rating), rd: Math.round(after.rd),
        games: (p.games || 0) + 1, wins: (p.wins || 0) + (won ? 1 : 0),
      };
    }
    const entry = { uid: id, name: room.players[id].name, remaining: finishes[id] && !flags[id] ? 0 : remainingOf(id), finished: !!finishes[id] && !flags[id], ratingDelta: delta, xp: reward.xp, coins: reward.coins };
    if (entry.finished) entry.finishedAt = finishes[id].at;
    if (flags[id]) entry.flagged = true;
    ranking.push(entry);
  });

  const result = { ranked: rated, timedOut: finishers.length === 0, durationMs: finishers.length ? finishes[finishers[0]].at : CFG.ROUND_TIMEOUT_MS, finishedAt: now, ranking };
  for (const [path, value] of Object.entries(updates)) await ctx.db.set(path, value);
  await ctx.db.update(`rooms/${code}`, { result, status: 'FINISHED', finishedAt: now, updatedAt: now });
  for (const id of ids) await ctx.db.remove(`users/${id}/currentRoom`);
  return result;
}

module.exports = { sendAttack, reportFinish, finalizeRound, resolveRound };
