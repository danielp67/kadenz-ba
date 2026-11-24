'use strict';
/**
 * Port JavaScript EXACT du moteur de jeu Java (engine/*.java de l'app Android).
 * Sert à REJOUER côté serveur la manche d'un joueur qui prétend avoir gagné (anti-triche, 51.8).
 *
 * La parité avec le Java est vérifiée par test/parity.test.js à partir de données générées par le vrai code Java.
 * Si vous changez une règle ou GameConfig côté Android, changez-la ici aussi puis régénérez la fixture
 * (voir README : "Garder le serveur et l'app synchronisés").
 */

// ---- GameConfig (doit rester identique à GameConfig.java) --------------------------------
const CFG = Object.freeze({
  MAX_VALUE: 10,
  SUITS: 4,
  MAIN_PILE_SIZE: 10,
  TABLEAU_COLUMNS: 4,
  INITIAL_CARDS_PER_COLUMN: 1,
  COMBO_CHAIN: 3,
  ATTACK_GAUGE_MAX: 3,
  DEAL_MAX_GREEDY_REMAINING: 2,
  DEAL_MAX_ATTEMPTS: 40,
});
const DECK_SIZE = CFG.SUITS * CFG.MAX_VALUE;

// ---- SplitMix64 (arithmétique 64 bits non signée via BigInt) -----------------------------
const U64 = (x) => BigInt.asUintN(64, x);
const K_PLAYER = 0x9E3779B97F4A7C15n;
const K_SALT = 0xC2B2AE3D27D4EB4Fn;
const K_MALUS = 0xD6E8FEB86659FD93n;

