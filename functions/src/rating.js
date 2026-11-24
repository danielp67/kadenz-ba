'use strict';
/**
 * Glicko-2 (Glickman, 2013) adapté à une manche à plusieurs joueurs :
 * chaque joueur est comparé à chacun des autres (1 = mieux classé, 0,5 = égalité, 0 = moins bien),
 * le tout dans une seule période d'évaluation. Gère bien les nouveaux joueurs (RD élevé).
 */
const CFG = require('./config');
const SCALE = 173.7178;

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * @param {{rating:number, rd:number, vol:number}} player
 * @param {{rating:number, rd:number, score:number}[]} results
 */
function update(player, results, opts = {}) {
  const center = opts.center ?? CFG.RATING.CENTER;
  const tau = opts.tau ?? CFG.RATING.TAU;
  const mu = (player.rating - center) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;

  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: player.rating, rd: phiStar * SCALE, vol: sigma };
  }

  let vInv = 0; let deltaSum = 0;
  for (const r of results) {
    const muJ = (r.rating - center) / SCALE;
    const phiJ = r.rd / SCALE;
    const e = E(mu, muJ, phiJ);
    vInv += g(phiJ) ** 2 * e * (1 - e);
    deltaSum += g(phiJ) * (r.score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Nouvelle volatilité (algorithme d'Illinois)
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a; let B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * tau) < 0) k++; B = a - k * tau; }
  let fA = f(A); let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;
  return { rating: SCALE * muNew + center, rd: SCALE * phiNew, vol: sigmaNew };
}

/**
 * Une manche complète.
 * @param {{uid:string, rating:number, rd:number, vol:number, rank:number}[]} players  rank : plus petit = mieux (égalité = même rank)
 * @returns {Object<string,{rating:number, rd:number, vol:number}>}
 */
function rateRound(players, opts = {}) {
  const out = {};
  for (const p of players) {
    const results = players.filter((o) => o.uid !== p.uid).map((o) => ({
      rating: o.rating, rd: o.rd, score: p.rank < o.rank ? 1 : p.rank === o.rank ? 0.5 : 0,
    }));
    const n = update(p, results, opts);
    out[p.uid] = {
      rating: n.rating,
      rd: Math.min(CFG.RATING.INIT_RD, Math.max(CFG.RATING.MIN_RD, n.rd)),
      vol: n.vol,
    };
  }
  return out;
}

module.exports = { update, rateRound };
