# Chantier du serveur natif RocketVibe

Date de lancement : 30 septembre 2026. Branche : `feature/rocketvibe-server`.
Destination : [RFC 0001](rfcs/0001-serveur-rocketvibe-rust.md).

## Premier incrément : socle serveur et transports pilotes

- [x] Workspace Rust natif indépendant du bureau, `rv-server`, `rv-protocol`, `rv-client`.
- [x] Compose, base et volumes isolés du banc Rocket.Chat ; écoute locale.
- [x] Contrat JSON Schema, génération TypeScript et fixtures communes.
- [x] Comptes créés par CLI, Argon2id, sessions hachées et révocation.
- [x] Salons, contrôle des adhésions par le propriétaire et DM unique par paire.
- [x] Envoi texte idempotent, refus des demandes divergentes et historique paginé.
- [x] Séquenceur transactionnel, journal durable, snapshot cohérent et curseurs opaques.
- [x] WebSocket avec tickets à usage unique et reprise depuis un curseur.
- [x] Transports pilotes Rust et TypeScript, non raccordés aux interfaces existantes.
- [x] Tests contre PostgreSQL réel, HTTP / WebSocket, rejeu et redémarrage du serveur.
- [x] CI dédiée et documentation de démarrage / limites.

Les cases décrivent du code livré. Les résultats d'exécution et limites pratiques
doivent être conservés dans le résumé de livraison ; une définition de workflow
ne signifie pas que sa première exécution distante a déjà réussi.

### Vérifications exécutées le 30 septembre 2026

- Formatage et Clippy sur tout le workspace natif, sans avertissement.
- 10 tests Rust réussis, dont 8 contre PostgreSQL réel ; le test client exerce aussi
  le transport TypeScript contre le même serveur via HTTP et WebSocket.
- 5 tests du contrat / transport TypeScript et vérification TypeScript stricte réussis.
- JSON Schema et types TypeScript régénérés sans divergence.
- Régression de concurrence couverte : les envois et créations de DM ne bloquent
  pas les vérifications de clés étrangères utilisées par les changements d'adhésion.
- 12 tests existants du fournisseur Rocket.Chat réussis.
- Image de production construite et démarrée localement : readiness HTTP 204 et
  découverte native correcte sur `127.0.0.1:3400`.

La première CI distante est verte ; chaque correctif suit le même workflow sur la
branche. Le premier incrément ne comportait aucun écran natif connecté.

## Deuxième incrément : parcours mobile pilote

- [x] Sonde native avant authentification, sans repli Rocket.Chat si le protocole
  RocketVibe annoncé est incompatible.
- [x] Connexion, reprise et déconnexion natives ; genre, identité / génération et
  jeton conservés dans le stockage sécurisé existant.
- [x] Écran React Native dédié : salons privés / publics, invitation par le
  propriétaire, DM, texte, historique, retry / abandon et changement de serveur.
  Cet écran de pilote a été retiré au troisième incrément, au profit des écrans existants.
- [x] Projection SQLite : lot et curseur atomiques, outbox durable, écho idempotent
  et ordre exact des positions dépassant la précision JavaScript.
- [x] Reprise HTTP puis WebSocket, reconnexion, suspension au passage en arrière-plan
  et heartbeats ; file de trames bornée.
- [x] Purge locale au retrait d'un salon ; cache et envois d'une ancienne génération
  masqués avant le nouveau snapshot et jamais rejoués sur la suivante.
- [x] Test de deux moteurs mobiles et de leurs vraies migrations SQLite contre
  PostgreSQL : coupure, recréation, rejeu, retrait privé avant renvoi de l'outbox.
- [x] CI étendue aux changements mobiles, aux tests et à l'export Android.

### Vérifications locales du deuxième incrément

- 946 tests mobiles réussis, dont 18 tests natifs ; typecheck et ESLint des fichiers
  concernés réussis.
- 10 tests Rust réussis, formatage / Clippy et génération des contrats sans diff.
- Export Android Expo réussi : bundle Hermes et assets. Ce n'est pas un APK.
- Image serveur reconstruite ; readiness et découverte locale vérifiées.

