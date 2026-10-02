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

- P02, récupération du mot de passe par e-mail côté serveur / SDK : migration
  0021, demande anonyme avec acquittement générique, intention aléatoire liée à
  l'instance / génération et mail vers le contact déjà vérifié uniquement.
  Code de 256 bits valable une heure, hash dans la récupération existante et
  outbox chiffrée partageant les budgets SMTP des autres producteurs. Reprise
  du même code après réponse SMTP ambiguë, demandes supprimées / limitées
  persistées comme reçus opaques et coordonnées effacées après suppression du
  compte, sans réactivation lors d'une réutilisation du pseudo. La confirmation
  revérifie contact / autorité / génération sous verrou, change le mot de passe
  sans session, conserve conversations / facteurs / secours et révoque les
  anciennes familles. Un rejeu du reçu ne révoque pas une nouvelle connexion.
  Les coffres et boutons de demande dans les trois clients restent à raccorder ;
  le formulaire existant de récupération accepte le code reçu par la même API.
  Douze tests PostgreSQL dédiés passent : vraies demandes HTTP / SDK sans
  bearer, worker partagé / relais SMTP loopback, perte d'ACK, concurrence,
  redémarrage, contact modifié pendant le verrou d'acceptation, génération,
  échéance, suppression / réutilisation du pseudo, budgets et clé incorrecte.
  Une conversation réelle et le profil TOTP sont conservés ; le secours permet
  une nouvelle connexion que le rejeu du reçu ne révoque pas. Les cinq tests de
  récupération opérateur historique restent verts. Vérifications complètes :
  154 tests serveur et sept protocoles / client, 151 tests TypeScript natifs,
  1 101 régressions mobile, 291 tests bureau, formatage / Clippy, typecheck / lint,
  schéma / génération / inventaire sans divergence. Ces tests utilisent un
  PostgreSQL jetable et des adresses synthétiques ; ils ne qualifient pas la
  délivrabilité extérieure ni un trousseau installé. La CI du lot reste à suivre.

- P02, inscription du facteur e-mail dans les trois clients : boutons explicites
  dans les paramètres mobile / GTK / SwiftUI existants, confirmations liées au
  contact et aux profils affichés, garde de vue et reprise du reçu privé. Les
  secours partagent leur présentation / copie / acknowledgement avec TOTP.
  Les contrôles d'adresse expliquent et empêchent son remplacement ou retrait
  tant que le profil e-mail est actif. Désactiver TOTP ou e-mail décrit la
  conservation de l'autre profil ; e-mail seul permet les secours communs.
  Les bancs mobile, GTK et Swift passent chacun trois vrais processus, avec
  PostgreSQL, contact vérifié par SMTP / TLS et réponses d'activation / retrait
  perdues. Après activation, ils confirment à nouveau l'identité avec un secours,
  perdent aussi les réponses de preuve et retrouvent son reçu avant le retrait.
  SQL exige une seule famille / credential, deux opérations de profil d'origine,
  un seul mail de contact, aucun OTP envoyé et le contact conservé après retrait
  du dernier facteur. GTK / Swift utilisent Secret Service ; mobile recrée son
  fournisseur, sa projection SQLite et un stockage privé portable sur disque.
  Ces bancs rejoignent la CI dans trois projets distincts. Les 291 tests Rust
  bureau, Clippy / compilation GTK, 1 099 tests mobile, typecheck / lint / export
  Android, bindings et six tests locaux Swift passent. Les contrôles FFI refusent
  une révision obsolète ou un handle fermé. La vue GTK sans secret est vérifiée
  à 435 × 760. Inventaire : 295 fichiers / 344 occurrences. Les services et
  volumes privés du banc sont supprimés après vérification. Compilation SwiftUI
  macOS et qualifications installées restent des contrôles distincts.
  La CI `36966528293` du coffre `9c35bbb` passe ses quatre jobs, y compris
  les régressions connectées OTP / TOTP / contact des deux clients bureau.
  La CI native `36968362558` du lot `6a6a48c` passe ses quatre jobs ; macOS
  `36968362546` compile, package et démarre l'application avec SwiftUI.
  La récupération du compte par e-mail est le raccordement P02 en cours.

- P02, coffres d'inscription du facteur e-mail : les coordinateurs Rust bureau
  et mobile conservent l'opération, le contact affiché et la version des profils
  avant HTTP, dans le même coffre privé que TOTP / secours. Une réponse perdue
  reprend le reçu et les dix codes d'origine ; une demande concurrente ne peut
  remplacer ce reçu avant son acknowledgement. Contact / génération / famille,
  fermeture, stockage refusé et versions obsolètes sont contrôlés. Le retrait
  reste accessible sans SMTP et conserve TOTP / secours s'il reste installé.
  Les secours communs peuvent aussi être régénérés avec un profil e-mail seul.
  Six nouveaux tests Rust et neuf tests TypeScript dédiés passent : 291 tests
  bureau et 1 099 tests mobiles au total, formatage / Clippy / compilation GTK,
  typecheck / lint / export Android, bindings et six tests locaux Swift.
  L'inventaire compte 294 fichiers / 344 occurrences. Le transport bureau
  vérifie aussi la route de retrait avec les capacités TOTP / SMTP absentes et
  refuse une capacité de profil disparue avant HTTP. Ces tests de coffres ne
  remplacent pas encore un parcours positif connecté d'inscription par les
  widgets : les boutons mobile / GTK / SwiftUI sont le prochain raccordement.
  La CI native `36963735968` du lot OTP Swift `e0ee062` passe ses quatre jobs,
  et sa CI macOS `36963735943` passe compilation, package et lancement.

