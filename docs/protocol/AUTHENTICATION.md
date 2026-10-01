# Authentification native — P02, socle TOTP et secours

Ce lot livre le serveur, les SDK et les connexions mobile / GTK / SwiftUI, ainsi
que les API de régénération des secours et réauthentification. P02 reste ouvert :
coffres / formulaires de réauthentification et gestion des facteurs dans les
paramètres des trois clients, email vérifié /
SMTP et qualification des appareils. Le fournisseur Rocket.Chat garde son parcours.

Les coordinateurs `rv-core::native::authentication` et
`fournisseurs/rocketvibe/authentication.ts` préparent ce raccordement. Ils séparent
challenge et compte actif, épinglent instance / génération / UID, sauvegardent
le candidat via un callback de trousseau avant validation, puis le sondent en
priorité après réponse perdue. Une session déjà committée se récupère même après
expiration du défi. Seul un `401 session_rejected` compris autorise un nouvel
envoi du code ; refus de proxy, panne réseau ou réponse ambiguë conservent le
pending. Le formulaire mobile utilise son coffre SecureStore privé ; GTK utilise
le trousseau système, partagé avec FFI / SwiftUI sur macOS. Le pending n'est effacé
qu'après sauvegarde de la session active.
Inscription et récupération passent par le même parcours complet et comparent
l'UID rendu par le code opérateur avec celui du challenge / de la session.

### Coffre et formulaire mobile

L'écran de connexion existant propose TOTP et les secours annoncés par le serveur.
Mot de passe et code opérateur quittent son état dès le défi ; les codes TOTP /
secours restent seulement en mémoire. Retour ou perte du focus empêche une
réponse tardive de commencer l'installation du compte. Le fournisseur Rocket.Chat
garde son parcours de facteur existant.

Le coffre utilise une clé `native-auth-` dérivée d'un tuple JSON domaine / URL
canonique / identifiant, distincte des sessions et des clés E2EE. SecureStore
emploie `WHEN_UNLOCKED_THIS_DEVICE_ONLY` ; ni SQLite, ni extension push ne lisent
ce candidat. Une file partagée entre instances couvre lectures, écritures,
HTTP et comparaison du pending. Les données corrompues échouent sans exposer
leur JSON dans une erreur.

Une nouvelle preuve de mot de passe sonde d'abord le candidat précédent. Elle
le conserve tant que l'ancien défi peut encore valider une requête retardée.
Son remplacement exige un nouveau défi émis après l'expiration du précédent
(TTL serveur fixe de cinq minutes) et une sonde après cette barrière : `start`
et `verify` détiennent le même verrou de compte. Une erreur ambiguë, un UID,
une instance ou une génération différents ne peuvent effacer ce pending.
Le mobile conserve aussi le pending si les deux instants tombent dans la même
milliseconde : PostgreSQL est plus précis que `Date.parse`, et cette égalité
ne prouve pas que l'ancien défi était déjà expiré au moment de la nouvelle preuve.

Après perte de réponse, « Valider » sans code sonde la session déjà acceptée.
Après redémarrage, une nouvelle connexion par mot de passe reprend ce même
candidat avant toute demande d'un nouveau code. Le nettoyage compare défi,
identité et bearer réellement sauvegardé ; une session renouvelée ou une autre
tentative conserve le pending par prudence. Un échec du stockage actif garde
la reprise possible ; une erreur de nettoyage ne défait pas un compte installé.

Onze tests du coffre couvrent interruptions, concurrence, preuve fraîche,
comparaison du stockage et isolement. Le banc HTTP / PostgreSQL utilise un
adaptateur portable, pas le Keystore Android : la qualification SecureStore
sur appareil, processus réellement tué et verrouillage système reste ouverte.

### Coffre partagé bureau

`rv-core::native::authentication_vault` porte les mêmes règles pour GTK et FFI :
clé privée par URL canonique / identifiant, défi séparé du compte actif,
comparaison du pending avant écriture, récupération prioritaire et remplacement
après la barrière de compte. Le nettoyage vise exactement le défi et le bearer
installés ; un compte, une génération ou une session renouvelée différents ne
peuvent enlever la preuve précédente.

