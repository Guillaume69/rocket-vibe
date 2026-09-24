# AUDIT — état des lieux de la codebase

*Relevé du 25 juillet 2026, sur `b7a73f1`. 141 fichiers, 27 300 lignes.*

Produit par un audit en éventail : 14 relecteurs (10 par sous-système, 4 transverses), chaque constat de sévérité haute ou critique passé ensuite devant un réfuteur adversarial dont la consigne était de le démolir. **122 constats bruts, 7 réfutés, 115 retenus.**

La consigne qui a présidé au classement est *zéro régression* : un chantier à fort gain et risque nul passe avant un chantier à gain moyen et risque élevé.

Référence d'état à la date du relevé : `tsc` sort 0, 460 tests passent, `eslint` sort 24 erreurs analysées et écartées (voir « À ne pas toucher »).

---

## L'état général

La codebase est en bonne santé, et c'est un jugement, pas une politesse : tsc sort 0, 460 tests passent, tout le SQL vit dans un seul fichier et s'exécute tel quel sur `node:sqlite` migré, le client DDP maison gère correctement le comptage de références, la survie des souscriptions désirées à travers une coupure et l'ordonnancement du raccordement sur un signal plutôt qu'un délai, et les commentaires expliquent presque toujours le POURQUOI d'un choix contre-intuitif — souvent avec une mesure à l'appui (les 3-4 s de `chat.syncMessages?type=UPDATED` sur le serveur cible, l'absence d'ETag sur `/avatar`, le NPE d'arbre de vues au lancement d'un sélecteur). Je n'ai trouvé aucune corruption d'écriture, aucune requête non paramétrée, aucun secret commité, et pratiquement aucun `setTimeout` utilisé comme béquille de synchronisation. Les défauts ne sont donc pas dans les algorithmes : ils sont aux JOINTURES et dans les CYCLES DE VIE. Trois motifs reviennent partout. (1) Ce qui se crée à la session ne se détruit pas : la clé privée E2EE déchiffrée survit à la déconnexion et n'est même pas indexée par compte, la base SQLite avec les clairs E2E reste sur le disque, cinq stores module-level ne sont jamais purgés, les curseurs de rattrapage survivent aux messages qu'ils décrivent, et la purge de salon ne connaît que trois tables sur huit. (2) Un même invariant est gardé à un endroit et pas à l'autre : le garde anti-empilement du rattrapage vit dans le provider mais l'écran appelle la même fonction en direct, la garde de schéma d'URL existe dans le markdown mais pas dans les cartes de lien, la file d'écritures protège trois dépôts mais pas les brouillons, le 401 est traité au démarrage à froid et nulle part ailleurs. (3) Le chemin FICHIER n'a reçu aucune des trois cicatrices que le chemin TEXTE a acquises — pas d'identifiant client, pas de confirmation après échec, pas d'objet optimiste — d'où à la fois un risque de doublon et une disparition silencieuse. Un seul constat est critique et il est vérifié : le `rc_token` part dans la barre d'adresse de Chrome dès qu'on touche une pièce jointe « fichier ». Enfin, EXECUTION.md, désigné source de vérité, a 110 commits de retard.

---

## Les chantiers, dans l'ordre d'attaque conseillé

| # | Chantier | Sévérité max | Risque de correction | Effort | Constats |
|---|---|---|---|---|---|
| 1 | Le lot d'une ligne — corrections locales, vérifiées, à régression quasi nulle | 🟠 haute | faible | heures | 9 |
| 2 | Une file d'écritures par CONNEXION SQLite (et les brouillons dedans) | 🟡 moyenne | faible | heures | 3 |
| 3 | Zéro secret hors du processus | 🔴 critique | moyen | jour | 4 |
| 4 | Ce qui entre en base doit être juste : normalisation, aperçus, clés E2EE | 🟡 moyenne | faible | jour | 6 |
| 5 | Rattrapage de salon : un seul par salon, des caches qui ne mentent pas | 🟡 moyenne | moyen | jour | 5 |
| 6 | Cycle de vie de la donnée locale : purge, curseurs, rétention | 🟡 moyenne | moyen | jour | 4 |
| 7 | File de téléversements : ni doublon, ni disparition silencieuse | 🟠 haute | moyen | plusieurs-jours | 7 |
| 8 | Transport DDP et REST : ne pas tuer une socket saine, ne pas dormir sans écouter | 🟡 moyenne | moyen | jour | 6 |
| 9 | Session morte et fin de session : ramener au login, et tout emporter en partant | 🟠 haute | ÉLEVÉ | jour | 5 |
| 10 | Push natif : doublons, deep-link multi-serveur, hygiène du service | 🟠 haute | moyen | plusieurs-jours | 8 |
| 11 | Écrans : boucles sans borne, attentes fixes, coûts natifs inutiles | 🟡 moyenne | faible | jour | 9 |
| 12 | Filet de test là où le code n'est pas atteignable | 🟡 moyenne | nul | jour | 5 |
| 13 | Une seule source par concept : i18n, couleurs, formats, tables MIME | 🟡 moyenne | faible | jour | 6 |
| 14 | Duplication structurelle et découpage de l'écran salon | 🟡 moyenne | moyen | plusieurs-jours | 7 |
| 15 | La façade Fournisseur : ce qui nomme Rocket.Chat doit passer par elle | 🟡 moyenne | moyen | jour | 4 |
| 16 | Remettre la documentation d'accord avec le code | 🟡 moyenne | nul | heures | 2 |

### 1. Le lot d'une ligne — corrections locales, vérifiées, à régression quasi nulle

**Sévérité max** 🟠 haute · **risque de correction** faible · **effort** heures

