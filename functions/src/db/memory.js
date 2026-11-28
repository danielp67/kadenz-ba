'use strict';
/**
 * Faux Realtime Database en mémoire, avec la même sémantique que Firebase pour ce dont on a besoin :
 * null = supprimer, objets vides disparaissent, update multi-chemins, transactions (retourner undefined = annuler).
 * Sert uniquement aux tests : c'est ce qui permet de vérifier TOUTE la logique serveur hors-ligne.
 */
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const parts = (p) => String(p).split('/').filter(Boolean);

class MemoryDb {
  constructor(initial = {}) { this.root = clone(initial) || {}; this._seq = 0; this.stats = { get: 0, set: 0, remove: 0, update: 0, transaction: 0 }; }

  _get(path) {
    let cur = this.root;
    for (const k of parts(path)) {
      if (cur === null || typeof cur !== 'object' || !(k in cur)) return null;
      cur = cur[k];
    }
    return cur === undefined ? null : cur;
  }

  _set(path, value) {
    const ks = parts(path);
    if (ks.length === 0) { this.root = value === null ? {} : clone(value); return; }
    if (value === null) {
      const stack = [this.root];
      for (const k of ks.slice(0, -1)) {
        const next = stack[stack.length - 1] && stack[stack.length - 1][k];
        if (next === undefined || next === null || typeof next !== 'object') return;
        stack.push(next);
      }
      delete stack[stack.length - 1][ks[ks.length - 1]];
      for (let i = ks.length - 1; i > 0; i--) {           // élaguer les parents devenus vides
        if (Object.keys(stack[i]).length === 0) delete stack[i - 1][ks[i - 1]]; else break;
      }
      return;
    }
    let cur = this.root;
    for (const k of ks.slice(0, -1)) {
      if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[ks[ks.length - 1]] = this._clean(clone(value));
  }

  _clean(v) {                                              // retire les null / objets vides, comme Firebase
    if (v === null || typeof v !== 'object') return v;
    for (const k of Object.keys(v)) {
      v[k] = this._clean(v[k]);
      if (v[k] === null || (typeof v[k] === 'object' && Object.keys(v[k]).length === 0)) delete v[k];
    }
    return v;
  }

  async get(path) { this.stats.get++; return clone(this._get(path)); }
  async set(path, value) { this.stats.set++; this._set(path, value === undefined ? null : value); }
  async remove(path) { this.stats.remove++; this._set(path, null); }

  async update(path, updates) {
    this.stats.update++;
    for (const [rel, val] of Object.entries(updates)) {
      this._set([path, rel].filter(Boolean).join('/'), val === undefined ? null : val);
    }
  }

  async transaction(path, fn) {
    this.stats.transaction++;
    const current = clone(this._get(path));
    const result = fn(current);
    if (result === undefined) return { committed: false, value: current };
    this._set(path, result);
    return { committed: true, value: clone(this._get(path)) };
  }

  pushKey() { return `k${String(++this._seq).padStart(6, '0')}`; }

  async queryByChildLte(path, child, max, limit = 1000) {
    const all = this._get(path) || {};
    const rows = Object.entries(all).filter(([, v]) => v && typeof v[child] === 'number' && v[child] <= max)
      .sort((a, b) => a[1][child] - b[1][child]).slice(0, limit);
    const out = {};
    for (const [k, v] of rows) out[k] = clone(v);
    return out;
  }
}

module.exports = { MemoryDb };
