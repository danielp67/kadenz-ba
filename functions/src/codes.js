'use strict';
const CFG = require('./config');

/** Code de room aléatoire. randomInt(n) doit renvoyer un entier dans [0, n). */
function generateCode(randomInt) {
  let s = '';
  for (let i = 0; i < CFG.CODE_LENGTH; i++) s += CFG.CODE_ALPHABET[randomInt(CFG.CODE_ALPHABET.length)];
  return s;
}

/** Saisie utilisateur -> code canonique, ou null si invalide. Tolère espaces, tirets et minuscules. */
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CFG.CODE_LENGTH) return null;
  for (const ch of s) if (!CFG.CODE_ALPHABET.includes(ch)) return null;
  return s;
}

module.exports = { generateCode, normalizeCode };
