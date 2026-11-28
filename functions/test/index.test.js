'use strict';
// Teste le câblage de index.js avec un FAUX Firebase (firebase-admin et firebase-functions ne sont pas installés pour les tests).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { MemoryDb } = require('../src/db/memory');

// ---- faux firebase-admin : database().ref(path) calqué sur l'API réelle, branché sur MemoryDb
const mem = new MemoryDb();
const snap = (v) => ({ val: () => v });
const fakeDatabase = {
  ref: (path) => ({
    get: async () => snap(await mem.get(path)),
    set: (v) => mem.set(path, v),
    remove: () => mem.remove(path),
    update: (u) => mem.update(path, u),
    transaction: async (fn) => { const r = await mem.transaction(path, fn); return { committed: r.committed, snapshot: snap(r.value) }; },
    push: () => ({ key: mem.pushKey() }),
    orderByChild: (child) => ({ endAt: (max) => ({ limitToFirst: (n) => ({ get: async () => snap(await mem.queryByChildLte(path, child, max, n)) }) }) }),
  }),
};
class FakeHttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const deletedAuthUsers = [];
const registered = {};
const fakes = {
  'firebase-admin': { initializeApp() {}, database: () => fakeDatabase, auth: () => ({ deleteUser: async (id) => { deletedAuthUsers.push(id); } }) },
  'firebase-functions/v2/https': {
    HttpsError: FakeHttpsError,
    onCall: (opts, fn) => { fn.opts = opts; return fn; },
  },
  'firebase-functions/v2/scheduler': { onSchedule: (opts, fn) => { fn.opts = opts; return fn; } },
  'firebase-functions/logger': { error() {}, info() {}, warn() {} },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return fakes[request] || origLoad.call(this, request, ...rest); };
const api = require('../index.js');
Module._load = origLoad;

test('les 12 fonctions appelables et le ménage planifié sont exportés', () => {
  const names = ['ensureProfile', 'createRoom', 'joinRoom', 'leaveRoom', 'setReady', 'startGame',
    'quickMatch', 'cancelQuickMatch', 'sendAttack', 'reportFinish', 'finalizeRound', 'deleteAccount', 'cleanup'];
  for (const n of names) assert.equal(typeof api[n], 'function', n);
  assert.equal(Object.keys(api).length, names.length);
});

test('toutes les fonctions tournent dans la région européenne choisie', () => {
  for (const [name, fn] of Object.entries(api)) assert.equal(fn.opts.region, 'europe-west1', name);
  assert.equal(api.cleanup.opts.schedule, 'every 5 minutes');
});

test('sans connexion : unauthenticated', async () => {
  await assert.rejects(() => api.createRoom({ data: {} }), (e) => e.code === 'unauthenticated');
});

test('parcours complet via les vraies fonctions : profil, création, rejoindre, prêt, départ', async () => {
  const hostAuth = { auth: { uid: 'host' } };
  const guestAuth = { auth: { uid: 'guest' } };
  const profile = await api.ensureProfile({ ...hostAuth, data: { name: 'Daniel' } });
  assert.equal(profile.name, 'Daniel');
  const { code } = await api.createRoom({ ...hostAuth, data: {} });
  assert.match(code, /^[A-Z2-9]{5}$/);
  await api.joinRoom({ ...guestAuth, data: { code: code.toLowerCase() } });
  await api.setReady({ ...guestAuth, data: { code, ready: true } });
  const { startAt } = await api.startGame({ ...hostAuth, data: { code } });
  const room = await mem.get(`rooms/${code}`);
  assert.equal(room.status, 'PLAYING');
  assert.ok(Number.isInteger(room.seed) && room.seed >= 0 && room.seed < 2 ** 48);
  assert.ok(startAt > Date.now());
});

test("les erreurs métier deviennent des HttpsError avec le bon code et un message lisible", async () => {
  await assert.rejects(() => api.joinRoom({ auth: { uid: 'x' }, data: { code: 'ZZZZZ' } }),
    (e) => e instanceof FakeHttpsError && e.code === 'not-found' && /introuvable/i.test(e.message)
      && e.details && e.details.key === 'ROOM_NOT_FOUND');          // la clé que l'app traduit
});

test("une erreur inattendue ne fuit jamais ses détails au client", async () => {
  const origGet = mem.get.bind(mem);
  mem.get = async () => { throw new Error('secret interne'); };
  try {
    await assert.rejects(() => api.ensureProfile({ auth: { uid: 'boom' }, data: {} }),
      (e) => e.code === 'internal' && !/secret/.test(e.message));
  } finally { mem.get = origGet; }
});

test("le ménage s'exécute sans erreur", async () => {
  await api.cleanup();
});

test("deleteAccount : efface le profil, supprime le compte d'authentification et reste rejouable", async () => {
  await api.ensureProfile({ auth: { uid: 'leaver' }, data: { name: 'Léa' } });
  assert.ok(await mem.get('users/leaver'));
  const r = await api.deleteAccount({ auth: { uid: 'leaver' }, data: {} });
  assert.equal(r.ok, true);
  assert.equal(await mem.get('users/leaver'), null);
  assert.deepEqual(deletedAuthUsers, ['leaver']);
  await api.deleteAccount({ auth: { uid: 'leaver' }, data: {} });            // rappel : aucune erreur
  await assert.rejects(() => api.deleteAccount({ data: {} }), (e) => e.code === 'unauthenticated');
});
