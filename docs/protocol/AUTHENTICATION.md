# Authentification native — P02, socle TOTP et secours

Ce lot livre le serveur et les SDK. P02 reste ouvert : raccordement des formulaires
GTK, SwiftUI et mobile, gestion des facteurs dans leurs paramètres, email vérifié /
SMTP et qualification des appareils. Le fournisseur Rocket.Chat garde son parcours.

Les coordinateurs `rv-core::native::authentication` et
`fournisseurs/rocketvibe/authentication.ts` préparent ce raccordement. Ils séparent
challenge et compte actif, épinglent instance / génération / UID, sauvegardent
le candidat via un callback de trousseau avant validation, puis le sondent en
priorité après réponse perdue. Une session déjà committée se récupère même après
expiration du défi. Seul un `401 session_rejected` compris autorise un nouvel
envoi du code ; refus de proxy, panne réseau ou réponse ambiguë conservent le
pending. Les paramètres du défi doivent encore être reliés aux coffres privés
des plateformes. Le pending n'est effacé qu'après sauvegarde de la session active.
Inscription et récupération passent par le même parcours complet et comparent
l'UID rendu par le code opérateur avec celui du challenge / de la session.

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

Une connexion de moins de quinze minutes autorise l'inscription initiale.
Après activation, la connexion doit aussi avoir été créée **après** cette
activation : le seul appareil inscrit initialement peut continuer à chatter,
mais doit refaire un login complet pour désactiver son facteur. Rotation,
activité et reprise ne rajeunissent pas cette autorisation. La révocation d'un
autre appareil applique la même preuve de connexion complète. Une session ancienne
rend `403 reauthentication_required`. Un défi explicite de réauthentification,
la régénération des secours et les clients restent les prochaines étapes.