La validation visuelle Android n'a pas été exécutée : aucun appareil n'est
connecté et les fichiers Firebase du build natif ne sont pas présents dans ce
checkout. Les tests clients recréent le moteur sous Node et un test SQLite ferme
puis rouvre une base sur disque ; ils ne prouvent pas encore le comportement d'un
processus Android réellement tué.
Les instructions et limites sont dans le [guide pilote](NATIVE_MOBILE_PILOT.md).

## Troisième incrément : deux fournisseurs dans les interfaces actuelles

- [x] Sonde native et genre / identité conservés dans les comptes bureau.
- [x] Moteur `NativeSession` dans `rv-core`, cache SQLite séparé, brouillons et outbox.
- [x] Transactions atomiques projection / curseur / écho, ordre exact, purge des
  retraits et protection contre les réponses d'historique tardives.
- [x] Même ChatPage / MessageList / Composer GTK pour Rocket.Chat et RocketVibe.
- [x] Même accueil / salon / liste / composeur mobile, via le contrat Fournisseur.
- [x] Bascule entre comptes et transports, capacités absentes désactivées.
- [x] Brouillons mobiles persistants, protégés contre les écritures d'une ancienne génération.
- [x] API UniFFI explicite ; la connexion historique ne remet pas un jeton natif à RC.
- [x] Raccordement de cette API aux modèles et écrans SwiftUI.
- [x] Banc PostgreSQL éphémère mobile / bureau et smoke test du vrai binaire GTK.
- [x] CI étendue au workspace bureau, au banc GTK et aux tests du cœur sous Windows.

Le [guide bureau](NATIVE_DESKTOP_PILOT.md) décrit le parcours et le banc. La validation
Android / Windows sur appareils reste ouverte.

### Vérifications locales du troisième incrément

- Formatage / Clippy sans avertissement et 212 tests du workspace bureau réussis.
- 949 tests mobiles réussis, typecheck, lint et export Android / Hermes.
- Contrat de connexion Rocket.Chat historique vérifié après la découverte native.
- Fournisseur natif mobile vérifié : requête UI par séquence, pagination indépendante
  des dates, outbox / retry, purge et brouillons de génération.
- Banc réel PostgreSQL / moteur mobile / cœur bureau réussi : réouverture SQLite,
  rejeu unique, message manqué, brouillon, DM, création / invitation, retrait privé
  et révocation de la session.
- Binaire GTK connecté via son formulaire, envoi et réponse mobile vérifiés dans
  les widgets affichés ; captures en largeur normale et à 435 pixels.

Le banc ne fournit pas de trousseau système : la connexion fonctionne pendant
le test, mais la reprise d'un jeton depuis le stockage sécurisé réel reste à exercer.

## Quatrième incrément : SwiftUI partagé

- [x] Connexion et reprise par genre de compte, avant remise des identifiants.
- [x] Même AppModel / RoomModel et mêmes vues SwiftUI pour les deux fournisseurs.
- [x] Même rendu de message UniFFI, regroupement et Markdown, ordre natif conservé.
- [x] Brouillons persistants, envoi hors ligne, reprise d'outbox et DM.
- [x] Arrêt des anciens transports, gardes de session et modèles quittés inactifs.
- [x] Fonctions natives absentes désactivées, compte / langue et navigation conservés.
- [x] Backend Secret Service réel pour les bindings Linux du banc de tests.
- [x] Banc Swift / PostgreSQL / stockage sécurisé ajouté à la CI.

Le banc Swift vérifie la connexion refusée puis réussie, l'envoi, l'intention hors
ligne reprise une seule fois, le brouillon au changement de compte, le rejet d'un
ancien modèle, le DM et la suppression du compte à la déconnexion. Il utilise les
vrais modèles et le vrai cœur, sans serveur factice. Il ne remplace pas un essai
manuel de l'interface native sur un Mac connecté au serveur.

Vérification locale : 200 tests Rust du cœur / bindings, Clippy et formatage sans
erreur ; compilation Swift, 6 tests locaux et scénario natif réel réussis. Les deux
tests d'intégration Rocket.Chat sont ignorés en l'absence de son serveur de test.

## Cinquième incrément : limites et données temporaires

- [x] Quotas de connexion par pseudo / IP TCP / instance en PostgreSQL, conservés
  au redémarrage, sans confiance dans les en-têtes de proxy.
