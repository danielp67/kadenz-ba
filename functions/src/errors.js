'use strict';
/**
 * Erreur "métier". `code` suit les codes des HttpsError Firebase (not-found, failed-precondition...).
 * `key` est un identifiant STABLE (ex. ROOM_NOT_FOUND) : l'application s'en sert pour afficher le message
 * dans la langue du joueur. `message` (en français) n'est qu'un texte de secours pour les journaux et les anciens clients.
 */
class AppError extends Error {
  constructor(code, message, key) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.key = key || null;
  }
}
module.exports = { AppError };