- P02, défis OTP SwiftUI : les écrans existants proposent e-mail à la connexion
  et à la confirmation d'identité. `NativeLoginAttempt` / `NativeSecurity`
  exposent statut, échéance, capacité et révision affichée ; les candidats et
  IDs de défi / livraison restent dans le coffre Rust. Envoi, reprise et renvoi
  sont explicites. Le vrai job d'envoi conserve son verrou après annulation
  foreign ; fermeture et révision obsolète bloquent les callbacks tardifs. Le
  statut distingue aussi e-mail seul et TOTP pour conserver les bonnes actions
  de configuration de l'authenticator. Bindings réels, compilation des modèles,
  six tests locaux Swift et 285 tests Rust bureau / Clippy / compilation GTK
  passent. Le nouveau banc Swift passe trois processus et Secret Service avec
  HTTP, PostgreSQL et SMTP / TLS réels. Il perd les réponses de livraison /
  confirmation, teste reprise après redémarrage, délai de renvoi, handles fermés
  et révisions obsolètes, sans journaliser les codes. SQL confirme deux OTP
  consommés, une seule famille / credential, une preuve d'âge inchangé, trois
  admissions SMTP avec le contact initial et les dix secours conservés. Ce
  banc rejoint la CI Swift avec sa propre base / proxy, indépendante de GTK.
  Le banc Swift existant TOTP / secours / contact passe aussi ses trois processus
  et son contrôle SQL avec les nouveaux bindings. Les deux bancs et leurs volumes
  privés sont supprimés après validation. La CI native `36961965082` du lot GTK
  `1f11eba` passe ses quatre jobs, y compris le nouveau parcours OTP GTK.
  La compilation de la vue SwiftUI est contrôlée par la CI macOS ; les appareils
  installés / trousseaux natifs restent à qualifier. L'inscription explicite
  du facteur dans les trois clients et la récupération e-mail restent les
  raccordements P02 suivants.

- P02, défis OTP GTK : les formulaires existants de connexion et de confirmation
  d'identité proposent e-mail, statut, envoi / reprise et renvoi explicites.
  Le trousseau reprend une livraison ambiguë après redémarrage sans recréer le
  défi ; masquer la vue annule sa garde. Le code est effacé à chaque commande
  et reste transitoire. Le banc GTK réel utilise un contact préalablement vérifié,
  son facteur explicitement activé, PostgreSQL et un relais SMTP / TLS local.
  Trois processus avec Secret Service perdent les réponses de livraison et de
  confirmation puis retrouvent la livraison, la session et la preuve d'origine.
  SQL constate deux livraisons consommées, une seule famille / credential, une
  preuve complète avec son âge initial, trois admissions SMTP (contact inclus),
  aucune charge OTP conservée et les dix secours inchangés. Le renvoi pendant
  le cooldown n'ajoute pas de mail. Le vrai formulaire vide est contrôlé à
  435 × 760 ; aucun code n'est capturé. Ce banc rejoint la CI GTK dans un projet
  jetable distinct. Les 285 tests Rust bureau, Clippy, compilation GTK et
  inventaire régénéré (293 fichiers / 344 occurrences) passent. La CI native
  `36959580252` du socle `d08c4f3` passe ses quatre jobs. SwiftUI, l'inscription
  du facteur dans les trois clients, la récupération e-mail et les qualifications
  sur appareils restent à poursuivre.

- P02, coffres OTP bureau : le coordinateur Rust conserve la livraison dans
  le défi de connexion ou de réauthentification initial, sous le même verrou
  OS et dans le trousseau privé. L'envoi sauvegarde son candidat avant HTTP,
  reprend une réponse perdue et distingue un renvoi explicite avec délai relu.
  Portée, garde de vue, métadonnées privées et échéance sont vérifiées ; les
  codes saisis restent transitoires. Une nouvelle preuve de mot de passe ne
  remplace pas une livraison ambiguë avant la barrière d'expiration. Sans SMTP,
  le reçu et un code déjà envoyé restent utilisables sur le même défi. Les
  anciens formats restent lisibles. Dix tests dédiés passent parmi 285 tests
  Rust bureau ; Clippy, compilation GTK et inventaire régénéré passent. Les
  contrôles HTTP vérifient aussi absence de bearer avant connexion, famille
  conservée pour la preuve, disparition de capacité et génération changée.
  Bindings générés, compilation et six tests locaux Swift passent. Les bancs
  existants TOTP / contact GTK et Swift passent chacun trois vrais processus
  avec Secret Service et leur contrôle PostgreSQL, sur deux projets jetables
  distincts : leurs proxies de perte de réponse ne doivent pas être partagés.
  Ils qualifient la compatibilité des coffres, pas encore un parcours OTP
  rendu et connecté. Les projets et volumes privés sont supprimés.
  Les formulaires GTK / SwiftUI ne sont pas encore raccordés à ces opérations.

- P02, copie privée Swift pendant la reconnexion : la CI `36955805765` du
  commit mobile `020b5b6` a relevé une course entre la régénération des secours
  et leur copie. La lecture FFI reprend le même reçu après reconnexion, avec
  la même famille, révision affichée et garde de vue ; aucune mutation nouvelle
  n'est déclenchée. Le parcours connecté force cette reconnexion et conserve
  les refus de copie obsolète ou après fermeture. Vérifications locales : 275
  tests Rust bureau, Clippy, compilation GTK, bindings et six tests locaux
  Swift passent ; trois processus Swift avec Secret Service réel et contrôle
  PostgreSQL passent. Le banc jetable et son volume privé sont supprimés.
  La CI native `36957450999` du correctif `3a4d12f` passe ses quatre jobs ;
  la CI macOS `36957450981` passe compilation, package et lancement.
  Le raccordement des défis OTP aux formulaires bureau reste le point suivant.

- P02, défis OTP mobile : connexion et confirmation d'identité proposent e-mail
  dans les formulaires existants, avec reprise du candidat de livraison dans les
  coffres privés, garde de vue pour les renvois et conservation de l'échéance.
  Onze tests de coffres passent. Le pilote du vrai fournisseur, HTTP, PostgreSQL,
  SMTP loopback et SQLite perd volontairement les quatre réponses de start /
  finish et constate deux livraisons, deux preuves et aucune duplication.
  Les 1090 tests mobile, typecheck, lint et export Android / Hermes passent.
  Le contrôle natif complet passe : 142 tests serveur, 7 protocole / client,
  140 TypeScript natifs, Clippy et contrats générés.
  Le pilote portable ne ferme pas la validation du Keystore ou du rendu installé.
  Les défis bureau et l'inscription explicite du facteur dans les trois clients
  restent les raccordements P02 suivants.

