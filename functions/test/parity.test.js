'use strict';
// Vérifie que le moteur JavaScript du serveur est IDENTIQUE au moteur Java de l'app,
// à partir de données générées par le vrai code Java (test/fixtures/parity.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/parity.json');
const E = require('../src/engine');
const { replay } = require('../src/replay');

const pairs = (deck) => deck.map((c) => [c.s, c.v]);

test(`la fixture contient des cas variés`, () => {
  assert.ok(fixture.length >= 40);
});

for (const c of fixture) {
  const label = `graine ${c.seed}, joueur ${c.player}`;

  test(`mélange brut identique au Java (${label})`, () => {
    assert.deepEqual(pairs(E.shuffled(c.seed, c.player, 0)), c.raw);
  });

  test(`filtre glouton identique au Java (${label})`, () => {
    assert.equal(E.simulate(E.shuffled(c.seed, c.player, 0)), c.rawGreedy);
    assert.deepEqual(pairs(E.playable(c.seed, c.player)), c.deck);
  });

  test(`cartes Malus identiques au Java (${label})`, () => {
    for (let k = 0; k < c.malusCards.length; k++) {
      const m = E.malusCard(c.seed, c.player, k);
      assert.deepEqual([m.s, m.v], c.malusCards[k]);
    }
  });

  test(`rejeu des journaux Java : même plateau final (${label})`, () => {
    for (const g of c.games) {
      const r = replay({ seed: c.seed, playerIndex: c.player, log: g.log, malus: g.malus, requireFinished: false });
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.remaining, g.remaining);
      assert.equal(r.plays, g.plays);
      assert.equal(r.draws, g.draws);
      assert.equal(r.actions, g.plays + g.draws);
    }
  });
}

test('un journal complet est accepté comme victoire, un journal tronqué est refusé', () => {
  const won = fixture.find((c) => c.games[0].remaining === 0);
  assert.ok(won);
  const g = won.games[0];
  assert.equal(replay({ seed: won.seed, playerIndex: won.player, log: g.log, malus: 0 }).ok, true);
  const truncated = g.log.split(',').slice(0, -1).join(',');
  const r = replay({ seed: won.seed, playerIndex: won.player, log: truncated, malus: 0 });
  assert.equal(r.ok, false);
});

test('omettre les Malus reçus rend la victoire invalide', () => {
  const won = fixture.find((c) => c.games[1].remaining === 0);
  assert.ok(won);
  const g = won.games[1];
  assert.equal(replay({ seed: won.seed, playerIndex: won.player, log: g.log, malus: 2 }).ok, true);
  assert.equal(replay({ seed: won.seed, playerIndex: won.player, log: g.log, malus: 0 }).ok, false);
});

test('un coup illégal glissé dans le journal est détecté', () => {
  const won = fixture.find((c) => c.games[0].remaining === 0);
  const g = won.games[0];
  const cheat = 'M>F0,M>F0,M>F0,' + g.log;
  assert.equal(replay({ seed: won.seed, playerIndex: won.player, log: cheat, malus: 0 }).ok, false);
});

test('journaux mal formés refusés', () => {
  for (const bad of ['', 'X>Y9', 'M>F', 'D,,D', 'M>F0;D']) {
    assert.equal(replay({ seed: 1, playerIndex: 0, log: bad, malus: 0 }).ok, false);
  }
});
