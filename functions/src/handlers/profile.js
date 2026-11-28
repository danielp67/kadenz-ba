'use strict';
const { AppError } = require('../errors');
const P = require('../progress');

async function getOrCreateProfile(ctx, wantedName) {
  let p = await ctx.db.get(`users/${ctx.uid}`);
  if (!p) {
    p = P.newProfile(ctx.uid, wantedName || P.defaultName(ctx.uid), ctx.now());
    await ctx.db.set(`users/${ctx.uid}`, p);
  }
  return p;
}

/** Crée le profil au premier lancement, ou change le pseudo. */
async function ensureProfile(ctx, data) {
  let name = null;
  if (data.name !== undefined && data.name !== null && data.name !== '') {
    name = P.sanitizeName(data.name);
    if (name === null) throw new AppError('invalid-argument', 'Pseudo invalide : 2 à 16 caractères (lettres, chiffres, espace, _ . -).', 'NAME_INVALID');
  }
  const p = await getOrCreateProfile(ctx, name);
  if (name && p.name !== name) {
    p.name = name;
    await ctx.db.update(`users/${ctx.uid}`, { name });
    // Le classement affiche le pseudo : on le garde à jour
    const board = await ctx.db.get(`leaderboard/${P.seasonId(ctx.now())}/${ctx.uid}`);
    if (board) await ctx.db.update(`leaderboard/${P.seasonId(ctx.now())}/${ctx.uid}`, { name });
  }
  return P.publicProfile(ctx.uid, P.applySeason(p, P.seasonId(ctx.now())));
}

module.exports = { getOrCreateProfile, ensureProfile };
