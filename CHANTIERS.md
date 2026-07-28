# CHANTIERS — la dette relevée par l'audit

Issu de l'audit du **25 juillet 2026** (`docs/AUDIT.md`, commit `50c00dc`) : 122 constats
bruts, 7 démolis par réfutation adversariale, **115 retenus**, regroupés en 16 chantiers.

- **`docs/AUDIT.md`** porte le détail de chaque ligne : le mécanisme, le scénario d'échec, la
  correction proposée, et pourquoi tel constat a été écarté. On n'y touche plus — c'est un relevé daté.
- **Ce fichier-ci** porte l'ordre et l'état. C'est lui qu'on coche.

## La boucle

Un chantier = un ou plusieurs commits. Pour chacun :

1. Ouvrir `docs/AUDIT.md` à la section du chantier — la correction y est déjà écrite et pesée.
2. Corriger, en commençant par le test quand le chantier le réclame (c'est noté).
3. `npx tsc --noEmit` + la suite de tests. **Sur ce poste (Node 22)** : `node --test --experimental-strip-types "lib/**/*.test.ts" "db/**/*.test.ts" "ui/**/*.test.ts" "fournisseurs/**/*.test.ts"` — `npm test` échoue pour une raison d'environnement, pas de code.
4. Cocher, commiter, pousser.
5. Ce qu'on écarte se raye (`~~...~~`) avec la raison en fin de ligne — pas se supprime.

L'ordre est classé par **gain sur risque de régression**, pas par sévérité : un chantier à fort
gain et risque nul passe avant un chantier à gain moyen et risque élevé. Les dépendances entre
chantiers sont notées ; hors d'elles, on peut piocher.

## Avancement

| # | Chantier | Sév. | Risque | Effort | État |
|---|---|---|---|---|---|
| 1 | Le lot d'une ligne — corrections locales, vérifiées, à régression quasi nulle | 🟠 | faible | heures | ✅ 9/9 |
| 2 | Une file d'écritures par CONNEXION SQLite (et les brouillons dedans) | 🟡 | faible | heures | ✅ 3/3 |
| 3 | Zéro secret hors du processus | 🔴 | moyen | jour | ☐ 0/4 |
| 4 | Ce qui entre en base doit être juste : normalisation, aperçus, clés E2EE | 🟡 | faible | jour | ☐ 0/6 |
| 5 | Rattrapage de salon : un seul par salon, des caches qui ne mentent pas | 🟡 | moyen | jour | ☐ 0/5 |
| 6 | Cycle de vie de la donnée locale : purge, curseurs, rétention | 🟡 | moyen | jour | ☐ 0/4 |
| 7 | File de téléversements : ni doublon, ni disparition silencieuse | 🟠 | moyen | plusieurs-jours | ☐ 0/7 |
| 8 | Transport DDP et REST : ne pas tuer une socket saine, ne pas dormir sans écouter | 🟡 | moyen | jour | ☐ 0/6 |
| 9 | Session morte et fin de session : ramener au login, et tout emporter en partant | 🟠 | ÉLEVÉ | jour | ☐ 0/5 |
| 10 | Push natif : doublons, deep-link multi-serveur, hygiène du service | 🟠 | moyen | plusieurs-jours | ☐ 0/8 |
| 11 | Écrans : boucles sans borne, attentes fixes, coûts natifs inutiles | 🟡 | faible | jour | ☐ 0/9 |
| 12 | Filet de test là où le code n'est pas atteignable | 🟡 | nul | jour | ☐ 0/5 |
| 13 | Une seule source par concept : i18n, couleurs, formats, tables MIME | 🟡 | faible | jour | ☐ 0/6 |
| 14 | Duplication structurelle et découpage de l'écran salon | 🟡 | moyen | plusieurs-jours | ☐ 0/7 |
| 15 | La façade Fournisseur : ce qui nomme Rocket.Chat doit passer par elle | 🟡 | moyen | jour | ☐ 0/4 |
| 16 | Remettre la documentation d'accord avec le code | 🟡 | nul | heures | ☐ 0/2 |

---

<!-- fait en 3a57bae -->
## 1. Le lot d'une ligne — corrections locales, vérifiées, à régression quasi nulle

**🟠 haute** · risque de correction **faible** · effort **heures** · 9 constats

> Sept défauts dont deux de sévérité haute se corrigent chacun en trois lignes ou moins, dans un seul fichier, sans toucher à un chemin partagé. Aujourd'hui ils coûtent : plus aucune notification de la session quand les Play Services répondent mal au premier raccordement, un rechargement complet de l'historique à chaque bascule E2EE, du texte utilisateur détruit, des photos postées en double, une feuille d'actions vide sur tout un salon chiffré. Vu le maître mot (zéro régression), ce lot passe avant tout le reste : gain immédiat, surface minuscule, et deux d'entre eux (la génération E2E, la garde d'upload) débloquent des chantiers ultérieurs.

- [x] 🟠 Un échec d'obtention du jeton FCM arme quand même le drapeau : plus aucune notification pour toute la session — `ui/synchro.tsx:333`
- [x] 🟡 `generation` est bumpée par les transitions E2EE, ce qui refait partir historique et rattrapage sans qu'aucune connexion n'ait été perdue — `ui/synchro.tsx:211`
- [x] 🟡 Le texte tapé PENDANT un téléversement est effacé à la fin de l'envoi — un correctif de 8.7 a été perdu — `app/salon/[rid].tsx:813`
- [x] 🟡 Écran de partage : un refus de validation en milieu de boucle renvoie en double les pièces déjà envoyées — `app/partager.tsx:217`
- [x] 🟡 La feuille d'actions s'ouvre VIDE sur tout message d'un salon chiffré et sur tout message système — `lib/actionsMessage.ts:46`
- [x] ⚪ Le message d'erreur de recherche survit au vidage du champ — `app/recherche.tsx:84`
- [x] 🟡 L'écran de partage affiche les avatars de salon sans leur `avatarETag` : photo figée à vie par le cache Fresco — `app/partager.tsx:361` *(non passé au réfuteur)*
- [x] 🟡 Depuis la fiche d'un DM, « Message » empile une SECONDE copie du salon déjà ouvert — `app/profil.tsx:196` *(non passé au réfuteur)*
- [x] 🟡 `ouvrirFicheProfil` n'a aucune garde de réentrance : un double tap empile deux fiches — `lib/profilPreload.ts:104` *(non passé au réfuteur)*
- [x] **Sortie du chantier** : `tsc` propre ✅, suite verte ✅ (462), lancement réel sur le Pixel ✅ (26/07/2026, `assembleRelease` + `adb install -r`, contre `chat.barrut.me`). Vérifiés à la main : feuille d'actions garnie sur un message chiffré de `laprivitude` ; « Message » depuis la fiche d'un DM qui rend le salon déjà ouvert sans l'empiler ; le texte tapé pendant un téléversement qui survit à la fin de l'envoi ; la citation qui se désarme à l'envoi d'une pièce jointe et ne contamine pas le message suivant.

## 2. Une file d'écritures par CONNEXION SQLite (et les brouillons dedans)

**🟡 moyenne** · risque de correction **faible** · effort **heures** · 3 constats

> C'est la race la plus dangereuse du dépôt — deux `BEGIN` concurrents sur une même connexion, ce que db/depot.ts:64-76 documente comme mortel (« cannot rollback - no transaction is active », lot annulé en silence) — et sa correction tient en deux lignes dans db/client.ts, vérifiées, sans changement de comportement sur le chemin nominal. Rapport gain/risque imbattable : à faire tout de suite, d'autant qu'elle rend inoffensive la reconstruction du moteur de synchro sur un simple renommage, qu'on peut alors laisser en l'état.

**Ordre.** Aucune dépendance. À passer avant tout ce qui touchera à la base.

- [x] 🟡 Un changement de pseudo reconstruit toute la synchro et crée une SECONDE file d'écritures sur la même connexion SQLite — `ui/synchro.tsx:424` → la file naît avec la connexion (`db/fileEcritures.ts`, nouveau module : le mettre dans `db/depot.ts` aurait fait importer le dépôt par `db/client.ts`, à contre-courant des couches)
- [x] 🟡 Les brouillons écrivent hors de la file, donc à l'intérieur des transactions de synchro — `ui/brouillons.ts:60` *(non passé au réfuteur)* → `creerDepotBrouillons` + SQL statique dans `db/upserts.ts`, 6 tests
- [x] ⚪ `useRequeteVive` ne filtre pas les événements par base, et les connexions des comptes visités ne sont jamais fermées — `ui/requeteVive.ts:79` *(non passé au réfuteur)* → **la correction prescrite par l'audit était fausse** : `databaseName` vaut `main` pour toutes nos bases (nom SQLite interne du schéma attaché), il ne discrimine rien. Filtré sur `databaseFilePath`, que le natif remplit avec `sqlite3_db_filename()` — comparaison par nom de fichier, et seulement si les deux valeurs sont lisibles, pour que le pire cas reste le comportement d'avant.
- [ ] **Sortie du chantier** : `tsc` propre ✅, suite verte ✅ (468), **lancement réel sur le Pixel — à faire**. À regarder en premier : les messages arrivent-ils toujours en direct ? C'est le filtre par fichier qui est en jeu — s'il se trompait, l'UI cesserait de se rafraîchir.

## 3. Zéro secret hors du processus

**🔴 critique** · risque de correction **moyen** · effort **jour** · 4 constats

> Un `rc_token` Rocket.Chat vaut le compte entier (lecture de tous les salons, envoi, changement de profil) et il part aujourd'hui dans la barre d'adresse de Chrome — donc dans son historique, synchronisé vers le compte Google — dès qu'on touche une pièce jointe « fichier ». C'est le seul constat critique de tout l'audit et il est vérifié. Les trois autres fuites du chantier (schéma d'URL non gardé, WebView d'appel sans verrou d'origine, hôte push non validé) partagent le même invariant : ce qui sort du processus doit être choisi par nous, pas par le contenu reçu. Corrections locales, aucune touche à la synchro ni à la base.

**Ordre.** Indépendant de tout le reste.

- [ ] 🔴 Le jeton d'authentification est remis au navigateur système quand on ouvre une pièce jointe « fichier » — `ui/ligneMessage.tsx:561`
- [ ] 🟡 Une carte d'aperçu de lien ouvre l'URL du serveur sans garde de schéma, alors que le markdown en pose une — `ui/carteLien.tsx:159` *(non passé au réfuteur)*
- [ ] 🟡 La WebView d'appel accorde caméra et micro à n'importe quelle origine https — `app/appel/[callId].tsx:188` *(non passé au réfuteur)*
- [ ] 🟡 Le jeton part vers l'hôte indiqué par le payload push quand une seule session est connue, sans vérification d'hôte — `plugins/with-fcm-deeplink.js:601` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 4. Ce qui entre en base doit être juste : normalisation, aperçus, clés E2EE

**🟡 moyenne** · risque de correction **faible** · effort **jour** · 6 constats

> Cinq défauts qui écrivent une donnée fausse en SQLite — donc durable, puisque l'UI n'est qu'une projection : le pseudo d'un correspondant remplacé par le mien dans la table `utilisateurs`, l'aperçu d'un salon effacé par un message d'appel vidéo, un aperçu chiffré qui montre une réponse de fil invisible, une clé AES de salon jamais invalidée à la rotation. Toutes les corrections sont locales à des fonctions pures ou à du SQL statique, donc testables sans appareil, et lib/normaliser.ts — par où passent 100 % des documents serveur — n'a aujourd'hui que trois tests sur le `callId`. Fort gain, risque faible : à faire tôt.

**Ordre.** Avant le chantier 6, qui manipule les mêmes tables.

- [ ] 🟡 `versSalon` devine le pseudo de l'autre par exclusion de `moi` : si `moi` est périmé, l'uid du correspondant reçoit MON pseudo — `lib/normaliser.ts:238`
- [ ] 🟡 L'aperçu de la liste des salons est EFFACÉ quand le dernier message n'a ni texte ni pièce jointe (message d'appel vidéo) — `lib/normaliser.ts:179` *(non passé au réfuteur)*
- [ ] ⚪ L'aperçu d'un salon chiffré peut afficher une réponse de fil ou un message système jamais visibles dans le salon — `db/upserts.ts:216` *(non passé au réfuteur)*
- [ ] 🟡 Une rotation de clé de salon E2EE n'est jamais prise en compte : la clé AES périmée reste en cache jusqu'au redémarrage — `lib/e2e/moteur.ts:132`
- [ ] ⚪ Le verrouillage E2EE réécrit tous les messages chiffrés, y compris ceux déjà masqués — `db/upserts.ts:199` *(non passé au réfuteur)*
- [ ] ⚪ `versSalon`, `versAbonnement`, `versEpoch` et `apercuDuDernier` n'ont aucun test direct — `lib/normaliser.test.ts:1`
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 5. Rattrapage de salon : un seul par salon, des caches qui ne mentent pas

**🟡 moyenne** · risque de correction **moyen** · effort **jour** · 5 constats

> À CHAQUE raccordement — donc à chaque retour au premier plan — deux paginations identiques partent sur le salon ouvert : le provider (garde `rattrapageSalonEnVol`) et l'écran, réveillé par le bump de `generation` que ce même raccordement vient de poser, qui appelle `lib/rattrapage.ts` en direct sans consulter la garde. Jusqu'à 8 `chat.syncMessages` là où 4 suffisent, sur une route à 10 appels/min et à 3-4 s par appel sur le serveur cible. La correction tient dans lib/rattrapage.ts, sans changer une seule signature d'appelant. Trois défauts de couverture voisins (lecture garantissante avalée, cache repeuplé après purge, fil sans garde) se traitent dans la foulée.

**Ordre.** Suppose acquis le correctif de `generation` du chantier 1.

- [ ] 🟡 Deux rattrapages concurrents sur le même salon à chaque raccordement — `lib/rattrapage.ts:227`
- [ ] 🟡 La lecture qui GARANTIT est avalée pour le salon actif par le garde anti-empilement — `ui/synchro.tsx:298` *(non passé au réfuteur)*
- [ ] 🟡 `garderAuChaud` peut repeupler le LRU APRÈS `libererSalonsChauds`, et l'entrée fantôme fait mentir `salonCouvert` — `ui/synchro.tsx:420` *(non passé au réfuteur)*
- [ ] 🟡 L'écran fil retélécharge le fil ENTIER à chaque raccordement, sans garde ni indicateur — `app/fil/[id].tsx:197` *(non passé au réfuteur)*
- [ ] ⚪ `salonActif` suppose qu'un seul écran salon est monté — `app/salon/[rid].tsx:366` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 6. Cycle de vie de la donnée locale : purge, curseurs, rétention

**🟡 moyenne** · risque de correction **moyen** · effort **jour** · 4 constats

> La purge ne connaît que trois tables sur huit, les curseurs survivent aux données qu'ils décrivent, et le critère de purge est un instantané PLUS ANCIEN que l'état qu'il juge — cette dernière est la seule race de tout l'audit qui peut faire disparaître de l'app un DM que l'utilisateur vient de recevoir. Les corrections sont du SQL statique paramétré, exactement le style déjà en place et déjà testé sur `node:sqlite` ; le risque tient au fait qu'on touche à des DELETE, donc à faire avec les tests écrits d'abord.

**Ordre.** Après le chantier 4. **Écrire les tests de dépôt d'abord** — on touche des `DELETE`.

- [ ] 🟡 La réconciliation anti-fantômes efface un salon créé PENDANT sa propre requête réseau — `db/depot.ts:178`
- [ ] 🟡 Les curseurs de rattrapage survivent aux données qu'ils décrivent — `db/schema.ts:242` *(non passé au réfuteur)*
- [ ] 🟡 Les files d'envoi et de téléversement ne sont jamais purgées avec leur salon : lignes zombies rejouées à l'infini — `db/upserts.ts:246` *(non passé au réfuteur)*
- [ ] 🟡 Aucune rétention : `messages` et ses tables satellites ne cessent jamais de croître — `db/schema.ts:77` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 7. File de téléversements : ni doublon, ni disparition silencieuse

**🟠 haute** · risque de correction **moyen** · effort **plusieurs-jours** · 7 constats

> C'est le maillon le plus faible du dépôt. Le chemin TEXTE (lib/envoi.ts) a acquis au fil des cicatrices un `_id` client, une confirmation par `chat.getMessage` et un message optimiste ; le chemin FICHIER n'a rien de tout cela. Conséquences réelles : une photo envoyée hors ligne disparaît de l'écran sans le moindre signe (l'utilisateur la renvoie, il en aura deux), une réponse de `mediaConfirm` perdue poste le message en double avec un fichier orphelin de plus sur le serveur, et une ligne en échec définitif re-pousse tous ses octets à chaque retour au premier plan. Aucun de ces chemins n'est couvert par les tests — d'où l'ordre imposé ci-dessous : les tests d'abord, la migration ensuite.

**Ordre.** **Écrire les tests absents d'abord** (statut 0, SQL de la file), puis le bandeau, puis la migration `file_id`.

- [ ] 🟠 Un fichier envoyé hors ligne disparaît de l'écran sans aucune trace — `lib/envoiFichiers.ts:187`
- [ ] 🟡 Une réponse perdue sur `rooms.mediaConfirm` fait poster DEUX fois le même fichier — `lib/upload.ts:86`
- [ ] 🟡 Aucun état « en cours » : « Abandonner » pendant une reprise supprime la ligne mais le message est posté quand même — `lib/envoiFichiers.ts:196` *(non passé au réfuteur)*
- [ ] 🟡 Les lignes en échec sont rejouées à chaque retour au premier plan, sans plafond ni recul — `db/upserts.ts:330` *(non passé au réfuteur)*
- [ ] 🟡 `messageLivre` confond « le serveur n'a pas répondu » et « le message n'a pas été livré » — `lib/envoi.ts:197` *(non passé au réfuteur)*
- [ ] ⚪ Aucun fichier temporaire n'est jamais supprimé — `ui/preparerPieceJointe.ts:27` *(non passé au réfuteur)*
- [ ] 🟡 Le chemin d'échec réseau et le SQL de la file de téléversements ne sont testés nulle part — `lib/envoiFichiers.test.ts:116` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 8. Transport DDP et REST : ne pas tuer une socket saine, ne pas dormir sans écouter

**🟡 moyenne** · risque de correction **moyen** · effort **jour** · 6 constats

> Le domaine est solide et bien testé, mais quatre défauts précis font que l'app se punit elle-même sur réseau dégradé : une sonde de vie envoyée trop tôt ferme une socket qui fonctionne (comportement serveur vérifié sur le banc), le pilote de reconnexion continue de rouvrir des sockets en arrière-plan contre l'intention documentée, un sommeil de rejeu 429 ignore l'annulation et fait converger les appels concurrents, et `/api/info` échappe seul à toute la défense du module — au point de pouvoir bloquer l'écran de connexion définitivement. Chaque correction est locale à un module déjà couvert par des tests.

**Ordre.** Indépendant. À traiter d'un bloc pour ne payer qu'une campagne de tests de reconnexion.

- [ ] 🟡 La sonde de vie envoyée pendant la négociation DDP tue une socket saine 10 s plus tard — `lib/ddp.ts:437` *(non passé au réfuteur)*
- [ ] 🟡 Le pilote de reconnexion n'est pas suspendu au passage en arrière-plan — `ui/synchro.tsx:389` *(non passé au réfuteur)*
- [ ] 🟡 `recupererVersion` appelle `fetch` sans délai maximal : l'écran de connexion peut rester bloqué à vie — `lib/server.ts:87` *(non passé au réfuteur)*
- [ ] 🟡 Le sommeil de rejeu sur 429 ignore l'annulation et n'a aucune dispersion — `lib/rest.ts:239` *(non passé au réfuteur)*
- [ ] ⚪ Rien n'invalide la présence quand le transport meurt — `lib/presence.ts:45` *(non passé au réfuteur)*
- [ ] ⚪ `nettoyer()` n'est pas idempotent : une socket qui meurt pendant le login notifie `surPerte` deux fois — `lib/ddp.ts:552`
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 9. Session morte et fin de session : ramener au login, et tout emporter en partant

**🟠 haute** · risque de correction **ÉLEVÉ** · effort **jour** · 5 constats

> Trois trous se rejoignent sur le même symptôme : l'app reste dans un état qu'elle croit valide et l'utilisateur n'a aucun chemin de sortie. Un jeton révoqué en cours de session (mot de passe changé ailleurs, `Accounts_LoginExpiration`, `logoutOtherClients`) fait boucler le pilote de reconnexion à l'infini sur un cache d'hier, sans un message ; une déconnexion laisse sur le disque la clé privée E2EE DÉCHIFFRÉE, indexée par serveur seul, si bien que le compte suivant se croit déverrouillé et ne peut plus rien lire ; et la base SQLite avec les clairs E2E survit intacte. Je le place APRÈS les chantiers à faible risque parce que le déclenchement d'une déconnexion automatique est la correction la plus dangereuse de tout l'audit : une erreur de discrimination éjecte l'utilisateur à tort. À faire avec son test de prédicat écrit d'abord.

**Ordre.** **Écrire le prédicat `estJetonRefuse` et son test à quatre cas AVANT de le brancher.** Faire d'abord la partie clé E2EE indexée par compte, qui est sans risque.

- [ ] 🟠 Un 401 survenu EN COURS de session ne révoque jamais la session : état zombie jusqu'au redémarrage — `lib/rest.ts:280`
- [ ] 🟡 La clé privée E2EE survit à la déconnexion et est rangée par serveur seul — `ui/session.tsx:184`
- [ ] 🟡 La déconnexion laisse sur le disque la base SQLite entière, clairs E2E compris — `ui/session.tsx:170` *(non passé au réfuteur)*
- [ ] 🟡 Trois stores module-level ne sont jamais purgés en fin de session — `ui/reponse.ts:31` *(non passé au réfuteur)*
- [ ] 🟡 Après une déconnexion hors ligne, le jeton reste enregistré côté serveur — `ui/session.tsx:178` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 10. Push natif : doublons, deep-link multi-serveur, hygiène du service

**🟠 haute** · risque de correction **moyen** · effort **plusieurs-jours** · 8 constats

> Tout ce chantier est du Kotlin injecté par un config plugin : ni tsc ni les 460 tests ne le voient, et chaque itération coûte `expo prebuild` + `assembleRelease` (statut testé SANS pipe). Il faut donc le traiter en un seul passage, pas au fil de l'eau. Le plus grave est vérifié : le garde anti-doublon du commit 249887e ne couvre qu'un sens de la course, si bien que le worker de rattrapage et la relivraison FCM — réveillés par le MÊME événement, le retour du réseau — ajoutent deux fois le même message dans la conversation. Le deep-link ignore par ailleurs la dimension multi-serveur que l'app supporte pourtant, ce qui donne un spinner définitif.

**Ordre.** Un seul passage, un seul cycle `expo prebuild` + `assembleRelease` (statut testé **sans pipe**). Y embarquer la validation d'hôte du chantier 3.

- [ ] 🟠 Le garde anti-doublon ne couvre pas le cas « le worker a déjà posté » — `plugins/with-fcm-deeplink.js:249`
- [ ] 🟡 Le deep-link de notification ne porte pas le serveur : spinner définitif en multi-serveur — `plugins/with-fcm-deeplink.js:465`
- [ ] 🟡 Aucune notification n'est retirée quand le salon est lu — `ui/notifications.tsx:118` *(non passé au réfuteur)*
- [ ] 🟡 Le `push.get` bloquant peut coûter 16 s (32 s en debug) sur le thread de dispatch FCM — `plugins/with-fcm-deeplink.js:663` *(non passé au réfuteur)*
- [ ] ⚪ Un 401 sur `push.get` déclenche huit tentatives WorkManager vouées à l'échec, par notification — `plugins/with-fcm-deeplink.js:667` *(non passé au réfuteur)*
- [ ] 🟡 Les chaînes de la voie native sont en français en dur alors que l'app est intégralement EN/FR — `plugins/with-fcm-deeplink.js:414` *(non passé au réfuteur)*
- [ ] ⚪ La rotation du jeton FCM n'est jamais écoutée — `ui/synchro.tsx:333` *(non passé au réfuteur)*
- [ ] ⚪ La chirurgie de configuration du plugin (JS pur) n'a aucun test — `plugins/with-fcm-deeplink.js:737` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 11. Écrans : boucles sans borne, attentes fixes, coûts natifs inutiles

**🟡 moyenne** · risque de correction **faible** · effort **jour** · 9 constats

> Quatre défauts d'écran qui coûtent du réseau, de la batterie ou de la confiance : une pagination qui peut boucler indéfiniment sur `channels.history` quand les plus vieux messages partagent une milliseconde, un `subscriptions.read` toutes les 2 s dans un salon animé (30/min sur une route à 10/min), un ExoPlayer + MediaSession + Visualizer alloué et un fichier téléchargé par message vocal SIMPLEMENT VISIBLE — l'inverse exact de la décision écrite dans ui/lecteurVideo.tsx — et un défilement après envoi calé sur `setTimeout(250)`, c'est-à-dire le correctif par temps d'attente que la règle permanente du projet interdit. Toutes les corrections sont locales à un écran ou un composant.

**Ordre.** Après le chantier 5, qui touche déjà `app/salon/[rid].tsx`.

- [ ] 🟡 Le critère « passé épuisé » (`n > 1`) boucle indéfiniment si les plus vieux messages partagent la même milliseconde — `app/salon/[rid].tsx:522` *(non passé au réfuteur)*
- [ ] 🟡 Le débounce de `marquerLu` borne les rafales mais pas la CADENCE : 30 POST/min sur une route à 10/min — `app/salon/[rid].tsx:284` *(non passé au réfuteur)*
- [ ] 🟡 Chaque message vocal MONTÉ crée un ExoPlayer et télécharge son fichier, même sans lecture — `ui/lecteurAudio.tsx:208` *(non passé au réfuteur)*
- [ ] 🟡 Le défilement après envoi dans un fil repose sur un délai fixe de 250 ms — `app/fil/[id].tsx:258` *(non passé au réfuteur)*
- [ ] 🟡 Le navigateur d'emojis fige la liste des emojis personnalisés au montage alors qu'il ne se démonte plus jamais — `ui/navigateurEmoji.tsx:228` *(non passé au réfuteur)*
- [ ] ⚪ Le garde-fou de rendu markdown ne se réarme jamais — `ui/markdown.tsx:56` *(non passé au réfuteur)*
- [ ] 🟡 Les réactions sont envoyées au serveur mais jamais affichées ni retirables — `app/actions-message.tsx:253` *(non passé au réfuteur)*
- [ ] ⚪ Effets de bord exécutés à l'intérieur d'un updater de setState — `ui/navigateurEmoji.tsx:131` *(non passé au réfuteur)*
- [ ] ⚪ Deux écrans appliquent un état optimiste sans séquencement — `app/parametres.tsx:89` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 12. Filet de test là où le code n'est pas atteignable

**🟡 moyenne** · risque de correction **nul** · effort **jour** · 5 constats

> La couverture du dépôt est au-dessus de la moyenne, mais elle s'arrête à une frontière nette : ce qui touche la plateforme (db/depot.ts, lib/server.ts, ui/brouillons.ts, les plugins) et tout `app/` (5 400 lignes, zéro test). Deux points sont pires qu'un simple trou : les faux dépôts MENTENT — leur `transaction: (fn) => fn(depot)` efface l'invariant d'interblocage que db/depot.ts a payé en crash réel — et la crypto E2EE n'est éprouvée que contre `node:crypto`, jamais contre quick-crypto, qui est l'implémentation réellement embarquée. Risque de régression nul par construction : ce chantier ne modifie pas de code de production, et il conditionne le découpage de l'écran salon.

**Ordre.** Risque nul par construction : ne modifie aucun code de production. **Impératif avant le chantier 14.**

- [ ] 🟡 Les faux dépôts exposent le dépôt COMPLET dans `transaction`, ce qui rend indétectable l'interblocage file/transaction — `lib/sync.test.ts:274` *(non passé au réfuteur)*
- [ ] 🟡 La crypto E2EE n'est éprouvée que contre `node:crypto` ; quick-crypto n'est couvert par rien — `lib/e2e/crypto.ts:27` *(non passé au réfuteur)*
- [ ] 🟡 `lib/server.ts` n'a aucun test alors qu'il commande tout l'écran de connexion — `lib/server.ts:58` *(non passé au réfuteur)*
- [ ] 🟡 Le débounce et le flush de sortie d'écran des brouillons ne sont testés nulle part — `ui/brouillons.ts:104` *(non passé au réfuteur)*
- [ ] 🟡 Les logiques pures de l'écran salon et de l'accueil sont enfouies dans des composants, donc intestables — `app/salon/[rid].tsx:295` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 13. Une seule source par concept : i18n, couleurs, formats, tables MIME

**🟡 moyenne** · risque de correction **faible** · effort **jour** · 6 constats

> Le commit 4dc5df6 a migré toute l'app vers `t()` — mais quatre îlots ont été manqués et sont invisibles au test de parité FR/EN, puisqu'ils ne sont pas dans le catalogue : l'heure de chaque message formatée en `fr-FR` en dur, l'indicateur de saisie (« bob écrit… »), les messages d'erreur de lib/profilPreload.ts et lib/envoiFichiers.ts qui remontent tels quels à l'écran. Un utilisateur en anglais voit donc des phrases françaises dans une interface anglaise. S'y ajoutent trois définitions concurrentes des couleurs de présence (avec trois teintes différentes pour le même statut) et deux tables MIME→emoji déjà divergentes. Risque faible, gain de cohérence immédiat, et cela prépare le découpage du composer.

**Ordre.** Prépare le composer partagé du chantier 14.

- [ ] 🟡 L'heure des messages est formatée en `fr-FR` codé en dur, et l'indicateur de saisie est en français hors catalogue — `ui/ligneMessage.tsx:66` *(non passé au réfuteur)*
- [ ] 🟡 Des messages d'erreur affichés à l'utilisateur sont en français en dur, en doublon de clés existantes — `lib/profilPreload.ts:125` *(non passé au réfuteur)*
- [ ] 🟡 Trois définitions concurrentes des couleurs de présence, avec trois valeurs différentes par statut — `ui/presence.ts:14` *(non passé au réfuteur)*
- [ ] ⚪ Deux tables MIME→emoji, déjà divergentes sur le cas audio — `ui/apercuPieceJointe.tsx:34` *(non passé au réfuteur)*
- [ ] ⚪ Le corps des messages markdown ne porte aucune famille de police — `ui/markdown.tsx:306` *(non passé au réfuteur)*
- [ ] ⚪ Les composants médias codent en dur des couleurs sombres, ce qui invalide la promesse « trois retouches » du thème — `ui/visionneuse.tsx:240` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 14. Duplication structurelle et découpage de l'écran salon

**🟡 moyenne** · risque de correction **moyen** · effort **plusieurs-jours** · 7 constats

> Trois copier-collers ont déjà coûté ou coûteront un correctif écrit deux fois : `rattraperMisAJour` / `rattraperSupprimes` (le commit ffe1f7c a dû appliquer le MÊME correctif de curseur dans deux hunks du même commit), le composer salon / composer fil (le fil n'a pas la fermeture du clavier avant sélecteur qui corrige le NPE d'arbre de vues, il la reproduira le jour où il gagne les pièces jointes), et le débounce des deux écrans de recherche (déjà divergé). Ajouter à cela l'écran salon à 1 397 lignes, dont deux composants se déplacent SANS RISQUE (props uniquement, stores module-level) et le ramènent à ~450 lignes. Placé en fin de séquence délibérément : c'est du refactor pur, donc à faire quand les tests des chantiers précédents sont en place et qu'aucune correction fonctionnelle n'est en vol dans ces fichiers.

**Ordre.** Refactor pur. Après 12 et 13, et quand aucune correction fonctionnelle n'est en vol dans ces fichiers. Commencer par les déplacements sans risque ; **laisser le moteur de liste tranquille**.

- [ ] 🟡 `app/salon/[rid].tsx` mélange trois responsabilités sur 1 397 lignes ; deux sont extractibles sans aucun risque — `app/salon/[rid].tsx:161` *(non passé au réfuteur)*
- [ ] 🟡 Le composer du fil est une copie divergée du composer du salon — `app/fil/[id].tsx:330` *(non passé au réfuteur)*
- [ ] 🟡 `rattraperMisAJour` et `rattraperSupprimes` sont deux copies de la même boucle de pagination — `lib/rattrapage.ts:227`
- [ ] 🟡 Débounce + garde de séquence recopiés entre les deux écrans de recherche — `app/recherche.tsx:85` *(non passé au réfuteur)*
- [ ] 🟡 « Ouvrir ou créer un DM » est implémenté deux fois, avec deux traitements différents de la réponse — `app/profil.tsx:180` *(non passé au réfuteur)*
- [ ] ⚪ Le rendu des images de pièce jointe est écrit deux fois dans le même fichier, avec des bornes différentes — `ui/ligneMessage.tsx:355` *(non passé au réfuteur)*
- [ ] ⚪ Code mort : `couleursClaires` et cinq clés de traduction inutilisées — `ui/theme.ts:141` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 15. La façade Fournisseur : ce qui nomme Rocket.Chat doit passer par elle

**🟡 moyenne** · risque de correction **moyen** · effort **jour** · 4 constats

> L'abstraction est propre et exhaustive sur la synchro et les actions, mais elle est court-circuitée exactement là où elle compte : l'écran salon importe `rattraperSalon` de lib/rattrapage.ts, nomme trois endpoints REST (`channels/groups/im.history`) et fabrique lui-même les clés de stream `${rid}/deleteMessage` et `${rid}/user-activity`. Il existe donc DEUX chemins pour le même rattrapage, l'un routé, l'autre codé en dur — et le format de clé Rocket.Chat est dupliqué dans deux écrans plus `sujetDe`. Gain purement structurel, aucun bug utilisateur aujourd'hui : à faire en dernier, quand le découpage de l'écran salon a déjà déplacé `cheminHistorique`.

**Ordre.** Prolongement du chantier 5 et du découpage 14.

- [ ] 🟡 L'interface `Fournisseur` n'a pas de couture pour les abonnements PAR SALON — `lib/fournisseur.ts:208` *(non passé au réfuteur)*
- [ ] 🟡 L'écran salon contourne la façade en appelant l'implémentation Rocket.Chat en direct — `app/salon/[rid].tsx:44` *(non passé au réfuteur)*
- [ ] 🟡 Le permalien de citation est bâti sur `client.baseUrl` alors que le serveur n'accepte que `Site_Url` — `lib/citation.ts:21` *(non passé au réfuteur)*
- [ ] ⚪ `lib/`, déclaré « cœur non-UI », pilote la navigation — `lib/profilPreload.ts:22` *(non passé au réfuteur)*
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

## 16. Remettre la documentation d'accord avec le code

**🟡 moyenne** · risque de correction **nul** · effort **heures** · 2 constats

> CLAUDE.md désigne EXECUTION.md comme « source de vérité sur où on en est » et ce fichier a 110 commits de retard : ni l'E2EE en lecture, ni les appels Jitsi, ni l'i18n, ni les citations, ni la façade multi-fournisseur, ni les caches de salon n'y figurent — et sa table d'avancement affirme que l'étape 9 est iOS alors que le corps du document dit thème. Symétriquement, ROADMAP.md §4.2, EXECUTION.md:52 et CLAUDE.md:50 déclarent la WebView « interdit ferme » alors que react-native-webview est une dépendance ordinaire et que l'écran d'appel la monte en plein écran — au point que ui/carteEmbed.tsx cite comme autorité la section que l'écran d'appel viole. Risque nul, coût d'une heure, et cela évite qu'une session future réimplémente ou supprime du travail livré.

**Ordre.** En dernier, pour décrire l'état réel plutôt qu'un état intermédiaire.

- [ ] 🟡 EXECUTION.md, déclaré source de vérité, a 110 commits de retard et sa table renumérote les étapes à faux — `EXECUTION.md:77`
- [ ] 🟡 La WebView de l'écran d'appel n'est consignée dans aucun des trois documents qui la déclarent interdite — `ROADMAP.md:150`
- [ ] **Sortie du chantier** : `tsc` propre, suite verte, et lancement réel sur le Pixel

---

## À ne pas toucher

Signalé pendant l'audit, puis écarté. Ces lignes sont là pour qu'on ne les redécouvre pas dans six mois.

- **La double lecture de `raccorder` (lib/raccordement.**ts:89 et 104, deux `rattraperTout` par raccordement). Le constat est réel — 2 x rooms.get + 2 x subscriptions.get à chaque retour au premier plan, sur une route à 10 req/min — mais la seconde lecture est CE qui garantit qu'aucun document ne tombe entre la lecture et l'armement des souscriptions. La rendre conditionnelle touche le cœur du raccordement, sans test de non-régression aujourd'hui. À reprendre seulement après le chantier « rattrapage dédupliqué » (qui supprime déjà l'essentiel du gaspillage) ET une fois lib/raccordement.test.ts étendu.

