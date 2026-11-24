# KADENZ — back-end Firebase

Tout ce qu'il faut côté serveur pour le multijoueur de KADENZ : **règles de sécurité**, **Cloud Functions** (rooms, matchmaking, arbitrage de manche, classement) et leurs **tests**.

Le principe de l'architecture, repris des specs : le réseau *synchronise* la partie, il ne la pilote pas. Chaque joueur joue sur son plateau en local ; le serveur ne fait que
- fixer la graine du paquet et l'instant du GO (une seule horloge pour tous) ;
- relayer la progression et les attaques ;
- **arbitrer la fin de manche** : il rejoue la partie d'un joueur qui prétend avoir gagné avant de le croire, puis publie le classement officiel.

```text
Android ──(appels)──▶ Cloud Functions ──▶ Realtime Database ◀──(écoute)── Android
   │                   (rooms, arbitrage,                          ▲
   └─ écrit SEULEMENT sa progression ───────────────────────────────┘
```

## Contenu

```text
kadenz-back/
├── firebase.json            configuration du projet + émulateurs
├── .firebaserc              identifiant de VOTRE projet (à remplir)
├── database.rules.json      règles de sécurité de la base
└── functions/
    ├── index.js             points d'entrée (branche src/ sur Firebase)
    ├── package.json
    ├── src/
    │   ├── config.js        tous les réglages (durées, matchmaking, ligues, saison…)
    │   ├── engine.js        port JavaScript EXACT du moteur de jeu Java (pour rejouer les manches)
    │   ├── replay.js        rejeu d'un journal de coups
    │   ├── rating.js        Glicko-2
    │   ├── progress.js      niveaux, ligues, saisons, récompenses, pseudos
    │   ├── codes.js         codes de room
    │   └── handlers/        profile, rooms, matchmaking, rounds, cleanup
    └── test/                254 tests (node:test, sans dépendance)
```

## Prérequis