Sept défauts dont deux de sévérité haute se corrigent chacun en trois lignes ou moins, dans un seul fichier, sans toucher à un chemin partagé. Aujourd'hui ils coûtent : plus aucune notification de la session quand les Play Services répondent mal au premier raccordement, un rechargement complet de l'historique à chaque bascule E2EE, du texte utilisateur détruit, des photos postées en double, une feuille d'actions vide sur tout un salon chiffré. Vu le maître mot (zéro régression), ce lot passe avant tout le reste : gain immédiat, surface minuscule, et deux d'entre eux (la génération E2E, la garde d'upload) débloquent des chantiers ultérieurs.

#### 🟠 haute — Un échec d'obtention du jeton FCM arme quand même le drapeau : plus aucune notification pour toute la session

`ui/synchro.tsx:333` · ✅ vérifié · risque de correction : faible

Vérifié sur le code : `jetonPushEnregistre = true` est posé AVANT l'appel, et `obtenirJetonFcm()` (lib/push.ts:22-45) ne REJETTE jamais — son catch interne rend `{ok:false, raison:'echec'}`. Le `.then((r) => (r.ok ? enregistrerJeton(...) : undefined))` traverse donc sans rejet, le `.catch` qui désarme le drapeau ne part pas, et le jeton n'est plus jamais posté de la session. Le commentaire juste au-dessus promet pourtant « un échec sera retenté au prochain raccordement ».

**Correction.** Traiter le RÉSULTAT et non le seul rejet : `if (!r.ok) { if (r.raison === 'echec') jetonPushEnregistre = false; return; }`. Ne PAS désarmer sur `permission-refusee` — cela rejouerait le prompt système à chaque raccordement.

#### 🟡 moyenne — `generation` est bumpée par les transitions E2EE, ce qui refait partir historique et rattrapage sans qu'aucune connexion n'ait été perdue

`ui/synchro.tsx:211` · ✅ vérifié · risque de correction : faible

Vérifié : `rafraichirE2E` fait `{...s, generation: s.generation + 1}` uniquement pour forcer un re-rendu, alors que `generation` est le critère de validité de `ui/salonsCharges.ts` et `ui/salonChaud.ts` (« la connexion a-t-elle tenu ? ») et une dépendance des effets d'ouverture de app/salon/[rid].tsx:495 et app/fil/[id].tsx:197. Au démarrage sur un compte dont la clé est au Keystore, `e2e.reprendre()` suffit à relancer un `channels.history?count=50` complet plus un `chat.syncMessages` (3-4 s pour zéro document sur un gros salon) — pour zéro donnée nouvelle.

**Correction.** Une ligne : `setSynchro((s) => (s.phase === 'pret' ? { ...s } : s))`. Le re-rendu tient au changement d'IDENTITÉ de la valeur de contexte (`useContext` compare par `Object.is`), pas à la valeur du compteur. Variante nommée si l'on craint une future mémoïsation : un champ `revisionE2E` distinct.

#### 🟡 moyenne — Le texte tapé PENDANT un téléversement est effacé à la fin de l'envoi — un correctif de 8.7 a été perdu

`app/salon/[rid].tsx:813` · ✅ vérifié · risque de correction : faible

Le `.then` de la branche pièce jointe fait `setBrouillon('')` + `effacerBrouillon()` + `annulerReponse(rid)` inconditionnellement, alors que le TextInput reste éditable pendant tout l'upload (seuls 📎/➤/🎤 sont grisés). Le commit 781bc19 avait précisément corrigé ce point par une mise à jour fonctionnelle (« ce qui a été tapé pendant l'envoi n'est ni la légende partie, ni à jeter », consigné EXECUTION.md §8.7) ; le commit 30e1c85 l'a remplacé par un vidage sec. `effacerBrouillon()` détruit en plus la ligne persistée : le texte n'est pas récupérable au retour dans le salon.

**Correction.** Tenir une `brouillonRef` à jour dans un effet et ne solder que si `brouillonRef.current === brouillon` (le texte capturé à l'appui). Regrouper `annulerReponse(rid)` sous la même garde. Remettre EXECUTION.md:324 en accord avec le code.

#### 🟡 moyenne — Écran de partage : un refus de validation en milieu de boucle renvoie en double les pièces déjà envoyées

`app/partager.tsx:217` · ✅ vérifié · risque de correction : faible

`partagerVers` boucle `for … await fichiers.envoyer(...)` ; une `ErreurValidation` (taille/type refusés) sort de la boucle, le catch affiche l'erreur et relâche les verrous, mais `pieces` n'est jamais amputé de ce qui est déjà parti. L'utilisateur retire la pièce fautive, retape sur le salon : les deux premières photos sont postées une seconde fois.

**Correction.** Retirer la pièce de l'état à chaque itération réussie (`setPieces(prev => prev.filter(x => x.cle !== p.cle))`, et vider la légende quand elle est partie). La boucle itère le tableau capturé, retirer de l'état ne la perturbe pas. Bénéfice secondaire : progression visible.

#### 🟡 moyenne — La feuille d'actions s'ouvre VIDE sur tout message d'un salon chiffré et sur tout message système

`lib/actionsMessage.ts:46` · ✅ vérifié · risque de correction : faible

`actionsPossibles` sort avec un tableau vide dès que `typeSysteme !== null`. Or un message chiffré garde `typeSysteme = 'e2e'` même APRÈS déchiffrement (db/upserts.ts:29 ne remplit que `texte`), et ui/ligneMessage.tsx:229 le rend pourtant comme un message ordinaire. Sur `p:laprivitude` — le seul salon chiffré de la cible — et sur toutes les lignes système (`uj`, `ul`, `rm`), l'appui long vibre, la sheet monte et affiche une bande de 30 px sans un mot.

**Correction.** (1) Repli explicite dans app/actions-message.tsx quand `actions.length === 0` (clé `actionsMessage.aucuneAction` dans LES DEUX catalogues — ui/messages.test.ts vérifie la parité). (2) Rouvrir `reagir`/`supprimer`/`epingler` pour un message chiffré DÉCHIFFRÉ (`typeSysteme === 'e2e' && texte !== null`), en excluant `modifier` (chat.update poste du clair) et `repondre`. (3) Remplacer le test mort de lib/actionsMessage.test.ts:76-80 par les trois cas réels.

#### ⚪ basse — Le message d'erreur de recherche survit au vidage du champ

`app/recherche.tsx:84` · ✅ vérifié · risque de correction : nul

Vérifié : la branche `propre === ''` fait `setResultats({}); return;` sans toucher à `message`. Le bandeau rouge « Recherche impossible. » reste affiché au-dessus d'une liste vide. La branche jumelle de app/recherche-messages.tsx:77-81 fait bien `setMessage(null)` — les deux écrans, écrits sur le même idiome, ont divergé.

**Correction.** Ajouter `setMessage(null);` dans la branche vide.

#### 🟡 moyenne — L'écran de partage affiche les avatars de salon sans leur `avatarETag` : photo figée à vie par le cache Fresco

`app/partager.tsx:361` · non passé au réfuteur · risque de correction : faible

`AvatarSalon` déclare `avatarEtag` OPTIONNEL (ui/kit.tsx:212). app/index.tsx:242 et app/salon/[rid].tsx:1247 le passent, app/partager.tsx ne le passe pas (ni `chiffreDeverrouille`). `urlAvatar` n'ajoute alors aucun `?etag=`, et CLAUDE.md décrit exactement ce piège : `/avatar/room/<rid>` répond `max-age=3600` sans `ETag` HTTP, Fresco fige l'URI à vie.

**Correction.** Passer `avatarEtag={salon.avatarEtag}` et `chiffreDeverrouille`. Rendre ensuite `avatarEtag` OBLIGATOIRE (`string | null`) dans les props d'`AvatarSalon` pour que tsc signale tout futur oubli.

#### 🟡 moyenne — Depuis la fiche d'un DM, « Message » empile une SECONDE copie du salon déjà ouvert

`app/profil.tsx:196` · non passé au réfuteur · risque de correction : moyen

La pile est `[index, salon/A, profil]` ; `im.create` étant idempotent, le bouton rend le même rid puis fait `routeur.replace` — qui crée toujours une nouvelle clé de route. Deux instances de l'écran salon vivent alors sur le même rid : deux minuteries `marquerLu` (donc deux `subscriptions.read` sur une route à 10/min), deux `signalerSalonActif`, deux écouteurs de saisie, deux FlashList. Et un retour arrière semble ne rien faire.

**Correction.** `routeur.navigate({ pathname: '/salon/[rid]', params: { rid } })` : react-navigation dépile jusqu'à l'écran existant portant les mêmes params.

#### 🟡 moyenne — `ouvrirFicheProfil` n'a aucune garde de réentrance : un double tap empile deux fiches

`lib/profilPreload.ts:104` · non passé au réfuteur · risque de correction : faible

La fonction attend jusqu'à 2 s (`PLAFOND_MS`) plus 400 ms d'anti-flash avant `router.push('/profil')`, et rien n'est verrouillé pendant ce temps : `IndicateurOuvertureProfil` est monté en `pointerEvents="none"`. Deux taps → deux `push` → deux sheets à fermer. `poserBusy` étant un booléen global, le `finally` de la première exécution éteint l'indicateur alors que la seconde vole encore. Tout le reste du dépôt utilise une ref `enVol` pour ce motif (app/actions-message.tsx:175, app/recherche.tsx:70, app/profil.tsx:123).

**Correction.** Verrou de module `ouvertureEnCours` testé en tête et relâché dans le `finally`, ou compteur d'exécutions en vol pilotant aussi `poserBusy`. Garde d'état, aucun délai ajouté.

---

### 2. Une file d'écritures par CONNEXION SQLite (et les brouillons dedans)

**Sévérité max** 🟡 moyenne · **risque de correction** faible · **effort** heures

C'est la race la plus dangereuse du dépôt — deux `BEGIN` concurrents sur une même connexion, ce que db/depot.ts:64-76 documente comme mortel (« cannot rollback - no transaction is active », lot annulé en silence) — et sa correction tient en deux lignes dans db/client.ts, vérifiées, sans changement de comportement sur le chemin nominal. Rapport gain/risque imbattable : à faire tout de suite, d'autant qu'elle rend inoffensive la reconstruction du moteur de synchro sur un simple renommage, qu'on peut alors laisser en l'état.

#### 🟡 moyenne — Un changement de pseudo reconstruit toute la synchro et crée une SECONDE file d'écritures sur la même connexion SQLite

`ui/synchro.tsx:424` · ✅ vérifié · risque de correction : faible

L'effet de `SynchroProvider` dépend de l'OBJET `etat` (l.424) ; `majProfilSession` (ui/session.tsx:190-200, appelé après un renommage) et la reprise au démarrage produisent un objet neuf pour le même serveur, le même compte, le même jeton. L'effet se rejoue donc en entier et crée un `creerFileEcritures()` (l.159) — alors que `ouvrirBase` mémoïse la connexion par fichier (db/client.ts:23-42) et que `fermerBase` n'est jamais appelée. Deux files indépendantes sérialisent alors sur une seule connexion, pendant que les écritures en vol de l'ancien moteur (historique, outbox, uploads) reviennent du réseau.

**Correction.** Faire porter la file par la CONNEXION : `const paire = { brute, base: drizzle(...), fileEcritures: creerFileEcritures() }` dans la Map `ouvertes` de db/client.ts, et `const { base, brute, fileEcritures } = ouvirBase(...)` dans ui/synchro.tsx (supprimer l'appel local, seul appelant de `creerFileEcritures`). No-op strict en nominal ; en cas de recouvrement, les deux moteurs se sérialisent au lieu de s'entrelacer.

#### 🟡 moyenne — Les brouillons écrivent hors de la file, donc à l'intérieur des transactions de synchro

`ui/brouillons.ts:60` · non passé au réfuteur · risque de correction : faible

`useBrouillon.ecrire` construit un `insert().onConflictDoUpdate()` / `delete()` Drizzle et le lance directement sur la connexion partagée, hors `FileEcritures` — le seul chemin d'écriture du dépôt à le faire, et le seul SQL qui ne vit pas dans db/upserts.ts (donc qu'aucun test n'exécute). `withTransactionAsync` d'expo-sqlite n'est PAS exclusif (node_modules/expo-sqlite/build/SQLiteDatabase.js:99) : le débounce de 400 ms qui tombe pendant l'ingestion d'une page de 50 messages fait entrer l'INSERT dans le `BEGIN` du lot, et un échec du lot annule le brouillon sans que personne ne le sache. Les deux issues de la promesse sont en plus avalées (l.70).

**Correction.** `creerDepotBrouillons(brute, enSerie)` dans db/depot.ts avec `UPSERT_BROUILLON` / `SUPPRIMER_BROUILLON` dans db/upserts.ts (donc couverts par db/upserts.test.ts), fourni à `useBrouillon` à la place de la `BaseLocale` brute.

#### ⚪ basse — `useRequeteVive` ne filtre pas les événements par base, et les connexions des comptes visités ne sont jamais fermées

`ui/requeteVive.ts:79` · non passé au réfuteur · risque de correction : faible

`addDatabaseChangeListener` d'expo-sqlite est global à toutes les bases ouvertes, mais le listener ne compare que `tableName` et ignore `databaseName`. Le filtrage n'est correct que grâce à l'invariant, écrit nulle part, qu'une seule base est vivante — invariant que `fermerBase` (db/client.ts:45, aucun appelant) ne garantit justement pas : chaque couple (serveur, compte) visité laisse une connexion ouverte avec son change-listener actif.

**Correction.** Ajouter le test `databaseName` au listener, et documenter explicitement dans db/client.ts que les connexions sont gardées pour la vie du process (ne PAS appeler `fermerBase` dans un cleanup, voir « à ne pas toucher »).

---

### 3. Zéro secret hors du processus

**Sévérité max** 🔴 critique · **risque de correction** moyen · **effort** jour

Un `rc_token` Rocket.Chat vaut le compte entier (lecture de tous les salons, envoi, changement de profil) et il part aujourd'hui dans la barre d'adresse de Chrome — donc dans son historique, synchronisé vers le compte Google — dès qu'on touche une pièce jointe « fichier ». C'est le seul constat critique de tout l'audit et il est vérifié. Les trois autres fuites du chantier (schéma d'URL non gardé, WebView d'appel sans verrou d'origine, hôte push non validé) partagent le même invariant : ce qui sort du processus doit être choisi par nous, pas par le contenu reçu. Corrections locales, aucune touche à la synchro ni à la base.

#### 🔴 critique — Le jeton d'authentification est remis au navigateur système quand on ouvre une pièce jointe « fichier »

`ui/ligneMessage.tsx:561` · ✅ vérifié · risque de correction : moyen

Vérifié dans le code : la branche `title_link` fait `urlFichierProtege(client, jointe.title_link)` (qui colle `rc_uid` et `rc_token` en query, lib/upload.ts:136-141) puis `Linking.openURL(url)` — un intent VIEW. L'URL complète, jeton compris, atterrit dans Chrome, son historique et sa synchronisation, et est offerte à toute application qui déclare gérer https. ui/visionneuse.tsx pose pourtant l'invariant inverse en tête de fichier, et l'image comme la vidéo le respectent en gardant l'URL en mémoire. Seule cette branche sort du processus ; rien dans ROADMAP.md ne justifie l'exception.

**Correction.** Télécharger avec `expo-file-system/legacy` (déjà en dépendance) puis ouvrir le fichier LOCAL via `expo-sharing` (le module pose son propre FileProvider, aucun config plugin). Assainir le nom de destination (`[A-Za-z0-9._-]`, refuser `..` et `/` — il vient d'autrui). Ne PAS basculer sur des en-têtes `X-Auth-Token` : le middleware de fichiers protégés s'authentifie par query/cookie, ce serait un 403 déguisé en correctif. Filet d'attente acceptable si l'on ne veut pas embarquer expo-sharing tout de suite : désactiver l'ouverture quand `client.identifiants !== null`. Verrouiller par un test : aucune chaîne contenant `rc_token` ne doit jamais atteindre `Linking.openURL`.

#### 🟡 moyenne — Une carte d'aperçu de lien ouvre l'URL du serveur sans garde de schéma, alors que le markdown en pose une

`ui/carteLien.tsx:159` · non passé au réfuteur · risque de correction : faible

`Linking.openURL(apercu.url)` sur une chaîne qui vient telle quelle de `message.urls`, stockée brute (lib/normaliser.ts:159) et projetée sans validation de schéma (lib/apercuLien.ts:172 ne teste que `typeof === 'string'`). ui/markdown.tsx:32-37 traite exactement la même classe de donnée et pose `/^https?:\/\//i` avec le commentaire « javascript:, intent:, file: restent lettre morte ». Même trou sur `estImage` (l.73-80), qui laisse un `file:///…jpg` s'afficher dans le fil. lib/apercuLien.test.ts n'a aucun cas de schéma non-http.

**Correction.** Extraire la garde de ui/markdown.tsx dans `lib/lienExterne.ts` et l'appeler depuis carteLien.tsx, carteEmbed.tsx et la branche fichier de ligneMessage.tsx. Filtrer aussi à la source dans lib/apercuLien.ts (n'émettre un aperçu que si `url` et `image` sont en https?), avec le cas de test correspondant.

#### 🟡 moyenne — La WebView d'appel accorde caméra et micro à n'importe quelle origine https

`app/appel/[callId].tsx:188` · non passé au réfuteur · risque de correction : faible

L'app détient CAMERA et RECORD_AUDIO au moment où la WebView tourne (`demanderCameraMicro`, l.38-41), donc react-native-webview répond `onPermissionRequest` sans invite quelle que soit l'origine. Or le filtrage de navigation est purement scheme-based (`/^(https?|about|blob|data):/i`) avec `originWhitelist={['*']}` : toute redirection vers un https arbitraire est suivie, et la page peut ouvrir caméra et micro en silence. L'exception WebView est assumée ; elle n'est pas cantonnée à l'hôte que le serveur a désigné.

**Correction.** Extraire `new URL(u).origin` de l'URL rendue par `rejoindreConference`, la garder dans l'état, n'autoriser que cette origine plus `about:blank` dans `onShouldStartLoadWithRequest`, et poser `originWhitelist={[origine]}`. Le cas nominal (une seule origine pour toute la conférence) n'est pas affecté.

#### 🟡 moyenne — Le jeton part vers l'hôte indiqué par le payload push quand une seule session est connue, sans vérification d'hôte

`plugins/with-fcm-deeplink.js:601` · non passé au réfuteur · risque de correction : faible

`lireSession(ctx, host)` rend l'unique session connue quand aucun `baseUrl` ne correspond au host (`if (nbCandidats == 1) repli`). Or `host` vient intégralement du payload FCM (l.219 et 262), n'est validé nulle part, et `recupererContenu` (l.656-663) construit `URL(host + "/api/v1/push.get?...")` en y posant `X-User-Id` et `X-Auth-Token`. Le commentaire vise une tolérance de FORME d'URL ; l'implémentation accepte n'importe quel domaine. Un acteur capable d'émettre vers le jeton FCM de l'appareil exfiltre le jeton de session hors de tout runtime JS, sans trace.

**Correction.** Comparer sur l'HÔTE seul (scheme + authority de `session.baseUrl` vs celui de `host`), en ignorant sous-chemin et barre finale — ce qui couvre la tolérance recherchée — et rendre `null` sinon, en journalisant le rejet. Nécessite `expo prebuild` + rebuild ; à embarquer avec le chantier push natif si l'on veut ne payer qu'un seul build.

---

### 4. Ce qui entre en base doit être juste : normalisation, aperçus, clés E2EE

**Sévérité max** 🟡 moyenne · **risque de correction** faible · **effort** jour

Cinq défauts qui écrivent une donnée fausse en SQLite — donc durable, puisque l'UI n'est qu'une projection : le pseudo d'un correspondant remplacé par le mien dans la table `utilisateurs`, l'aperçu d'un salon effacé par un message d'appel vidéo, un aperçu chiffré qui montre une réponse de fil invisible, une clé AES de salon jamais invalidée à la rotation. Toutes les corrections sont locales à des fonctions pures ou à du SQL statique, donc testables sans appareil, et lib/normaliser.ts — par où passent 100 % des documents serveur — n'a aujourd'hui que trois tests sur le `callId`. Fort gain, risque faible : à faire tôt.

#### 🟡 moyenne — `versSalon` devine le pseudo de l'autre par exclusion de `moi` : si `moi` est périmé, l'uid du correspondant reçoit MON pseudo

`lib/normaliser.ts:238` · ✅ vérifié · risque de correction : faible

Vérifié : `noms.find((u) => u !== moi) ?? (noms.length === 1 ? noms[0] : null)` ne teste jamais que `moi` figure réellement dans `usernames`. `moi` vaut `session.username`, figé à la construction de `TraducteurRC` : après un renommage depuis le web (ou avec `username: ''`, lib/auth.ts:114), le `find` retient le premier élément — moi une fois sur deux. Le résultat part directement en base : db/depot.ts:123-128 exécute `UPSERT_IDENTITE(dmAutreUid, dmAutreUsername)`, et cet upsert n'a AUCUNE garde d'horodatage. Bob s'affiche alors sous mon pseudo et avec mon avatar, en SQLite, jusqu'à ce qu'il poste un message.

**Correction.** N'apparier par exclusion que si l'exclusion est prouvée : `const jeSuisDedans = moi !== null && moi !== '' && noms.includes(moi);` puis rendre `null` quand on ne sait pas — sans coût, `UPSERT_SALON` n'écrit rien sur null (db/depot.ts:123) et l'avatar se posera au premier message.

#### 🟡 moyenne — L'aperçu de la liste des salons est EFFACÉ quand le dernier message n'a ni texte ni pièce jointe (message d'appel vidéo)

`lib/normaliser.ts:179` · non passé au réfuteur · risque de correction : faible

`apercuDuDernier` rend `null` quand `msg` est vide et qu'aucune pièce jointe ne parle — ce qui est exactement la forme du message `t: 'videoconf'` dont le contenu vit dans `blocks` (traité l.160). Or depuis 07411d9, `dernier_message` n'est plus protégé par COALESCE (db/upserts.ts:84-87) : `null` signifie délibérément « salon vidé » et écrase. Le salon remonte en tête de liste (l'horodatage, lui, est COALESCÉ l.92) mais sans une ligne de texte.

**Correction.** Ajouter un dernier repli dérivant un libellé du type système (appel vidéo → clé i18n), et distinguer les deux `null` : « pas de `lastMessage` du tout » (effacement légitime) vs « dernier message sans texte affichable ». Fixer les trois cas dans lib/normaliser.test.ts.

#### ⚪ basse — L'aperçu d'un salon chiffré peut afficher une réponse de fil ou un message système jamais visibles dans le salon

`db/upserts.ts:216` · non passé au réfuteur · risque de correction : faible

`MAJ_APERCU_CHIFFRE` fait `SELECT texte ... WHERE rid = ? AND texte IS NOT NULL ORDER BY horodatage DESC LIMIT 1`, sans le filtre `isNull(filId) OR filAffiche = true` du flux (app/salon/[rid].tsx:219), sans exclure `type_systeme`, et sans la clé de tri secondaire `id` que le flux a justement dû ajouter pour départager les ex æquo.

**Correction.** Aligner la sous-requête : `AND (fil_id IS NULL OR fil_affiche = 1) AND type_systeme IS NULL`, `ORDER BY horodatage DESC, id DESC` — aux DEUX endroits où elle est écrite (write et garde `IS NOT`), avec un test à côté du bloc « aperçu de liste d'un salon chiffré » de db/upserts.test.ts.

#### 🟡 moyenne — Une rotation de clé de salon E2EE n'est jamais prise en compte : la clé AES périmée reste en cache jusqu'au redémarrage

`lib/e2e/moteur.ts:132` · ✅ vérifié · risque de correction : faible

Vérifié dans le code : `enregistrerCleSalon` met à jour `e2eKeys` puis sort si `clesSalon.has(rid)`. Le commentaire annonce « idempotent », ce qui n'est vrai que si l'`E2EKey` ne change jamais ; `dechiffrerContenu` consulte `clesSalon` EN PREMIER. Les deux appelants sont branchés sur le flux vivant (lib/sync.ts:234 et :318), donc à la première rotation de clé (membre retiré du salon) tous les messages neufs se figent au placeholder 🔒 sans indice de cause.

**Correction.** `const ancienne = this.e2eKeys.get(rid); this.e2eKeys.set(rid, e2eKey); if (ancienne !== undefined && ancienne !== e2eKey) this.clesSalon.delete(rid);` avant la garde existante. Test à deux clés successives dans lib/e2e/moteur.test.ts (le fichier ne couvre que le cas mono-clé).

#### ⚪ basse — Le verrouillage E2EE réécrit tous les messages chiffrés, y compris ceux déjà masqués

`db/upserts.ts:199` · non passé au réfuteur · risque de correction : nul

`MASQUER_MESSAGES_CHIFFRES` = `UPDATE messages SET texte = NULL WHERE chiffre_brut IS NOT NULL`, sans `AND texte IS NOT NULL` — alors que toute la famille voisine porte cette garde avec un commentaire disant qu'elle « n'est pas cosmétique » (l.147, 184, 188, 220) : sans elle, l'écriture réveille toutes les `useLiveQuery` de la table. `reverrouillageE2E` (lib/sync.ts:180) rejoue l'opération sur un verrouillage répété.

**Correction.** Ajouter `AND texte IS NOT NULL`, et `AND dernier_message IS NOT NULL` à `MASQUER_APERCU_CHIFFRE`. Test sur `total_changes()`, modèle déjà présent (db/upserts.test.ts:536-544).

#### ⚪ basse — `versSalon`, `versAbonnement`, `versEpoch` et `apercuDuDernier` n'ont aucun test direct

`lib/normaliser.test.ts:1` · ✅ vérifié · risque de correction : nul

Le fichier ne contient qu'un `describe` de trois cas sur le `callId` d'un message d'appel. Rien ne couvre l'appariement `uids`/`usernames` explicitement documenté comme NON aligné, le repli de nom d'un DM, le DM avec soi-même, `avatarEtag` absent, les trois formes de `versEpoch`. C'est le chemin par lequel passent tous les documents serveur avant SQLite, et les deux constats ci-dessus auraient été attrapés par une table de cas.

**Correction.** Table de cas sur `versSalon` (moi présent / moi absent / DM avec soi-même / DM de groupe / salon chiffré / sans `_updatedAt` / `lastMessage` absent vs `msg: ''`) et sur `versAbonnement`. Module pur : coût d'exécution nul.

---

### 5. Rattrapage de salon : un seul par salon, des caches qui ne mentent pas

**Sévérité max** 🟡 moyenne · **risque de correction** moyen · **effort** jour

À CHAQUE raccordement — donc à chaque retour au premier plan — deux paginations identiques partent sur le salon ouvert : le provider (garde `rattrapageSalonEnVol`) et l'écran, réveillé par le bump de `generation` que ce même raccordement vient de poser, qui appelle `lib/rattrapage.ts` en direct sans consulter la garde. Jusqu'à 8 `chat.syncMessages` là où 4 suffisent, sur une route à 10 appels/min et à 3-4 s par appel sur le serveur cible. La correction tient dans lib/rattrapage.ts, sans changer une seule signature d'appelant. Trois défauts de couverture voisins (lecture garantissante avalée, cache repeuplé après purge, fil sans garde) se traitent dans la foulée.

#### 🟡 moyenne — Deux rattrapages concurrents sur le même salon à chaque raccordement

`lib/rattrapage.ts:227` · ✅ vérifié · risque de correction : moyen

Vérifié dans les deux fichiers : ui/synchro.tsx:298 protège son propre appel par `rattrapageSalonEnVol`, mais app/salon/[rid].tsx:465 appelle `rattraperSalon(client, moteur, rid, …)` importé directement de lib/rattrapage.ts, avec `generation` dans les deps de son effet (l.495). `apresRattrapage` incrémente `generation` juste après que `rattraperTout` a lancé le rattrapage du salon actif : l'effet de l'écran se rejoue, `salonCouvert(rid, generationNeuve)` est forcément faux, et une seconde pagination part sur le même curseur. Pas de corruption (le curseur ne régresse pas, les upserts sont idempotents), mais tout le travail est fait en double, plus un `*.history?count=50`.

**Correction.** Mettre la déduplication DANS lib/rattrapage.ts, au seul point où les deux chemins se rejoignent : renommer le corps en `rattraperSalonBrut` et exporter un `rattraperSalon` qui coalesce par rid dans une `Map<string, Promise<void>>` vidée par un `.finally`. Aucun appelant à toucher, `activite.suivre` garde son comportement, les tests existants (appels séquentiels) voient une Map déjà vidée. Documenter que le rejoignant hérite de l'`estAbandonne` du premier arrivé — sans perte, le curseur est écrit après chaque page. Laisser `rattrapageSalonEnVol` en place dans le même commit, le retirer plus tard.

#### 🟡 moyenne — La lecture qui GARANTIT est avalée pour le salon actif par le garde anti-empilement

`ui/synchro.tsx:298` · non passé au réfuteur · risque de correction : moyen

lib/raccordement.ts appelle `rattraper()` deux fois : la seconde, après `streamArme()`, est celle qui garantit qu'aucun document ne tombe entre les deux transports. Côté salon, `if (rattrapageSalonEnVol) return;` l'ABANDONNE au lieu de la différer — et le cas nominal est justement que la première (lancée avant l'ouverture de la socket) court encore. Fenêtre non couverte : [évaluation serveur de la lecture #1 ; armement des souscriptions], pendant laquelle le curseur a déjà avancé. Un message posté là n'est vu par personne jusqu'au raccordement suivant, alors que la liste des salons, elle, montre déjà l'aperçu à jour.

**Correction.** Reprendre l'idiome de `Reconnecteur` (`enVol` + `relance`) : poser un drapeau `redemande` et relancer une passe dans le `finally` au lieu de retourner. Le coalesceur du constat précédent doit intégrer cette relance, sinon il fige le défaut.

#### 🟡 moyenne — `garderAuChaud` peut repeupler le LRU APRÈS `libererSalonsChauds`, et l'entrée fantôme fait mentir `salonCouvert`

`ui/synchro.tsx:420` · non passé au réfuteur · risque de correction : faible

Le cleanup du provider (deps `[etat]`) court AVANT que `<Salon>` ne soit démonté : l'écran appelle ensuite `garderAuChaud(rid, generationRef.current, relachers)` (app/salon/[rid].tsx:366) avec des relâcheurs pointant sur un client DDP déjà `reinitialiser()`. `salonCouvert` compare une égalité de nombres et la génération repart de 0 : dès que la nouvelle session atteint la valeur de l'entrée fantôme, la garde répond « couvert » pour un salon jamais écouté sur cette socket — éditions et suppressions manquées ne sont alors jamais rapatriées.

**Correction.** Jeton de session incrémenté par `libererSalonsChauds`, passé à `garderAuChaud`/`salonCouvert` : si le jeton ne correspond plus, relâcher immédiatement au lieu de mémoriser. Même traitement pour `marquerSalonCharge`. Test dans ui/salonChaud.test.ts.

#### 🟡 moyenne — L'écran fil retélécharge le fil ENTIER à chaque raccordement, sans garde ni indicateur

`app/fil/[id].tsx:197` · non passé au réfuteur · risque de correction : faible

L'effet de chargement a `generation` dans ses deps et n'a aucun équivalent de `salonsCharges` : chaque incrément rejoue `chat.getMessage` puis jusqu'à 20 pages de `chat.getThreadMessages` de 100. Sur un fil de 300 réponses, 4 appels par raccordement sur une route à 10/min. Rien n'est enveloppé dans `activite.suivre` : la barre de synchro reste éteinte pendant que la liste se réécrit intégralement.

**Correction.** Un `filsCharges` indexé par (filId, generation) sur le modèle de ui/salonsCharges.ts, et envelopper le chargement dans `activite.suivre(rid ?? filId, ...)`. Dépend du correctif « generation ne bouge plus sur E2EE » du chantier 1.

#### ⚪ basse — `salonActif` suppose qu'un seul écran salon est monté

`app/salon/[rid].tsx:366` · non passé au réfuteur · risque de correction : faible

`signalerSalonActif` pose le rid au montage et `null` au démontage, sur une variable unique du provider. Or la pile peut contenir deux écrans salon (ui/notifications.tsx:88 fait un `push` depuis n'importe où, app/profil.tsx:196 un `replace`) : au retour arrière, le cleanup du salon du dessus pose `null` alors qu'un salon est affiché, et `rattraperTout` sort sans rattraper aucun salon. Le dégât est aujourd'hui masqué par le rattrapage redondant de l'écran — corriger le premier constat sans celui-ci transforme cette dette en perte réelle.

**Correction.** Remplacer la variable par une pile : `declarerSalonOuvert(rid): () => void` qui empile/dépile, `salonActif` étant le sommet. À faire dans le MÊME commit que la déduplication du rattrapage.

---

### 6. Cycle de vie de la donnée locale : purge, curseurs, rétention

**Sévérité max** 🟡 moyenne · **risque de correction** moyen · **effort** jour

La purge ne connaît que trois tables sur huit, les curseurs survivent aux données qu'ils décrivent, et le critère de purge est un instantané PLUS ANCIEN que l'état qu'il juge — cette dernière est la seule race de tout l'audit qui peut faire disparaître de l'app un DM que l'utilisateur vient de recevoir. Les corrections sont du SQL statique paramétré, exactement le style déjà en place et déjà testé sur `node:sqlite` ; le risque tient au fait qu'on touche à des DELETE, donc à faire avec les tests écrits d'abord.

#### 🟡 moyenne — La réconciliation anti-fantômes efface un salon créé PENDANT sa propre requête réseau

`db/depot.ts:178` · ✅ vérifié · risque de correction : moyen

`reconcilierSalons` fait un `subscriptions.get` COMPLET puis `purgerSalonsAbsents(vivants)` — trois `DELETE … WHERE rid NOT IN (json_each(?))`. Pendant les ~200 ms de l'aller-retour, le stream DDP continue d'écrire (ui/synchro.tsx:257-264) : un DM ouvert par un collègue à cet instant n'est pas dans `vivants` et ses trois lignes sont effacées. La file d'écritures ne protège de rien ici — elle sérialise, elle ne rafraîchit pas la liste. Le DM ne revient qu'au prochain `rattraperGlobal`, et la notification push renvoie entre-temps sur un salon absent.

**Correction.** Relever `listerRidsConnus()` (`SELECT rid FROM salons UNION … abonnements UNION … messages`) AVANT la requête, et resserrer les trois DELETE avec un second paramètre JSON : `rid IN (connus) AND rid NOT IN (vivants)`. C'est l'ORDRE qui porte la justesse, aucun délai. Signature `purgerSalonsAbsents(vivants, connus)` : tsc signalera les faux dépôts à compléter (lib/rattrapage.test.ts:29, lib/sync.test.ts:251). Test : `r3` ingéré pendant le vol ne doit pas figurer dans la purge.

#### 🟡 moyenne — Les curseurs de rattrapage survivent aux données qu'ils décrivent

`db/schema.ts:242` · non passé au réfuteur · risque de correction : moyen

`etat_synchro` n'est effacé ni par `SUPPRIMER_SALON`, ni par `supprimerParSubId`, ni par la purge. Un salon quitté garde ses lignes `(rid,'messages')` alors que ses messages sont effacés ; à la réintégration, app/salon/[rid].tsx:423-427 n'ancre le curseur QUE s'il est absent, donc l'ancienne valeur reprend la main. `rattraperSalon` repart alors d'un point qui ne dit plus rien de l'état local, plafonné à 2 pages : sur un salon à 3 000 messages il faut des dizaines d'ouvertures pour converger, chacune payée en appels rate-limités. `UPSERT_CURSEUR` interdisant toute régression, rien ne peut corriger la valeur après coup.

**Correction.** `DELETE FROM etat_synchro WHERE portee = ?` dans `supprimerSalon`/`supprimerParSubId`, et `PURGER_CURSEURS_ABSENTS` (`portee <> '*' AND portee NOT IN (json_each(?))`) dans la transaction de purge. Le `portee <> '*'` est indispensable : les curseurs globaux ne doivent jamais tomber.

#### 🟡 moyenne — Les files d'envoi et de téléversement ne sont jamais purgées avec leur salon : lignes zombies rejouées à l'infini

`db/upserts.ts:246` · non passé au réfuteur · risque de correction : faible

Vérifié sur base migrée : après les trois DELETE de purge du salon, `sortie`, `televersements`, `brouillons` et `etat_synchro` gardent chacun leur ligne, et la sortie orpheline ressort bien dans `LISTER_SORTIE_A_ENVOYER`. Plus aucun écran ne peut l'afficher (app/salon/[rid].tsx:238 ne lit `sortie` que pour le salon ouvert), donc plus aucun bouton « abandonner » ; à chaque raccordement elle coûte deux appels REST (`chat.sendMessage` puis le `chat.getMessage` de `messageLivre`), pour toujours, en retardant les envois légitimes derrière elle.

**Correction.** Ajouter `PURGER_SORTIE_ABSENTE`, `PURGER_TELEVERSEMENTS_ABSENTS`, `PURGER_BROUILLONS_ABSENTS` à la transaction de `purgerSalonsAbsents`, et effacer les lignes du rid dans `supprimerSalon`/`supprimerParSubId`. Le plafond de tentatives est traité dans le chantier téléversements.

#### 🟡 moyenne — Aucune rétention : `messages` et ses tables satellites ne cessent jamais de croître

`db/schema.ts:77` · non passé au réfuteur · risque de correction : moyen

Le seul effacement de masse ne se déclenche qu'au départ d'un salon. Pour un salon vivant, tout reste : `texte` plus les blobs JSON `md`, `pieces_jointes`, `reactions`, `urls`, souvent plus lourds que le texte. L'app ne lit pourtant jamais au-delà de sa pagination et sait re-télécharger. Deux requêtes balayent en outre la table entière sans index utilisable (`MESSAGES_A_DECHIFFRER`, `MASQUER_MESSAGES_CHIFFRES`). Sur Android, le seul recours de l'utilisateur est « vider les données », qui détruit tout.

**Correction.** Passe de rétention au raccordement, dans la file d'écritures : par salon, garder les N derniers (ex. 500), en épargnant les optimistes (`mis_a_jour_le = 0`) et les racines de fils encore référencées. SQL statique avec `json_each` pour la liste des rids, comme les purges existantes. Inutile de ré-ancrer le curseur : on ne coupe que par l'ancien.

---

### 7. File de téléversements : ni doublon, ni disparition silencieuse

**Sévérité max** 🟠 haute · **risque de correction** moyen · **effort** plusieurs-jours

C'est le maillon le plus faible du dépôt. Le chemin TEXTE (lib/envoi.ts) a acquis au fil des cicatrices un `_id` client, une confirmation par `chat.getMessage` et un message optimiste ; le chemin FICHIER n'a rien de tout cela. Conséquences réelles : une photo envoyée hors ligne disparaît de l'écran sans le moindre signe (l'utilisateur la renvoie, il en aura deux), une réponse de `mediaConfirm` perdue poste le message en double avec un fichier orphelin de plus sur le serveur, et une ligne en échec définitif re-pousse tous ses octets à chaque retour au premier plan. Aucun de ces chemins n'est couvert par les tests — d'où l'ordre imposé ci-dessous : les tests d'abord, la migration ensuite.

#### 🟠 haute — Un fichier envoyé hors ligne disparaît de l'écran sans aucune trace

`lib/envoiFichiers.ts:187` · ✅ vérifié · risque de correction : faible

`MoteurTeleversement` ne crée AUCUN message optimiste (contrairement à lib/envoi.ts:89-112). Sur échec réseau, `unePasse` rend `false` sans marquer la ligne : elle reste `en-attente`. Or la seule surface UI filtre sur `statut === 'echec'` (app/salon/[rid].tsx:246). Et `envoyer()` a résolu normalement, donc le `.then` vide l'aperçu, le brouillon et la citation ; l'écran de partage, lui, navigue vers le salon comme si tout s'était bien passé.

**Correction.** Ne plus filtrer sur l'échec dans app/salon/[rid].tsx:246 et choisir le libellé par statut (nouvelle clé `salon.fichierEnAttente` dans LES DEUX catalogues — ui/messages.test.ts vérifie la parité). Les boutons réessayer/abandonner restent valables (`traiter()` est ré-entrant, `abandonner` ne fait qu'un DELETE). Corriger les deux commentaires devenus faux (app/salon/[rid].tsx:806-808, app/partager.tsx:230-231). NE PAS créer de message optimiste pour les fichiers : il serait irréconciliable avec l'écho serveur, qui n'a pas d'`_id` client.

#### 🟡 moyenne — Une réponse perdue sur `rooms.mediaConfirm` fait poster DEUX fois le même fichier

`lib/upload.ts:86` · ✅ vérifié · risque de correction : moyen

`televerser` enchaîne `rooms.media` puis `rooms.mediaConfirm` (qui CRÉE le message) sans état intermédiaire. `ClientRest` avorte à 15 s et convertit tout échec sans réponse HTTP en `ErreurRest(statut 0)` ; `unePasse` laisse alors la ligne `en-attente` et le prochain `fichiers.traiter()` — à CHAQUE raccordement — repart de zéro. Aucune clé de déduplication n'existe : la table `televersements` n'a ni `_id` client ni `file_id`, et son commentaire (db/schema.ts:161-162) évoque un statut `envoi` jamais implémenté. Symétriquement, tout échec survenant APRÈS l'upload laisse un fichier orphelin que rien ne nettoie — le piège même que CLAUDE.md signale sur le flux en deux temps.

**Correction.** Persister `file_id` (migration, colonne nullable) dès le retour de `rooms.media` ; scinder `televerser` en `televerserOctets` / `confirmerMedia`, et sauter la première étape quand `file_id` est déjà là. Avant de re-confirmer, interroger SQLite — pas le réseau : `SELECT 1 FROM messages WHERE rid = ? AND pieces_jointes LIKE '%' || ? || '%'` ; si le message est là, le confirm avait abouti, on purge la ligne. Purement local, donc insensible au rate-limit. Ne PAS tenter un `_id` client sur `mediaConfirm` (`additionalProperties: false`).

#### 🟡 moyenne — Aucun état « en cours » : « Abandonner » pendant une reprise supprime la ligne mais le message est posté quand même

`lib/envoiFichiers.ts:196` · non passé au réfuteur · risque de correction : moyen

`LISTER_TELEVERSEMENTS_A_ENVOYER` rend les lignes `en-attente` ET `echec`, et `unePasse` ne change pas le statut en prenant une ligne en charge : le bandeau affiche « non envoyé · Réessayer · Abandonner » pendant tout le re-téléversement, sans progression (la `Map progression`, annoncée « pour l'UI » dans lib/fournisseur.ts:182, n'est lue nulle part). `abandonner(id)` n'est qu'un DELETE : il n'annule pas la `FileSystemUploadTask` en vol (`cancelAsync` n'est jamais appelé) et n'empêche pas `ingerer(message)` — la vidéo apparaît dans le salon après que l'utilisateur l'a explicitement abandonnée.

**Correction.** Implémenter le statut `envoi` déjà décrit dans le schéma : posé à la prise en charge, exclu du listage, affiché avec la fraction de `progression`. `abandonner` sur une ligne `envoi` pose une intention d'annulation vérifiée avant `ingerer`, et idéalement appelle `tache.cancelAsync()` (à exposer dans le type `TransportUpload`).

#### 🟡 moyenne — Les lignes en échec sont rejouées à chaque retour au premier plan, sans plafond ni recul

`db/upserts.ts:330` · non passé au réfuteur · risque de correction : faible

`apresRattrapage` appelle `envoi.traiter()` et `fichiers.traiter()` à chaque raccordement, et les deux requêtes de listage incluent `echec`. Aucun moteur ne lit de compteur : la colonne `tentatives` existe pour `sortie` mais n'est jamais consultée, `televersements` n'en a même pas. Une vidéo refusée par le serveur (413, type refusé, quota) repousse donc tous ses octets à chaque flap réseau — cas fréquent quand `fileSize` est null sur Android et que la validation locale laisse passer.

**Correction.** Ne rejouer automatiquement que les lignes `en-attente` ; réserver `echec` au geste explicite « réessayer ». À défaut, colonne `tentatives` incrémentée par `MARQUER_TELEVERSEMENT_ECHEC` et plafond, comme pour la file de texte — un plafond, pas un délai.

#### 🟡 moyenne — `messageLivre` confond « le serveur n'a pas répondu » et « le message n'a pas été livré »

`lib/envoi.ts:197` · non passé au réfuteur · risque de correction : faible

Quand `chat.sendMessage` échoue avec un statut ≠ 0, `unePasse` interroge `chat.getMessage` pour trancher — mais `messageLivre` attrape TOUTES les erreurs et rend `null`, y compris une panne réseau ou un 429 après les trois rejeux (le `chat.getMessage` subit la même limite de 10/min). L'appelant marque `echec` : l'utilisateur voit « non envoyé » sur un message que le serveur a peut-être accepté.

**Correction.** Rendre `'inconnu'` quand l'erreur est une `ErreurRest` de statut 0 ou 429 (la ligne reste alors `en-attente`), `null` seulement quand le serveur a répondu que le message n'existe pas.

#### ⚪ basse — Aucun fichier temporaire n'est jamais supprimé

`ui/preparerPieceJointe.ts:27` · non passé au réfuteur · risque de correction : faible

`compresserImageSiUtile` écrit un JPEG par photo, `DocumentPicker({copyToCacheDirectory:true})` copie chaque document, `ImagePicker` copie chaque média, l'enregistreur produit un `.m4a` par prise. Une recherche `deleteAsync` sur tout le dépôt ne rend AUCUN appel : rien n'est effacé, ni après envoi, ni quand l'aperçu est retiré, ni pour les pièces retirées dans app/partager.tsx. Le seul mécanisme de purge est celui d'Android sous pression, qui casse au passage les envois encore en file.

**Correction.** Supprimer le fichier local quand la ligne de téléversement est purgée (succès ou abandon) si l'URI est dans le cache de l'app — la connaissance est côté `MoteurTeleversement`. Et supprimer le JPEG recompressé quand l'aperçu est retiré sans envoi.

#### 🟡 moyenne — Le chemin d'échec réseau et le SQL de la file de téléversements ne sont testés nulle part

`lib/envoiFichiers.test.ts:116` · non passé au réfuteur · risque de correction : nul

Le fichier s'arrête au succès et au refus franc. Ni le `statut === 0` (le seul chemin qui laisse une ligne invisible), ni la garde `enVol`/`repasser`, ni le nettoyage de `progression` ne sont exercés — alors que les trois équivalents de `MoteurEnvoi` sont testés un par un. Côté SQL, `grep TELEVERSEMENT db/*.test.ts` ne rend que le nom de la table : `INSERER_TELEVERSEMENT`, `LISTER_…`, `MARQUER_…`, `SUPPRIMER_…` ne sont exécutés par aucun test, alors que db/depot.ts:373 rend `getAllAsync` directement comme `LigneTeleversement[]` — une simple assertion de type, jamais vérifiée.

**Correction.** Un `describe('file de téléversements')` dans db/upserts.test.ts, calqué sur celui de l'outbox (insérer avec les paramètres réels de db/depot.ts, relire, comparer champ à champ, marquer en échec, supprimer). Et trois cas dans lib/envoiFichiers.test.ts : `ErreurRest(…, 0)` → ligne `en-attente` et `marquerEchec` NON appelé ; `traiter()` concurrent → une passe puis une repasse ; `progression.has(id)` faux après échec comme après succès. À ÉCRIRE AVANT la migration `file_id`.

---

### 8. Transport DDP et REST : ne pas tuer une socket saine, ne pas dormir sans écouter

**Sévérité max** 🟡 moyenne · **risque de correction** moyen · **effort** jour

Le domaine est solide et bien testé, mais quatre défauts précis font que l'app se punit elle-même sur réseau dégradé : une sonde de vie envoyée trop tôt ferme une socket qui fonctionne (comportement serveur vérifié sur le banc), le pilote de reconnexion continue de rouvrir des sockets en arrière-plan contre l'intention documentée, un sommeil de rejeu 429 ignore l'annulation et fait converger les appels concurrents, et `/api/info` échappe seul à toute la défense du module — au point de pouvoir bloquer l'écran de connexion définitivement. Chaque correction est locale à un module déjà couvert par des tests.

#### 🟡 moyenne — La sonde de vie envoyée pendant la négociation DDP tue une socket saine 10 s plus tard

`lib/ddp.ts:437` · non passé au réfuteur · risque de correction : faible

`verifierVie()` ne se protège que de l'état `ferme` : elle sonde donc pendant `connexion`. Sondé sur un vrai Rocket.Chat : un `ping` envoyé avant le `connect` reçoit `{msg:'error', reason:'Must connect first'}` — jamais de `pong`. Or `recevoir()` n'a aucun cas pour `msg:'error'` : le message est avalé, l'attente n'est jamais résolue, et au bout de 10 s le `catch` fait `ws.close()` + `nettoyer()` sur une socket qui a entre-temps terminé son login et rejoué ses souscriptions. Les deux appelants ne filtrent pas (ui/synchro.tsx:393, sonde de fin d'upload).

**Correction.** `if (this.etat !== 'authentifie' && this.etat !== 'connecte') return false;` en tête de `verifierVie()` — une négociation en cours a déjà son propre timeout. Accessoirement, traiter `msg:'error'` dans `recevoir()` en rejetant l'attente correspondant à `error.offendingMessage.id`, ce qui transformerait ce silence en échec immédiat.

#### 🟡 moyenne — Le pilote de reconnexion n'est pas suspendu au passage en arrière-plan

`ui/synchro.tsx:389` · non passé au réfuteur · risque de correction : moyen

Le commentaire l.379-385 pose la règle : en arrière-plan, fermeture volontaire, « le push prend le relais ». Mais le handler ne fait que `ddp.fermer()` ; le `Reconnecteur` n'a que `arreter()`, définitif et réservé au démontage. Deux chemins rouvrent une socket en fond : une minuterie de backoff déjà armée qui tire quand même, et une tentative en vol dont l'échec relance la boucle. Chaque tentative entraîne un `rattraperTout()` complet (REST rate-limité) et, en cas de succès, une socket laissée ouverte jusqu'à ce que Doze la tue — ce qui redéclenche `surPerte`.

**Correction.** Ajouter `suspendre()` / `reprendre()` au `Reconnecteur` (drapeau réversible qui bloque `declencher()` et annule la minuterie), appelés depuis le handler `AppState` autour de `ddp.fermer()`. Test « une minuterie programmée ne tire pas après suspendre() ».

#### 🟡 moyenne — `recupererVersion` appelle `fetch` sans délai maximal : l'écran de connexion peut rester bloqué à vie

`lib/server.ts:87` · non passé au réfuteur · risque de correction : faible

Le module se réclame de la défense de `ClientRest` mais `/api/info` part sur un `fetch` nu, sans `DELAI_MS`. `sonderServeur` attend les deux appels en `Promise.all` ; le seul filet, `controleur.abort()`, ne s'exécute que si une des deux promesses REJETTE. Si `settings.public` réussit et que `/api/info` reste pendante (reverse proxy, portail captif), `Promise.all` reste pendante à vie : le `finally` d'app/connexion.tsx:136-139 ne s'exécute pas, `enVol.current` reste `true`, et un second appui ressort sur le `if (enVol.current) return;` SANS atteindre le `abort()`. Écran mort, sans message.

**Correction.** Borner l'appel : `AbortController` local armé par `setTimeout(DELAI_MS)` et relais du signal reçu, ou — plus propre — une méthode `getHorsApiV1` sur `ClientRest` pour que `/api/info` hérite du délai, du rejeu 429 et du JSON défensif.

#### 🟡 moyenne — Le sommeil de rejeu sur 429 ignore l'annulation et n'a aucune dispersion

`lib/rest.ts:239` · non passé au réfuteur · risque de correction : faible

Deux défauts au même endroit. (a) Le `finally` retire l'écouteur d'annulation AVANT `await this.dep.dormir(delai)` : un `abort()` pendant le sommeil n'est constaté qu'au retour de récursion, jusqu'à 30 s plus tard et 90 s cumulés — la promesse rendue à l'appelant reste pendante d'autant, donc son spinner aussi. (b) `delaiApres429` calcule `reset - maintenant() + 250` : deux appels concurrents reçoivent le même `x-ratelimit-reset` et se réveillent à la même milliseconde, sans dispersion et sans file par route — la nouvelle fenêtre n'en admet que 10, les autres reprennent un 429.

**Correction.** (a) Course entre `dormir(delai)` et une promesse résolue par un écouteur `abort`, puis relever `erreurAnnulation()`. (b) Dispersion bornée injectable via `Dependances` pour garder les tests déterministes (les `deepEqual(dormirs, [2250, 2250])` de lib/rest.test.ts:167 se réécrivent en encadrement). Un verrou par `chemin` sérialiserait les rejeux d'une même route plutôt que de les faire converger.

#### ⚪ basse — Rien n'invalide la présence quand le transport meurt

`lib/presence.ts:45` · non passé au réfuteur · risque de correction : faible

L'en-tête du module pose le contrat (« une présence périmée affichée depuis un cache est pire que pas de présence du tout ») et `statutDe` rend `null` pour que l'UI n'affiche RIEN. Le contrat n'est tenu que contre la PERSISTANCE : la carte `statuts` en mémoire n'est jamais invalidée, `MoteurPresence` n'est branché ni sur `surPerte` ni sur aucun signal de transport, et la seule remise à niveau est `charger()` depuis `apresRattrapage`. Entre la coupure et le raccordement suivant, la liste des DM continue d'afficher des pastilles vertes datant de l'entrée dans le tunnel.

**Correction.** `MoteurPresence.invalider()` (vider `statuts`, incrémenter le compteur pour garder les séquences monotones, notifier) appelé depuis `ddp.surPerte` dans ui/synchro.tsx:376 et au passage en arrière-plan. L'UI retombe sur « inconnu », le comportement de dégradation déjà spécifié.

#### ⚪ basse — `nettoyer()` n'est pas idempotent : une socket qui meurt pendant le login notifie `surPerte` deux fois

`lib/ddp.ts:552` · ✅ vérifié · risque de correction : faible

Vérifié par exécution : `onclose` → `nettoyer()` notifie puis rejette l'attente du login ; le `catch` de `connecter()` rappelle `nettoyer(e)` et notifie une seconde fois. Sans dégât aujourd'hui (`Reconnecteur.declencher()` est idempotent), mais c'est un couplage implicite : tout futur abonné (compteur de coupures, bandeau hors ligne, métrique) comptera double, et le second passage réémet l'événement sur un objet déjà entièrement nettoyé.

**Correction.** Sortie immédiate si le nettoyage a déjà eu lieu (drapeau remis à zéro par `connecter()`), et assertion `pertes === 1` dans le test « socket morte pendant le login » de lib/ddp.test.ts.

---

### 9. Session morte et fin de session : ramener au login, et tout emporter en partant

**Sévérité max** 🟠 haute · **risque de correction** ÉLEVÉ · **effort** jour

Trois trous se rejoignent sur le même symptôme : l'app reste dans un état qu'elle croit valide et l'utilisateur n'a aucun chemin de sortie. Un jeton révoqué en cours de session (mot de passe changé ailleurs, `Accounts_LoginExpiration`, `logoutOtherClients`) fait boucler le pilote de reconnexion à l'infini sur un cache d'hier, sans un message ; une déconnexion laisse sur le disque la clé privée E2EE DÉCHIFFRÉE, indexée par serveur seul, si bien que le compte suivant se croit déverrouillé et ne peut plus rien lire ; et la base SQLite avec les clairs E2E survit intacte. Je le place APRÈS les chantiers à faible risque parce que le déclenchement d'une déconnexion automatique est la correction la plus dangereuse de tout l'audit : une erreur de discrimination éjecte l'utilisateur à tort. À faire avec son test de prédicat écrit d'abord.

#### 🟠 haute — Un 401 survenu EN COURS de session ne révoque jamais la session : état zombie jusqu'au redémarrage

`lib/rest.ts:280` · ✅ vérifié · risque de correction : ÉLEVÉ

Vérifié par grep : les DEUX seuls endroits qui testent `statut === 401` pour effacer la session sont ui/session.tsx:114 (démarrage) et :159-165 (bascule de serveur). Aucun appel de la vie courante ne remonte l'invalidation — `rattraperGlobal`, `chat.syncMessages`, `chat.sendMessage` (qui ne distingue que le statut 0), `users.presence` (qui avale tout en silence). Côté DDP, `login {resume}` rejette et le `Reconnecteur`, délibérément aveugle à la cause (`catch { tentative++; declencher(); }`), retente toutes les 30 s pour toujours. L'écran affiche les données d'hier, la barre de synchro bat, tout envoi échoue : l'aspect exact d'un problème réseau.

**Correction.** Deux gestes complémentaires. (1) `ClientRest` DIT que le jeton est refusé : champ optionnel `surJetonRefuse?: (jeton: string) => void`, appelé au SITE DU THROW existant (après la branche `totp-required`, donc jamais sur un défi 2FA ; après le parse JSON, donc jamais sur un 401 HTML de proxy), avec le jeton RÉELLEMENT envoyé pour qu'un 401 tardif sur un jeton déjà remplacé soit ignoré. Branché dans `clientPour` (ui/session.tsx:55, point de création unique des trois chemins) sur la séquence de démarrage déjà éprouvée. (2) Côté raccordement, envelopper l'appel du `Reconnecteur` et n'appeler `deconnecter()` que sur `ErreurRest` de statut 401 qui n'est PAS une `ErreurDeuxFacteurs` — `deconnecter()` fait tomber l'effet de `SynchroProvider`, donc le pilote s'éteint sans code d'arrêt supplémentaire. Écrire D'ABORD le test du prédicat `estJetonRefuse` sur quatre cas : `ErreurRest(401)` → true, `ErreurDeuxFacteurs` → false, `ErreurRest(0)` → false, `ErreurDdp` → false. C'est ce test qui protège du seul vrai risque : la déconnexion abusive.

#### 🟡 moyenne — La clé privée E2EE survit à la déconnexion et est rangée par serveur seul

`ui/session.tsx:184` · ✅ vérifié · risque de correction : moyen

`deconnecter()` n'efface que la session, jamais `effacerClePriveeE2E` — alors que ce qui est stocké est le JWK RSA DÉCHIFFRÉ, le secret le plus sensible de l'app. Second défaut, structurel : `cleE2E(baseUrl)` ne dérive QUE de l'URL, alors que la session et la base SQLite sont indexées par le couple (serveur, compte). Au démarrage suivant, `e2e.reprendre()` réimporte aveuglément ce JWK pour un AUTRE compte : `importerClePriveeRSA` réussit (c'est un JWK valide), `estDeverrouille` passe à vrai, `dechiffrerCleSalon` échoue en silence — et l'UI affiche « chiffré, lecture seule » au lieu du bouton « Déverrouiller ». Aucun chemin visible vers l'écran de déverrouillage.

**Correction.** (1) INDISPENSABLE — `cleE2E(baseUrl, userId)` dérivant du condensé de `baseUrl + '|' + userId`, propagé aux trois fonctions exportées, `session.userId` étant déjà sous la main dans ui/synchro.tsx:167. Seule correction valable quel que soit le chemin de sortie de session. Aucune migration : une clé d'ancien format devient introuvable, l'utilisateur ressaisit son mot de passe une fois. Extraire la dérivation comme db/nomFichier.ts l'a fait pour la base, pour la tester sans expo. (2) HYGIÈNE — `effacerClePriveeE2E` aux TROIS sorties : `deconnecter()` et les deux chemins 401 (ui/session.tsx:115 et :163). Ne pas toucher à lib/e2e/moteur.ts, correct par injection.

#### 🟡 moyenne — La déconnexion laisse sur le disque la base SQLite entière, clairs E2E compris

`ui/session.tsx:170` · non passé au réfuteur · risque de correction : moyen

`deverrouillageE2E` écrit le texte déchiffré dans la colonne `texte` (lib/sync.ts:153-176), et le projet reconnaît que ce clair doit pouvoir disparaître : `reverrouillageE2E` appelle `masquerMessagesChiffres`, câblé sur le bouton « Verrouiller ». Mais `deconnecter()` ne verrouille pas et n'efface aucune base (aucun `deleteDatabaseSync` dans le dépôt, base non chiffrée). Incohérence flagrante : le geste le plus fort protège moins que le plus faible.

**Correction.** Appeler au minimum `masquerMessagesChiffres()` dans `deconnecter()` ; de préférence ajouter `supprimerBase(baseUrl, userId)` à db/client.ts (fermeture puis `deleteDatabaseSync`) — en le faisant depuis `deconnecter`, PAS depuis un cleanup d'effet. Si l'on préfère garder le cache hors ligne pour un retour rapide, trancher explicitement et le documenter.

#### 🟡 moyenne — Trois stores module-level ne sont jamais purgés en fin de session

`ui/reponse.ts:31` · non passé au réfuteur · risque de correction : faible

Le cleanup de ui/synchro.tsx purge `salonsCharges` et `salonChaud`, mais pas : (a) la Map `cibles` de ui/reponse.ts — dont l'en-tête affirme pourtant qu'« une citation en suspens ne survit pas », vrai d'un redémarrage de process, faux d'une déconnexion : le premier message tapé après reconnexion part préfixé du permalien de la session précédente ; (b) `identites` et `etags` de ui/identites.tsx, qui servent les pseudos et URL d'avatar du compte précédent pendant les premières frames ; (c) `dispoParServeur` de lib/appel.ts:72, dont un `false` mémoïsé masque le bouton 📞 pour toute la vie du process, même après reconnexion — aucun geste dans l'app n'en sort.

**Correction.** Exporter `oublierReponses()`, `oublierIdentites()` et `oublierDisponibiliteAppel()` et les appeler dans le cleanup de ui/synchro.tsx, à côté des deux purges existantes, pour que la règle « tout store module-level se purge en fin de session » soit sans exception. Corriger l'en-tête de ui/reponse.ts.

#### 🟡 moyenne — Après une déconnexion hors ligne, le jeton reste enregistré côté serveur

`ui/session.tsx:178` · non passé au réfuteur · risque de correction : faible

Le DELETE `push.token` est en best-effort dans un try/catch vide : un échec réseau (ou un `obtenirJetonFcm` en `permission-refusee`) laisse le jeton vivant, sans file de reprise. Côté natif, `recupererEtPoster` constate `session == null` et poste QUAND MÊME la notification dégradée, puis programme un rattrapage WorkManager voué à l'échec. Résultat : des « Nouveau message » fantômes sur un appareil sans compte, jusqu'à la désinstallation.

**Correction.** (1) Natif : quand `lireSession` ne rend rien pour ce host, ne rien poster et ne rien programmer. (2) JS : persister le couple (baseUrl, jeton) dans une file « à désenregistrer » et la vider au prochain démarrage — le DELETE tolère déjà le 404 (lib/pushToken.ts:40).

---

### 10. Push natif : doublons, deep-link multi-serveur, hygiène du service

**Sévérité max** 🟠 haute · **risque de correction** moyen · **effort** plusieurs-jours

Tout ce chantier est du Kotlin injecté par un config plugin : ni tsc ni les 460 tests ne le voient, et chaque itération coûte `expo prebuild` + `assembleRelease` (statut testé SANS pipe). Il faut donc le traiter en un seul passage, pas au fil de l'eau. Le plus grave est vérifié : le garde anti-doublon du commit 249887e ne couvre qu'un sens de la course, si bien que le worker de rattrapage et la relivraison FCM — réveillés par le MÊME événement, le retour du réseau — ajoutent deux fois le même message dans la conversation. Le deep-link ignore par ailleurs la dimension multi-serveur que l'app supporte pourtant, ce qui donne un spinner définitif.

#### 🟠 haute — Le garde anti-doublon ne couvre pas le cas « le worker a déjà posté »

`plugins/with-fcm-deeplink.js:249` · ✅ vérifié · risque de correction : moyen

`recupererEtPoster` annule la dégradée et le rattrapage puis appelle `afficherNotifSalon`, qui RÉ-EXTRAIT le MessagingStyle actif du salon et y ajoute le message — aucun état ne mémorise qu'un messageId a déjà été affiché. Symétriquement, `RattrapagePushWorker.doWork` ne teste jamais `isStopped` avant de publier : un `cancelUniqueWork` n'arrête pas un worker en vol. Le réseau revient, le worker poste, FCM relivre le push non acquitté 1-2 s plus tard, et l'utilisateur voit le même message deux fois avec « 2 nouveaux messages ».

**Correction.** Un test-et-pose atomique `dejaAffiche(ctx, messageId)` (SharedPreferences dédié, entrées purgées au-delà d'une heure, `@Synchronized`, best-effort qui rend `false` en cas d'exception pour ne jamais perdre une notification), consulté dans les DEUX voies id-only : dans `recupererEtPoster` juste avant l'affichage (en gardant `cancel` + `annulerRattrapage` AVANT le test, la dégradée doit disparaître dans tous les cas), et dans `doWork` sous la forme `if (isStopped || dejaAffiche(...))`. La dégradée, elle, ne pose PAS le marqueur : elle doit rester remplaçable. Le régime « contenu présent dans le push » reste inchangé (ni dégradée ni rattrapage, donc pas de course).

#### 🟡 moyenne — Le deep-link de notification ne porte pas le serveur : spinner définitif en multi-serveur

`plugins/with-fcm-deeplink.js:465` · ✅ vérifié · risque de correction : moyen

L'intent est `rocketvibe://salon/<rid>` — le `host`, pourtant présent dans le payload et correctement utilisé par `lireSession` pour afficher le bon contenu, est jeté. Or les sessions coexistent (`changerDeServeur` n'efface rien) et le jeton push est enregistré sur chaque serveur, donc les deux poussent. À l'arrivée, app/salon/[rid].tsx n'a pas de ligne `salons` pour ce rid : `type === undefined` court-circuite tout l'effet, `premierPassageFini` reste `false`, et l'écran affiche un `ActivityIndicator` définitif. ui/notifications.tsx:88 a le même trou côté JS.

**Correction.** (1) Ajouter le host au lien (`?host=…`) dans `afficherNotifSalon` — les trois appelants l'ont déjà sous la main ; ne PAS le relire depuis le payload de `push.get`, dont la forme n'est pas garantie. Miroir côté JS dans ui/notifications.tsx. (2) Dans `EcranSalon`, si `host` est défini et diffère de `session.baseUrl`, rendre un écran explicite « Ce message est sur <host> » avec un bouton qui appelle `changerDeServeur` puis `replace` — bascule sur geste explicite uniquement. `host` absent → comportement identique à aujourd'hui, donc zéro régression en mono-serveur.

#### 🟡 moyenne — Aucune notification n'est retirée quand le salon est lu

`ui/notifications.tsx:118` · non passé au réfuteur · risque de correction : faible

`dismissNotificationAsync` n'apparaît nulle part (vérifié par grep) : seul `setAutoCancel(true)` retire la notification, et uniquement au TAP. L'effet de badge suit pourtant déjà les non-lus en temps réel. Les notifications étant groupées par salon et cumulatives, lire #general depuis l'icône laisse ses 3 messages dans la barre d'état, et le suivant s'y ajoute en 4e ligne — idem quand le salon est lu depuis un autre appareil.

**Correction.** Dans `SuiviBadgeEtChiffre`, pour tout rid passant à `nonLus === 0`, appeler `Notifications.dismissNotificationAsync('expo-notifications://foreign_notifications?id=' + hashCodeJava(rid))` — la forme que `ExpoPresentationDelegate` décode en `cancel(tag=null, id)`, l'id posé par le natif étant `rid.hashCode()`. `hashCodeJava` est une dizaine de lignes déterministes, testables sous Node.

#### 🟡 moyenne — Le `push.get` bloquant peut coûter 16 s (32 s en debug) sur le thread de dispatch FCM

`plugins/with-fcm-deeplink.js:663` · non passé au réfuteur · risque de correction : faible

Le commentaire annonce un « timeout serré » mais pose `connectTimeout = 8000` ET `readTimeout = 8000` : en Doze, radio pas encore levée, c'est 16 s dans `handleIntent`, et `verifierPushGetEnDebug` enchaîne un SECOND fetch complet (~32 s). C'est ce qui rend le process tuable pendant le fetch — l'hypothèse déjà écrite l.241-243 — donc ce qui ALIMENTE la relivraison FCM et la famille de doublons ci-dessus. Ce chemin n'a par ailleurs aucun traitement du 429, alors que `push.get` subit la limite de 10/min.

**Correction.** ~3 s de connect et ~3 s de read (budget total 6 s), en laissant le rattrapage WorkManager faire son travail ; conditionner `verifierPushGetEnDebug` à un drapeau explicite ; sur 429, programmer le rattrapage en lisant `x-ratelimit-reset` sans consommer de tentative immédiate.

#### ⚪ basse — Un 401 sur `push.get` déclenche huit tentatives WorkManager vouées à l'échec, par notification

`plugins/with-fcm-deeplink.js:667` · non passé au réfuteur · risque de correction : faible

`recupererContenu` rend `null` pour TOUT code ≠ 200, sans distinguer une panne passagère d'un refus définitif. `recupererEtPoster` programme alors systématiquement le rattrapage, et `doWork` retente jusqu'à 8 fois avec un backoff de 30 s, en relisant la même session morte. Sur une soirée de messages, c'est de la batterie et des réveils radio pour rien.

**Correction.** Faire remonter le code HTTP (résultat typé plutôt que `JSONObject?`) et, sur 401/403, poster la dégradée SANS programmer de rattrapage — comme le fait déjà la branche « payload inattendu ».

#### 🟡 moyenne — Les chaînes de la voie native sont en français en dur alors que l'app est intégralement EN/FR

`plugins/with-fcm-deeplink.js:414` · non passé au réfuteur · risque de correction : faible

Depuis que le service natif poste TOUTES les notifications de message, les seules chaînes vues par l'utilisateur sont celles du Kotlin : « Message chiffré » (l.414), « Vous » (l.436, nom de la Person du MessagingStyle), « Nouveau message » (l.518). Le catalogue JS a pourtant les deux langues, et la préférence est déjà lisible depuis le natif (`langue-preferee` dans le même SharedPreferences SecureStore que la session).

**Correction.** Sortir les trois chaînes dans `res/values/strings.xml` + `res/values-fr/strings.xml` posés par le même plugin (`withStringsXml`), ou lire `langue-preferee` pour honorer la préférence explicite plutôt que la locale système.

#### ⚪ basse — La rotation du jeton FCM n'est jamais écoutée

`ui/synchro.tsx:333` · non passé au réfuteur · risque de correction : faible

`Notifications.addPushTokenListener` n'existe nulle part : le jeton n'est poussé qu'une fois par session. Si FCM le fait tourner pendant que l'app vit, `onNewToken` est traité par expo mais rien ne le réenregistre — les notifications cessent silencieusement jusqu'au prochain démarrage à froid, et l'ancien jeton reste côté serveur.

**Correction.** Poser un `addPushTokenListener` au montage de la session qui rappelle `enregistrerJeton` (POST idempotent). À faire avec le correctif du drapeau (chantier 1), qui touche les mêmes lignes.

#### ⚪ basse — La chirurgie de configuration du plugin (JS pur) n'a aucun test

`plugins/with-fcm-deeplink.js:737` · non passé au réfuteur · risque de correction : nul

Le Kotlin n'est vérifiable que par un build, c'est admis. Mais `withServiceManifest` (idempotence, `android:priority=1` — la valeur exacte dont dépend le routage FCM vers notre service plutôt que celui d'expo) et `withNativeDeps` (injection par `contents.replace(/dependencies\s*\{/, …)`, donc dans la PREMIÈRE occurrence rencontrée, avec pour seule garde `includes(artefact)` sans version) sont du JS testable. Aujourd'hui correct par propriété du gabarit RN 0.86, pas du plugin.

**Correction.** `plugins/with-fcm-deeplink.test.ts` (Node, sans Expo) sur fixtures : les `implementation` atterrissent dans le bloc `dependencies` de plus haut niveau, un second passage n'ajoute rien, un gradle SANS bloc `dependencies` est DÉTECTÉ au lieu d'être laissé intact, et le service est ajouté une seule fois avec `android:priority=1`.

---

### 11. Écrans : boucles sans borne, attentes fixes, coûts natifs inutiles

**Sévérité max** 🟡 moyenne · **risque de correction** faible · **effort** jour

Quatre défauts d'écran qui coûtent du réseau, de la batterie ou de la confiance : une pagination qui peut boucler indéfiniment sur `channels.history` quand les plus vieux messages partagent une milliseconde, un `subscriptions.read` toutes les 2 s dans un salon animé (30/min sur une route à 10/min), un ExoPlayer + MediaSession + Visualizer alloué et un fichier téléchargé par message vocal SIMPLEMENT VISIBLE — l'inverse exact de la décision écrite dans ui/lecteurVideo.tsx — et un défilement après envoi calé sur `setTimeout(250)`, c'est-à-dire le correctif par temps d'attente que la règle permanente du projet interdit. Toutes les corrections sont locales à un écran ou un composant.

#### 🟡 moyenne — Le critère « passé épuisé » (`n > 1`) boucle indéfiniment si les plus vieux messages partagent la même milliseconde

`app/salon/[rid].tsx:522` · non passé au réfuteur · risque de correction : faible

`chargerPlus` demande la page antérieure avec `latest = horodatage du plus vieux local` et `inclusive: true`, puis conclut `n > 1 ⇒ il reste du passé`. Le raisonnement ne tient que si le message-borne est SEUL sur sa milliseconde — or la clé de tri secondaire `desc(messages.id)` (l.229) reconnaît explicitement les ex æquo comme réels (rafale de bot, import). Le serveur renvoie alors le groupe entier, `n` reste > 1, `passeEpuise` n'est jamais armé, et la ré-ingestion fait changer `data`, ce qui réarme `onEndReached` de FlashList v2 : la boucle s'auto-entretient jusqu'au 429.

**Correction.** Déduire l'épuisement du fait que la page contient un message strictement plus ancien que la borne (renvoyer le plus petit `ts` du lot depuis `chargerHistorique` et comparer), plutôt que du cardinal. Filet complémentaire : armer aussi `passeEpuise` si le dernier id est inchangé après deux pages consécutives.

#### 🟡 moyenne — Le débounce de `marquerLu` borne les rafales mais pas la CADENCE : 30 POST/min sur une route à 10/min

`app/salon/[rid].tsx:284` · non passé au réfuteur · risque de correction : faible

L'effet réarme un `setTimeout(1500)` à chaque nouvel id en tête et appelle `subscriptions.read`. Un débounce trailing ne garantit que l'absence de deux appels à moins de 1,5 s ; un message toutes les 2 s produit 30 appels dans la minute. Le commentaire « débouncé, le REST est rate-limité » suppose une protection qui n'existe pas. À chaque 429, lib/rest.ts retente 3 fois avec des siestes jusqu'à 30 s, pour un travail purement idempotent — et le compteur de non-lus de l'accueil reste faux plusieurs dizaines de secondes.

**Correction.** Plancher de cadence en plus du débounce : mémoriser l'instant du dernier `marquerLu` réussi et ne relancer que si `Date.now() - dernier >= 10_000`, sinon reprogrammer au reste du plancher. Rien n'est perdu sémantiquement (`subscriptions.read` marque tout lu jusqu'à maintenant, un appel tardif englobe les précédents). Compléter par un appel garanti à la sortie de l'écran et au passage en arrière-plan.

#### 🟡 moyenne — Chaque message vocal MONTÉ crée un ExoPlayer et télécharge son fichier, même sans lecture

`ui/lecteurAudio.tsx:208` · non passé au réfuteur · risque de correction : moyen

`useAudioPlayer(url)` est appelé au corps du composant, donc pour chaque pièce jointe audio rendue par la liste. Côté natif, le constructeur fait `setMediaSource` → `prepare()` : ExoPlayer bufférise immédiatement l'URL distante, plus une coroutine périodique, une MediaSession par instance, et un `Visualizer` système via l'effet l.226 — alors que le natif prévient « It must only be created once, otherwise the app will crash ». Le fichier voisin ui/lecteurVideo.tsx a tranché explicitement dans l'autre sens (« le player n'existe que lorsqu'on regarde »). Faire défiler 20 vocaux télécharge ~20 Mo pour zéro seconde d'écoute — avec les URL porteuses de `rc_uid`/`rc_token`.

**Correction.** Reprendre le patron de lecteurVideo.tsx : la carte au repos ne monte aucun player, `useAudioPlayer` et `useAudioSampleListener` vivent dans un sous-composant monté au premier appui sur « lire » (le coordinateur `lecteurActif` devient alors trivial). Retirer au passage l'appel redondant à `setAudioSamplingEnabled(true)` : `useAudioSampleListener` le fait déjà, après avoir testé `isAudioSamplingSupported` — ce que notre effet ne fait pas.

#### 🟡 moyenne — Le défilement après envoi dans un fil repose sur un délai fixe de 250 ms

`app/fil/[id].tsx:258` · non passé au réfuteur · risque de correction : faible

`apresEnvoi` fait `setTimeout(() => liste.current?.scrollToEnd(...), 250)`. La chaîne attendue est : écriture SQLite sérialisée par la file (donc derrière toute transaction de synchro en cours) → `addDatabaseChangeListener` → `useRequeteVive`, dont le debounce est de 48 ms mais PLAFONNÉ à 400 ms. Le délai n'a donc aucune borne supérieure garantie face à ce qu'il attend : sous flot d'écritures, le scroll part sur les données d'avant, la réponse naît sous le pli, et l'utilisateur renvoie son message. C'est exactement le correctif par temps d'attente que la règle permanente interdit — et l'écran salon résout le même problème sans horloge (app/salon/[rid].tsx:322-336, effet sur `plusRecent` avec garde chronologique).

**Correction.** Supprimer `apresEnvoi` et le `setTimeout` : un `useEffect` observant l'apparition d'un nouvel id en queue de `donnees` (l'`_id` rendu par `envoi.envoyer` est déjà disponible pour l'attendre nommément). La liste est recalée par le rendu, pas par une horloge.

#### 🟡 moyenne — Le navigateur d'emojis fige la liste des emojis personnalisés au montage alors qu'il ne se démonte plus jamais

`ui/navigateurEmoji.tsx:228` · non passé au réfuteur · risque de correction : faible

`useMemo(() => codesEmojiCustom(), [])` est justifié par un commentaire (« le panneau se démonte à la fermeture ») périmé depuis 0313574 : `usePanneauEmoji` monte le panneau une fois pour toutes et ne le démonte JAMAIS. Or `synchroniserEmojisCustom` court APRÈS `pret`, au raccordement — donc à la première installation `customs` vaut `[]`, l'onglet ⭐ n'est pas rendu (condition l.272) et la recherche ne propose aucun custom, alors que `:party_parrot:` s'affiche correctement dans les messages la seconde d'après.

**Correction.** Rendre l'index emoji observable comme les autres stores : compteur de génération dans lib/emojisCustom.ts exposé par un `useSyncExternalStore` (patron déjà en place dans ui/identites.tsx et ui/i18n.ts), et faire dépendre le `useMemo` de cette génération. À défaut, corriger au minimum le commentaire, qui affirme l'inverse du comportement réel.

#### ⚪ basse — Le garde-fou de rendu markdown ne se réarme jamais

`ui/markdown.tsx:56` · non passé au réfuteur · risque de correction : faible

`GardeRendu` pose `casse: true` et rend `this.props.repli` pour toujours : rien ne remet l'état à `false` quand les props changent. La ligne reste montée à travers les éditions, donc un `md` momentanément mal formé fige le message sur son texte nu — sans gras, sans lien, sans emoji — jusqu'au recyclage de la cellule, même après l'édition qui corrige le `md`. Le reste de la chaîne est pourtant remarquablement défensif ; c'est le seul maillon sans réarmement.

**Correction.** `componentDidUpdate(prev) { if (this.state.casse && prev.children !== this.props.children) this.setState({ casse: false }); }`, ou une `key` dérivée de `message.md ?? message.texte` depuis `ContenuMessage`.

#### 🟡 moyenne — Les réactions sont envoyées au serveur mais jamais affichées ni retirables

`app/actions-message.tsx:253` · non passé au réfuteur · risque de correction : faible

La rangée de six pastilles câble `mettre` en dur à `true`, alors que `chat.react` sait aussi retirer. Et la colonne `messages.reactions` est ÉCRITE (lib/normaliser.ts:156, db/upserts.ts:42) mais un grep sur ui/, app/, lib/ ne remonte aucune LECTURE. L'utilisateur tape 👍, la feuille se ferme, rien ne change — ni tout de suite, ni à l'arrivée de l'écho serveur — et il n'a aucun moyen d'annuler. C'est une action offerte sans retour ni annulation, et une colonne SQLite en écriture seule.

**Correction.** Soit retirer la rangée tant que le rendu n'existe pas (ne rien promettre), soit — préférable — rendre les réactions dans ui/ligneMessage.tsx depuis `message.reactions` (pastille par code, compteur, contour accentué si mon username y figure) et passer `mettre = !jaiDejaReagi`. La donnée est déjà en base et déjà rafraîchie par le stream.

#### ⚪ basse — Effets de bord exécutés à l'intérieur d'un updater de setState

`ui/navigateurEmoji.tsx:131` · non passé au réfuteur · risque de correction : faible

`basculer` place `champRef.current?.focus()` et `Keyboard.dismiss()` DANS la fonction passée à `setEtat`. React exige un updater pur : StrictMode le double systématiquement, et un rendu concurrent interrompu le rejoue. Or l'ordre clavier/panneau est précisément ce que le commit 0313574 a eu le plus de mal à stabiliser — un `Keyboard.dismiss()` de trop pendant l'animation peut faire manquer la transition à `useAnimatedReaction` (l.124-129) et laisser le panneau en `cede`, hauteur réservée sous le composer.

**Correction.** Calculer l'état suivant hors de l'updater, appeler `setEtat(suivant)`, puis faire l'effet de bord ; ou déplacer `focus()`/`dismiss()` dans un `useEffect` déclenché par la transition d'`etat`.

#### ⚪ basse — Deux écrans appliquent un état optimiste sans séquencement

`app/parametres.tsx:89` · non passé au réfuteur · risque de correction : faible

`definir` capture `precedente` puis pose la valeur avant d'attendre `users.setPreferences`, sans garde `enVol` ni numéro de séquence (contrairement à app/recherche.tsx:72 et app/recherche-messages.tsx:72). Deux taps rapprochés lancent deux POST concurrents et le `catch` du premier restaure la valeur d'AVANT le second choix : l'UI affiche un niveau que le serveur ne porte pas. Même famille, app/mon-profil.tsx:161-216 enchaîne trois appels (infos, statut, avatar) avec un catch unique qui n'applique aucun `setInitial` — une réémission rejoue le pseudo déjà accepté et peut être refusée, rendant l'écran inutilisable pour la seule étape restante.

**Correction.** Séquence en ref pour `definir` (n'appliquer rollback et message que si `sequence.current === n`), ou garde `enVol` avec les trois options désactivées. Pour `mon-profil`, suivre le succès de chaque étape (vider `avatarLocal` dès `definirAvatar` réussi, `setInitial` champ par champ) et n'énoncer dans le bandeau que ce qui a échoué.

---

### 12. Filet de test là où le code n'est pas atteignable

**Sévérité max** 🟡 moyenne · **risque de correction** nul · **effort** jour

La couverture du dépôt est au-dessus de la moyenne, mais elle s'arrête à une frontière nette : ce qui touche la plateforme (db/depot.ts, lib/server.ts, ui/brouillons.ts, les plugins) et tout `app/` (5 400 lignes, zéro test). Deux points sont pires qu'un simple trou : les faux dépôts MENTENT — leur `transaction: (fn) => fn(depot)` efface l'invariant d'interblocage que db/depot.ts a payé en crash réel — et la crypto E2EE n'est éprouvée que contre `node:crypto`, jamais contre quick-crypto, qui est l'implémentation réellement embarquée. Risque de régression nul par construction : ce chantier ne modifie pas de code de production, et il conditionne le découpage de l'écran salon.

#### 🟡 moyenne — Les faux dépôts exposent le dépôt COMPLET dans `transaction`, ce qui rend indétectable l'interblocage file/transaction

`lib/sync.test.ts:274` · non passé au réfuteur · risque de correction : nul

lib/sync.test.ts:274 et lib/rattrapage.test.ts:45 définissent `transaction: async (fn) => fn(depot)` : le callback reçoit l'objet `Depot` entier, dont les méthodes sont de simples `push`. En production, `transaction` vaut `enSerie(() => brute.withTransactionAsync(() => fn(direct)))` et passe l'écrivain DIRECT, hors file — parce qu'appeler une méthode de la file depuis l'intérieur d'une transaction s'interbloque (db/depot.ts:64-76, lib/sync.ts:88-93). Un refactor qui écrirait `this.depot.upsertMessage` au lieu de `tx.upsertMessage` passerait tsc et les 460 tests, et figerait le premier lot de rattrapage sur l'appareil, pour toujours.

**Correction.** Faire du faux `transaction` un piège : drapeau `enTransaction` posé pendant l'appel, `ecrivainDirect` n'exposant que `EcrituresDepot`, et chaque méthode de premier niveau du faux qui jette « écriture hors file pendant une transaction » si le drapeau est levé. Le test devient le miroir exact de la contrainte.

#### 🟡 moyenne — La crypto E2EE n'est éprouvée que contre `node:crypto` ; quick-crypto n'est couvert par rien

`lib/e2e/crypto.ts:27` · non passé au réfuteur · risque de correction : nul

Les tests valident une implémentation qui n'est jamais celle qui tourne sur l'appareil (metro.config.js alias vers react-native-quick-crypto). Les points de contact sont ceux où deux implémentations OpenSSL divergent le plus : `createDecipheriv('aes-256-gcm')` + `setAuthTag` avec le tag découpé en fin de buffer, `createPrivateKey({format:'jwk'})`, `privateDecrypt` avec `oaepHash: 'sha256'`, et le fait qu'un échec d'authentification doive rendre `null` plutôt que jeter. Une montée de version qui casserait l'un des quatre passerait tsc et les 9 tests, et donnerait « Déverrouillage impossible » sur l'appareil sans qu'aucun signal ne précède.

**Correction.** Harnais exécuté sur l'appareil (ou dans e2e/harnais/) rejouant les vecteurs de crypto.test.ts — enveloppe v2, enveloppe v1, content GCM, content CBC — à travers le module réellement chargé, avec échec bruyant. À défaut, un test Node qui assert au moins la SURFACE utilisée sur le module résolu par l'alias Metro.

#### 🟡 moyenne — `lib/server.ts` n'a aucun test alors qu'il commande tout l'écran de connexion

`lib/server.ts:58` · non passé au réfuteur · risque de correction : nul

`normaliserUrl` porte des règles précises et contre-intuitives, toutes justifiées en commentaire — schéma https supposé, sous-chemin CONSERVÉ (`origin + pathname`) parce qu'un reverse proxy sert souvent Rocket.Chat sous `/chat`, barres rabotées, URL invalide en `ErreurServeur`. `sonderServeur` n'est pas plus couvert : parallélisation, absorption des rejets, `abort()` de la requête sœur, conversion des réglages en `ProfilServeur`. Une « simplification » en `new URL(x).origin` passerait tous les tests et rendrait le serveur inaccessible à tout utilisateur en sous-chemin.

**Correction.** Créer lib/server.test.ts : table de cas pour `normaliserUrl`, et pour `sonderServeur` injecter le fetch (extraire `recupererVersion` derrière le même point d'injection que `ClientRest` — ce qui règle aussi son absence de timeout, chantier transport) puis couvrir `/api/info` non JSON, `settings.public` sans tableau, les drapeaux 2FA/OAuth, et l'annulation qui coupe les deux requêtes.

#### 🟡 moyenne — Le débounce et le flush de sortie d'écran des brouillons ne sont testés nulle part

`ui/brouillons.ts:104` · non passé au réfuteur · risque de correction : faible

La correction du hook dépend d'un détail non exprimé : l'effet de flush a `[ecrire]` en dépendances, et `ecrire` dépend de `[base, cle]` — c'est la SEULE chose qui garantit que le cleanup s'exécute avec l'`ecrire` de l'ANCIENNE clé. Rien ne verrouille cet invariant : ni type, ni test, ni assertion. Quelqu'un qui stabiliserait `ecrire` avec une ref (motif courant) ferait passer l'effet à `[]` : le brouillon du salon A, quitté en moins de 400 ms, serait perdu ou écrit sous la clé de B.

**Correction.** Extraire la mécanique en objet testable sous Node (`creerBrouillonDifferre({ecrire, delaiMs, programmer, annuler})`, horloge injectée comme lib/reconnexion.ts) et couvrir : une frappe → une écriture, deux frappes rapprochées → une seule (la dernière), texte vide → suppression, démontage pendant la pause → flush, CHANGEMENT DE CLÉ pendant la pause → flush sous l'ANCIENNE clé et rien sous la nouvelle. À combiner avec le passage des brouillons dans la file (chantier 2).

#### 🟡 moyenne — Les logiques pures de l'écran salon et de l'accueil sont enfouies dans des composants, donc intestables

`app/salon/[rid].tsx:295` · non passé au réfuteur · risque de correction : faible

`donneesAvecBarre` (l.295-312) tient trois conventions simultanées dans 17 lignes — données DESC donc la DERNIÈRE occurrence est le plus ANCIEN non-lu, liste inversée donc i+1 se rend au-dessus, exclusion de mes propres messages — plus un cas où `client.identifiants` est null et où `moiUid` vaut `undefined` (la barre peut alors se poser au-dessus d'un de MES messages). Même situation pour `useDonneesLissees`, `cheminHistorique`, le prédicat d'épuisement de `chargerPlus`, et pour le regroupement de app/index.tsx:126-148 (masquage `?.ouvert !== false`, remontée sur `alerte`, sections vides retirées). Une « optimisation » en `break` au premier index poserait la barre sous le message le plus récent, sans qu'aucun test ne tombe.

**Correction.** Extraire quatre fonctions pures et les tester : `insererBarreNonLus(donneesDesc, luJusquA, moiUid)`, `useDonneesLissees` déplacé en ui/donneesLissees.ts avec horloge injectable, le prédicat d'épuisement, et `construireSections(salons, abonnements, titres)`. Ces extractions font partie du découpage sans risque du chantier suivant et doivent le PRÉCÉDER.

---

### 13. Une seule source par concept : i18n, couleurs, formats, tables MIME

**Sévérité max** 🟡 moyenne · **risque de correction** faible · **effort** jour

Le commit 4dc5df6 a migré toute l'app vers `t()` — mais quatre îlots ont été manqués et sont invisibles au test de parité FR/EN, puisqu'ils ne sont pas dans le catalogue : l'heure de chaque message formatée en `fr-FR` en dur, l'indicateur de saisie (« bob écrit… »), les messages d'erreur de lib/profilPreload.ts et lib/envoiFichiers.ts qui remontent tels quels à l'écran. Un utilisateur en anglais voit donc des phrases françaises dans une interface anglaise. S'y ajoutent trois définitions concurrentes des couleurs de présence (avec trois teintes différentes pour le même statut) et deux tables MIME→emoji déjà divergentes. Risque faible, gain de cohérence immédiat, et cela prépare le découpage du composer.

#### 🟡 moyenne — L'heure des messages est formatée en `fr-FR` codé en dur, et l'indicateur de saisie est en français hors catalogue

`ui/ligneMessage.tsx:66` · non passé au réfuteur · risque de correction : faible

`toLocaleTimeString('fr-FR', …)` aux lignes 66 et 193 : les DEUX seuls `toLocale*` en dur du dépôt (les autres `toISOString` sont des paramètres d'API). Même famille, `phraseSaisie` (lib/saisie.ts:120-125) construit « bob écrit… », « bob et carol écrivent… », « 3 personnes écrivent… » sans aucune clé — ui/messages.ts n'en contient aucune pour la saisie, donc le test de parité ne voit rien. En anglais : « 14:05 » au lieu de « 2:05 PM », et « bob écrit… » au-dessus du composer.

**Correction.** Un `useHeure()` dans ui/i18n.ts rendant un `Intl.DateTimeFormat` mémoïsé sur la langue active, appelé aux deux emplacements. `phraseSaisie` rend une donnée (`{noms, n}`) et la mise en phrase passe au catalogue (`salon.saisieUn/Deux/N`) ; lib/saisie.test.ts:96-102, qui assert les chaînes françaises, se réécrit sur la forme structurée.

#### 🟡 moyenne — Des messages d'erreur affichés à l'utilisateur sont en français en dur, en doublon de clés existantes

`lib/profilPreload.ts:125` · non passé au réfuteur · risque de correction : faible

`'Profil illisible.'` et `'Profil introuvable.'` en dur alors que `profil.profilIllisible` / `profil.profilIntrouvable` existent au catalogue et sont bien utilisées par app/profil.tsx:141-145 — mais uniquement sur le chemin de chargement ASYNC ; le chemin NOMINAL (`precharge.erreur`) affiche la version en dur. `git log` confirme la cause : le fichier a été créé le 2026-07-13 à 11:49, le commit de migration i18n est du même jour à 17:34. Même motif dans lib/envoiFichiers.ts:85 et :94 (« Fichier trop lourd (maximum X Mo). », « Type X refusé par le serveur. ») et lib/envoi.ts:176, dont les messages remontent tels quels via `setErreurFichier(e.message)`.

**Correction.** Dans lib/profilPreload.ts, `traduireCourant(...)` (prévu exactement pour ce cas, ui/i18n.ts:101). Pour lib/envoiFichiers.ts et lib/envoi.ts — modules purs testés sous Node, qui ne doivent PAS importer l'i18n — faire porter à `ErreurValidation` un code (`'taille'`, `'type'`) plus ses paramètres, et traduire au point d'affichage.

#### 🟡 moyenne — Trois définitions concurrentes des couleurs de présence, avec trois valeurs différentes par statut

`ui/presence.ts:14` · non passé au réfuteur · risque de correction : faible

`COULEURS_PRESENCE` (#2de0a5 / #ffd21f / #f5455c / #9ea2a8, utilisé par la liste et le sous-titre du DM), `PRESENCE` en dur dans app/profil.tsx:33-38 (#3BD16F / #F5B03E / #E8506B / #8A8FA3, avec un commentaire « mêmes mots que le sous-titre d'un DM » faux pour les couleurs), et les jetons du thème (#3ED67F / #FFC24B / #FF7A8A / #5A5573, utilisés par app/mon-profil.tsx). Les libellés sont dupliqués de la même façon : `salon.presence*`, `profil.presence*`, `monProfil.presence*` — douze clés pour quatre mots, déjà divergentes en casse. ui/kit.tsx interdit pourtant explicitement les couleurs en dur.

**Correction.** Faire de `COULEURS_PRESENCE` la seule source, alimentée par les jetons du thème, supprimer la table de app/profil.tsx et le mapping de app/mon-profil.tsx, et réduire les douze clés à quatre `commun.presence*` en laissant la casse à l'appelant.

#### ⚪ basse — Deux tables MIME→emoji, déjà divergentes sur le cas audio

`ui/apercuPieceJointe.tsx:34` · non passé au réfuteur · risque de correction : faible

`emojiFichier` (ui/apercuPieceJointe.tsx:34-40) et `emojiPiece` (app/partager.tsx:387-394) sont la même correspondance écrite deux fois ; `emojiPiece` traite `audio/` → 🎵, l'autre non. Le voisinage est dupliqué de même (`estImage` à deux endroits, vignette dégradée reconstruite dans `VignettePiece`). Toute famille ajoutée à l'une ne le sera pas à l'autre.

**Correction.** Exporter une seule fonction (depuis ui/apercuPieceJointe.tsx ou un ui/mime.ts), avec la branche `audio/` — inoffensive pour l'aperçu du composeur, qui détourne l'audio vers `LecteurAudio` — et supprimer `emojiPiece`.

#### ⚪ basse — Le corps des messages markdown ne porte aucune famille de police

`ui/markdown.tsx:306` · non passé au réfuteur · risque de correction : faible

ui/markdown.tsx n'importe jamais `POLICES` : `styles.paragraphe` ne déclare que `fontSize`/`lineHeight`, et le `<Text>` du bloc PARAGRAPH n'est imbriqué dans aucun `<Text>` parent (uniquement des `<View>`), donc rien n'est hérité. Le corps de tout message ayant un `md` sort en police système, à côté du repli de `GardeRendu` et du texte cité qui sont en Nunito. S'y ajoutent trois `fontWeight` alors que ui/theme.ts:189-206 documente une famille PAR graisse et conclut « ne jamais y adjoindre de fontWeight » (faux-gras synthétique d'Android). Même oubli dans app/recherche.tsx et app/recherche-messages.tsx.

**Correction.** `fontFamily: POLICES.corps` sur `paragraphe` et `texteItem`, et remplacer les `fontWeight` par les familles (`POLICES.titre`, `corpsGras`, `corpsSemi`) — les deux ensemble, jamais l'un sans l'autre.

#### ⚪ basse — Les composants médias codent en dur des couleurs sombres, ce qui invalide la promesse « trois retouches » du thème

`ui/visionneuse.tsx:240` · non passé au réfuteur · risque de correction : faible

ui/theme.ts:10-17 affirme que rebrancher la bascule de thème « demandera TROIS retouches ». C'est déjà faux : `rgba(4,3,10,0.94)` (visionneuse), `rgba(12,11,22,0.80)` et `:186` (lecteurVideo), `#00000020` et `rgba(12,11,22,0.42)` (carteEmbed), carteLien:197-202 — et ui/kit.tsx lui-même (`couleurTexte = '#FFFFFF'`, une boxShadow en dur) tout en affirmant « jamais de couleur en dur ici ». Le jour de la bascule, ce sera une chasse aux teintes dans six fichiers, et un voile noir à 80 % sur fond blanc.

**Correction.** Ajouter les deux jetons qui manquent réellement (`voileMedia`, `fondPleinEcran`) aux deux jeux et remplacer les six littéraux. Corriger la phrase « TROIS retouches » de theme.ts : elle sert de contrat, elle doit rester vraie ou disparaître.

---

### 14. Duplication structurelle et découpage de l'écran salon

**Sévérité max** 🟡 moyenne · **risque de correction** moyen · **effort** plusieurs-jours

Trois copier-collers ont déjà coûté ou coûteront un correctif écrit deux fois : `rattraperMisAJour` / `rattraperSupprimes` (le commit ffe1f7c a dû appliquer le MÊME correctif de curseur dans deux hunks du même commit), le composer salon / composer fil (le fil n'a pas la fermeture du clavier avant sélecteur qui corrige le NPE d'arbre de vues, il la reproduira le jour où il gagne les pièces jointes), et le débounce des deux écrans de recherche (déjà divergé). Ajouter à cela l'écran salon à 1 397 lignes, dont deux composants se déplacent SANS RISQUE (props uniquement, stores module-level) et le ramènent à ~450 lignes. Placé en fin de séquence délibérément : c'est du refactor pur, donc à faire quand les tests des chantiers précédents sont en place et qu'aucune correction fonctionnelle n'est en vol dans ces fichiers.

#### 🟡 moyenne — `app/salon/[rid].tsx` mélange trois responsabilités sur 1 397 lignes ; deux sont extractibles sans aucun risque

`app/salon/[rid].tsx:161` · non passé au réfuteur · risque de correction : faible

Le fichier porte le moteur de liste (l.161-706), le composer complet (l.708-1156 : sélecteurs, audio, emojis, mentions, citations, contournement du NPE), l'en-tête (l.1158-1291), un utilitaire REST Rocket.Chat (`cheminHistorique`) et un hook générique (`useDonneesLissees`). Conséquence déjà visible dans cet audit : les trois défauts les plus coûteux du domaine (double rattrapage, `n > 1`, cadence de `marquerLu`) vivent dans la même soupe d'effets que le choix d'un fichier joint. L'historique montre trois correctifs successifs sur le seul lancement du sélecteur (ad8ecec, e06f658, c9e6694).

**Correction.** Déplacements PURS, aucune ligne de logique modifiée : `Composer` + `ComposerChiffre` + `assetVersFichier` → ui/composerSalon.tsx (~420 l., 11 props explicites, couplages externes uniquement par stores module-level) ; `EnTeteSalon` → ui/enTeteSalon.tsx (~135 l., props uniquement) ; `useDonneesLissees` → ui/donneesLissees.ts ; `cheminHistorique` → fournisseurs/rocketchat/. NE PAS extraire `useFluxSalon` (limite/fraiches/donnees/presDuBas/dernierSuivi/passeEpuise s'arbitrent mutuellement, et l'idiome inversé est une cicatrice mesurée) tant que les fonctions pures ne sont pas testées.

#### 🟡 moyenne — Le composer du fil est une copie divergée du composer du salon

`app/fil/[id].tsx:330` · non passé au réfuteur · risque de correction : moyen

`ComposerFil` reprend point par point `Composer` : même `useCompletionEmoji`, même `usePanneauEmoji`, même couple `useReponse`/`annulerReponse` + `useRetourMateriel`, même `changer`/`changerBrouillon`, même `envoyer`, mêmes bandeaux — et jusqu'au commentaire « Jetons `:` et `@` mutuellement exclusifs » recopié mot pour mot. Les divergences sont déjà là : bordure différente, AUCUNE famille de `POLICES` (donc l'écran fil s'affiche en police système), bouton d'envoi textuel au lieu de la tuile ➤, et quatre clés de traduction dupliquées (`fil.chiffre` = `salon.chiffre`, etc.). Le fil n'a surtout pas le `fermerEmoji()` + `Keyboard.dismiss()` que le salon fait avant de lancer un sélecteur.

**Correction.** Extraire `ui/composer.tsx` portant le tronc commun, paramétré par ce qui diffère réellement (présence 📎/🎤, clé de réponse `rid` vs `rid:filId`, `filId` passé à `envoi.envoyer`, placeholder). Prérequis : le déplacement du composer salon ci-dessus. Fusionner les clés `fil.*` dupliquées dans `commun.*`.

#### 🟡 moyenne — `rattraperMisAJour` et `rattraperSupprimes` sont deux copies de la même boucle de pagination

`lib/rattrapage.ts:227` · ✅ vérifié · risque de correction : moyen

Les deux fonctions ont la même structure ligne pour ligne : boucle `for (page < PAGES_MAX)`, `pageCurseur`, garde `estAbandonne`, calcul de `suivant`, branche « dernière page » avec avancée sur le plus grand horodatage ingéré, écriture du curseur, `console.warn` de plafond. Seuls le `type`, le nom de flux et le corps d'ingestion diffèrent. `git show ffe1f7c` montre que le correctif « faire avancer le curseur sur la DERNIÈRE page » a été appliqué DEUX fois dans le même commit, avec « voir rattraperMisAJour, même raisonnement » comme seul lien.

**Correction.** `paginerCurseur(client, rid, type, flux, depuis, estAbandonne, appliquer)` portant la boucle, le curseur et le plafond, avec en paramètre le seul `appliquer(resultat) => Promise<number | null>` qui rend le plus grand horodatage traité. Les deux appelants tombent à trois lignes. À faire APRÈS la déduplication par rid (chantier 5), qui touche le même fichier.

#### 🟡 moyenne — Débounce + garde de séquence recopiés entre les deux écrans de recherche

`app/recherche.tsx:85` · non passé au réfuteur · risque de correction : faible

Le même bloc — `sequence = useRef(0)`, `const n = ++sequence.current`, `setTimeout(…, propre === '' ? 0 : 300)`, court-circuit sur requête vide, `if (sequence.current !== n) return` dans le `.then` ET le `.catch`, `clearTimeout` au cleanup — dans les deux écrans, le second l'admettant en commentaire (« Même idiome que le spotlight »). La copie a déjà divergé sur le nettoyage du message d'erreur (voir chantier 1).

**Correction.** `useRechercheDebouncee<T>(requete, chercher, delaiMs = 300)` encapsulant minuterie, garde de séquence et remise à zéro complète (résultats ET message) sur requête vide.

#### 🟡 moyenne — « Ouvrir ou créer un DM » est implémenté deux fois, avec deux traitements différents de la réponse

`app/profil.tsx:180` · non passé au réfuteur · risque de correction : faible

app/profil.tsx:180-186 poste `im.create`, garde `typeof rid !== 'string'` et ingère conditionnellement le salon ; app/recherche.tsx:119-121 fait le même POST mais passe la réponse à un helper local avec un cast `as string | undefined`. Les deux ont déjà divergé sur la validation et sur la gestion d'erreur (catch vs finally), et aucun ne passe par `ActionsFournisseur`.

**Correction.** `ouvrirOuCreerDm(username): Promise<{ rid, salonBrut }>` sur `ActionsFournisseur`, implémenté une fois dans fournisseurs/rocketchat/actions.ts avec la garde de type. Les deux écrans n'ont plus qu'à appeler et naviguer.

#### ⚪ basse — Le rendu des images de pièce jointe est écrit deux fois dans le même fichier, avec des bornes différentes

`ui/ligneMessage.tsx:355` · non passé au réfuteur · risque de correction : faible

`FichierCite` (l.355-381) et la branche image de `PiecesJointes` (l.485-527) refont la même séquence — source `title_link ?? image_url` avec le même commentaire justificatif, `urlFichierProtege`, ratio avec le même `Math.max(…, 1)` défensif, `Pressable` + visionneuse + `Image cover` — avec des bornes déjà divergées (72..200 sur 200 fixe vs 120..400 sur `dispoLargeur`). `Math.min(largeurEcran - 92, 380)` est en outre dupliqué à l'identique dans ui/carteLien.tsx:45.

**Correction.** `<ImageJointe c jointe client largeurMax hauteurMin hauteurMax surAppuiLong />` portant le choix de source, l'URL protégée, le gabarit et l'ouverture ; exporter `largeurDispoCorps(largeurEcran)` depuis ui/theme.ts.

#### ⚪ basse — Code mort : `couleursClaires` et cinq clés de traduction inutilisées

`ui/theme.ts:141` · non passé au réfuteur · risque de correction : faible

`couleursClaires` (~28 lignes de jetons) n'est référencée que par un commentaire, `useCouleurs` rendant toujours `couleursSombres`. Cinq clés ne sont référencées par aucun fichier (`commun.erreur`, `commun.chargement`, `commun.copier`, `commun.ok`, `salon.chiffre` — ce dernier doublon mot pour mot de `fil.chiffre`), soit dix entrées mortes sur les deux catalogues.

**Correction.** Supprimer (Git garde) ou brancher `couleursClaires` derrière `useColorScheme()` en même temps que les jetons `voileMedia`/`fondPleinEcran` du chantier précédent ; retirer les cinq clés.

---

### 15. La façade Fournisseur : ce qui nomme Rocket.Chat doit passer par elle

**Sévérité max** 🟡 moyenne · **risque de correction** moyen · **effort** jour

L'abstraction est propre et exhaustive sur la synchro et les actions, mais elle est court-circuitée exactement là où elle compte : l'écran salon importe `rattraperSalon` de lib/rattrapage.ts, nomme trois endpoints REST (`channels/groups/im.history`) et fabrique lui-même les clés de stream `${rid}/deleteMessage` et `${rid}/user-activity`. Il existe donc DEUX chemins pour le même rattrapage, l'un routé, l'autre codé en dur — et le format de clé Rocket.Chat est dupliqué dans deux écrans plus `sujetDe`. Gain purement structurel, aucun bug utilisateur aujourd'hui : à faire en dernier, quand le découpage de l'écran salon a déjà déplacé `cheminHistorique`.

#### 🟡 moyenne — L'interface `Fournisseur` n'a pas de couture pour les abonnements PAR SALON

`lib/fournisseur.ts:208` · non passé au réfuteur · risque de correction : moyen

L'en-tête pose la règle (« tout ce qui nomme un endpoint /api/v1/* ou un stream stream-* doit à terme passer par ici ») et le contrat prévoit `souscriptionsInitiales()` pour les abonnements GLOBAUX. Rien ne couvre l'abonnement au salon ouvert — pourtant permanent : app/salon/[rid].tsx:358-360 et app/fil/[id].tsx:205-206 importent `STREAM_MESSAGES`/`STREAM_NOTIFY_ROOM` de lib/sync.ts et fabriquent les clés à la main. Le format « rid + / + sujet » est ainsi dupliqué dans deux écrans, dans `sujetDe` et dans un commentaire de ui/salonChaud.ts.

**Correction.** `souscriptionsSalon(rid): readonly (readonly [nom, cle])[]` symétrique de `souscriptionsInitiales`, implémentée dans fournisseurs/rocketchat/index.ts, les écrans bouclant sur son résultat. Cela retire aussi de app/ les imports de noms de streams.

#### 🟡 moyenne — L'écran salon contourne la façade en appelant l'implémentation Rocket.Chat en direct

`app/salon/[rid].tsx:44` · non passé au réfuteur · risque de correction : moyen

lib/fournisseur.ts:216-218 expose `rattraperSalon(moteur, rid, estAbandonne)` et ui/synchro.tsx l'appelle bien par ce chemin, mais l'écran importe la fonction de lib/rattrapage.ts avec le `ClientRest` en main. Le même écran nomme `channels.history`/`groups.history`/`im.history` (`cheminHistorique`), et app/fil/[id].tsx appelle `chat.getMessage` et `chat.getThreadMessages` en direct. Un second driver (Mattermost, prévu par `Genre`) verrait chaque ouverture de salon émettre `chat.syncMessages` sur une route inexistante.

**Correction.** Ajouter `chargerHistorique(rid, type, latest)` à l'interface `Fournisseur` (implémenté côté RC par `cheminHistorique` + `chat.getThreadMessages`) et faire passer l'écran par `synchro.fournisseur` pour le rattrapage comme pour l'historique — le fournisseur est déjà porté par le contexte. À faire APRÈS la déduplication par rid (chantier 5), dont c'est le prolongement naturel.

#### 🟡 moyenne — Le permalien de citation est bâti sur `client.baseUrl` alors que le serveur n'accepte que `Site_Url`

`lib/citation.ts:21` · non passé au réfuteur · risque de correction : faible

La doc du module le dit elle-même (l.18) : le hook `BeforeSaveJumpToMessage` ne reconnaît une citation que si l'URL COMMENCE PAR `Site_Url`. `lib/server.ts:142-147` récupère bien `siteUrl`, mais un grep ne rend que ces trois lignes : la valeur n'est stockée ni dans la `Session` ni lue nulle part. Dès que l'URL saisie diffère (alias de proxy, IP, port, http/https — cas du banc émulateur : `10.0.2.2:3300` vs `localhost:3300`), le serveur n'attache pas `message_link`. Pire que « pas de bloc » : l'affichage optimiste MONTRE la citation, puis l'écho serveur écrase `piecesJointes` et `sansLiensDeCitation` retire le lien brut du corps — le message final ne porte plus aucune trace de ce à quoi il répondait.

**Correction.** Propager `siteUrl` du sondage jusqu'à la `Session` (déjà lu) et faire de `permalienMessage` un consommateur de `siteUrl ?? baseUrl` — zéro appel réseau supplémentaire, repli identique au comportement actuel quand le réglage manque. Test dans lib/citation.test.ts avec `baseUrl !== siteUrl`.

#### ⚪ basse — `lib/`, déclaré « cœur non-UI », pilote la navigation

`lib/profilPreload.ts:22` · non passé au réfuteur · risque de correction : faible

Le module importe `{ router } from 'expo-router'` et l'appelle en 113 et 164 ; il tient en plus un client REST en singleton, un cache et un store d'état avec écouteurs. C'est la seule inversion de dépendance du dépôt (le seul autre franchissement, lib/messagesSysteme.ts → ui/messages.ts, est un `import type` consigné). Conséquence directe et mesurable : c'est le seul module de lib/ sans `.test.ts`, parce qu'il n'est pas chargeable sous Node — donc la course entre `users.info`, la sonde d'appel et le plafond de 2 s reste entièrement non testée.

**Correction.** Rendre le module pur : `precharger(p): Promise<ProfilBrut | null>` qui renvoie la décision, la navigation restant à l'appelant. Si l'appel depuis ui/markdown.tsx impose un singleton, `definirNavigateurProfil((p) => router.push(...))` depuis ui/, sur le modèle de `definirClientProfil` déjà en place.

---

### 16. Remettre la documentation d'accord avec le code

**Sévérité max** 🟡 moyenne · **risque de correction** nul · **effort** heures

CLAUDE.md désigne EXECUTION.md comme « source de vérité sur où on en est » et ce fichier a 110 commits de retard : ni l'E2EE en lecture, ni les appels Jitsi, ni l'i18n, ni les citations, ni la façade multi-fournisseur, ni les caches de salon n'y figurent — et sa table d'avancement affirme que l'étape 9 est iOS alors que le corps du document dit thème. Symétriquement, ROADMAP.md §4.2, EXECUTION.md:52 et CLAUDE.md:50 déclarent la WebView « interdit ferme » alors que react-native-webview est une dépendance ordinaire et que l'écran d'appel la monte en plein écran — au point que ui/carteEmbed.tsx cite comme autorité la section que l'écran d'appel viole. Risque nul, coût d'une heure, et cela évite qu'une session future réimplémente ou supprime du travail livré.

#### 🟡 moyenne — EXECUTION.md, déclaré source de vérité, a 110 commits de retard et sa table renumérote les étapes à faux

`EXECUTION.md:77` · ✅ vérifié · risque de correction : nul

`git log -1 -- EXECUTION.md` donne ee1a4aa et `git rev-list --count ee1a4aa..HEAD` donne 110. Absents du document : E2EE en lecture complète (8 commits), appels Jitsi, i18n EN/FR, citations, façade multi-fournisseur, rattrapage WorkManager du push, caches de salon — qui portent pourtant des décisions de perf mesurées. La table « État d'avancement » liste « 9 | iOS | ☐ » alors que le corps porte « Étape 9 — Thème visuel » (9.4 non cochée) et « Étape 10 — iOS ».

**Correction.** Corriger la table pour refléter la numérotation réelle (9 = thème, partiel ; 10 = iOS) et ajouter une section « Étape 11 — travaux post-thème » listant en une ligne chacune les briques livrées depuis ee1a4aa, avec renvoi au fichier qui porte la justification. Ou, si la cérémonie est vraiment levée, corriger CLAUDE.md:7 pour que le fichier ne se prétende plus source de vérité.

#### 🟡 moyenne — La WebView de l'écran d'appel n'est consignée dans aucun des trois documents qui la déclarent interdite

`ROADMAP.md:150` · ✅ vérifié · risque de correction : nul

ROADMAP.md:150, EXECUTION.md:52 et CLAUDE.md:50 posent « toute WebView » en interdit ferme, jamais amendé. Or react-native-webview 13.16.1 est une dépendance ordinaire (package.json:45) et app/appel/[callId].tsx:164 la monte en plein écran ; la justification n'existe que dans les commentaires du code (l.22-29, lib/appel.ts:16-19). Pire, ui/carteEmbed.tsx:4 et lib/liensVideo.ts:10 écrivent « une WebView (interdite, ROADMAP §4.2) » — la section même que l'écran d'appel viole.

**Correction.** Amender ROADMAP §4.2 d'une ligne d'exception bornée (« react-native-webview — UNIQUEMENT app/appel/[callId].tsx, Jitsi étant une web-app ; le SDK natif vise RN ~0.79 et embarque react-native-webrtc »), en reprenant le raisonnement déjà écrit dans lib/appel.ts, et répercuter le « sauf l'écran d'appel » dans EXECUTION.md:52 et CLAUDE.md:50.

---

## L'ordre d'attaque, et pourquoi

1. Le lot d'une ligne — sept correctifs vérifiés, chacun dans un seul fichier, dont deux de sévérité haute ; c'est le meilleur rapport gain/risque du dépôt et deux d'entre eux (la génération non bumpée par l'E2EE, la garde d'upload) sont des prérequis de chantiers ultérieurs.

2. Une file d'écritures par connexion SQLite — deux lignes dans db/client.ts qui rendent impossible la seule race capable d'annuler un lot en silence ; no-op strict sur le chemin nominal, donc à passer avant tout ce qui touchera à la base.

3. Zéro secret hors du processus — le seul constat critique de l'audit (le jeton dans Chrome) plus trois fuites de la même famille ; indépendant de tout le reste, donc à faire dès que la surface est calme.

4. Ce qui entre en base doit être juste — corrections de fonctions pures et de SQL statique, avec les tests de lib/normaliser.test.ts écrits dans le même commit ; à faire avant les chantiers de purge, qui manipulent les mêmes tables.

5. Rattrapage de salon dédupliqué — la déduplication vit dans lib/rattrapage.ts, donc aucune signature d'appelant ne bouge ; elle suppose acquis le correctif de `generation` (chantier 1) et doit embarquer la pile `salonActif`, sans quoi elle transforme une dette en perte réelle de rattrapage.

6. Cycle de vie de la donnée locale (purge, curseurs, rétention) — on touche des DELETE, donc après le chantier normalisation et avec les tests de dépôt écrits d'abord ; la race de réconciliation est la seule du lot qui fasse disparaître une donnée visible.

7. File de téléversements — le plus gros chantier fonctionnel : écrire D'ABORD les tests absents (statut 0, SQL de la file), puis le bandeau « en attente » qui supprime la disparition silencieuse, puis seulement la migration `file_id` qui supprime le doublon.

8. Transport DDP et REST — sonde de vie, suspension du pilote en arrière-plan, timeout d'`/api/info`, sommeil 429 interruptible ; modules déjà bien couverts, à traiter d'un bloc pour ne payer qu'une seule campagne de tests de reconnexion.

9. Session morte et fin de session — placé ici parce que la déconnexion automatique sur 401 est la correction la plus dangereuse de l'audit : écrire le prédicat `estJetonRefuse` et son test à quatre cas AVANT de le brancher, et faire d'abord la partie clé E2EE indexée par compte, qui est sans risque.

10. Push natif — un seul passage, un seul cycle prebuild + assembleRelease (statut testé sans pipe) ; y embarquer la validation d'hôte du chantier 3 pour ne pas payer deux builds.

11. Écrans : boucles sans borne et attentes fixes — indépendant du reste, mais après le chantier rattrapage qui touche déjà app/salon/[rid].tsx, pour ne pas empiler deux séries de modifications sur le même fichier.

12. Filet de test là où le code n'est pas atteignable — risque nul par construction, et impératif AVANT le découpage : les faux dépôts qui mentent sur `transaction` et les fonctions pures de l'écran salon sont exactement ce qui protégera le refactor suivant.

13. Une seule source par concept (i18n, couleurs, formats, MIME) — prépare le composer partagé en supprimant les divergences de style et de clés entre salon et fil.

14. Duplication structurelle et découpage de l'écran salon — refactor pur, à faire quand plus aucune correction fonctionnelle n'est en vol dans ces fichiers et que les tests des chantiers 12 et 13 sont en place ; commencer par les quatre déplacements sans risque, laisser le moteur de liste tranquille.

15. La façade Fournisseur — prolongement naturel du chantier 5 et du découpage (`cheminHistorique` a déjà migré) ; gain structurel seul, aucun bug utilisateur en attente.

16. Documentation — une heure, risque nul, à faire en dernier pour que EXECUTION.md décrive l'état réel après tous les chantiers plutôt qu'un état intermédiaire.


---

## À ne pas toucher

Ce qui a été signalé au cours de l'audit mais qu'il vaut mieux laisser tel quel — soit parce que le risque de correction dépasse le gain, soit parce que c'est un choix délibéré.

- La double lecture de `raccorder` (lib/raccordement.ts:89 et 104, deux `rattraperTout` par raccordement). Le constat est réel — 2 x rooms.get + 2 x subscriptions.get à chaque retour au premier plan, sur une route à 10 req/min — mais la seconde lecture est CE qui garantit qu'aucun document ne tombe entre la lecture et l'armement des souscriptions. La rendre conditionnelle touche le cœur du raccordement, sans test de non-régression aujourd'hui. À reprendre seulement après le chantier « rattrapage dédupliqué » (qui supprime déjà l'essentiel du gaspillage) ET une fois lib/raccordement.test.ts étendu.

- Le découplage de l'effet `SynchroProvider` d'avec l'objet `etat` (clé `baseUrl|userId|authToken` en dépendance). Proposé par deux relecteurs, contredit par un troisième après vérification : `TraducteurRC` et `MoteurEnvoi` capturent `session.username` à la construction (fournisseurs/rocketchat/index.ts:40), donc figer la clé casse le nom affiché et `dmAutreUsername` des DM après un renommage. Le vrai correctif (mémoïser la file d'écritures avec la connexion) supprime le danger sans toucher aux dépendances ; la reconstruction gratuite du moteur sur renommage devient alors un simple gaspillage, à traiter plus tard avec un traducteur qui relit son pseudo.

- Les 24 erreurs eslint react-hooks/immutability et refs de ui/visionneuse.tsx et ui/lecteurAudio.tsx. Vérifié : ce sont des écritures de `SharedValue` dans des worklets de geste, c'est-à-dire l'API normale de Reanimated que la règle (modèle React Compiler) ne modélise pas. `remettreAPlat` porte bien sa directive `'worklet'`. Le seul cas litigieux, `moi.current.pause = …` écrit pendant le rendu, est bénin (le coordinateur compare l'identité de l'objet, jamais la closure). Y toucher ne ferait qu'ajouter des indirections.

- L'idiome « liste inversée + maintainVisibleContentPosition coupé » et le lissage des entrants de app/salon/[rid].tsx (commentaire l.74-99), ainsi que la clé de tri secondaire `desc(messages.id)`. Ce sont des cicatrices mesurées, pas des bizarreries ; le découpage du fichier ne doit toucher ni au moteur de liste ni à ces réglages.

- Le `setTimeout` de ui/lancerSelecteur.ts. C'est le seul délai fixe du dépôt qui soit explicitement argumenté (NPE d'arbre de vues Android au lancement d'un sélecteur, trois correctifs successifs : c9e6694, e06f658, ad8ecec). La règle « pas d'attente comme correctif » vise les synchronisations de données, pas les contournements de bug de plateforme documentés.

- `fermerBase` (db/client.ts:45) : ne PAS l'appeler dans le cleanup de `SynchroProvider`. La connexion est partagée et le cleanup court pendant que des écritures de l'ancien moteur peuvent encore être en vol — fermer sous elles est pire que de laisser la connexion ouverte. Le bon geste est de documenter le choix dans db/client.ts et de filtrer `databaseName` dans ui/requeteVive.ts (constat retenu), pas d'appeler la fonction.

- L'exception WebView de app/appel/[callId].tsx. Le SDK Jitsi natif vise RN ~0.79 et embarque react-native-webrtc : l'exception est justifiée et doit rester. Ce qu'il faut, c'est la consigner dans ROADMAP §4.2 et la borner à une origine — pas la remettre en cause.

- `Push_request_content_from_server` (push sans contenu, `push.get` à la réception). C'est une décision utilisateur datée (2026-07-16 : rien chez Google/Apple). Tous les constats push doivent composer avec, jamais proposer de la lever.

- Ne pas passer d'`_id` client à `rooms.mediaConfirm` pour dédupliquer les uploads : le schéma serveur est `additionalProperties: false`. La déduplication doit passer par la persistance du `fileId` côté client, comme retenu dans le chantier téléversements.

- Ne pas retirer l'appui long de app/salon/[rid].tsx:584 et app/fil/[id].tsx:245 pour régler la feuille d'actions vide : ce serait la même règle dupliquée dans deux écrans, et cela supprimerait le retour haptique qui confirme que l'appui a pris. Le repli se fait dans app/actions-message.tsx.


---

## Les constats réfutés

7 constats de sévérité haute ou critique ont été **démolis** par le réfuteur adversarial. Ils sont consignés ici pour qu'une session future ne les redécouvre pas.

### Un `ready` suivi de la mort de la socket dans le même tour JS marque la souscription comme établie sur une socket morte — elle n'est plus jamais ré-armée

`lib/ddp.ts`

**Le code décrit est exact ; le déclencheur, lui, n'existe pas sur l'architecture imposée par le projet.**

1. Ce que dit le code (lu en entier, `lib/ddp.ts` 1-589). `etablir()` l.330-345 ne teste que `this.desirees.get(cle) !== entree` ; `nettoyer()` l.566-569 remet `s.id = null` de façon synchrone ; `etablir()` l.325 sort sur `entree.id !== null`. J'ai rejoué le scénario dans un harnais Node (FauxWebSocket, `recevoir({msg:'ready'})` puis `onclose(null)` dans le MÊME tour synchrone, sans laisser drainer les microtâches) : `etat= ferme  etablies= 1  desirees= 1`, puis reconnexion complète → `subs sur la nouvelle socket = 0`. Le mécanisme interne est donc réel, et `lib/ddp.test.ts` (505 l., lu en entier) ne le verrouille pas : le test le plus proche, « la fermeture de la socket laisse la négociation retomber proprement » (l.310), ferme AVANT le `ready`.

2. Mais la prémisse « batch du pont RN : plusieurs événements natifs sont livrés avant le drain des microtâches » est fausse pour RN 0.86 en New Architecture — qui est obligatoire ici (CLAUDE.md, et le bridge legacy n'existe plus depuis 0.82). Chaîne vérifiée dans `node_modules/react-native` :
   - `ReactAndroid/.../modules/websocket/WebSocketModule.kt` l.62-65, 167/185 : chaque événement passe par `reactAppContext.emitDeviceEvent(...)` — un appel par événement, `websocketMessage` comme `websocketClosed`.
   - `runtime/BridgelessReactContext.kt` l.156-162 : `emitDeviceEvent` → `reactHost.callFunctionOnModule("RCTDeviceEventEmitter","emit",…)`.
   - `ReactCommon/react/runtime/ReactInstance.cpp` l.300-314 + l.159-162 : `callFunctionOnModule` → `bufferedRuntimeExecutor_` → `runtimeScheduler->scheduleWork(...)`.
   - `RuntimeScheduler.cpp` l.26 : sous `enableBridgelessArchitecture()` c'est `RuntimeScheduler_Modern`. Et `ReactNativeFeatureFlagsOverridesOSSStable.h` l.16-19 force ce flag à `true` pour toute app OSS publiée.
   - `RuntimeScheduler_Modern.cpp` l.293-322 : `runEventLoop` boucle sur `runEventLoopTick`, et **chaque tick fait `executeTask(...)` PUIS `performMicrotaskCheckpoint(runtime)`** (l.313-315), lequel appelle `runtime.drainMicrotasks()` en boucle jusqu'à épuisement (l.414-421, non borné).

   Autremen

*(justification tronquée)*

### Un `result` de login suivi de la mort de la socket dans le même tour laisse le client « authentifié » avec `ws === null` — le pilote croit le stream actif et ne reconnecte plus

`lib/ddp.ts`

## Ce que j'ai lu

- `lib/ddp.ts` en entier (589 l.), `lib/ddp.test.ts` en entier (598 l.), `lib/reconnexion.ts`, `ui/synchro.tsx`.
- Les sources React Native 0.86 présentes dans `node_modules` (chemin de livraison réel des événements WebSocket).

## Le mécanisme décrit est exact — sur un modèle qui n'existe pas en production

J'ai d'abord rejoué le scénario pour ne pas le rejeter à la légère (script jetable, `FauxWebSocket` du fichier de test) :

```
memeTour=true  -> connecter resolue; etat=authentifie; pertes=1; subs=0/1; wsFerme=false
   subs envoyees sur le fil: 0 ; garde active ? true
memeTour=false -> connecter resolue; etat=ferme;       pertes=1; subs=0/1; wsFerme=false
   subs envoyees sur le fil: 1 ; garde active ? false
```

Donc oui : SI `onmessage({result})` puis `onclose()` sont invoqués dans **la même macro-tâche JS**, le client finit `etat='authentifie'` avec `ws === null`, zéro `sub` partie, garde relancée — exactement le zombie annoncé. Le relecteur a raison sur la mécanique interne.

Mais `memeTour=true` n'est pas un modèle du transport : c'est le test qui appelle `ws.onclose?.(null)` à la main, à la ligne suivante, sans laisser la file de micro-tâches se vider. Il faut donc démontrer que le vrai transport peut produire ça.

## Le vrai transport ne peut pas le produire

Seul appelant de production : `fournisseurs/rocketchat/index.ts:39` → `new ClientDdp(urlWebSocket(...))` **sans** `creerWebSocket`, donc `lib/ddp.ts:153` → le `WebSocket` global de React Native. Aucun autre injecteur hors tests (grep sur `creerWebSocket|new ClientDdp`).

Chaîne réelle d'un événement WebSocket Android, vérifiée dans les sources :

1. `ReactAndroid/.../websocket/WebSocketModule.kt` — `onMessage` (l.185) et `onClosed` (l.167) appellent chacun `sendEvent(...)` → `reactAppContext.emitDeviceEvent(...)`. Deux appels distincts.
2. `runtime/BridgelessReactContext.kt:156` — `emitDeviceEvent` → `reactHost.callFunctionOnModule("RCTDeviceEventEmitter", "emit", …)`, **un appel par événement**.
3. `ReactCommon/react/runtime/ReactInstance.cpp:310` — `bufferedRuntimeExecutor_->execute(...)`. `BufferedRuntimeExecutor.cpp` : hors phase de démarrage, chemin rapide `runtimeExecutor

*(justification tronquée)*

### Le jeton de session peut être envoyé à un hôte arbitraire dicté par le push (repli mono-session + aucune vérification du host ni du schéma)

`plugins/with-fcm-deeplink.js`

J'ai lu `plugins/with-fcm-deeplink.js` en entier (760 l.), `lib/sessionStore.ts`, `lib/server.ts`, `lib/push.ts`, `lib/pushToken.ts`, `ui/notifications.tsx`, le manifeste généré `android/app/src/main/AndroidManifest.xml` + `src/debug/AndroidManifest.xml`, `docker/.env`, `.gitignore`, et `git log -- plugins/with-fcm-deeplink.js`.

CE QUI EST EXACT DANS LE CONSTAT (mécanique du code) : oui, `lireSession` (l.581-607) retourne `repli` quand `nbCandidats == 1` même si aucun `baseUrl` ne matche (l.602), et `recupererContenu` (l.647-686) construit l'URL à partir du `host` du push (l.655-657) puis y pose `X-User-Id`/`X-Auth-Token` (l.660-661). Il y a bien une rupture d'invariant : la seule chose qui garantit « le jeton ne part qu'au serveur auquel il appartient » est l'égalité exacte, et le repli la casse.

MAIS LA PRÉMISSE DE MENACE EST FAUSSE, donc le scénario n'est pas atteignable :

1. **« Tout serveur Rocket.Chat capable de pousser vers cette app détient les identifiants Firebase de l'app » — l'implication est inversée.** Pour délivrer un data-message à ce token il faut signer une requête FCM HTTP v1 avec la CLÉ PRIVÉE d'un compte de service du projet Firebase de l'app. Cette clé n'est ni dans l'APK ni dans le dépôt (`google-services.json` est gitignoré — et le fichier client ne permet de toute façon PAS d'émettre en HTTP v1 ; le server key legacy n'existe plus, cf. `Push_UseLegacy=false` dans CLAUDE.md). Le serveur adverse « collecte.example » ne peut donc pas pousser. Un serveur tiers auquel l'utilisateur se connecte reçoit le token FCM (`lib/pushToken.ts`, `POST push.token`) mais un token n'autorise pas l'émission. Et le gateway RC Cloud ne route que vers les app-ids officielles (CLAUDE.md). L'ensemble des émetteurs possibles = {celui qui détient le compte de service Firebase} = le serveur de l'utilisateur lui-même, c'est-à-dire précisément le propriétaire du jeton volé. Pas d'escalade.

2. **Le service est fermé aux applis locales** : `android:exported: 'false'` (l.724 du plugin) ; l'injection ne peut venir que du canal FCM de GMS.

3. **« en clair » est faux en release.** Le manifeste principal ne déclare aucun `usesCleartextTraffic` et targetSdk = 36 → cleart

*(justification tronquée)*

### La façade `Fournisseur` est contournée par les écrans : endpoints et noms de streams Rocket.Chat en dur dans app/, y compris un rattrapage qui existe déjà derrière le contrat

`app/salon/[rid].tsx`

J'ai lu lib/fournisseur.ts en entier, fournisseurs/index.ts, fournisseurs/rocketchat/index.ts:75-78, ui/synchro.tsx:240-370, lib/rattrapage.ts:377-406, app/salon/[rid].tsx (imports, 340-495, 1293-1299), app/fil/[id].tsx:165-210, lib/fournisseur.test.ts, et les messages des 5 commits qui ont construit la façade.

1) Les FAITS cités sont exacts, mais le CONSTAT (« la façade est contournée », sévérité haute) contredit ce que le code dit de lui-même. La règle invoquée est citée tronquée : lib/fournisseur.ts:3-5 dit « doit **à terme** passer par ici » — pas « passe par ici ». Le même fichier borne explicitement le périmètre atteint : ActionsFournisseur (l.138-141) « Les lectures secondaires (profil, recherche, info salon, spotlight) **seront ajoutées ici quand leurs écrans seront routés** — elles portent des DTO qu'on ne définit pas à l'avance » ; l'interface Fournisseur (l.196-197) « Les ornements encore RC-only (présence, emojis custom, push, E2EE) restent hors de cette façade **en 4a**, gardés par capacites, **à absorber ensuite** ». Le commit 59bc618 (« Palier 4a ») redit mot pour mot « restent sur `client`, gardés par `capacites`, **à absorber en 4b/5** », et eb764a9 « Transitoire (absorbé en 4b) ». Le constat re-décrit donc l'état d'avancement documenté d'une migration en cours, pas un défaut. C'est exactement le cas « un commentaire documente le choix comme délibéré ».

2) Le scénario d'échec est INATTEIGNABLE en l'état. `Genre` (lib/fournisseur.ts:46) n'a qu'un membre, `GENRES` idem, `creerFournisseur` n'a qu'une clause `case 'rocketchat'` et aucun driver Mattermost n'existe dans fournisseurs/ (un seul sous-dossier, `rocketchat`). Le scénario « creerFournisseur rend bien un objet Mattermost » suppose du code qui n'est pas écrit ; le jour où il le sera, le switch exhaustif casse la compilation (documenté fournisseurs/index.ts:4-5) et l'auteur du driver traversera nécessairement ces écrans. Aucun état d'entrée aujourd'hui ne produit un salon vide, un fil vide ou un DM en échec. Sévérité « haute » (= comportement faux visible par l'utilisateur) est donc très exagérée : l'effet actuel est nul.

3) Le point le plus concret du constat — « rattraperSalon est court-c

*(justification tronquée)*

### Aucun test ne relie les migrations à `_journal.json` / `migrations.js` : une migration présente mais non journalisée passe verte

`db/schema.test.ts`

**Ce que le constat décrit correctement.** La divergence de source est réelle : `db/schema.test.ts:17-19` et `43-45` listent le dossier (`readdirSync(DOSSIER).filter(f => f.endsWith('.sql')).sort()`), alors que `db/migrer.ts:40` fait `await migrate(ouvrirBase(baseUrl, utilisateurId).base, migrations)` avec `migrations` importé de `db/migrations/migrations.js`, qui exporte `{ journal, migrations: { m0000…m0011 } }`. Et le grep confirme qu'aucun test ne mentionne `_journal` ni `migrations.js` : les seules occurrences hors `node_modules` sont `db/migrations/migrations.js:3`, `db/migrer.ts:17`, `db/migrations.d.ts` et `drizzle.config.ts`. `db/upserts.test.ts:52` recopie d'ailleurs le même chargeur par dossier.

Mais le scénario d'échec ne tient pas, pour quatre raisons.

**1. Le cas « .sql présent, journal absent » exige de contourner le seul producteur.** `drizzle.config.ts` porte `driver: 'expo'` et `package.json` n'expose qu'une voie : `"db:generate": "drizzle-kit generate"`. Cette commande écrit le `.sql`, le `meta/NNNN_snapshot.json`, l'entrée de journal ET régénère `migrations.js` en un seul passage. Le dépôt le confirme sur ses 12 migrations : `git show --stat f98d696 -- db/` (migration 0011, la plus récente) touche dans le MÊME commit `0011_safe_mach_iv.sql`, `meta/0011_snapshot.json`, `meta/_journal.json` et `migrations.js`. `git log -- db/migrations/meta/_journal.json` rend exactement la même liste de commits que `git log -- db/migrations/`. Aucune migration écrite à la main n'a jamais existé ici.

**2. La branche « conflit de merge sur `_journal.json` » est exclue par le process du projet.** CLAUDE.md : « Branche principale : **`master`**. Commits directs, pas de PR. » Mono-développeur, pas de merge, donc pas de conflit de journal à mal résoudre.

**3. La variante réellement plausible n'est PAS silencieuse.** Si le journal est à jour mais `migrations.js` périmé, `node_modules/drizzle-orm/expo-sqlite/migrator.js` (`readMigrationFiles`) fait `const query = migrations['m' + journalEntry.idx.toString().padStart(4,'0')]; if (!query) throw new Error('Missing migration: ' + journalEntry.tag)`. Ça lève AVANT la moindre écriture, au premier lancement, et `migrerBa

*(justification tronquée)*

### `db/depot.ts` — la seule implémentation réelle du `Depot` (385 lignes) n'a aucun test, file d'écritures comprise

`db/depot.ts`

FAIT VÉRIFIÉ : il n'existe effectivement pas de `db/depot.test.ts` (`find . -name "*.test.ts"` : 36 fichiers, aucun pour `depot.ts`), et `lib/sync.test.ts:243` comme `lib/rattrapage.test.ts:29` utilisent des faux `Depot` en mémoire. Le câblage de `db/depot.ts` n'est donc pas couvert. C'est le seul point exact du constat. Tout le reste — le mécanisme, le scénario, la sévérité — ne résiste pas au code.

1) LE SCÉNARIO D'ÉCHEC EST FAUX. Le constat prétend que supprimer `await brute.runAsync(SUPPRIMER_SORTIE, [m.id])` (db/depot.ts:114) laisserait « chaque message envoyé avec sa ligne `sortie` en-attente après livraison », puis un repost de tout l'historique de sortie à chaque reconnexion jusqu'au 429. `lib/envoi.ts` le contredit deux fois :
   - chemin nominal, `MoteurEnvoi.unePasse()` l.145-156 : `const reponse = await this.client.post('chat.sendMessage', …)` PUIS `await this.depot.supprimerSortie(ligne.id);` (l.155) — la ligne de sortie est effacée par le moteur lui-même, AVANT l'ingestion (`this.ingerer(reponse.message)` l.156). Verrouillé par un test : `lib/envoi.test.ts:106` — `assert.equal(sortie.size, 0, 'la file est vidée au succès')`.
   - chemin du rejeu d'un `_id` déjà accepté (le 400 « starred » de RC 8.5), l.168-174 : `const livre = await this.messageLivre(ligne.id); if (livre !== null) { await this.ingerer(livre); await this.depot.supprimerSortie(ligne.id); continue; }` — là encore un `supprimerSortie` explicite. Verrouillé par `lib/envoi.test.ts:151` (« un rejeu refusé mais DÉJÀ LIVRÉ est réconcilié, pas marqué échec ») et :167.
   Il n'existe donc aucun chemin où une ligne de sortie survit à une livraison confirmée sans la ligne 114. Le pire effet de sa suppression : après un kill du process entre la réponse HTTP et `supprimerSortie`, le prochain `traiter()` fait UN aller-retour 400 + `chat.getMessage` de plus par message concerné, puis efface la ligne. Un appel, une fois — pas une boucle de repost, pas de 429. La ligne 114 est une réconciliation de ceinture-et-bretelles (son commentaire l.110-113 le dit : « L'un d'eux qui porte notre `_id` prouve la livraison »), pas le seul rempart.

2) LE GARDE-FOU DE PURGE EST DÉJÀ TESTÉ, AILLEURS. `purgerSalonsA

*(justification tronquée)*

### `verrouiller()` oublie la clé en mémoire AVANT d'effacer le Keystore, et son rejet n'est capté nulle part

`lib/e2e/moteur.ts`

CODE LU EN ENTIER : lib/e2e/moteur.ts (173 l.), lib/e2e/moteur.test.ts (152 l.), ui/synchro.tsx:160-256, app/parametres.tsx:369-423, lib/sessionStore.ts (137 l.), ui/e2e.ts, lib/sync.ts:170-185, db/depot.ts:210-230, db/upserts.ts:199, et l'implémentation native node_modules/expo-secure-store/android/.../SecureStoreModule.kt.

1) LE DÉCLENCHEUR ALLÉGUÉ N'EXISTE PAS. Le constat repose entièrement sur « SecureStore.deleteItemAsync échoue (clé Keystore invalidée après un changement de verrouillage d'écran, cas connu d'Android) ». C'est faux au niveau natif. `deleteItemImpl` (SecureStoreModule.kt:243-264) ne touche NI le Keystore NI le déchiffrement :

    if (prefs.contains(keychainAwareKey)) success = prefs.edit().remove(keychainAwareKey).commit()
    if (prefs.contains(key)) success = prefs.edit().remove(key).commit() && success
    if (legacyPrefs.contains(key)) success = legacyPrefs.edit().remove(key).commit() && success
    if (!success) throw DeleteException(...)

Trois `SharedPreferences.remove().commit()`, rien d'autre. `KeyPermanentlyInvalidatedException` ne peut survenir que dans `getItemImpl`/`setItemImpl` — et dans `getItemImpl` (l.156-158) elle est CAPTÉE et rend `null`, elle ne rejette même pas. Le seul rejet possible de `deleteItemAsync` est un `commit()` qui rend `false`, c'est-à-dire une panne de stockage (disque plein / prefs corrompues). Le scénario concret décrit ne produit donc PAS le résultat annoncé : le chemin est inatteignable par le mécanisme invoqué.

2) LA CORRECTION PRINCIPALE PROPOSÉE EST UNE RÉGRESSION DE SÉCURITÉ. « Inverser l'ordre : `await effacer()` d'abord, puis `clePrivee = null` » — dans le cas d'échec (le seul cas où l'ordre compte), l'inversion laisse la clé privée RSA EN RAM et `estDeverrouille` à `true`. L'ordre actuel est le bon pour une opération « oublie tout » : la seule partie qui ne peut pas échouer (vider la mémoire) est faite en premier, de façon inconditionnelle. Le commentaire l.15/116 dit exactement ça (« Oublie toute clé — mémoire et Keystore »). Appliquer la correction proposée dégraderait la garantie forte actuelle au profit d'une garantie faible.

3) LE MODÈLE DE MENACE EXCLUT EXPLICITEMENT CE QUE LE CONSTAT Q

*(justification tronquée)*

