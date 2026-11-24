'use strict';
const CFG = require('./config');

const levelFromXp = (xp) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 100));

function leagueFromRating(rating) {
  for (const l of CFG.LEAGUES) if (rating < l.below) return l.name;
  return CFG.LEAGUES[CFG.LEAGUES.length - 1].name;
}

function seasonId(now) {
  const idx = Math.max(0, Math.floor((now - CFG.SEASON_EPOCH_MS) / (CFG.SEASON_DAYS * 86_400_000)));
  return `S${idx + 1}`;
}

/**
 * Récompenses d'une manche en ligne (section 53) : participation + bonus de place + bonus de victoire.
 * Purement cosmétiques : XP et pièces ne donnent jamais d'avantage de jeu.
 */
function rewardsFor({ rank, players, won }) {
  const xp = 20 + Math.max(0, players - 1 - rank) * 5 + (won ? 30 : 0);
  const coins = 10 + (won ? 20 : 0);
  return { xp, coins };
}

/** Pseudo : 2 à 16 caractères (lettres, chiffres, espace, _ . -). Renvoie null si invalide. */
function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 16) return null;
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(s)) return null;
  return s;
}

function defaultName(uid) {
  let h = 0;
  for (const ch of uid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `Joueur${String(h % 10000).padStart(4, '0')}`;
}

/** Nouvelle saison : le classement est recompressé vers le centre (reset doux, 54.3). */
function applySeason(profile, currentSeason) {
  if (profile.seasonId === currentSeason) return profile;
  const c = CFG.RATING.CENTER;
  return {
    ...profile,
    rating: c + 0.5 * (profile.rating - c),
    rd: Math.max(profile.rd, CFG.RATING.SEASON_RD_FLOOR),
    seasonId: currentSeason,
  };
}

function newProfile(uid, name, now) {
  return {
    name, createdAt: now, xp: 0, coins: 0, games: 0, wins: 0,
    rating: CFG.RATING.CENTER, rd: CFG.RATING.INIT_RD, vol: CFG.RATING.INIT_VOL,
    seasonId: seasonId(now),
  };
}

function publicProfile(uid, p) {
  return {
    uid, name: p.name, level: levelFromXp(p.xp), xp: p.xp, coins: p.coins,
    rating: Math.round(p.rating), league: leagueFromRating(p.rating),
    games: p.games || 0, wins: p.wins || 0, season: p.seasonId,
  };
}

module.exports = { levelFromXp, leagueFromRating, seasonId, rewardsFor, sanitizeName, defaultName, applySeason, newProfile, publicProfile };