- [x] Calcul Argon2 borné même après annulation d'une requête HTTP.
- [x] `429` avec délai, respecté par les transports Rust et mobile sans révocation.
- [x] Tickets non consommés et sockets simultanées bornés ; réservations libérées
  à la fermeture / annulation, fermeture elle-même limitée en durée.
- [x] Snapshot limité à 8 Mio ; refus explicite sans publier de curseur partiel.
- [x] Lots du journal limités à 1 Mio, sans sauter les événements restants.
- [x] Expiration des curseurs, rotation d'un token périmé et plafond de 512 par compte.
- [x] Nettoyage au démarrage et périodique par lots, sans attendre les lignes verrouillées.
- [x] Reprise du moteur mobile SQLite après expiration réelle en PostgreSQL,
  brouillon conservé et même intention hors ligne livrée une fois.

Les tests exercent concurrence / redémarrage des quotas, IP usurpée par en-tête,
expiration / élagage, nettoyage pendant un verrou concurrent, tickets rejoués,
limite et libération des sockets, révocation active et gros messages dont le JSON
est plus volumineux que le texte. La pagination de snapshots et la qualification
de charge restent ouvertes ; les bornes exactes sont dans le [contrat](protocol/README.md).

Vérifications locales le 1er octobre 2026 : 17 tests Rust du workspace natif,
23 tests du fournisseur TypeScript, 951 tests mobiles et 200 tests du cœur bureau /
bindings réussis ; formatage, Clippy, typecheck et lint des fichiers mobiles modifiés.
L'image de production a été construite et démarrée dans un PostgreSQL jetable :
readiness 204, découverte correcte et suppression périodique des lignes périmées
par le processus serveur lui-même. Ces tests ne ferment pas les essais sur appareils.

## Sixième incrément : contrats et inventaire J0

Inventaire reproductible de 273 fichiers / 344 occurrences Rocket.Chat, paramètres
dynamiques revus et contrôle CI. Les schémas de destination couvrent droits,
compteurs, actions, profils, fichiers, 2FA et enveloppes de clés ; ils sont lus
par Rust et TypeScript, sans activer les fonctions absentes. Le corpus partagé
couvre 15 cas de Markdown et 5 cas de pièces jointes, avec projection en runs Swift.
Les capacités s'intersectent avec le support client et les diagnostics mobiles
gardent l'identité de requête / délai sans confondre 2FA, proxy et révocation.

Vérifications locales : 21 tests Rust natifs, 25 tests TypeScript natifs,
975 tests mobiles ; typecheck et lint des fichiers concernés réussis. Cœur /
bindings et binaire GTK compilés dans Fedora, Clippy sans avertissement ; modèles
Swift compilés avec bindings régénérés, 6 tests locaux réussis (les 3 parcours
connectés restent ignorés sans leur service). Les validations physiques restent ouvertes.

## Pour fermer J0

- [x] Inventaire des appels Rocket.Chat dans les écrans / modules natifs, génération
  et contrôle CI ; paramètres dynamiques et transports revus.
- [x] Schémas et fixtures Rust / TypeScript : droits fins, lecture / compteurs,
  actions, profils, fichiers, défis 2FA et enveloppes opaques de clés.
- [x] Corpus commun de rendu Markdown, mentions, citations et pièces jointes,
  traversant le mobile, le renderer GTK et les runs UniFFI pour SwiftUI.
- [x] Capacités additives et intersection serveur / client dans mobile / cœur
  bureau / GTK / UniFFI / SwiftUI ; identité et diagnostics mobiles neutres.
- [x] Backlog P01–P23 lié à chaque ligne de la matrice ; politique de compteurs,
  droits, routes des lots suivants et hypothèses du banc documentées.
- [x] Diagnostic bureau : identifiant de requête natif et délai serveur préservés
  par le transport, le fournisseur, son état et les erreurs UniFFI / Swift.
- [ ] Conditions externes : droits / format d'export, services opérateur, appareils
  physiques ; choix et revue du protocole E2EE dédiés à J4.

Le [contrat de parité J0](protocol/PARITY.md) distingue les schémas de destination
des endpoints réellement disponibles. La présence de DTO de clés ne constitue
aucune garantie crypto.

## Septième incrément : snapshots paginés immuables