- P02, facteur e-mail explicite côté serveur / SDK : migration 0020, inscription
  et retrait conditionnels avec reçu privé, OTP sur défi de connexion ou de
  réauthentification existant, reprise sans renvoi et renvois bornés du même code.
  Les délais initiaux ne sont pas prolongés. La file partage les budgets SMTP et
  ne conserve aucun verrou métier pendant la transmission. Neuf tests PostgreSQL
  et trois tests de transport passent : concurrence, réponse perdue, ACK SMTP
  ambigu, coexistence TOTP, absence de relais et expiration sous verrou réel.
  Le contrôle complet passe : 141 tests serveur, 7 protocole / client, 129
  TypeScript natifs, Clippy et contrats générés ; les 1079 tests mobile, le
  typecheck et le lint passent également.
  La CI `36953451597` du commit `b887462` passe ses quatre jobs : serveur /
  mobile, cœur Windows, GTK connecté et Swift connecté.
  Les formulaires et coffres OTP des trois clients sont le prochain raccordement ;
  récupération du compte par e-mail et qualifications externes restent ouvertes.

- P02, profils de facteurs indépendants : migration 0019, vue d'autorité commune
  et validation authentifiée de la clé du profil e-mail sur son contact exact.
  Connexion et réauthentification considèrent e-mail seul ou coexistence ; les
  anciennes preuves TOTP conservent leur identité. Les secours appartiennent au
  compte et ne sont effacés qu'au dernier facteur retiré. Changer le profil de
  référence impose une nouvelle preuve ; une inscription TOTP présente une
  seule liste de remplacement, sans additionner les anciens secours. Les routes
  bloquent le retrait / remplacement du contact actif ; les contraintes SQL
  refusent son retrait ou le changement de sa version.
  Huit tests PostgreSQL passent, dont vraie migration depuis 0018 avec TOTP,
  compteurs, secours consommés et preuve de connexion préexistants intacts.
  Le contrôle complet passe : 132 tests serveur dont les 27 régressions facteurs,
  7 tests protocole / client, 126 tests TypeScript, Clippy et contrats générés.
  Le banc Swift du serveur reconstruit passe trois processus et le contrôle SQL
  avec vrai Secret Service, SMTP TLS local et réponses perdues. Aucune inscription
  e-mail ni émission OTP n'était exposée dans ce premier socle ; le lot 0020
  ci-dessus les raccorde côté serveur et SDK.

- P02, budget SMTP commun : extraction de l'admission persistante de la
  vérification vers un composant partagé, en conservant les clés des commandes
  déjà admises. Les futures finalités OTP / récupération partageront les limites
  globales, par compte, adresse et IP. Cinq tests PostgreSQL couvrent concurrence,
  reprise après redémarrage et saturation, casse de l'adresse, expiration,
  absence de valeurs privées en clair et annulation sous le verrou réel du quota.
  Le contrôle complet passe : 124 tests serveur, 7 tests protocole / client,
  126 tests TypeScript, Clippy et générations des contrats. Ce composant ne rend
  pas encore disponibles le facteur e-mail ni la récupération du mot de passe.

- P02, retrait du contact bureau : boutons dans les paramètres GTK / SwiftUI
  existants et une seule entrée privée partagée entre vérification et retrait.
  Le format des anciennes vérifications reste lisible ; aucun retrait ne conserve
  l'ancienne adresse. Une confirmation épingle contact / révision avant HTTP ;
  les anciennes révisions, fournisseurs, vues fermées et générations sont refusés.
  Le verrou OS reste pris pendant le travail de trousseau annulé côté appelant.
  Une réponse perdue conserve l'opération initiale ; Annuler ne relance pas le
  start et une acceptation gagnante reste visible jusqu'à Terminer. Un reçu
  nettoyé sans acceptation enregistrée ne permet pas de déduire le succès de la
  seule absence d'adresse. Le contact reste consultable et retirable sans SMTP,
  tandis que les nouvelles vérifications suivent leur capacité propre.
  Vérifications : 22 tests de contact dont 12 de retrait, gardes HTTP sans SMTP /
  TOTP, 275 régressions Rust bureau, Clippy et compilation GTK passent ; bindings
  générés, compilation et six tests locaux Swift réussis. Les bancs PostgreSQL
  GTK / Swift passent chacun trois vrais processus avec Secret Service et SMTP
  TLS local : verification start / confirm perdus, retrait perdu, reprise après
  nouveau restart, fermeture explicite et ancien callback refusé. SQL conserve
  une famille, une preuve avec son âge, deux secours consommés, une régénération,
  une admission et un retrait, sans ancien contact, défi ou job. Le retrait laisse
  le second facteur actif avant sa désactivation explicitement testée à part.
  Un premier scénario GTK retrouvait l'ancien dialogue encore en fermeture :
  l'attente porte désormais sur sa disparition effective ; le banc complet passe.
  La vue finale tient à 435 px et n'affiche aucun code privé. La compilation
  SwiftUI est confirmée par la CI macOS `36944950019` du commit `b06487b` :
  compilation, package et démarrage réussis. Sa CI native `36944950072` passe
  serveur / mobile, GTK et cœur Windows mais échoue dans le banc Swift : aucun
  start de vérification n'était parti après la reconnexion de régénération.
  Le banc exige désormais une vue fraîche avant soumission explicite et observe
  séparément les réponses réellement perdues par le proxy jetable. Sa correction
  passe compilation, six tests locaux, trois processus connectés et le contrôle
  PostgreSQL du serveur reconstruit. Le correctif et le budget SMTP du commit
  `fab08e0` passent les quatre jobs natifs `36947405591` et macOS `36947405670`.
  Facteur e-mail,
  récupération et trousseaux / apps installés restent la suite de P02.

