'use strict';
const { leaveRoomInternal } = require('./rooms');

/**
 * Suppression du compte et de TOUTES les données du joueur (profil, XP, classement, file d'attente, limites).
 * Idempotent : peut être rappelée sans risque si une étape a échoué.
 *
 * Reste temporairement dans les rooms en cours ou récentes : son identifiant et son pseudo, tant que la room existe
 * (le ménage les supprime : lobby inactif après 30 min, partie terminée après 1 h).
 */
async function deleteAccount(ctx) {
  const uid = ctx.uid;

  // 1. Quitter la room en cours (transfert d'hôte si besoin)
  const current = await ctx.db.get(`users/${uid}/currentRoom`);
  if (current) await leaveRoomInternal(ctx, uid, current);

  // 2. Retirer de la file d'attente de la partie rapide
  await ctx.db.transaction('matchmaking/queue', (cur) => {
    if (!cur || !cur[uid]) return cur === undefined ? null : cur;
    const q = { ...cur };
    delete q[uid];
    return Object.keys(q).length ? q : null;
  });

  // 3. Effacer le profil, les classements de saison, les limites : en une seule écriture groupée
  const profile = await ctx.db.get(`users/${uid}`);
  const batch = {
    [`users/${uid}`]: null,
    [`rateLimits/${uid}`]: null,
    [`matchmaking/matches/${uid}`]: null,
  };
  for (const season of Object.keys((profile && profile.seasons) || {})) batch[`leaderboard/${season}/${uid}`] = null;
  await ctx.db.update('', batch);

  // 4. Supprimer le compte d'authentification (en dernier : si cela échoue, tout peut être rejoué)
  await ctx.deleteAuthUser(uid);
  return { ok: true };
}

module.exports = { deleteAccount };
