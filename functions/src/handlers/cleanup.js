'use strict';
const CFG = require('../config');
const { resolveRound } = require('./rounds');
const { playersSorted } = require('./rooms');

/** Découpe en paquets de `size` éléments. */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Ménage périodique, TRAITÉ PAR LOTS :
 *  - UNE seule requête repère les rooms inactives (au plus CLEANUP_ROOMS_PER_RUN par passage) ;
 *  - toutes les suppressions et migrations d'hôte sont accumulées puis écrites en quelques écritures groupées
 *    (400 chemins par écriture) au lieu d'une écriture par room et par joueur ;
 *  - les manches restées bloquées sont clôturées 10 par 10 en parallèle.
 */
async function cleanupRooms(ctx) {
  const now = ctx.now();
  const stats = { deleted: 0, resolved: 0, migrated: 0, purged: 0, writes: 0, more: false };

  const stale = await ctx.db.queryByChildLte('rooms', 'updatedAt', now - 60_000, CFG.CLEANUP_ROOMS_PER_RUN);
  const entries = Object.entries(stale);
  stats.more = entries.length >= CFG.CLEANUP_ROOMS_PER_RUN;      // il en reste peut-être : prochain passage

  const batch = {};          // chemin -> valeur (null = supprimer), écrit en bloc
  const toResolve = [];

  for (const [code, room] of entries) {
    const idle = now - (room.updatedAt || 0);
    const members = Object.keys(room.players || {});

    if (room.status === 'LOBBY') {
      if (idle > CFG.LOBBY_IDLE_MS) {
        batch[`rooms/${code}`] = null;
        for (const id of members) batch[`users/${id}/currentRoom`] = null;
        stats.deleted++;
        continue;
      }
      const host = room.players[room.hostUid];
      if (host && host.connected === false && idle > CFG.HOST_MIGRATION_AFTER_MS) {
        const next = playersSorted(room).find((p) => p.uid !== room.hostUid && p.connected !== false);
        if (next) {
          batch[`rooms/${code}/hostUid`] = next.uid;
          batch[`rooms/${code}/players/${next.uid}/ready`] = true;
          batch[`rooms/${code}/updatedAt`] = now;
          stats.migrated++;
        }
      }
    } else if (room.status === 'PLAYING') {
      if (now > room.startAt + CFG.ROUND_TIMEOUT_MS + CFG.PLAYING_STUCK_MS) toResolve.push(code);
    } else if (room.status === 'FINALIZING') {
      if (now > (room.finalizeAt || room.updatedAt || 0) + CFG.FINALIZING_STUCK_MS) toResolve.push(code);
    } else if (room.status === 'FINISHED') {
      if (now - (room.finishedAt || room.updatedAt || 0) > CFG.FINISHED_TTL_MS) {
        batch[`rooms/${code}`] = null;
        stats.deleted++;
      }
    }
  }

  // File d'attente et assignations périmées : même lot
  const matches = (await ctx.db.get('matchmaking/matches')) || {};
  for (const [id, m] of Object.entries(matches)) {
    if (now - m.at > CFG.MATCH_ASSIGN_PURGE_MS) { batch[`matchmaking/matches/${id}`] = null; stats.purged++; }
  }
  await ctx.db.transaction('matchmaking/queue', (cur) => {
    if (!cur) return null;
    const q = { ...cur };
    for (const [id, e] of Object.entries(q)) if (now - e.lastPing > CFG.MM.ALIVE_MS * 5) { delete q[id]; stats.purged++; }
    return Object.keys(q).length ? q : null;
  });

  // Écritures groupées : N rooms = quelques écritures, pas N
  for (const paths of chunk(Object.keys(batch), CFG.CLEANUP_PATHS_PER_WRITE)) {
    const part = {};
    for (const p of paths) part[p] = batch[p];
    await ctx.db.update('', part);
    stats.writes++;
  }

  // Manches bloquées : clôturées en parallèle, par groupes
  for (const group of chunk(toResolve, CFG.CLEANUP_RESOLVE_PARALLEL)) {
    await Promise.all(group.map((code) => resolveRound(ctx, code, { force: true })));
    stats.resolved += group.length;
  }
  return stats;
}

module.exports = { cleanupRooms, chunk };