- P02, retrait du contact mobile : bouton avec confirmation native dans les
  paramètres existants, révision / focus épinglés et saisies transitoires.
  SecureStore contient une seule intention e-mail, vérification ou retrait,
  avant HTTP ; les anciennes vérifications restent lisibles. Le retrait garde
  portée / versions / opération et reçu, sans ancienne adresse. Une réponse
  perdue reste non confirmée, une acceptation connue exige ses versions et
  l'absence de contact ; un reçu nettoyé sans réponse enregistrée reste périmé.
  Annuler ne relance jamais le start et conserve une acceptation gagnante jusqu'à
  Terminer. Le contact reste lisible / retirable sans SMTP ni configuration
  TOTP, et une vérification non reçue peut être fermée après arrêt de SMTP.
  Le banc connecté réutilise le même bearer et la même famille contre un second
  runtime sans SMTP / clé de facteurs. Il annule avant réception, refuse un
  start ancien, perd la réponse de retrait, refuse une écriture privée puis
  reprend le reçu. PostgreSQL constate une famille, une admission et un reçu
  de retrait, sans contact, défi ou job restant.
  Vérifications : 12 tests du coffre de retrait, 12 de vérification et gardes
  fournisseur ; 119 tests serveur et 7 contrat / client, 126 tests SDK et
  1 076 tests mobiles passent, avec Clippy, typecheck, lint, bundle Android et
  contrats. Les repères de lignes de l'inventaire Rocket.Chat sont régénérés
  après les traductions. ADB voit zéro appareil connecté le 2026-10-02.
  La CI `native-server` du commit `10eade4` est entièrement verte (run
  `36941624686`, quatre jobs : serveur / mobile, Fedora, cœur Windows et Swift).
  Les boutons / coffres GTK et SwiftUI, le facteur e-mail et la récupération
  restent la suite de P02. Les widgets / SecureStore installés restent ouverts.

- P02, retrait du contact serveur / SDK : migration 0018 et trois routes privées
  start / resume / retire, avec capacité additive indépendante de SMTP. Le
  premier retrait exige une preuve récente et les versions affichées ; il
  supprime contact, anciens défis et charges de livraison sur tous les appareils,
  sans changer famille, bearer, facteurs, mot de passe ni âge de preuve.
  Le reçu hashé, sans ancienne adresse, dure cinq minutes. Rejeux, nettoyage ou
  remplacement du contact ne permettent pas de retirer une nouvelle adresse.
  L'annulation compare contact et tête : elle bloque un start tardif et préserve
  une nouvelle vérification sous la même tête après changement de contact.
  Quatorze tests PostgreSQL / HTTP / SDK Rust couvrent ces courses, absence de
  SMTP, autorité, suppression des anciens codes et échéances expirant sous
  verrou. Le [contrat e-mail](protocol/EMAIL.md) précise les garanties.
  La suite complète passe : 119 tests serveur, 7 tests contrat / client, 112
  tests SDK TypeScript, workspace bureau Fedora, 1 062 tests mobiles, typecheck
  et lint. Un premier lancement en parallèle des builds a dépassé la seconde
  d'un ancien test de verrouillage ; ce test passe isolément puis dans la suite
  avec `RUST_TEST_THREADS=4`. Aucun test ou délai produit n'a été modifié.
  La CI `native-server` du commit `39177c1` est entièrement verte, avec Fedora,
  cœur Windows, serveur / mobile et modèles / bancs Swift.
  Les coffres et boutons de retrait mobile / GTK / SwiftUI restent le prochain
  lot ; le facteur e-mail, la récupération et les appareils installés restent
  ouverts. Ce socle ne ferme pas P02.

- P02, adresse e-mail bureau : formulaires dans les paramètres GTK / SwiftUI
  existants, traduction FR / EN et coffre Rust partagé avec preuves et facteurs.
  Le candidat précède HTTP dans le trousseau ; aucun code saisi ni identifiant
  privé de l'opération ne traverse l'ABI Swift. La révision affichée lie ses
  actions à la bonne tentative. Neuf tests couvrent pertes d'ACK, refus / délai
  / identité altérés, ancien reçu, write failure et deux coffres sous un verrou
  OS, retenu jusqu'à la fin réelle de l'écriture après annulation de l'appelant.
  Les bancs GTK (435 px) et Swift passent avec deux processus, vrai Secret
  Service et SMTP TLS local : tentative en attente au restart, confirmation
  perdue reprise sans autre code, reçu explicitement fermé, adresse refusée
  annulée sans retirer le contact. PostgreSQL exige une famille, une preuve
  d'identité, un mail admis / confirmé et la charge livrée effacée. Tous les
  tests / Clippy du workspace bureau passent ; les modèles Swift compilent
  avec bindings réellement générés. Les CI du commit `0336f62` passent :
  `native-server` (Fedora, cœur Windows et modèles Swift) et compilation /
  démarrage SwiftUI macOS. Les trousseaux Windows / macOS installés restent ouverts.
  La correction d'adresse refusée mobile passe aussi contre HTTP / PostgreSQL /
  SMTP, avec 11 tests de coffre et 1 060 tests mobiles verts, typecheck et lint.
  Le retrait du contact, les défis e-mail et la récupération restent dans P02.

- P02, adresse e-mail mobile : la section Sécurité existante affiche le contact
  privé, propose un code et son état de livraison, puis reprend / annule une
  vérification ou confirme son reçu. Les saisies disparaissent à la sortie /
  suspension ; le candidat et les versions restent dans SecureStore par cinq
  champs de portée. La file de sécurité sérialise HTTP et stockage. Les anciens
  callbacks, remplacements d'adresse, identités ou délais altérés sont refusés.
  Dix tests de coffre et un test des gardes fournisseur couvrent ces invariants.
  Le banc connecté utilise le vrai fournisseur, SQLite, HTTP / WebSocket,
  PostgreSQL et SMTP loopback : pertes d'ACK start / confirm, échec d'écriture
  du reçu, reprise sans second code ni nouvelle famille. Sa route de lecture
  de code est privée à la construction des tests ; son stockage privé est
  simulé. Vérifications : 105 tests serveur, 7 tests contrat / client, 109 tests
  SDK TypeScript et 1 059 tests mobiles ; typecheck, lint, contrats, inventaire
  et export Android passent. La qualification des widgets / SecureStore sur
  app installée reste ouverte. ADB voit zéro appareil connecté, un AVD
  `Medium_Phone_API_36.1` est disponible pour le prochain banc installé.
  Les paramètres GTK / SwiftUI, le retrait de contact, les défis e-mail et la
  récupération restent la suite de P02.

