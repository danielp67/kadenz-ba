'use strict';
/**
 * KADENZ — back-end Firebase (Cloud Functions 2e génération + Realtime Database).
 *
 * Toute la logique est dans src/ (testable hors-ligne). Ce fichier ne fait que la brancher sur Firebase :
 * il vérifie la connexion, fournit le contexte (base de données, horloge, hasard) et traduit les erreurs.
 */
const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');

admin.initializeApp();

const CFG = require('./src/config');
const { AppError } = require('./src/errors');
const { adminDb } = require('./src/db/admin');
const { ensureProfile } = require('./src/handlers/profile');
const rooms = require('./src/handlers/rooms');
const matchmaking = require('./src/handlers/matchmaking');
const rounds = require('./src/handlers/rounds');
const { cleanupRooms } = require('./src/handlers/cleanup');
const { deleteAccount } = require('./src/handlers/account');

const db = adminDb(admin.database());

// App Check : à activer une fois l'app enregistrée (voir README) -> firebase functions:config ou variable d'environnement
const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === 'true';

function makeCtx(uid) {
  return {
    db,
    uid,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomInt: (n) => crypto.randomInt(n),
    randomSeed: () => crypto.randomBytes(6).readUIntBE(0, 6),   // 48 bits : tient exactement dans un nombre JS et dans un long Java
    deleteAuthUser: async (id) => {
      try { await admin.auth().deleteUser(id); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
    },
  };
}

/** Enveloppe commune : authentification obligatoire + traduction des erreurs métier en erreurs Firebase. */
function callable(handler, options = {}) {
  return onCall(
    { region: CFG.REGION, enforceAppCheck: ENFORCE_APP_CHECK, maxInstances: 50, ...options },
    async (request) => {
      if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise.');
      try {
        return await handler(makeCtx(request.auth.uid), request.data || {});
      } catch (e) {
        // `details.key` : identifiant stable que l'app traduit dans la langue du joueur
        if (e instanceof AppError) throw new HttpsError(e.code, e.message, { key: e.key });
        logger.error('Erreur inattendue', e);
        throw new HttpsError('internal', 'Erreur serveur. Réessayez.');
      }
    },
  );
}

// ---- API appelée par l'app Android --------------------------------------------------------
exports.ensureProfile    = callable(ensureProfile);
exports.createRoom       = callable(rooms.createRoom);
exports.joinRoom         = callable(rooms.joinRoom);
exports.leaveRoom        = callable(rooms.leaveRoom);
exports.setReady         = callable(rooms.setReady);
exports.startGame        = callable(rooms.startGame);
exports.quickMatch       = callable(matchmaking.quickMatch);
exports.cancelQuickMatch = callable(matchmaking.cancelQuickMatch);
exports.sendAttack       = callable(rounds.sendAttack);
exports.reportFinish     = callable(rounds.reportFinish, { timeoutSeconds: 30 });   // attend la fenêtre de grâce avant de publier le classement
exports.finalizeRound    = callable(rounds.finalizeRound, { timeoutSeconds: 30 });
exports.deleteAccount    = callable(deleteAccount);

// ---- Ménage planifié (nécessite le forfait Blaze : Cloud Scheduler) -------------------------
exports.cleanup = onSchedule(
  { schedule: 'every 5 minutes', region: CFG.REGION, timeZone: 'Europe/Paris' },
  async () => {
    const stats = await cleanupRooms(makeCtx('system'));
    logger.info('Ménage terminé', stats);
  },
);