class SplitMix64 {
  constructor(seed) { this.state = U64(BigInt(seed)); }
  nextLong() {
    this.state = U64(this.state + 0x9E3779B97F4A7C15n);
    let z = this.state;
    z = U64((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n);
    z = U64((z ^ (z >> 27n)) * 0x94D049BB133111EBn);
    return z ^ (z >> 31n);
  }
  nextInt(bound) { return Number((this.nextLong() >> 1n) % BigInt(bound)); }
}

// ---- Paquets ------------------------------------------------------------------------------
function orderedDeck() {
  const d = [];
  for (let s = 0; s < CFG.SUITS; s++) for (let v = 1; v <= CFG.MAX_VALUE; v++) d.push({ s, v });
  return d;
}

function shuffled(seed, playerIndex, salt) {
  const d = orderedDeck();
  const mixed = U64(BigInt(seed)) ^ U64(BigInt(playerIndex) * K_PLAYER) ^ U64(BigInt(salt) * K_SALT);
  const r = new SplitMix64(mixed);
  r.nextLong(); r.nextLong();
  for (let i = d.length - 1; i > 0; i--) {
    const j = r.nextInt(i + 1);
    const t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

function playable(seed, playerIndex) {
  let best = null; let bestScore = Infinity;
  for (let salt = 0; salt < CFG.DEAL_MAX_ATTEMPTS; salt++) {
    const d = shuffled(seed, playerIndex, salt);
    const remaining = simulate(d);
    if (remaining <= CFG.DEAL_MAX_GREEDY_REMAINING) return d;
    if (remaining < bestScore) { bestScore = remaining; best = d; }
  }
  return best;
}

function malusCard(seed, targetPlayerIndex, malusIndex) {
  const mixed = U64(BigInt(seed)) ^ 0x5DEECE66Dn ^ U64(BigInt(targetPlayerIndex) * K_PLAYER) ^ U64(BigInt(malusIndex) * K_MALUS);
  const r = new SplitMix64(mixed);
  r.nextLong();
  const s = r.nextInt(CFG.SUITS);
  return { s, v: 1 + r.nextInt(CFG.MAX_VALUE) };
}

// ---- Moteur -------------------------------------------------------------------------------
const MAIN = 'M', WASTE = 'W', TAB = 'T';

class GameEngine {
  constructor(deck) {
    this.main = []; this.stock = []; this.waste = [];
    this.tableau = []; this.foundation = new Array(CFG.SUITS).fill(0);
    let i = 0;
    for (; i < CFG.MAIN_PILE_SIZE; i++) this.main.push(deck[i]);
    for (let c = 0; c < CFG.TABLEAU_COLUMNS; c++) {
      const col = [];
      for (let k = 0; k < CFG.INITIAL_CARDS_PER_COLUMN; k++) col.push(deck[i++]);
      this.tableau.push(col);
    }
    for (; i < deck.length; i++) this.stock.push(deck[i]);
    this.comboStreak = 0; this.charges = 0; this.plays = 0; this.draws = 0; this.invalid = 0;
  }

  static top(list) { return list.length === 0 ? null : list[list.length - 1]; }

  peek(source, index) {
    if (source === MAIN) return GameEngine.top(this.main);
    if (source === WASTE) return GameEngine.top(this.waste);
    if (index < 0 || index >= this.tableau.length) return null;
    return GameEngine.top(this.tableau[index]);
  }

  get cardsRemaining() { return this.main.length; }
  get finished() { return this.main.length === 0; }

  /** null si la pose est légale, sinon la raison du refus (miroir de placementError en Java). */
  placementError(c, m) {
    if (m.target === 'F') {
      if (m.targetIndex < 0 || m.targetIndex >= this.foundation.length) return 'fondation inconnue';
      if (c.s !== m.targetIndex) return 'mauvaise couleur';
      if (c.v !== this.foundation[m.targetIndex] + 1) return 'ordre de fondation';
      return null;
    }
    const col = m.targetIndex;
    if (col < 0 || col >= this.tableau.length) return 'colonne inconnue';
    if (m.source === TAB) {
      if (m.sourceIndex === col) return 'même colonne';
      if (this.tableau[m.sourceIndex].length === 1 && this.tableau[col].length === 0) return 'déplacement inutile';
    }
    const t = this.tableau[col];
    if (t.length === 0) return null;
    return GameEngine.top(t).v === c.v + 1 ? null : 'ordre du tableau';
  }

  canApply(m) {
    if (this.finished) return false;
    const c = this.peek(m.source, m.sourceIndex);
    return c !== null && this.placementError(c, m) === null;
  }

  /** @returns {{success:boolean, reason?:string, finished?:boolean}} */
  apply(m) {
    if (this.finished) return { success: false, reason: 'manche terminée' };
    const c = this.peek(m.source, m.sourceIndex);
    if (c === null) { this.invalid++; return { success: false, reason: 'source vide' }; }
    const err = this.placementError(c, m);
    if (err !== null) { this.invalid++; return { success: false, reason: err }; }

    const src = m.source === MAIN ? this.main : m.source === WASTE ? this.waste : this.tableau[m.sourceIndex];
    src.pop();

    let foundationCompleted = false;
    if (m.target === 'F') {
      this.foundation[m.targetIndex] = c.v;
      if (c.v === CFG.MAX_VALUE) foundationCompleted = true;
    } else {
      this.tableau[m.targetIndex].push(c);
    }
    this.plays++;

    const columnEmptied = m.source === TAB && m.target === 'F' && this.tableau[m.sourceIndex].length === 0;
    const countsForStreak = m.source !== TAB || m.target === 'F';
    if (countsForStreak) {
      this.comboStreak++;
      if (this.comboStreak >= CFG.COMBO_CHAIN) { this.comboStreak = 0; this.charges++; }
    }
    if (columnEmptied) this.charges++;
    if (foundationCompleted) this.charges++;
    return { success: true, finished: this.main.length === 0 };
  }

  draw() {
    if (this.finished) return false;
    if (this.stock.length === 0) {
      if (this.waste.length === 0) return false;
      this.waste.reverse();
      this.stock.push(...this.waste);
      this.waste.length = 0;
    }
    this.waste.push(this.stock.pop());
    this.draws++;
    this.comboStreak = 0;
    return true;
  }

  receiveMalus(card) {
    if (this.finished) return false;
    this.main.unshift(card);
    return true;
  }
}

// ---- Joueur glouton (miroir de GreedyPlayer.java) -------------------------------------------
const DRAW = { draw: true };
const NONE = { none: true };

function foundationMove(e, source, idx) {
  const c = e.peek(source, idx);
  if (c === null) return null;
  const m = { source, sourceIndex: source === TAB ? idx : -1, target: 'F', targetIndex: c.s };
  return e.canApply(m) ? m : null;
}

function tableauMove(e, source, idx, allowEmpty) {
  if (e.peek(source, idx) === null) return null;
  let emptyCandidate = null;
  for (let col = 0; col < CFG.TABLEAU_COLUMNS; col++) {
    const m = { source, sourceIndex: source === TAB ? idx : -1, target: 'T', targetIndex: col };
    if (!e.canApply(m)) continue;
    if (e.tableau[col].length !== 0) return m;
    if (emptyCandidate === null) emptyCandidate = m;
  }
  return allowEmpty ? emptyCandidate : null;
}

function greedyNext(e) {
  if (e.finished) return NONE;
  let m = foundationMove(e, MAIN, -1);
  if (m === null) m = foundationMove(e, WASTE, -1);
  for (let c = 0; m === null && c < CFG.TABLEAU_COLUMNS; c++) m = foundationMove(e, TAB, c);
  if (m !== null) return { move: m };

  m = tableauMove(e, MAIN, -1, true);
  if (m !== null) return { move: m };
  m = tableauMove(e, WASTE, -1, false);
  if (m !== null) return { move: m };

  for (let a = 0; a < CFG.TABLEAU_COLUMNS; a++) {
    const col = e.tableau[a];
    if (col.length < 2) continue;
    const below = col[col.length - 2];
    if (below.v === e.foundation[below.s] + 1) {
      m = tableauMove(e, TAB, a, true);
      if (m !== null) return { move: m };
    }
  }
  if (e.stock.length + e.waste.length > 0) return DRAW;
  return NONE;
}

function simulate(deck) {
  const e = new GameEngine(deck);
  let idle = 0;
  for (let guard = 0; guard < 20000 && !e.finished; guard++) {
    const a = greedyNext(e);
    if (a.move) { e.apply(a.move); idle = 0; }
    else if (a.draw) {
      e.draw();
      if (++idle > e.stock.length + e.waste.length + 2) break;
    } else break;
  }
  return e.cardsRemaining;
}

module.exports = {
  CFG, DECK_SIZE, SplitMix64, orderedDeck, shuffled, playable, malusCard,
  GameEngine, greedyNext, simulate, MAIN, WASTE, TAB,
};