- P02, nettoyage des défis e-mail : migration 0017 et réservation durable de la
  tête de l'appareil. Le nettoyage d'un défi expiré ne peut plus autoriser le
  rejeu d'un ancien start avec une nouvelle échéance, ni un nouveau candidat
  sous la même tête. Le retrait explicite ouvre la tête suivante. La régression
  PostgreSQL et la suite complète passent : 104 tests serveur, 7 tests de contrat
  / client et 98 tests SDK TypeScript, avec Clippy et contrats générés.

- P02, adresse e-mail vérifiée serveur / SDK : migration 0016, routes privées
  start / resume / confirm / retire et statut avec barrière de livraison et
  `no-store`. La capacité additive est publiée avec SMTP et clé opérateur
  configurés. Le compte confirme son identité sur la famille actuelle ; le
  contact reste hors annuaire. Le reçu original n'étend ni échéance ni âge de
  preuve, ne crée pas de bearer et ne modifie pas les facteurs. La tête par
  appareil protège contre les starts / confirmations / retraits retardés.
  Défi et file chiffrée sont atomiques, avec quotas persistants par compte,
  adresse, IP et instance ; le worker fait SMTP hors verrous métier avec lease,
  retries du même code et échéance initiale. Un relais local perd l'ACK puis un
  nouveau runtime livre le même code. Des échanges TLS réels couvrent STARTTLS,
  TLS implicite, refus d'autorité inconnue et refus du mauvais nom de certificat.
  L'expiration pendant le verrou de budget est relue avant création, et une
  famille expirée ne peut plus livrer un job déjà en file. Vérifications locales :
  32 tests de bibliothèque et 71 tests d'intégration serveur, 7 tests de contrat /
  client, 98 tests SDK TypeScript ; Clippy, schéma / génération / inventaire,
  typecheck et lint mobile passent.
  Le [contrat e-mail](protocol/EMAIL.md) détaille les états et bornes.
  Les formulaires des trois clients, le retrait du contact, les défis e-mail,
  la récupération et la qualification avec relais réel / appareils restent
  ouverts. Ce lot ne ferme pas P02.

- P02, socle SMTP : transport Rust avec TLS exigé, configuration JSON privée
  montée, modèles de message bornés, quatre envois simultanés et échéance totale
  de 30 s. Le travail Tokio conserve le permis après annulation de l'appelant.
  Ce premier lot ne publiait pas encore de route ou capacité e-mail. Les cinq
  tests du transport passent : configuration / injections,
  fichier privé et symlink, refus du relais sans TLS, échange SMTP loopback et
  annulation ; Clippy, 90 tests serveur, 7 tests protocole / client et 95 tests
  SDK TypeScript passent, ainsi que schéma / génération / inventaire. Le
  [contrat e-mail](protocol/EMAIL.md)
  fixe la suite : adresse vérifiée, file chiffrée durable et quotas, défis
  explicites, récupération conservant les facteurs et raccordement des trois
  clients. Les échanges TLS locaux sont qualifiés dans le lot suivant ci-dessus ;
  la délivrabilité du relais d'exploitation reste ouverte.

- P02, paramètres SwiftUI / objet FFI : la section Sécurité rejoint les
  préférences groupées existantes, sur le `NativeChat` et la famille courante.
  L'objet opaque partage le coffre `rv-core::native::security` avec GTK ; les
  candidats / IDs de preuve, opération et reçu restent internes. Les saisies
  sont transitoires et les confirmations sont liées à la révision affichée.
  La copie relit intention et version avant son callback MainActor, encore
  conditionné au compte / fournisseur / visibilité. Fermeture et suspension
  effacent les valeurs privées et invalident les callbacks ; Actualiser peut
  reprendre la même intention après reconnexion sans rejouer mot de passe ou
  code. Le banc dédié PostgreSQL avec deux processus Swift / Secret Service
  passe connexion et preuve avec ACK perdus, code incorrect, régénération,
  reprise du reçu après restart, confirmations périmées, copie en cours de
  fermeture, ancien fournisseur et désactivation avec ACK perdu. Les contrôles
  SQL confirment une seule famille, une preuve complète, deux codes consommés,
  une régénération et l'âge originel. Bindings et modèles Swift compilent ; six
  tests locaux passent et huit parcours restent conditionnels hors banc, dont
  ce nouveau parcours exécuté réellement deux fois. Les 240 tests cœur / FFI,
  Clippy et compilation GTK passent. Ce banc rejoint le job Swift de CI ; la
  CI macOS du commit `c45cdc6` a compilé et packagé l'interface SwiftUI puis
  démarré l'app et ses parcours de galerie / soak. Les trousseaux des apps
  installées demeurent distincts du test Linux. SMTP / email vérifié restent à livrer.

- P02, paramètres GTK / coffre commun bureau : les préférences existantes et
  le dialogue Appareils ouvrent la confirmation d'identité sur la famille
  courante. Configuration TOTP, dix secours avec confirmation explicite,
  régénération et désactivation utilisent `rv-core::native::security` et le
  trousseau privé existant. Le dialogue reste lié à l'URL / UID / famille /
  instance / génération ; les secrets saisis sont effacés avant envoi et à la
  fermeture. Les opérations HTTP et KV sont sérialisées par un verrou OS,
  conservé par le vrai travail de stockage même après annulation de l'appelant.
  Les réponses d'une ancienne connexion sont refusées. Actualiser reprend
  l'intention originale après la reconnexion provoquée par une mutation de
  facteur ; il ne renvoie jamais le mot de passe ou un autre code.
  Huit tests couvrent reprise start / finish et activation / remplacement /
  désactivation, stockage indisponible / corrompu, verrou après annulation,
  ancien fournisseur, réponse tardive et capacités retirées. Vérifications :
  240 régressions cœur / FFI, Clippy et compilation GTK réussis ; inventaire et
  changelog contrôlés. Le test FFI `live` demeure conditionnel dans cette suite.
  Le banc PostgreSQL jetable avec deux vrais processus GTK / Secret Service
  exerce mot de passe, code incorrect, ACK perdus de start / finish,
  régénération, reçu privé après restart, confirmation des secours et
  désactivation après changement de génération du socket. SQL confirme une
  seule famille, une seule preuve complète, deux secours consommés, une seule
  régénération et l'âge / expiration originels de la preuve. Le dialogue rendu
  tient à 435 px et les captures excluent les codes privés. Ce banc est ajouté
  au job CI bureau. SwiftUI est raccordé dans le lot suivant ci-dessus. SMTP et
  les trousseaux / appareils physiques restent la suite de P02 ; ce lot ne
  qualifie pas une app Windows ou macOS installée.

