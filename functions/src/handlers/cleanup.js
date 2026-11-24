'use strict';
const CFG = require('../config');
const { resolveRound } = require('./rounds');
const { playersSorted } = require('./rooms');

/** Ménage périodique : rooms abandonnées, manches restées bloquées, migration d'hôte, files d'attente. */
async function cleanupRooms(ctx) {
  const now = ctx.now();
  const stats = { deleted: 0, resolved: 0, migrated: 0, purged: 0 };

  const stale = await ctx.db.queryByChildLte('rooms', 'updatedAt', now - 60_000);
  for (const [code, room] of Object.entries(stale)) {
    const idle = now - (room.updatedAt || 0);
    const members = Object.keys(room.players || {});

    if (room.status === 'LOBBY') {
      if (idle > CFG.LOBBY_IDLE_MS) {
        await ctx.db.remove(`rooms/${code}`);
        for (const id of members) await ctx.db.remove(`users/${id}/currentRoom`);
        stats.deleted++;
        continue;
      }
      const host = room.players[room.hostUid];
      if (host && host.connected === false && idle > CFG.HOST_MIGRATION_AFTER_MS) {
        const next = playersSorted(room).find((p) => p.uid !== room.hostUid && p.connected !== false);
        if (next) {
          await ctx.db.update(`rooms/${code}`, { hostUid: next.uid, [`players/${next.uid}/ready`]: true, updatedAt: now });
          stats.migrated++;
        }
      }
    } else if (room.status === 'PLAYING') {
      if (now > room.startAt + CFG.ROUND_TIMEOUT_MS + CFG.PLAYING_STUCK_MS) {
        await resolveRound(ctx, code, { force: true });
        stats.resolved++;
      }
    } else if (room.status === 'FINALIZING') {
      if (now > (room.finalizeAt || room.updatedAt || 0) + CFG.FINALIZING_STUCK_MS) {
        await resolveRound(ctx, code, { force: true });
        stats.resolved++;
      }
    } else if (room.status === 'FINISHED') {
      if (now - (room.finishedAt || room.updatedAt || 0) > CFG.FINISHED_TTL_MS) {
        await ctx.db.remove(`rooms/${code}`);
        stats.deleted++;
      }
    }
  }

  // File d'attente et assignations périmées
  await ctx.db.transaction('matchmaking/queue', (cur) => {
    if (!cur) return null;
    const q = { ...cur };
    for (const [id, e] of Object.entries(q)) if (now - e.lastPing > CFG.MM.ALIVE_MS * 5) { delete q[id]; stats.purged++; }
    return Object.keys(q).length ? q : null;
  });
  const matches = (await ctx.db.get('matchmaking/matches')) || {};
  for (const [id, m] of Object.entries(matches)) {
    if (now - m.at > CFG.MATCH_ASSIGN_PURGE_MS) { await ctx.db.remove(`matchmaking/matches/${id}`); stats.purged++; }
  }
  return stats;
}

module.exports = { cleanupRooms };
