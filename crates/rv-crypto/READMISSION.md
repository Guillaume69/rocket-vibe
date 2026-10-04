# Nouveau Welcome dans le même coffre

Une nouvelle admission n'utilise pas les secrets MLS précédents. Le même coffre
peut conserver son identité / appareil, ses pins et ses marqueurs d'opérations,
puis rejoindre avec un KeyPackage frais et un Welcome ciblé. Aucun remplacement
n'est déclenché par un simple changement de roster ou un code HTTP de refus.

`Coordinator::preview_readmission` authentifie le paquet, la portée complète,
le roster courant et les destinataires avec les pins / révocations actuels.
Il exige un état accepté, aucune transition / intention de message incertaine,
un package non observé dans les admissions acceptées et, pour la même portée de
groupe, une révision / époque plus récente. Une rotation confirmée mais encore
en attente de sa position dans le journal bloque aussi le remplacement.

La preview supprime l'ancien groupe uniquement dans une copie temporaire du
provider. Elle ouvre le vrai Welcome et vérifie arbre / contexte, feuille
propre, auteur, signature et correspondance du package privé. Les secrets et
le package persistants restent intacts. Le consentement lie le paquet exact,
l'état précédent, les pins, le certificat local et une échéance bornée.

`accept_readmission` revalide ce consentement et les contrôles courants dans
une transaction protégée. Suppression de l'ancien état OpenMLS, consommation
du nouveau package, nouveau groupe, conservation de l'historique de références,
retrait du curseur précédent et marquage du cache précédent sont atomiques.
Corps modifié, pins / droits devenus périmés ou erreur MLS laissent l'ancien
checkpoint intact. Une coupure de checkpoint externe ne libère aucun résultat ;
le même consentement réconcilie après réouverture un ancien état ou l'admission
nouvelle déjà enregistrée. Un ACK exact n'accorde aucun nouvel envoi après expiry.

Le worker annonce `EventKind::Readmission` dans la preview d'un nouveau Welcome
pour un salon déjà présent. `accept_event` ne remplace le groupe qu'après la
confirmation exacte de cette preview. Les previews de première admission,
réadmission et commits ont des intentions distinctes. Ce type permettra aux
interfaces existantes d'annoncer les frontières d'historique lors du consentement.
Il n'active aucune capacité dans les apps.

Le journal repart de son début autorisé par **la nouvelle admission**. Le serveur
filtre les anciennes frames avec ses témoins d'accès / activation / package ;
le coffre vérifie lui-même cette admission sur chaque plan signé. Un ancien
cache ou reçu HTTP ne fournit pas les clés des époques manquées. Les corps de
l'admission précédente restent marqués dans le cache privé borné ; réception
courante et rejeu de page les refusent. Les marqueurs de messages sont conservés
et les documents personnels abandonnés restent récupérables par leur API propre.
Une archive autorisée de cet ancien cache reste un lot distinct ; il ne devient
pas automatiquement une projection visible de la nouvelle admission.

L'effacement vise le provider et checkpoint actifs. Les anciennes copies
chiffrées SQLite / WAL / backups gardent les limites décrites dans
[README.md](README.md) ; aucune garantie nouvelle d'effacement
physique ou de forward secrecy des backups n'est annoncée.

Preuves : six scénarios avec vrais Welcomes dans le même coffre, paquet MLS
corrompu mais correctement signé, pins / roster périmés, opérations incertaines,
cache précédent, réouverture et checkpoint externe interrompu. Le banc HTTP /
PostgreSQL exerce un vrai départ / retour de membership, deux packages distincts
consommés par la première admission et la réadmission, puis nouveaux messages
sur la cinquième époque. Son stockage externe est simulé ; appareils / trousseaux
physiques, suspension après retrait, archives, projection dans les apps,
intégration Android et revue indépendante restent ouverts.
