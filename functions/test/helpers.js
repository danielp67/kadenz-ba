'use strict';
const { MemoryDb } = require('../src/db/memory');
const fixture = require('./fixtures/parity.json');

/** Environnement de test : faux Firebase + horloge qu'on contrôle. */
function makeEnv(opts = {}) {
  const db = new MemoryDb();
  const clock = { t: Date.UTC(2026, 10, 23, 12, 0, 0) };
  let n = opts.randomStart || 7;
  const env = {
    db, clock, seed: opts.seed || 123456,
    randomInt: opts.randomInt || ((max) => { n = (n * 1103515245 + 12345) % 2147483648; return n % max; }),
    advance(ms) { clock.t += ms; },
    ctx(uid, extra = {}) {
      return {
        db, uid, now: () => clock.t, sleep: async () => {},
        randomInt: env.randomInt, randomSeed: () => env.seed, ...extra,
      };
    },
  };
  return env;
}

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function rejects(promise, code) {
  try { await promise; } catch (e) {
    if (code && e.code !== code) throw new Error(`code attendu ${code}, reçu ${e.code} (${e.message})`);
    return e;
  }
  throw new Error('une erreur était attendue');
}

/** Graine pour laquelle les joueurs 0, 1 et 2 ont chacun une victoire jouable (et le joueur 1 aussi avec 2 Malus). */
function winnableSeed() {
  const by = {};
  for (const c of fixture) (by[c.seed] = by[c.seed] || {})[c.player] = c;
  for (const [seed, p] of Object.entries(by)) {
    if ([0, 1, 2].every((i) => p[i] && p[i].games[0].remaining === 0) && p[1].games[1].remaining === 0) {
      return { seed: Number(seed), players: p };
    }
  }
  throw new Error('aucune graine adaptée dans la fixture');
}

module.exports = { makeEnv, deferred, rejects, winnableSeed };