Le serveur matérialise les pages dans une seule vue transactionnelle, conserve
leurs données dans PostgreSQL et ne publie le curseur que sur la dernière page.
Les nouveaux clients Rust / mobile assemblent et valident la vue entière avant
l'application SQLite atomique ; un serveur natif plus ancien garde sa route initiale.
Quotas : 1 000 salons, 50 messages récents par salon, 1 Mio par page / 64 Mio au
total, durée 5 minutes, 4 vues par compte / 16 dans l'instance. Retrait de salon
et restauration invalident les pages, y compris après réadhésion. Un échec de
construction annule les pages partielles et libère la réservation.

Le banc réel PostgreSQL teste un snapshot supérieur à 8 Mio avec arrivée pendant
le téléchargement, puis replay au watermark capturé. Rust et le moteur mobile
avec SQLite lisent cette vue ; aucune page intermédiaire ne modifie le cache.
Les tests couvrent quotas concurrents, taille totale dépassée, 110 salons,
expiration, retrait / réadhésion, restauration et séquences de pages corrompues.
Les essais physiques et l'ordonnancement strict des diffusions restent ouverts.

Vérifications locales : 26 tests Rust natifs, 31 tests TypeScript natifs et 981
tests mobiles réussis ; schémas / génération / inventaire sans diff, typecheck
et lint des fichiers mobiles concernés réussis.
Les 203 tests du cœur / bindings bureau et Clippy passent dans Fedora ; le binaire
GTK est compilé avec le transport paginé partagé par SwiftUI.

## Huitième incrément : révocations et autorisations

Le huitième incrément ferme la course entre lecture et émission : version opaque
par adhésion, barrière PostgreSQL avant remise HTTP / envoi de trame, session /
compte / génération revérifiés et délai de livraison de 5 secondes. Les tests
retiennent réellement une réponse non consommée et constatent que le retrait d'un
membre, depuis un autre objet serveur, attend son verrou. Ils couvrent abandon,
expiration, réadhésion, rôle, session et restauration ; le séquenceur reste actif.
Une vraie socket est maintenue pendant des envois concurrents au retrait, reçoit
son événement minimal puis continue dans un autre salon sans recevoir de nouvelle
charge utile du salon retiré. Les outboxes conservent et rejouent la même intention
sur `delivery_revalidate`, avec tests SQLite dans le mobile et le cœur bureau.

Les octets déjà remis au transport peuvent encore être tamponnés par le réseau.
Les futures lectures de recherche / fichiers devront employer la même barrière.

Les écritures revérifient également l'acteur et retiennent sa session jusqu'au
commit. Le verrou de quota des curseurs est séparé de celui des mutations, pour
conserver le replay du watermark déjà committé pendant une écriture retardée.
Les écritures bornent les attentes de verrou à 6 secondes, les instructions à
8 secondes et une transaction inactive à 10 secondes ; le délai de verrou laisse
expirer la livraison de 5 secondes. Un éditeur bloqué libère ainsi sa session et
permet la déconnexion, avec rollback vérifié dans PostgreSQL.
Le banc GTK démarre un vrai Secret Service ; son second lancement recharge le
compte enregistré sans injection de login, dans un nouveau processus / bus.
Le modèle Swift connecté passe aussi avec ce trousseau et le serveur jetable.

Vérifications locales : 34 tests Rust natifs, 32 tests TypeScript natifs, 982 tests
mobiles et 204 tests cœur / bindings bureau réussis ; formatage, Clippy, typecheck,
lint des fichiers mobiles concernés et génération / inventaire sans diff.
GTK et bindings / modèles Swift sont compilés ; les validations sur appareils
physiques restent ouvertes.

## Neuvième incrément : création durable et salons publics

Les clients enregistrent dans SQLite l'intention d'un formulaire de création avant
sa requête. Après une réponse perdue ou un redémarrage, le même formulaire reprend
son identité ; PostgreSQL renvoie son salon déjà créé, sans second événement.
Les anciens clients v1 peuvent encore créer sans identité. Les reçus sont durables
et refusent une identité réutilisée avec un autre nom / genre ou un envoi de message.

L'annuaire public est paginé, borné à 20 entrées, avec recherche littérale et
adhésion personnelle idempotente. Il ne révèle pas les salons privés / DM ; sa
livraison protège aussi la visibilité et la révision des métadonnées. Le join
préserve un rôle existant et publie un seul événement personnel. Les écrans de
recherche mobile, GTK et SwiftUI consomment leurs modèles habituels.