- P02, paramètres / coffres mobile : la section Sécurité de l'écran existant
  configure TOTP, conserve puis confirme les dix secours, régénère ou désactive
  le facteur. La confirmation d'identité reste sur la famille courante, y compris
  pour la révocation d'un autre appareil. Coffres privés liés à l'URL / UID /
  famille / instance / génération, intentions persistées avant HTTP, mots de
  passe et codes saisis transitoires. Les callbacks perdent leur droit d'agir à
  la sortie de l'écran, suspension, déconnexion ou changement de fournisseur.
  Les contrôles TOTP suivent la capacité ; la preuve par mot de passe reste
  disponible sans clé opérateur TOTP. Aucun nouveau client ni écran de chat.
  La route additive retire un head de preuve attendu avant de remplacer un
  pending absent / expiré, puis le coffre sonde à nouveau le candidat original.
  Les barrières PostgreSQL préservent l'âge / provenance des preuves existantes
  et empêchent la reprise tardive d'un ancien start / finish. Les sacs de codes
  portent leur version commitée ; un changement concurrent les rend périmés.
  Douze scénarios de coffres et un scénario de runner couvrent ACK perdus,
  reprise après recréation, stockage refusé / corrompu, concurrence, callbacks
  obsolètes, changement de génération et confirmation explicite des secours.
  Le vrai transport TypeScript éprouve désormais les deux coffres sur PostgreSQL,
  perd les ACK d'activation, start / finish et régénération puis reprend les
  opérations originales avant désactivation. Deux scénarios SQL supplémentaires
  couvrent retirement, contexte, conservation de l'âge et des reçus plus récents.
  Vérifications : 85 tests serveur, sept de protocole, 95 TypeScript natifs et
  1 045 régressions mobiles réussis ; contrôles finaux ciblés, typecheck / lint,
  Clippy / 232 régressions cœur et FFI, compilation GTK, schéma / génération et
  inventaire réussis. Export Android Hermes produit ; il ne constitue pas un
  APK installé ni une validation du Keystore. Les fichiers Firebase Android /
  iOS restent absents et les parcours sur appareils demeurent ouverts.
  Les paramètres / coffres GTK et SwiftUI, SMTP et validations sur appareils
  restent la suite de P02. La CI du lot mobile `7e7c10e` est entièrement verte
  (run `36885412776`, quatre jobs).

- P02, réauthentification serveur / SDK : migration 0015, statut de preuve et
  parcours start / finish / resume sur la famille courante, sans nouveau bearer
  ni appareil. Mot de passe puis facteur courant donnent une preuve de quinze
  minutes ; un reçu de cinq minutes reprend une réponse perdue sans prolongation.
  La version de l'appareil bloque l'ancien corps même après nettoyage du reçu.
  Les limites CPU / SQL sont partagées avec le login, les essais sont persistants
  et les erreurs de preuve ne révoquent pas le chat. Login et réauthentification
  partagent compteur TOTP et secours ; leur provenance identifie le secret
  effectivement prouvé. Un authentificateur nouvellement inscrit ne profite pas
  d'une ancienne preuve, y compris après recul d'horloge ; les familles migrées
  sans provenance doivent confirmer à nouveau. Les réglages de facteur autorisés
  avancent l'autorité du gardien sans rajeunir la preuve ni changer sa provenance.
  Deux régressions HTTP reproduisaient un succès après expiration sous verrou
  d'appareil et une désactivation de nouveau facteur après correction d'horloge ;
  elles sont corrigées et couvertes. Onze nouveaux scénarios PostgreSQL couvrent
  ces barrières, code à usage unique, restart / rotation, pruning, quota de défis,
  erreurs de clé / code, mot de passe changé sous verrou et autorité / génération.
  Le vrai transport TypeScript perd les ACK de start / finish, reprend la preuve
  puis régénère / désactive depuis la famille inscrite initialement. Le SDK Rust
  reprend la même preuve après restart / rotation.
  Vérifications : 83 tests serveur, sept de protocole et 82 TypeScript natifs
  passent ; 1 032 régressions mobiles, typecheck / lint, Clippy / régressions
  cœur et FFI, compilation GTK, schéma / génération et inventaire réussis.
  Les coffres / formulaires de réauthentification et paramètres des trois clients,
  SMTP et validations sur appareils restent ouverts.

- P02, régénération des secours serveur / SDK : migration 0014 et endpoint
  privé visant une version précise et une opération persistée. La transaction
  remplace dix codes, conserve secret / compteur TOTP, avance l'autorité et
  révoque les autres familles / reprises de sync. Un reçu chiffré de cinq minutes
  permet au même appareil de récupérer le lot après réponse perdue, restart ou
  rotation, sans seconde révocation. Le quota de trois succès / quinze minutes
  survit à la révocation de l'appareil ; ciphertext expiré et métadonnées sont
  nettoyés par lots bornés. Cinq régressions HTTP / PostgreSQL supplémentaires
  couvrent concurrence, version périmée, preuves anciennes, clé incorrecte,
  ciphertext d'un autre usage, génération / autorité, expiration après verrou,
  pruning et absence de nouvelle consommation / révocation au rejeu. Le SDK
  Rust récupère le reçu après restart / rotation ; le vrai transport TypeScript
  perd l'ACK puis retrouve le même lot avec un transport recréé.
  Vérifications : 72 tests serveur, sept tests de protocole, 82 tests TypeScript
  natifs et 1 032 régressions mobiles passent ; formatage, Clippy, typecheck,
  lint, schéma / génération et inventaire réussis. Paramètres des trois clients,
  réauthentification explicite et SMTP restent ouverts ; aucun facteur activé
  sur une instance utilisateur.
  La CI native `36870100630` passe ses quatre jobs Linux / Windows / Swift.