Un fichier vide au nom condensé porte un verrou système entre instances / processus.
Le trait de stockage transmet ce verrou à chaque opération de trousseau et impose
de le garder jusqu'à sa fin réelle. L'annulation de la future appelante ne doit
pas libérer une écriture de plateforme déjà engagée. Sept tests vérifient les
scopes, réponses perdues, reprises parallèles, expiration, stockage indisponible,
JSON corrompu et annulation avec écriture bloquante encore active. Clippy,
régressions cœur / bindings et compilation GTK passent dans Fedora.

### Formulaire et trousseau GTK

La page existante propose les méthodes TOTP / secours annoncées par le serveur.
Le défi et son candidat utilisent une entrée privée distincte des sessions :
`kind: authentication` dans Secret Service ; une clé non indexée dans les
trousseaux Windows / macOS. Les énumérations des comptes actifs ignorent cette
entrée. Aucun mot de passe, code TOTP ou secours saisi n'est persisté.

Les tâches de plateforme gardent le verrou jusqu'à la fin réelle de leurs
opérations, même après annulation ou délai de cinq secondes. Le compte conserve
sa date d'expiration et sa clé E2EE lors de l'écriture du credential accepté.
Une erreur de stockage ne commence pas la session et garde le candidat récupérable.
Le nettoyage compare la preuve exacte à la session effectivement sauvegardée.

Retour, changement de compte et masquage de la fenêtre invalident les réponses
tardives. Mot de passe et code opérateur quittent le formulaire dès le défi ;
le code de facteur est effacé au changement de méthode, au retour et après
confirmation. La connexion Rocket.Chat conserve ses méthodes existantes.
Les adaptateurs Windows / macOS et SecureStore Android restent à qualifier sur
appareils ; les paramètres restent ouverts.

### Tentatives FFI et formulaire SwiftUI

`NativeLoginAttempt` est un objet opaque UniFFI : Swift voit les méthodes
disponibles et l'indication d'une confirmation en attente, jamais le défi,
le candidat ou le bearer. Vérification et commit sont sérialisés. Le candidat
reste dans une entrée de trousseau non indexée ; les tâches bloquantes de la
plateforme gardent le verrou après annulation et délai de cinq secondes.

Le formulaire SwiftUI existant propose TOTP / secours. Il efface mot de passe
et code opérateur dès le défi. Changement de serveur / identifiant, retour,
annulation et disparition de la vue invalident sa génération. Le commit écrit
le credential avec expiration et préserve la clé E2EE du même compte, puis
nettoie la preuve exacte. Il ne change pas le pointeur de compte actif.
L'application active le compte après ses gardes de formulaire et de sélection,
sans attente entre cette vérification et l'installation du fournisseur.

Un handle déjà committé rend le même fournisseur : son rejeu ne réécrit pas
le bearer initial après rotation ou logout. Le fournisseur Rocket.Chat conserve
ses méthodes de facteur et son transport. Le banc Linux utilise le vrai Secret
Service ; les essais sur le Keychain macOS et l'interface macOS installée restent
distincts des tests de modèles Swift et de la compilation SwiftUI distante.

## Clé opérateur

`rv-server` accepte `RV_AUTH_KEY_FILE` ou `--auth-key-file CHEMIN`, jamais la clé
dans un argument. Le fichier contient 64 caractères hexadécimaux, éventuellement
suivis d'une fin de ligne : 32 octets générés par un CSPRNG. Il doit être régulier,
dans un répertoire privé ; sous Unix, aucun accès groupe / autres (mode `600`).
Les liens symboliques, valeurs mal formées et fichiers trop grands sont refusés.
Lecture bornée, enveloppes et clés sans `Debug`, effacement des clés et des
plaintexts déchiffrés à leur libération avec `zeroize`.

La clé est provisionnée et sauvegardée séparément de PostgreSQL, avec contrôle
d'accès opérateur. Conserver la même clé lors d'une restauration. Une perte rend
les facteurs inutilisables ; un reset de mot de passe ne les supprime pas. Le
chantier J5 doit encore livrer la procédure complète de sauvegarde / restauration
et rotation de cette clé. Aucun secret par défaut, génération implicite au
redémarrage, ni inclusion dans l'export utilisateur.

Sans clé, la capacité additive `second_factors` est fausse et l'inscription d'un
facteur est refusée. Un compte déjà protégé reste protégé : clé absente,
incorrecte ou ciphertext corrompu donnent `503 factor_unavailable`, jamais une
session avec le seul mot de passe. Le login historique donne `400 factor_required`.