Vérifications locales : 37 tests Rust natifs, 33 TypeScript natifs, 983 tests
mobiles et 206 tests cœur / bindings bureau ; formatage, Clippy, typecheck, lint,
schéma et inventaire passent. Le serveur de production est construit puis testé
avec PostgreSQL jetable : mobile et cœur bureau découvrent / rejoignent les salons
de l'autre, GTK échange dans l'interface existante et reprend son compte du trousseau.
Le modèle SwiftUI trouve un salon d'un autre compte, le rejoint et y envoie un
message avec les vrais bindings et le vrai Secret Service. Les essais physiques
restent ouverts.

## Complément J0 : diagnostics bureau

Les erreurs HTTP reconnues conservent `request_id` et `Retry-After` jusqu'au
fournisseur bureau, à son état de connexion et aux erreurs UniFFI. Un retry
supprimé localement par le quota garde l'identité du dernier refus serveur et
indique son délai restant ; il ne fabrique pas de nouvel identifiant. Les erreurs
de transport / passerelle restent sans identité et ne prouvent pas une révocation.
Les tests traversent le vrai transport HTTP, le fournisseur et l'erreur exportée.
Rust / GTK et bindings / modèles Swift sont compilés ; le parcours Rocket.Chat
de connexion / 2FA conserve ses tests et ses branches existantes.
Vérifications : 37 tests Rust natifs, 33 TypeScript natifs et 208 tests bureau
passent, avec Clippy / GTK et les 6 tests Swift locaux ; les 3 tests connectés
restent conditionnés à leurs services de test.

## Pour fermer J1

La file mobile reprend aussi ses refus temporaires lorsque la socket reste
connectée : backoff borné avec jitter, `Retry-After`, annulation en suspension
et arrêt sur révocation comprise de la session. Un test traverse HTTP,
PostgreSQL, une vraie socket authentifiée et SQLite : l'acceptation initiale
perd sa réponse, le journal est retardé sans avancer son curseur, puis le client
rejoue automatiquement la même intention. Un seul message existe en base.
Les erreurs SQLite après confirmation et les transitions 503 / 429 sont
également couvertes. Vérifications : 985 tests mobiles, typecheck et lint passent.

- [x] Pilote mobile : sonde, connexion, stockage sécurisé, SQLite et outbox.
- [x] Intégration mobile au contrat fournisseur et aux écrans partagés, brouillons
  persistants et navigation salon / DM / comptes.
- [x] Fournisseur bureau dans `rv-core`, exposition GTK / `rv-ffi` / SwiftUI.
- [x] Application atomique des lots et curseurs dans le cache SQLite mobile pilote.
- [x] Même garantie dans le cache bureau pilote.
- [ ] Parcours réel Android ↔ Windows, avec réseau coupé et processus clients tués.
- [x] Heartbeats, rythme de diffusion, limites et essais d'authentification bornés.
- [x] Tailles maximales de snapshot / lots et nettoyage des tickets / curseurs.
- [x] Pagination d'un snapshot matérialisé pour dépasser les bornes du pilote.
- [x] Ordonnancement des révocations avec les réponses / sockets actives, barrière
  PostgreSQL et vérification des versions d'autorisation avant livraison.
- [x] Création de salon idempotente et découverte / adhésion aux salons publics.

Le parcours mobile pilote et les tests sans appareil ne ferment pas J1 : il exige
les parcours Android / bureau et les garanties restantes ci-dessus.

## Jalons suivants

- P01, renouvellement dans les apps : SecureStore mobile et trousseaux GTK / Swift
  conservent le successeur avant HTTP puis le reprennent après réponse perdue.
  Les écritures par compte sont sérialisées, y compris quand l'appelant d'une
  écriture de trousseau déjà engagée est annulé ; l'ancien bearer ne peut éjecter
  une session renouvelée. Les connexions longues vérifient quotidiennement
  l'expiration. Les brouillons, outbox et commandes SQLite restent au même compte.
  Vérifications : 27 tests API PostgreSQL, 52 tests TypeScript natifs, 1 002
  régressions mobiles, Clippy / tests cœur et bindings / compilation GTK, ainsi
  que génération et tests Swift. Le banc jetable raccourcit le premier bearer
  à J+1 : GTK reprend son compte du vrai Secret Service après redémarrage et
  les modèles Swift passent connexion / envoi / reprise / déconnexion. Des
  compteurs SQL sans secret prouvent les rotations des deux comptes ; le runner
  mobile réel renouvelle aussi avant la reprise HTTP / socket. SecureStore Android
  et les trousseaux Windows / macOS restent à qualifier sur appareils. Les écrans
  d'appareils, invitations / récupération et P02 restent à livrer.