- **Le découplage de l'effet `SynchroProvider` d'avec l'objet `etat` (clé `baseUrl|userId|authToken` en dépendance).** Proposé par deux relecteurs, contredit par un troisième après vérification : `TraducteurRC` et `MoteurEnvoi` capturent `session.username` à la construction (fournisseurs/rocketchat/index.ts:40), donc figer la clé casse le nom affiché et `dmAutreUsername` des DM après un renommage. Le vrai correctif (mémoïser la file d'écritures avec la connexion) supprime le danger sans toucher aux dépendances ; la reconstruction gratuite du moteur sur renommage devient alors un simple gaspillage, à traiter plus tard avec un traducteur qui relit son pseudo.

- **Les 24 erreurs eslint react-hooks/immutability et refs de ui/visionneuse.**tsx et ui/lecteurAudio.tsx. Vérifié : ce sont des écritures de `SharedValue` dans des worklets de geste, c'est-à-dire l'API normale de Reanimated que la règle (modèle React Compiler) ne modélise pas. `remettreAPlat` porte bien sa directive `'worklet'`. Le seul cas litigieux, `moi.current.pause = …` écrit pendant le rendu, est bénin (le coordinateur compare l'identité de l'objet, jamais la closure). Y toucher ne ferait qu'ajouter des indirections.

