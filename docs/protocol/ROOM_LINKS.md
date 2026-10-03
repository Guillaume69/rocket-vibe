# Liens de salon et de message — P21

Les clients existants GTK, SwiftUI et Android utilisent le même contrat :

```text
rocketvibe://salon/<rid>?host=<URL complète>&instanceId=<instance>&dataEpoch=<époque>&msg=<message>&tmid=<racine>
```

`msg` et `tmid` sont facultatifs. `host` conserve protocole, port et chemin du
reverse proxy. Le nom d'hôte et le port HTTP par défaut sont normalisés ; les
chemins distincts ne sont jamais fusionnés. Une URL avec credentials, query ou
fragment n'est pas une adresse de service. Une autre URL canonique exige une
reconnexion explicite, même si elle désigne le même serveur physique.

Un permalien natif identifie instance et époque ; il ne contient ni bearer,
contenu, ni compte de l'auteur. Un autre membre autorisé peut l'ouvrir avec son
propre compte. Le contrôle d'accès du serveur demeure nécessaire.

Une notification porte en plus le destinataire via `userId` ou le `nativeScope`
JSON existant `{instanceId,dataEpoch,userId}`. Les deux formes, si présentes,
doivent correspondre. Une identité partielle, un paramètre répété, une racine
invalide ou une portée malformée provoquent un refus, sans repli sur la session
active. Identifiants : 1 à 128 caractères ASCII alphanumériques, `_` ou `-` ;
URL au plus 8 Kio. Aucun lien ne fournit un jeton au transport.

Les anciens liens `rocketvibe://salon/…` et `rocketvibe://room/…` sans identité
native restent Rocket.Chat. Leur service explicite suit aussi la comparaison
de l'URL complète. Sans service, seul un compte Rocket.Chat convient. Les
liens reçus par le système sont marqués dans Expo Router afin qu'ils ne soient
pas confondus avec les routes internes vers un salon du compte actif.

## Compte et résolution

Le bureau garde le compte déjà choisi s'il correspond. Sinon, une seule session
enregistrée doit correspondre exactement au service, au fournisseur et à la
portée. Plusieurs comptes compatibles nécessitent le sélecteur existant :
jamais le premier de la liste. Le lien attend les salons et la connexion ;
un résultat tardif d'un ancien lien ou compte n'ouvre rien.

Android conserve l'écran « autre serveur » et son geste explicite. La session
SecureStore doit correspondre **avant** de changer le pointeur de reprise. Le
plugin Kotlin ajoute maintenant message et racine au lien de notification.

Les fournisseurs natifs relisent le message avec le transport authentifié,
vérifient son salon et sa suppression, puis prennent sa vraie racine de fil.
Une racine fournie qui contredit le message est refusée. La découverte,
l'adhésion d'origine et la génération de projection sont vérifiées autour de
la lecture, avant l'ingestion SQLite. Aucun curseur de journal n'est acquitté
par cette lecture ciblée. Une adhésion remplacée, une restauration ou une
session fermée annulent le résultat.

Les menus existants ajoutent « Copier le lien du message » pour les messages
natifs confirmés. Texte et fichiers partagés gardent leur chemin habituel.
Un saut natif compte les positions décimales, sans flottant ou horodatage ; les
réponses ouvrent le fil existant et y révèlent le message.

## Qualification et travaux restants

Tests du cœur Rust : parsing / comptes, protocole HTTP réel, changement de
salon, suppression, racine falsifiée, réadhésion et restauration pendant le
fetch ; SQLite ordonne les positions au-delà de `2^53` malgré des dates inversées.
Tests mobiles : mêmes barrières avec la projection SQLite réelle, arrêt du
runner, URLs du récepteur et routage du système. Les bindings et modèles Swift
compilent ; leurs tests appellent le parser Rust via UniFFI.

Le clic à froid sur un **permalien** est raccordé ; les parcours installés des
trois plateformes restent à exercer. Le registre des **actions de notification
bureau** est maintenant persisté dans le SQLite du compte ; sélection du compte,
attente de connexion, validation privée et réponse idempotente passent par les
modèles existants. GNOME enregistre l'action au startup, Windows utilise le
protocole app pour le clic, SwiftUI attend le compte destinataire. La réponse
Windows possède son activateur COM natif et un test entre vrais processus.
Le parcours Windows installé à processus arrêté, la remise à froid KDE et la
persistance d'une action attendant encore le réseau restent ouverts : [détails](PUSH.md).
Les anciens permaliens HTTP
Rocket.Chat importés attendent la table de correspondance et le résolveur J5.
P21 et J3 ne sont pas déclarés terminés.