- **Node.js 22** et le **Firebase CLI** : `npm install -g firebase-tools`
- Un compte Google et un projet Firebase
- **Forfait Blaze (paiement à l'usage)** : obligatoire pour les Cloud Functions et le ménage planifié. Le quota gratuit est large et un jeu à ce stade reste très en dessous (voir « Coûts »). Configurez une alerte de budget dans la console Google Cloud.

## Mise en place, pas à pas

1. **Créer le projet** dans la [console Firebase](https://console.firebase.google.com) et passer au forfait **Blaze**.
2. **Authentication** → *Méthode de connexion* → activer **Anonyme** (les joueurs n'ont pas de compte à créer).
3. **Realtime Database** → *Créer une base de données* → emplacement **europe-west1 (Belgique)** → démarrer en mode verrouillé (les règles de ce dossier la sécurisent au déploiement).
4. **Brancher ce dossier à votre projet** : ouvrir `.firebaserc` et remplacer `REMPLACEZ-PAR-VOTRE-ID-DE-PROJET-FIREBASE` par l'identifiant du projet.
5. **Installer et tester** (aucun accès à Firebase nécessaire pour les tests) :
   ```bash
   firebase login
   cd functions
   npm install
   npm test            # 254 tests doivent passer
   cd ..
   ```
6. **Déployer** :
   ```bash
   firebase deploy --only database,functions
   ```
   Au premier déploiement, Firebase propose d'activer quelques API (Cloud Scheduler, Artifact Registry…) : répondre oui.
7. **Brancher l'application Android** : dans *Paramètres du projet* → *Ajouter une application Android* avec le nom de package **`fr.accentweb.kadenz`**, télécharger **`google-services.json`** et le placer dans `kadenz-app/app/`. Rien d'autre à changer : le projet Gradle détecte le fichier et active Firebase tout seul.
8. **Vérifier** : lancer l'app sur deux appareils (ou un appareil + un émulateur), *Partie privée* → créer sur l'un, rejoindre avec le code sur l'autre.

> Les fonctions tournent en **europe-west1**, comme la base. Ce choix figure à deux endroits qui doivent rester identiques : `functions/src/config.js` (`REGION`) et `Firebases.java` côté app (`FUNCTIONS_REGION`).

## Développer en local (émulateurs)

```bash
firebase emulators:start          # Auth, Database, Functions + interface sur http://localhost:4000
```
Côté Android : `./gradlew installDebug -PkadenzEmulator=true`. L'émulateur Android joint votre PC par `10.0.2.2` ; la configuration réseau de l'app n'autorise le trafic non chiffré que vers cette adresse. Le fichier `google-services.json` reste nécessaire (il initialise Firebase), même en mode émulateur.

## API (fonctions appelables)

Toutes exigent une connexion (anonyme) et répondent en erreurs Firebase standard avec un **message en français prêt à afficher**.

| Fonction | Rôle | Entrée | Sortie | Erreurs courantes |
|---|---|---|---|---|
| `ensureProfile` | Crée le profil au 1er lancement, change le pseudo | `{name?}` | `{uid, name, level, xp, coins, rating, league, games, wins, season}` | `invalid-argument` (pseudo) |
| `createRoom` | Crée une partie privée | `{}` | `{code}` | — |
| `joinRoom` | Rejoint avec un code | `{code}` | `{code}` | `not-found`, `failed-precondition` (déjà commencée), `resource-exhausted` (pleine / trop d'essais) |
| `leaveRoom` | Quitte (l'hôte est transféré) | `{code}` | `{ok}` | — |
| `setReady` | Prêt / pas prêt | `{code, ready}` | `{ok}` | `permission-denied` |
| `startGame` | L'hôte lance la partie | `{code}` | `{startAt}` | `permission-denied`, `failed-precondition` |
| `quickMatch` | Partie rapide classée : à appeler toutes les ~2,5 s | `{}` | `{status:"WAITING", waitedMs, window}` ou `{status:"MATCHED", code}` | — |
| `cancelQuickMatch` | Quitte la file | `{}` | `{ok}` | — |
| `sendAttack` | Envoie une Carte Malus | `{code, to}` | `{ok}` | `failed-precondition` (recharge), `resource-exhausted` |
| `reportFinish` | « J'ai vidé ma pile » + journal de coups | `{code, finishedAtMs, actions, log, malus}` | `{ok}` | `permission-denied` (victoire refusée + raison) |
| `finalizeRound` | Chrono écoulé : clôturer la manche | `{code}` | `{ok, finished}` | `failed-precondition` (trop tôt) |
| `cleanup` | *(planifiée, toutes les 5 min)* Ménage | — | — | — |

## Modèle de données

```text
users/{uid}                 profil, XP, pièces, classement (lecture : le joueur seul ; écriture : serveur seul)
rooms/{CODE}
  status                    LOBBY → PLAYING → FINALIZING → FINISHED
  hostUid, ranked, visibility, seed, startAt
  players/{uid}             name, ready, connected, playerIndex, joinedAt, left
  progress/{uid}            remaining, t, seq        ← la SEULE chose que le client écrit (règles de sécurité)
  events/{id}               attaques (écrites par le serveur)
  finishes/{uid}            victoires validées
  flags/{uid}               victoires refusées (journal d'audit)
  result                    classement officiel
leaderboard/{saison}/{uid}  pseudo, classement (lecture : tout joueur connecté)
matchmaking/queue|matches   file d'attente (serveur seul) ; chaque joueur lit sa propre assignation
```

## Sécurité et anti-triche

**Règles de la base** (`database.rules.json`) : tout est fermé par défaut. Un joueur ne lit que les rooms où il est, et n'écrit que sa propre progression (nombre borné, numéro de séquence croissant, uniquement pendant la manche) et son état « connecté ». Tout le reste passe par les fonctions.

**Quand un joueur annonce sa victoire**, le serveur contrôle, dans l'ordre :
1. le **temps de jeu** annoncé (pas dans le futur, pas négatif) et la **cadence** (pas plus de ~8 actions/s) ;
2. les **Malus déclarés** contre les attaques réellement envoyées par le serveur ;
3. le **rejeu complet** : il regénère le paquet du joueur à partir de la graine du serveur, rejoue chaque coup du journal et exige que chaque coup soit légal et que la pile finisse vide ;
4. le **nombre d'attaques envoyées** : il ne peut pas dépasser ce que les combos du journal rendent possible.

Le **classement se fait sur le temps de jeu logique**, jamais sur l'ordre d'arrivée réseau : après la première victoire, une fenêtre de 2 s accueille les arrivées quasi simultanées, puis le serveur les départage sur leur temps de jeu (section 51.7 des specs). Un joueur dont la victoire est refusée ne touche aucune récompense ; une victoire valide envoyée ensuite annule ce signalement (un compteur de Malus erroné ne doit pas condamner un joueur honnête).

**Limites à connaître** : seuls les *vainqueurs* sont rejoués. Un joueur qui ne finit pas annonce lui-même son nombre de cartes restantes, ce qui n'influence que sa place parmi les non-finisseurs. À durcir avant un lancement public : **App Check** (variable d'environnement `ENFORCE_APP_CHECK=true` une fois l'app enregistrée) et, si besoin, rejeu des journaux de tous les joueurs en fin de manche.

## Classement, ligues, saisons, récompenses

- **Glicko-2** (RD élevé pour les nouveaux : ils montent vite, puis se stabilisent). Une manche à plusieurs est traitée comme des duels du joueur contre chaque autre. Seules les parties **classées** (partie rapide) comptent ; une partie entre amis donne de l'XP et des pièces mais jamais de points.
- **Ligues** : Bronze < 1100 · Argent < 1250 · Or < 1400 · Platine < 1550 · Diamant au-delà (`config.js`).
- **Saisons de 8 semaines** (`SEASON_DAYS`, première saison le 5 janvier 2026). Au premier match d'une nouvelle saison, le classement est recompressé de moitié vers le centre (reset doux).
- **Récompenses** purement cosmétiques : XP (niveau = 1 + √(XP/100)) et pièces. Jamais d'avantage de jeu.
- **Pas de bot en classé** : si peu de joueurs sont en ligne, la fourchette de niveau s'élargit, puis la partie part à 2 ou 3 humains après ~25 s.

## Garder le serveur et l'app synchronisés

Le serveur rejoue les parties avec `functions/src/engine.js`, un **port exact** du moteur Java (même générateur pseudo-aléatoire 64 bits, même mélange, même joueur glouton qui filtre les mauvais paquets). La parité est vérifiée par `test/parity.test.js` à partir de `test/fixtures/parity.json`, **généré par le vrai code Java**.

> **Si vous modifiez une règle ou `GameConfig.java` dans l'app**, reportez la même modification dans `engine.js` (bloc `CFG` + logique), puis régénérez la fixture depuis la racine du projet Android :
> ```bash
> javac -d /tmp/parity -sourcepath app/src/main/java tools/ParityFixture.java
> java -cp /tmp/parity ParityFixture > ../kadenz-back/functions/test/fixtures/parity.json
> cd ../kadenz-back/functions && npm test
> ```
> Si les tests de parité échouent, **ne déployez pas** : tous les joueurs verraient leurs victoires refusées.

Autre constante partagée : `MAIN_PILE_SIZE` apparaît aussi dans `database.rules.json` (plafond de 60 cartes restantes, large) ; rien à changer tant que la pile reste modeste.

## Coûts (ordre de grandeur)

Chaque joueur écrit sa progression au plus 4 fois par seconde (≈ 100 octets). Une manche à 4 joueurs de 4 minutes représente de l'ordre de **1 à 2 Mo** de trafic base de données au total, et quelques dizaines d'appels de fonctions. Le quota gratuit absorbe largement les premiers milliers de parties ; surveillez la console *Utilisation* et gardez une alerte de budget.

## Ce qui est vérifié, et ce qui ne l'est pas

**Vérifié (254 tests, hors ligne)** : toute la logique serveur sur un faux Realtime Database fidèle à la sémantique de Firebase — création et codes (y compris les collisions), rejoindre et ses erreurs, anti brute-force, migration d'hôte, démarrage, matchmaking, victoire validée par rejeu, tricheries détectées, classement au temps de jeu avec fenêtre de grâce, Glicko-2 (exemple de référence de Glickman), récompenses, ménage ; le câblage de `index.js` avec un faux Firebase ; et la **parité exacte** avec le moteur Java sur 48 cas.

**Non vérifié ici** (pas d'accès au réseau ni aux émulateurs) : le déploiement réel, et les **règles de sécurité** `database.rules.json` (JSON valide, mais jamais exécutées). Avant de publier, faites un tour dans l'émulateur et testez au minimum : un joueur ne peut pas lire une room où il n'est pas, ne peut pas écrire la progression d'un autre, ni écrire `status` ou `result`.

## Dépannage

| Symptôme | Piste |
|---|---|
| `PERMISSION_DENIED` à la lecture d'une room | Le joueur n'est pas dans `players` : c'est normal avant `joinRoom`. |
| Les fonctions ne trouvent pas la base | Vérifier l'URL de la base dans la console ; elle doit se terminer par `europe-west1.firebasedatabase.app`. Le CLI la fournit aux fonctions via `FIREBASE_CONFIG`. |
| `Cloud Scheduler` refuse le déploiement | Le forfait Blaze n'est pas actif sur le projet. |
| Toutes les victoires sont refusées | Moteur Java et `engine.js` ne sont plus synchronisés : voir « Garder le serveur et l'app synchronisés ». |
| L'app dit « mode en ligne non configuré » | `google-services.json` absent de `kadenz-app/app/`. |

## Évolutions prévues

Reconnexion en cours de manche, rejeu des journaux de tous les joueurs, parties publiques à parcourir, notifications push (FCM), créneaux programmés (section 57.5 des specs), boutique cosmétique.