- **L'idiome « liste inversée + maintainVisibleContentPosition coupé » et le lissage des entrants de app/salon/[rid].**tsx (commentaire l.74-99), ainsi que la clé de tri secondaire `desc(messages.id)`. Ce sont des cicatrices mesurées, pas des bizarreries ; le découpage du fichier ne doit toucher ni au moteur de liste ni à ces réglages.

- **Le `setTimeout` de ui/lancerSelecteur.**ts. C'est le seul délai fixe du dépôt qui soit explicitement argumenté (NPE d'arbre de vues Android au lancement d'un sélecteur, trois correctifs successifs : c9e6694, e06f658, ad8ecec). La règle « pas d'attente comme correctif » vise les synchronisations de données, pas les contournements de bug de plateforme documentés.

- **`fermerBase` (db/client.**ts:45) : ne PAS l'appeler dans le cleanup de `SynchroProvider`. La connexion est partagée et le cleanup court pendant que des écritures de l'ancien moteur peuvent encore être en vol — fermer sous elles est pire que de laisser la connexion ouverte. Le bon geste est de documenter le choix dans db/client.ts et de filtrer `databaseName` dans ui/requeteVive.ts (constat retenu), pas d'appeler la fonction.

- **L'exception WebView de app/appel/[callId].**tsx. Le SDK Jitsi natif vise RN ~0.79 et embarque react-native-webrtc : l'exception est justifiée et doit rester. Ce qu'il faut, c'est la consigner dans ROADMAP §4.2 et la borner à une origine — pas la remettre en cause.

