'use strict';
/** Tous les réglages du serveur. Les durées sont en millisecondes. */
module.exports = Object.freeze({
  REGION: 'europe-west1',
  RULES_VERSION: 1,

  // Rooms
  MAX_PLAYERS: 4,
  MIN_PLAYERS_TO_START: 2,
  CODE_LENGTH: 5,
  CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',   // sans I, L, O, 0, 1 : pas d'ambiguïté à l'écran ni à l'oral
  LOBBY_COUNTDOWN_MS: 5000,
  MATCH_COUNTDOWN_MS: 7000,                             // matchmaking : laisse le temps aux clients de charger
  JOIN_RATE_LIMIT: { max: 10, windowMs: 60_000 },       // anti brute-force sur les codes

  // Manche
  ROUND_TIMEOUT_MS: 4 * 60_000,
  FINALIZE_GRACE_MS: 2000,        // fenêtre pour recevoir les arrivées quasi simultanées (classement au temps de jeu, pas à l'arrivée réseau)
  FINALIZE_SLACK_MS: 3000,
  FINISH_TIME_TOLERANCE_MS: 3000, // écart d'horloge toléré entre client et serveur
  MIN_ACTION_MS: 120,             // aucun humain ne fait plus de ~8 actions par seconde
  MALUS_MUST_MS: 3000,
  MALUS_SLACK_MS: 3000,

  // Attaques
  ATTACK_COOLDOWN_MS: 8000,
  ATTACK_COOLDOWN_TOLERANCE_MS: 250,
  MAX_ATTACKS_PER_ROUND: 12,

  // Matchmaking
  MM: Object.freeze({
    BASE_WINDOW: 100,
    GROWTH_PER_SEC: 10,
    MAX_WINDOW: 600,
    FILL_WAIT_MS: 25_000,         // au bout de ~25 s on lance avec 2-3 joueurs plutôt que d'attendre un 4e (jamais de bot en classé)
    ALIVE_MS: 12_000,             // un joueur qui ne "ping" plus est retiré de la file
    MAX_GROUP: 4,
    ASSIGN_TTL_MS: 30_000,
  }),

  // Classement Glicko-2
  RATING: Object.freeze({ CENTER: 1000, INIT_RD: 350, INIT_VOL: 0.06, TAU: 0.5, MIN_RD: 50, SEASON_RD_FLOOR: 150 }),
  SEASON_DAYS: 56,
  SEASON_EPOCH_MS: Date.UTC(2026, 0, 5),
  LEAGUES: Object.freeze([                              // seuils sur le classement affiché
    { name: 'BRONZE', below: 1100 },
    { name: 'ARGENT', below: 1250 },
    { name: 'OR', below: 1400 },
    { name: 'PLATINE', below: 1550 },
    { name: 'DIAMANT', below: Infinity },
  ]),

  // Ménage
  LOBBY_IDLE_MS: 30 * 60_000,
  HOST_MIGRATION_AFTER_MS: 60_000,
  PLAYING_STUCK_MS: 15_000,
  FINALIZING_STUCK_MS: 30_000,
  FINISHED_TTL_MS: 60 * 60_000,
  MATCH_ASSIGN_PURGE_MS: 5 * 60_000,
});
