'use strict';
/** Adaptateur firebase-admin (Realtime Database) : mêmes méthodes que MemoryDb. */
function adminDb(database) {
  const ref = (p) => database.ref(p);
  return {
    async get(p) { return (await ref(p).get()).val(); },
    async set(p, v) { await ref(p).set(v); },
    async remove(p) { await ref(p).remove(); },
    // p = '' : écriture groupée à la racine (plusieurs chemins en une seule opération)
    async update(p, u) { await (p ? ref(p) : database.ref()).update(u); },
    async transaction(p, fn) {
      const r = await ref(p).transaction(fn);
      return { committed: r.committed, value: r.snapshot.val() };
    },
    pushKey(p) { return ref(p).push().key; },
    async queryByChildLte(p, child, max, limit = 1000) {
      const s = await ref(p).orderByChild(child).endAt(max).limitToFirst(limit).get();
      return s.val() || {};
    },
  };
}
module.exports = { adminDb };