- **`Push_request_content_from_server` (push sans contenu, `push.**get` à la réception). C'est une décision utilisateur datée (2026-07-16 : rien chez Google/Apple). Tous les constats push doivent composer avec, jamais proposer de la lever.

- **Ne pas passer d'`_id` client à `rooms.**mediaConfirm` pour dédupliquer les uploads : le schéma serveur est `additionalProperties: false`. La déduplication doit passer par la persistance du `fileId` côté client, comme retenu dans le chantier téléversements.

- **Ne pas retirer l'appui long de app/salon/[rid].**tsx:584 et app/fil/[id].tsx:245 pour régler la feuille d'actions vide : ce serait la même règle dupliquée dans deux écrans, et cela supprimerait le retour haptique qui confirme que l'appui a pris. Le repli se fait dans app/actions-message.tsx.


Les **7 constats réfutés** (dont deux « zombies DDP » démolis en descendant jusqu'à
`RuntimeScheduler_Modern.cpp`) sont consignés en fin de `docs/AUDIT.md`, avec le raisonnement complet.

---

## Relevé APRÈS l'audit

Ce que l'audit n'avait pas vu, trouvé en exécutant. `docs/AUDIT.md` est figé — les constats
postérieurs s'ajoutent ici.

- [ ] 🟠 **Une fiche profil AVEC bio pousse « Message » et « Appeler » hors de l'écran : les deux actions deviennent inatteignables.** Vu sur le Pixel le 2026-07-26, en validant le chantier 1. La sheet est en `sheetAllowedDetents: 'fitToContents'` (`app/_layout.tsx:128`) ; sur un profil sans bio (`rocket.cat`) les deux boutons s'affichent normalement, sur un profil qui en a une (`@bernard` : nom, rôle `admin`, heure locale, bio) la feuille s'arrête au bas de l'écran, la bio est coupée en cours de ligne et les boutons sont dessous, hors champ. La feuille ne défile pas (pas de `ScrollView`) et tirer son bord la referme — donc aucun geste ne les ramène. La bio est pourtant bornée (`numberOfLines={4}`, `app/profil.tsx:315`) et préchargée avant navigation (`lib/profilPreload.ts`), donc la première frame est déjà complète : c'est la mesure `fitToContents` qui n'a pas suivi, pas une arrivée tardive de contenu. À instruire avant de corriger — vérifier si react-native-screens plafonne le detent mesuré sur Android.
