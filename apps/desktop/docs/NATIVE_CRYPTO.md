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

Le contrat commun du salon indique maintenant l'existence d'un groupe MLS.
Ce booléen, absent ou faux sur les anciens serveurs, n'accorde aucune clé ou
admission. Une acceptation crypto publie uniquement cette métadonnée dans le
journal ordinaire, avec le même emplacement global que la livraison privée.
Les caches et vues de salon existants la conservent et verrouillent le composer,
y compris après une mise à jour du salon déjà ouvert. Un ancien envoi ordinaire
hors ligne passe en échec `crypto_required` avant tout POST, avec son corps
récupérable ; la file ordinaire refuse aussi de nouvelles intentions dans ce
salon. Aucun message déchiffré n'est encore affiché par ce raccordement.

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

Les réglages GTK et SwiftUI ont maintenant une section de préparation d'identité
et d'association d'appareil, visible uniquement avec les capacités expérimentales
E2EE et sessions d'appareils. Les trousseaux des deux interfaces utilisent le même
service dédié et le même répertoire `rocket-vibe-rs/native-crypto`. Une sélection
protégée, indexée par URL de serveur / instance / époque / utilisateur / appareil
HTTP, conserve l'incarnation avant l'initialisation du coffre ; une fermeture
ne régénère ni racine, ni clé d'appareil, ni enregistrement HTTP en attente.

Créer l'identité est une action explicite. L'appareil contrôleur examine une
demande signée et affiche les empreintes de racine et de demande avant une seconde
action d'approbation. Un nouvel appareil accepte explicitement la racine observée,
transmet un code public de demande au contrôleur puis installe son code public
d'approbation. Aucun secret de racine ou de coffre ne traverse UniFFI. Le consentement
reste opaque, lié au viewer ; le pont conserve son aperçu avec une révision locale.

L'installation du grant et le corps exact d'enregistrement sont checkpointés dans
la même transaction. La reprise lit d'abord le reçu personnel et vérifie tous ses
champs avant de terminer l'intention. Une erreur ou une réponse perdue conserve le
corps original. Le statut enregistré exige aussi le certificat courant dans
l'annuaire et la clé locale correspondante. Le renouvellement des certificats,
le remplacement avec révocation et la résolution d'une demande expirée avant toute
acceptation restent à raccorder : cette cérémonie n'active pas les salons chiffrés.

Restent les pins de pairs / cérémonies de groupe dans les interfaces, la récupération
et révocation visibles, la suspension des salons retirés et la projection
privée, le pont Android, les archives / fichiers et la qualification de la
[RFC E2EE](../../../docs/rfcs/0002-e2ee-native.md). La capacité reste désactivée
jusqu'à livraison et validation du parcours complet.
