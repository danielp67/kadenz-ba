'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { update, rateRound } = require('../src/rating');
const P = require('../src/progress');
const CFG = require('../src/config');

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≠ ${b} (±${eps})`);

test("Glicko-2 : exemple de l'article de Glickman (1464,06 / 151,52 / 0,05999)", () => {
  const r = update({ rating: 1500, rd: 200, vol: 0.06 }, [
    { rating: 1400, rd: 30, score: 1 }, { rating: 1550, rd: 100, score: 0 }, { rating: 1700, rd: 300, score: 0 },
  ], { center: 1500, tau: 0.5 });
  close(r.rating, 1464.06, 0.02, 'rating');
  close(r.rd, 151.52, 0.02, 'rd');
  close(r.vol, 0.05999, 0.00002, 'volatilité');
});

test('manche à 4 joueurs égaux : le vainqueur monte, le dernier descend, ordre cohérent', () => {
  const base = { rating: 1000, rd: 200, vol: 0.06 };
  const out = rateRound([0, 1, 2, 3].map((i) => ({ uid: 'p' + i, ...base, rank: i })));
  assert.ok(out.p0.rating > out.p1.rating && out.p1.rating > out.p2.rating && out.p2.rating > out.p3.rating);
  assert.ok(out.p0.rating > 1000 && out.p3.rating < 1000);
});

test('une égalité de rang donne le même résultat aux deux joueurs', () => {
  const base = { rating: 1000, rd: 200, vol: 0.06 };
  const out = rateRound([{ uid: 'a', ...base, rank: 0 }, { uid: 'b', ...base, rank: 1 }, { uid: 'c', ...base, rank: 1 }]);
  close(out.b.rating, out.c.rating, 1e-9);
});

test("un nouveau joueur (RD élevé) bouge davantage qu'un joueur établi", () => {
  const fresh = rateRound([{ uid: 'n', rating: 1000, rd: 350, vol: 0.06, rank: 0 }, { uid: 'x', rating: 1000, rd: 60, vol: 0.06, rank: 1 }]);
  const settled = rateRound([{ uid: 'n', rating: 1000, rd: 60, vol: 0.06, rank: 0 }, { uid: 'x', rating: 1000, rd: 60, vol: 0.06, rank: 1 }]);
  assert.ok(fresh.n.rating - 1000 > settled.n.rating - 1000);
});

test("le RD reste borné et diminue avec les parties", () => {
  const out = rateRound([{ uid: 'a', rating: 1000, rd: 350, vol: 0.06, rank: 0 }, { uid: 'b', rating: 1000, rd: 350, vol: 0.06, rank: 1 }]);
  assert.ok(out.a.rd < 350 && out.a.rd >= CFG.RATING.MIN_RD);
});

test('niveaux, ligues et saisons', () => {
  assert.equal(P.levelFromXp(0), 1);
  assert.equal(P.levelFromXp(100), 2);
  assert.equal(P.levelFromXp(400), 3);
  assert.equal(P.leagueFromRating(1000), 'BRONZE');
  assert.equal(P.leagueFromRating(1100), 'ARGENT');
  assert.equal(P.leagueFromRating(1399), 'OR');
  assert.equal(P.leagueFromRating(1549), 'PLATINE');
  assert.equal(P.leagueFromRating(2000), 'DIAMANT');
  assert.equal(P.seasonId(Date.UTC(2026, 10, 23)), 'S6');
});

test('reset de saison : le classement est recompressé vers le centre, le RD remonte', () => {
  const p = P.applySeason({ rating: 1400, rd: 80, seasonId: 'S5' }, 'S6');
  assert.equal(p.rating, 1200);
  assert.equal(p.rd, CFG.RATING.SEASON_RD_FLOOR);
  assert.equal(P.applySeason(p, 'S6'), p);   // déjà à jour : rien ne change
});

test('pseudos : validation', () => {
  assert.equal(P.sanitizeName('  Daniel  '), 'Daniel');
  assert.equal(P.sanitizeName('Zoé  Lou'), 'Zoé Lou');
  for (const bad of ['', 'a', 'x'.repeat(17), '<script>', 'a/b', null, 42]) assert.equal(P.sanitizeName(bad), null);
});

test('récompenses : victoire > 2e place > dernier, jamais nul', () => {
  const w = P.rewardsFor({ rank: 0, players: 4, won: true });
  const s = P.rewardsFor({ rank: 1, players: 4, won: false });
  const l = P.rewardsFor({ rank: 3, players: 4, won: false });
  assert.ok(w.xp > s.xp && s.xp > l.xp && l.xp > 0 && w.coins > l.coins);
});
