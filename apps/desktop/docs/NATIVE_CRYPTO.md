# Crypto native dans le fournisseur bureau existant

Le cœur `rv-core::native::crypto` dépend maintenant de `rv-crypto`, avec HTTP
natif. GTK et SwiftUI gardent leurs interfaces actuelles ; le fournisseur
Rocket.Chat et son moteur E2EE existant ne changent pas. Le serveur annonce
toujours `e2ee=false` et le masque des fonctionnalités bureau n'annonce pas
E2EE. Ce raccordement expérimental ne constitue pas un parcours utilisateur
activé.

## Compte et cycle de vie

`NativeSession::crypto(guard, manager, root)` attache explicitement un coffre
déjà choisi et une racine publique à la session native courante. Aucun coffre,
certificat, pin ou compte n'est créé par cet appel. Il vérifie instance,
génération, utilisateur et unique appareil courant avant l'attachement ; un
désaccord refuse l'accès avant toute lecture privée.

L'accès clone le `NativeClient` de la session : même origine et mêmes
credentials renouvelés, aucune seconde connexion autonome. Une découverte
fraîche dans le worker remet les capacités de la session à jour. Une capacité
retirée ou une génération serveur différente suspend cet accès.

Un seul accès vivant est attaché à une génération de session. Ses clones
partagent le worker et sa queue de dispatch. Le registre et la garde retiennent
une référence faible au runner ; une vue conservée ne bloque pas sa fermeture.
La fermeture de la vue, suspension, reconnexion, fin du cycle de synchronisation
et shutdown arrêtent l'ancien accès. Il ne redevient jamais actif ; le nouvel
accès réouvre le même coffre sans réinitialiser ses intentions ni ratchets.

La garde est vérifiée dans le worker après les attentes HTTP et à l'entrée de
la tâche privée possédée, puis avant publication du résultat. Une écriture de
checkpoint déjà commencée peut terminer avec son verrou ; son résultat tardif
est retenu et aucune requête suivante n'est lancée par l'accès fermé.

## Surface privée

L'accès expose packages, previews / confirmations de groupe, réadmission,
envois / reçus / abandons et pages du journal protégé. Aucun getter ne livre le
worker brut, un signer, une clé de stockage ou une ratchet. Les previews restent
des objets opaques à confirmer explicitement. Les messages clairs et pages ne
sont rendus qu'après leur checkpoint protégé et revalidation du cycle de vie.
Leur projection dans la liste des messages reste à raccorder ; ils ne sont pas
écrits dans la SQLite ordinaire.

## Vérifications et suite

Les tests `native_crypto` utilisent le vrai `NativeSession`, son client HTTP,
son cache SQLite et des clés / packages MLS réellement préparés dans le coffre.
Le checkpoint externe est simulé, comme dans le banc privé HTTP ; ces tests ne
qualifient pas un trousseau installé.

Ils couvrent refus de capacité / portée / appareil courant ambigu avant coffre,
fermeture pendant HTTP avant travail privé, annulation réelle du demandeur
pendant l'écriture du checkpoint avec verrou conservé, non-réactivation après reconnexion,
reprise d'un package préparé avec exactement le même corps après réouverture,
capacité retirée et génération serveur remplacée. L'accès ne maintient pas le
runner fermé en vie.

Restent la cérémonie de racine / appareil / pins dans les interfaces, leurs
adaptateurs de trousseau, la suspension des salons retirés et la projection
privée, le pont Android, les archives / fichiers et la qualification de la
[RFC E2EE](../../../docs/rfcs/0002-e2ee-native.md). La capacité reste désactivée
jusqu'à livraison et validation du parcours complet.