- P01 / P02, expiration sous verrou : le verrou d'autorisation relit l'horloge
  PostgreSQL après acquisition du compte et de la session. `now()` reste figé
  au début de la transaction, et un prédicat avec `clock_timestamp()` peut aussi
  précéder l'attente de `FOR SHARE` sans mise à jour de ligne. Une régression HTTP
  réelle reproduisait un renommage accepté avec un bearer expiré ; les deux
  attentes de verrou donnent désormais `401`, avec le nom initial inchangé.
  Formatage / Clippy et toutes les régressions serveur PostgreSQL passent,
  dont 28 scénarios API, facteurs, invitations, récupération et clients natifs.
  La CI native `36866737534` passe ses quatre jobs Linux / Windows / Swift.

- P02, connexion FFI / SwiftUI : objet UniFFI opaque pour la tentative, coffre
  privé non indexé et formulaire existant raccordé à TOTP / secours. Le commit
  conserve expiration et clé E2EE, puis nettoie la preuve ; l'activation du compte
  est synchrone après les gardes de formulaire / sélection. Les callbacks d'une
  vue quittée ne peuvent installer un fournisseur. Le rejeu d'un handle committé
  reprend le même fournisseur sans réécrire un bearer déjà renouvelé / supprimé.
  Vérifications : formatage / Clippy, régressions FFI et bindings régénérés,
  compilation / six tests locaux des modèles Swift et analyse syntaxique de la vue.
  Cinq parcours connectés passent sur PostgreSQL et le vrai Secret Service Linux,
  dont conservation du compte actif, preuve récupérée par un nouveau modèle,
  requête quittée, code erroné, réponse perdue, confirmation sans code, reprise
  depuis le trousseau et rejeu après rotation forcée. SQL confirme une seule
  famille et un seul secours consommé ; les compteurs de renouvellement passent.
  Inventaire : 280 fichiers / 344 occurrences. Le banc privé est supprimé après
  vérification. La CI native Linux / Windows et la compilation / le démarrage
  SwiftUI sur le runner macOS passent. La qualification du Keychain et de
  l'application macOS installée reste ouverte. P02 continue avec
  les paramètres des trois clients, réauthentification explicite, secours et SMTP.

- P02, connexion GTK : formulaire existant avec choix TOTP / secours, preuve
  privée hors liste des comptes et opérations de trousseau conservant leur
  verrou après annulation. Une sauvegarde de session refusée ne l'active pas ;
  le nettoyage compare la preuve exacte et le credential sauvegardé. Masquer
  la fenêtre ou quitter le formulaire invalide les réponses tardives sans
  supprimer le candidat durable. Rocket.Chat conserve son parcours existant.
  Vérifications : formatage / Clippy, suite cœur / bindings et compilation GTK
  réussis ; typecheck mobile et inventaire 279 fichiers / 344 occurrences.
  Banc jetable PostgreSQL / vrai Secret Service : code erroné, réponse réussie
  jetée par proxy, reprise sans nouveau code puis redémarrage du client sous
  un nouveau D-Bus. SQL confirme une seule famille et un seul secours consommé.
  Les dix lancements GTK d'échange, édition, appareils, invitation, facteurs
  et récupération passent ; le pair mobile et les compteurs de rotation passent.
  Le formulaire de facteur a été rendu et inspecté à 435 pixels, champs vides.
  Le volume privé est supprimé après les essais, le serveur de développement
  reste inchangé. SwiftUI / FFI, paramètres des trois clients, SMTP et appareils
  Android / trousseaux Windows / macOS restent ouverts.

- P02, coffre commun bureau : `rv-core::native::authentication_vault` sérialise
  le défi / candidat par URL canonique et identifiant avec un verrou de fichier
  interprocessus, sans secret sur disque. Le contrat de stockage garde ce verrou
  dans les tâches de plateforme qui survivent à l'annulation de leur appelant.
  Sept tests couvrent réponses perdues, reprises parallèles, comparaison du
  stockage, générations, données corrompues et une écriture bloquante annulée
  pendant qu'une autre instance attend. Formatage / Clippy, suite complète
  cœur / bindings et compilation GTK réussis. Les adaptateurs trousseau et les
  formulaires GTK / SwiftUI restent à raccorder ; ces tests utilisent un coffre
  portable et ne qualifient pas le Credential Manager ou le Keychain réels.

- P02, connexion mobile : formulaire existant raccordé à TOTP / secours et coffre
  SecureStore séparé par serveur / identifiant. Le candidat est écrit avant HTTP,
  la reprise sonde un code déjà accepté et le nettoyage attend le stockage actif.
  Une nouvelle preuve de mot de passe ne remplace pas un pending encore ambigu ;
  le verrou de compte et l'expiration du défi bornent son remplacement. Les
  instances du coffre partagent leur file, les formulaires périmés ne suppriment
  pas une nouvelle tentative et une erreur de proxy conserve le candidat.
  Vérifications : 1 032 tests mobiles, onze nouveaux scénarios de coffre,
  typecheck / lint sans avertissement et export Android / Hermes réussis.
  Banc PostgreSQL : réponse perdue, deux reprises concurrentes, nouveau mot de
  passe et un seul secours consommé. Ce banc exerce le coffre portable ; le vrai
  SecureStore Android reste à qualifier. Les formulaires GTK / SwiftUI et les
  paramètres des trois clients restent la suite de P02.

- P02, coordinateurs d'authentification bureau / mobile : étapes session / défi
  distinctes, identités épinglées, candidat durable avant code, sonde du candidat
  et validation du seul appareil courant avant installation. Une réponse perdue
  se récupère après expiration du défi sans réutiliser le facteur. Seul un refus
  structuré du candidat permet le rejeu de l'opération ; les autres erreurs ne
  changent pas le compte actif ni le pending. Inscription / récupération gardent
  cette même étape de facteur, avec comparaison de l'UID. Cinq tests cœur et huit
  tests TypeScript couvrent réponses ambiguës, génération, UID, coffre indisponible,
  ancien serveur et recovery ; le coordinateur mobile reprend une session réelle
  du banc HTTP / PostgreSQL après perte de réponse. Les adaptateurs trousseau et
  le raccordement des trois formulaires restent la suite immédiate de P02.