Le chiffrement repose sur AES-256-GCM-SIV de RustCrypto, enveloppe version 1,
nonce aléatoire de 96 bits. L'AAD sérialise version, usage, identité stable
d'instance, UID et ID du facteur. Les secrets TOTP et les reçus temporaires de
secours utilisent des usages distincts. La génération `data_epoch` reste hors
AAD pour permettre le déchiffrement après restauration ; elle invalide les défis.
La bibliothèque est documentée [ici](https://docs.rs/aes-gcm-siv/0.11.1/aes_gcm_siv/).
Ses tests et ceux du projet ne constituent pas une revue cryptographique externe.

## Parcours anonyme

`POST /auth/start` accepte le même `Login` strict que `/auth/login` et renvoie
`AuthenticationStep` : `kind: session` avec une session, ou `kind: challenge` avec
`AuthChallenge` et l'utilisateur dont le mot de passe vient d'être vérifié.
Un compte protégé ne crée aucune session à cette étape. Le défi opaque de
256 bits n'est conservé que sous SHA-256, lié à l'UID, l'autorité, la version des
facteurs et la génération. Il expire après cinq minutes ; au plus cinq défis
non consommés par compte. Les méthodes annoncées sont `totp` et, s'il reste
des codes, `recovery_code`. `email` n'est pas annoncé dans ce lot.

`POST /auth/factors/verify` reçoit `FinishFactor` : défi, méthode, code,
`operation_id` et `next_token`. Le client génère un candidat CSPRNG de 32 octets
hexadécimaux et le sauvegarde dans le stockage sécurisé **avant** HTTP. Il garde
le même candidat / opération sur retry ; un défi ne peut servir de bearer.
Le candidat ne remplace pas un compte actif avant vérification de la réponse et
des identités d'instance / génération / UID. Les SDK ne font pas cette installation
automatiquement et les étapes anonymes ne révoquent pas le compte actif sur `401`.

Les verrous instance / compte / défi / facteur sont retenus jusqu'au commit ;
les expirations sont relues à l'horloge après attente. Une validation crée une
seule famille d'appareil et conserve un reçu de cinq minutes avec seulement le
hash du candidat. Après réponse perdue, défi + opération + candidat retrouvent
la même session existante sans nouvelle consommation du code. Un autre candidat,
un compte désactivé, une génération / autorité modifiée, une session révoquée /
renouvelée ou un reçu expiré ferment cette reprise.

Les quotas persistants global / IP / identifiant sont partagés avec le login,
plus une fenêtre par défi. Cinq codes erronés condamnent le défi, y compris
après redémarrage. Les codes non supportés / expirés / consommés rendent
`400 factor_rejected` ; le corps strict refuse les identités et droits forgés.
Les succès contenant des credentials portent `Cache-Control: no-store`.

Le contrôle d'une session déjà authentifiée relit l'horloge PostgreSQL après
les verrous de compte et de session. Un bearer expiré pendant l'une de ces
attentes est refusé avant de rendre l'autorisation à la mutation. L'heure de
début de transaction et un prédicat évalué avant l'attente de `FOR SHARE` ne
suffisent pas. La régression HTTP vérifie les deux verrous, dont une expiration
naturelle sans modification de la ligne bloquée, et l'absence de renommage.

## TOTP et codes de secours

La construction suit [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), avec
HMAC-SHA1, secret individuel aléatoire de 160 bits, six chiffres et période
30 secondes. La fenêtre comporte le pas précédent, courant et suivant ; les
comparaisons de codes passent par `subtle`. Le compteur accepté est persisté
sous verrou et doit croître strictement, empêchant un second usage même sur
un autre défi. Les tests utilisent les vecteurs normatifs, dont les dates après
2038. La bibliothèque [HMAC](https://docs.rs/hmac/0.12.1/hmac/) fournit la primitive.

Dix codes de secours indépendants de 128 bits sont générés à l'activation.
Tirets et casse sont de présentation ; PostgreSQL conserve leur SHA-256,
et chaque code est consommé atomiquement. Ils complètent le mot de passe et
ne servent pas à le réinitialiser. Aucun code de secours n'entre dans SQLite,
les logs ou le journal de synchronisation.

## Configuration privée

- `GET /me/factors` : méthodes actives, version et nombre de secours restants.
- `POST /me/factors/totp/setup` : `BeginFactorSetup` ; secret Base32 et URI
  `otpauth`, valables dix minutes. Même opération = même secret ; une opération
  concurrente est refusée. Le pending reste chiffré et lié à l'autorité / génération.
- `POST /me/factors/totp/enable` : `EnableFactor`, preuve par code TOTP. Cinq
  erreurs bornent l'inscription. Succès = dix secours, changement d'autorité,
  révocation des autres appareils et reprises de sync. Le secret n'est actif
  qu'après preuve. Un reçu chiffré de cinq minutes récupère les mêmes secours
  après réponse perdue, sans régénération ni seconde révocation.
- `POST /me/factors/totp/disable` : `DisableFactor` visant la version affichée.
  Un retry après désactivation est sans effet ; il ne peut enlever un facteur
  réinscrit entre-temps. La désactivation supprime secours / pending, change
  l'autorité et révoque les autres familles.
- `POST /me/factors/recovery/regenerate` : `RegenerateFactorBackups`, version
  affichée et ID d'opération sauvegardés avant HTTP. Une preuve complète récente
  remplace atomiquement les dix secours, avance la version / autorité et révoque
  les autres appareils et reprises de sync. Le secret TOTP et son compteur
  anti-rejeu restent inchangés. Aucun ancien secours ne demeure utilisable.

La régénération conserve un reçu chiffré pendant cinq minutes, lié à l'instance,
UID, appareil initiateur, opération, versions attendue / résultante, autorité et
génération. Après réponse perdue, le même corps retrouve le même lot, même après
rotation du bearer sur cet appareil ou redémarrage serveur. Le rejeu ne consomme
aucun code, ne rajeunit aucune preuve et ne révoque pas un appareil ajouté depuis.
Une autre régénération, changement d'autorité / génération, révocation de
l'appareil ou expiration ferme ce reçu. Son horloge est relue après verrou.
Les réponses contenant les codes portent `Cache-Control: no-store`.

Au plus trois régénérations réussies par compte et fenêtre glissante de quinze
minutes ; `429 factor_regeneration_limit` donne `Retry-After`. Les replays ne
consomment pas ce quota. La révocation de l'appareil retire son accès au reçu,
mais conserve le compteur : changer d'appareil ne contourne pas la limite.
Le nettoyage borné efface le ciphertext expiré puis les métadonnées après un
jour. La version initiale empêche une ancienne demande de régénérer des codes
après cet effacement. Codes et reçus restent hors SQLite et journal de sync.

Une connexion de moins de quinze minutes autorise l'inscription initiale.
Après activation, le login complet ou la preuve explicite récente doit avoir
prouvé l'identité du facteur courant. L'appareil inscrit initialement peut continuer à chatter,
mais confirme son identité avant désactivation / régénération ou révocation
d'un autre appareil. Rotation, activité et reprise ne rajeunissent pas cette
autorisation. Une preuve ancienne rend `403 reauthentication_required`.

## Réauthentification explicite sur la famille courante

La capacité additive `reauthentication` annonce les routes, absente / fausse
sur les serveurs v1 précédents. Aucun nouveau bearer ni appareil n'est créé.
L'appel reste protégé par le bearer courant ; son renouvellement garde la famille.

- `GET /me/reauth` : `ReauthenticationStatus`, UID, appareil, identité /
  génération, version de preuve et indication `recent` issue de la même règle
  SQL que les opérations sensibles. Ce booléen ne remplace pas leur autorisation.
- `POST /me/reauth/start` : `BeginReauthentication`, mot de passe, version de
  preuve affichée, ID d'opération et candidat de défi CSPRNG de 32 octets hex
  minuscules. Le client sauvegarde version / candidat / opération et leur
  contexte de compte dans une entrée privée **avant** HTTP, jamais le mot de
  passe. Un compte sans facteur obtient `kind: granted` ; sinon `kind: challenge`
  avec TOTP / secours disponibles. La clé incorrecte / absente ne contourne
  pas le facteur. Le candidat est haché en base, dans un espace distinct du login.
- `POST /me/reauth/finish` : `FinishReauthentication`, défi / opération, méthode
  et code transitoire. La réussite rend `ReauthenticationGrant`, uniquement
  des métadonnées de preuve, sans credential. La famille demeure la même.
- `POST /me/reauth/resume` : `ResumeReauthentication`, candidat / opération.
  Sans renvoyer mot de passe ou OTP, retrouve le défi ou la preuve déjà acceptée,
  même après réponse perdue, restart ou rotation sur la même famille. Un pending
  absent donne `404 reauthentication_not_found`, sans révoquer le chat.
- `POST /me/reauth/retire` : capacité additive `reauthentication_retirement`,
  contexte UID / appareil / instance / génération obligatoire et version de
  preuve attendue. Sous le verrou de famille, avance cette version si elle est
  encore courante et retire les défis non acceptés associés. Une demande tardive
  de start ne peut plus les recréer. Un replay d'ancienne version ne modifie pas
  une nouvelle preuve. Une preuve déjà valide garde exactement son âge,
  expiration et provenance de facteur, y compris lorsqu'une autre tentative
  est annulée. La réponse est le statut courant, sans secret ni nouveau bearer.

Sur les serveurs annonçant cette dernière capacité, start accepte aussi le
champ additif `context` et vérifie ses quatre identifiants sous verrou avant
toute émission de défi / preuve. Les SDK précédents peuvent omettre ce champ ;
les nouveaux coffres le fournissent systématiquement. Après retirement, ils
re-sondent le candidat original : un finish qui avait déjà gagné la course
peut encore être récupéré. Une erreur réseau seule ne permet aucun remplacement.

Argon2 utilise le même sémaphore CPU de quatre travaux que le login, conservé
par le vrai travail bloquant après annulation. Son hash est revérifié sous
verrou après calcul. Compte, session, appareil / version, défi et facteur sont
verrouillés dans cet ordre après l'instance. Expiration de session et de défi
est relue à l'horloge après les attentes correspondantes, avant consommation.
Les limites persistantes globales / IP / utilisateur sont partagées avec le login,
plus une fenêtre de défi ; cinq essais erronés et cinq défis pending par compte.
Mot de passe / code erroné donne `400 reauthentication_rejected`, jamais une
révocation du chat. Un bearer réellement expiré / révoqué conserve son `401`.

Une validation accepte un code une seule fois et fixe la preuve à quinze minutes.
Login et réauthentification partagent le même compteur TOTP et les mêmes secours.
Le reçu de cinq minutes permet un replay sans consommation, nouvelle preuve ou
prolongation. Une autre famille, autorité, version ou génération ferme cette
reprise. Les métadonnées de défi / preuve expirées sont nettoyées par lots bornés.
L'acceptation avance aussi la version de preuve de l'appareil : après nettoyage
du reçu, le corps initial ne peut recréer / prolonger l'opération. Une nouvelle
confirmation exige version courante, nouveau candidat / opération et vraie preuve.

Les autorisations explicites sont liées à l'identité / génération, versions
d'autorité / facteurs, famille / version de preuve et identité du secret TOTP
effectivement prouvé. Une opération de facteur autorisée avance les versions
du gardien sans modifier l'heure, son identité de facteur prouvé ou transformer
une preuve par mot de passe en preuve de second facteur. Régénérer les secours
garde le même authentificateur ; en inscrire un nouveau exige une nouvelle preuve,
y compris après recul d'horloge. Les réponses privées portent `Cache-Control: no-store`.
Les familles migrées dont la provenance de facteur est inconnue doivent confirmer
à nouveau leur identité ; leur date seule ne prouve pas le facteur courant.

Le mobile utilise désormais ces routes dans les paramètres existants. Un coffre
privé est lié à l'URL canonique, UID, famille, instance et génération ; sa file
sérialise les appels HTTP et les écritures entre instances. Il sauvegarde le
candidat / opération / version avant start et finish, jamais mot de passe ou
code saisi. Il reprend une preuve déjà acceptée avant de redemander un code.
Les générations de fournisseur et de focus bloquent les callbacks après
déconnexion, changement de compte, sortie de l'écran ou suspension.

Un second coffre de ce même périmètre conserve les intentions de configuration,
activation, remplacement et désactivation. Les reçus privés de codes portent
la version de facteur **originellement commitée**, également chiffrée dans le
reçu serveur, et non une version inférée après HTTP. Une modification concurrente
ne peut présenter une ancienne liste comme courante. Les codes restent dans
SecureStore jusqu'à confirmation explicite ; les reçus périmés sont fermés
explicitement sans lancer une autre mutation. Configuration et codes sont
effacés de l'écran à la sortie / suspension. Toutes ces entrées utilisent
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, hors SQLite, push et index des comptes.

Ces parcours et leurs pertes d'ACK sont éprouvés via les vrais endpoints sur
PostgreSQL jetable et des coffres portables ; ce banc ne valide pas le Keystore
sur téléphone physique. Coffres / paramètres GTK et SwiftUI restent à raccorder.