- J2, troisième lot : menus et éditeurs mobile / GTK / SwiftUI existants raccordés
  aux actions natives. Texte / droits / révision sont vérifiés avant ouverture ;
  la sauvegarde utilise cette révision, avec conflit explicite si un autre appareil
  a modifié le message. SQLite conserve une intention par message, son ID et sa
  révision initiale malgré une réponse perdue ou un événement reçu entre-temps.
  Confirmation et projection se font ensemble ; les refus définitifs cessent
  leurs retries et le texte d'édition reste récupérable. Fermeture / refus de
  session bloque les appels tardifs. Les clients respectent le quota d'actions
  tout en laissant disponibles les lectures de message pendant `Retry-After`.
  Vérifications : 46 tests Rust natifs, 41 tests TypeScript natifs, 991 mobiles,
  211 cœur / bindings bureau ; formatage, Clippy, typecheck, lint et inventaire.
  L'application GTK rend l'édition avant / après dans son éditeur et reprend
  son compte depuis Secret Service. Les modèles Swift connectés à PostgreSQL
  vérifient édition, conflit concurrent, récupération du texte refusé et suppression.
  Swift : 6 tests locaux réussis et un parcours connecté réussi ; deux autres
  parcours restent conditionnés à leurs bancs. Les appareils Android physiques
  et l'application Windows installée restent à qualifier.

- J2, deuxième lot : API d'édition / suppression avec reçus persistants,
  révision attendue, délai d'auteur, rôle de modération, tombstones et effacement
  des anciennes charges du journal actif. Transport Rust / mobile disponible,
  projections SQLite mobile / bureau et renderer partagé GTK / SwiftUI intégrés.
  La fenêtre d'un reset remplace l'historique confirmé et protège contre les
  réponses antérieures, en conservant brouillons / intentions des salons présents.
  Un banc réel mobile / PostgreSQL / WebSocket / SQLite applique une édition,
  manque la suppression et 51 messages, puis remplace le cache par le snapshot
  borné sans conserver le message disparu. Tests de concurrence, restart,
  idempotence, barrières de livraison et page en construction couverts.
  Menus et intentions clientes persistantes sont livrés dans le lot suivant.
  Vérifications : 45 tests Rust natifs, 37 TypeScript natifs, 987 mobiles et
  209 cœur / bindings bureau passent ; Clippy et compilation GTK, schéma /
  génération / inventaire, typecheck et lint réussis. Bindings et modèles Swift
  compilés avec 6 tests locaux réussis, 3 parcours connectés conditionnels.

- J2, premier lot : droits fins de compte / salon / message, restrictions de
  création, rôles de modérateur et envoi en lecture seule appliqués en transaction.
  Les réponses protègent les versions de politique et détectent un changement
  puis rétablissement. Tests PostgreSQL : droits annoncés / appliqués, absence
  d'accès privé implicite de l'administrateur, délai d'édition, reçus consultables
  après restriction et verrous de livraison réels. `rooms/discover` est désormais
  l'alias prévu par J0, avec `rooms/public` conservé pour les clients récents.
  Ces droits préparent les actions, activées dans les lots suivants.
  Vérifications : 40 tests Rust natifs, 35 TypeScript natifs et 208 tests bureau
  passent ; formatage, Clippy, schéma / génération, inventaire et typecheck passent.

- [ ] J2 : actions, fils, lectures / non-lus, présence, recherche, profils et favoris.
- [ ] J3 : fichiers, vocaux, cartes, emojis, push natif Android et partage.
- [ ] J4 : Jitsi et E2EE autonome avec spécification / revue dédiées.
- [ ] J5 : import reprenable, exploitation, sauvegarde / restauration et pilote de bascule.

Le fournisseur Rocket.Chat et son Compose restent disponibles. Aucun merge vers
`master`, changement d'instance réelle ou import utilisateur n'appartient à ces incréments.
