'use strict';
const { GameEngine, playable, malusCard, MAIN, WASTE, TAB } = require('./engine');

const TOKEN = /^(D|[MW]>[FT]\d|T\d>[FT]\d)$/;
const MAX_LOG_CHARS = 30000;

/** "M>F0" -> {source:'M', sourceIndex:-1, target:'F', targetIndex:0} ; "D" -> null (pioche). */
function parseToken(t) {
  if (t === 'D') return null;
  const gt = t.indexOf('>');
  const source = t[0];
  return {
    source,
    sourceIndex: source === TAB ? parseInt(t.slice(1, gt), 10) : -1,
    target: t[gt + 1],
    targetIndex: parseInt(t.slice(gt + 2), 10),
  };
}

/**
 * Rejoue le journal d'un joueur sur SON paquet (graine + index) et dit s'il est valide.
 * @param {{seed:number, playerIndex:number, log:string, malus?:number, requireFinished?:boolean}} p
 * @returns {{ok:boolean, reason?:string, plays?:number, draws?:number, actions?:number, charges?:number, remaining?:number}}
 */
function replay(p) {
  const { seed, playerIndex, log } = p;
  const malus = p.malus || 0;
  const requireFinished = p.requireFinished !== false;
  if (typeof log !== 'string' || log.length === 0) return { ok: false, reason: 'journal vide' };
  if (log.length > MAX_LOG_CHARS) return { ok: false, reason: 'journal trop long' };
  if (!Number.isInteger(malus) || malus < 0 || malus > 60) return { ok: false, reason: 'malus invalide' };

  const tokens = log.split(',');
  for (const t of tokens) if (!TOKEN.test(t)) return { ok: false, reason: 'action mal formée' };

  const e = new GameEngine(playable(seed, playerIndex));
  // Les Malus s'ajoutent tout en bas de la pile : les insérer d'emblée donne le même plateau que de les recevoir en cours de route.
  for (let k = 0; k < malus; k++) e.receiveMalus(malusCard(seed, playerIndex, k));

  for (let i = 0; i < tokens.length; i++) {
    if (e.finished) return { ok: false, reason: 'actions après la fin' };
    const m = parseToken(tokens[i]);
    if (m === null) {
      if (!e.draw()) return { ok: false, reason: `pioche impossible (action ${i + 1})` };
    } else {
      const r = e.apply(m);
      if (!r.success) return { ok: false, reason: `coup illégal (action ${i + 1}) : ${r.reason}` };
    }
  }
  if (requireFinished && !e.finished) return { ok: false, reason: 'pile non vidée' };
  return { ok: true, plays: e.plays, draws: e.draws, actions: tokens.length, charges: e.charges, remaining: e.cardsRemaining };
}

module.exports = { replay, parseToken, MAX_LOG_CHARS, MAIN, WASTE, TAB };