- P02, socle TOTP / secours serveur et SDK : migration 0013, clé opérateur
  fournie par fichier privé hors PostgreSQL, secrets chiffrés avec AAD par
  instance / UID / usage. Défis de cinq minutes liés à l'autorité et génération,
  cinq essais persistants, compteur TOTP strictement croissant et dix secours
  de 128 bits à consommation atomique. Les étapes anonymes des SDK ne remplacent
  pas le bearer actif. Un candidat durable et un reçu haché reprennent la même
  session après réponse perdue ; le banc TypeScript le vérifie contre HTTP et
  PostgreSQL réels. Inscription prouvée et désactivation privée exigent une
  connexion récente ; après activation, login complet avec facteur requis aussi
  pour révoquer un autre appareil. Rotation / activité ne rajeunissent pas ce droit.
  Le reset de mot de passe conserve le facteur, et restauration / désactivation /
  changement d'autorité invalident les anciens défis. Clé absente / incorrecte /
  ciphertext corrompu ferment l'authentification du compte protégé.
  Vérifications : Clippy et suite Rust complète, neuf tests PostgreSQL de facteurs,
  vecteurs RFC 6238 / chiffrement / fichier opérateur, 63 tests TypeScript natifs,
  1 013 tests mobiles et typecheck / lint ; tests cœur / bindings et compilation
  GTK réussis. Une collision de délais publication / logout détectée sous charge
  est corrigée par une attente du compteur plus courte ; le scénario complet passe.
  Contrat dans [AUTHENTICATION.md](protocol/AUTHENTICATION.md). P02 reste ouvert
  pour les formulaires / paramètres des trois clients, email / SMTP, défi explicite
  de réauthentification et régénération des secours ; aucune activation sur une
  instance utilisateur ni qualification sur appareil n'est revendiquée.

- P01, récupération opérateur : CLI `recover-user` / liste / révocation et
  variante « Mot de passe oublié » dans la connexion mobile / GTK / SwiftUI.
  Code CSPRNG lié à UID, autorité et génération, hash seul en PostgreSQL ;
  1–24 h, 3 codes actifs par compte. La transaction change Argon2 et l'autorité,
  révoque les appareils / tickets / reçus et les reprises de snapshot / journal,
  tout en conservant compte, permissions et conversations. Le reçu se rejoue
  cinq minutes avec le nouveau mot de passe sans révoquer les sessions récentes.
  Aucun facteur ni donnée E2EE n'est effacé ; le login normal reste distinct.
  Cinq tests PostgreSQL couvrent concurrence, nouvelle session après rejeu,
  autorité / génération / compte / expiration, attente réelle de verrou et course
  d'un login ayant déjà vérifié l'ancien mot de passe. 59 tests TypeScript natifs
  et 1 009 tests mobiles, typecheck / lint / export Android passent, ainsi que
  Clippy / cœur / bindings / GTK et les modèles Swift. Le banc mobile vérifie UID,
  conversation conservée dans SQLite, ancien bearer refusé et reprise. GTK
  utilise le vrai formulaire puis Secret Service après redémarrage ; Swift
  teste récupération / ancienne session HTTP 401 / reprise du trousseau / logout.
  Le binaire opérateur réel est testé pour émission, liste sans secret,
  révocation idempotente et refus de durée hors politique ; le script refuse
  toute base autre que le banc jetable. Récupération par email, facteurs P02 et
  qualification physique restent ouverts.

- P01, invitations : CLI `invite` / `list-invitations` / `revoke-invitation` et
  inscription dans les écrans de connexion mobile / GTK / SwiftUI existants.
  Inscription publique fermée ; code aléatoire conservé sous empreinte seulement,
  1–168 h, au plus 1 000 invitations actives par génération. Un code crée un
  compte sans droit admin ; le login normal suit. Les confirmations perdues et
  deux inscriptions concurrentes retrouvent le même UID avec son mot de passe.
  Expiration après verrou PostgreSQL, révocation, compte désactivé / supprimé,
  changement de génération et quotas persistants sont testés. Les clients
  vérifient instance / génération et l'UID du login avant stockage sécurisé.
  Vérifications : 4 tests PostgreSQL dédiés en plus des 27 API, 56 tests natifs
  TypeScript, 1 006 tests mobiles, typecheck / lint / export Android ; Clippy,
  tests cœur / bindings et compilation GTK ; bindings et modèles Swift.
  Le banc jetable crée trois comptes invités : runner mobile avec SQLite réel,
  widgets GTK avec reprise après redémarrage depuis Secret Service, modèle Swift
  avec création / reprise / logout dans le trousseau. Ses codes restent dans un
  volume privé supprimé en fin de banc. Récupération P01 et second facteur P02
  restent ouverts, ainsi que les validations sur appareils physiques.

- P01, appareils : les paramètres existants mobile / GTK / SwiftUI listent les
  sessions du compte, affichent l'appareil courant, les dates et permettent de
  renommer / révoquer un autre appareil. Le fournisseur relit les credentials
  sécurisés avant les commandes bureau. La révocation exige une connexion récente
  côté serveur ; rotation et activité ne la prolongent pas. Le suivi d'activité
  est coalescé à cinq minutes et saute les lignes verrouillées. Les fournisseurs
  fermés et les confirmations d'un ancien compte ne peuvent muter une nouvelle
  session. Les tests du transport conservent code / request ID du refus de
  réauthentification ; le modèle Swift nomme l'appareil et révoque une seconde
  session réellement créée en PostgreSQL, puis constate son refus HTTP 401.
  GTK ouvre les paramètres / appareils et applique le nom par le champ Adwaita,
  avec lecture serveur et contrôle des limites du champ dans le dialogue.
  Typecheck / lint et 1 003 tests mobiles passent ; le bundle Android est exporté.
  Les validations physiques restent ouvertes, ainsi que récupération / invitations
  et le défi de réauthentification / second facteur P02.

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
