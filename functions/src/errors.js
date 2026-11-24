'use strict';
/** Erreur "métier" : le code suit les codes des HttpsError Firebase (not-found, failed-precondition...). */
class AppError extends Error {
  constructor(code, message) { super(message); this.name = 'AppError'; this.code = code; }
}
module.exports = { AppError };
