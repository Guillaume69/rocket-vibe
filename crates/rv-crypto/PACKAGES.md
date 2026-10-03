# Publication des clés d'admission MLS

Le module `packages::Coordinator` prépare les KeyPackages depuis le même coffre
protégé que les identités et groupes. Il utilise directement
`rv_protocol::e2ee::PublishKeyPackages` et `OperationReceipt` : aucune clé HPKE
privée, seed de signature ou ratchet MLS ne quitte le fournisseur du coffre.
Ce raccordement de contrat ne lance pas de requête réseau et n'active pas E2EE.

## Parcours du transport

1. Après l'enregistrement de l'appareil, transmettre sa révision décimale exacte
   à `prepare(revision, count, now)` sur le worker possédé du coffre.
2. Le moteur génère les clés privées, les véritables packages TLS et un ID
   d'opération aléatoire dans une transaction. L'outbox conserve le DTO public
   exact, ses références RFC 9420 et ses liaisons d'identité. Le résultat n'est
   remis qu'après confirmation du checkpoint par le stockage protégé.
3. Envoyer ce DTO via le transport existant `crypto_publish_key_packages` /
   `cryptoPublishKeyPackages`. Après réponse perdue ou redémarrage, `retry`
   fournit les mêmes octets publics et le même ID. Une préparation répétée
   avec les mêmes paramètres retrouve aussi le lot initial ; d'autres
   paramètres sont refusés tant que la publication reste en attente.
4. `pending_lookup` fournit seulement portée et ID pour consulter la route des
   opérations. Il ne fabrique pas de reçu accepté. Une expiration, révocation
   ou consommation par un Welcome interdit le renvoi, tout en gardant cette
   recherche possible.
5. Remettre le véritable reçu HTTP à `confirm`. Instance, époque des données,
   ID, genre d'opération, appareil, incarnation, révision, racine et liste
   ordonnée des références doivent correspondre exactement. Chaque refus
   annule la transaction ; l'ACK original conservé permet la reprise après
   perte de checkpoint. Un ACK historique ne réautorise aucun nouvel envoi.

Le dernier ACK peut être rejoué sans effacer l'outbox suivante. Une nouvelle
préparation génère son propre ID à l'intérieur du coffre ; l'appelant ne peut
pas réutiliser un ancien ID pour fabriquer d'autres clés. Un renouvellement
de certificat ne remplace pas les octets de la demande déjà préparée. Les
révisions au-delà de la précision entière JavaScript restent des chaînes ; la
borne est celle du serveur PostgreSQL, entier signé 64 bits positif canonique.

## Durée, consommation et bornes

Un lot contient 1–8 packages, de 16 Kio TLS au maximum chacun. Ils utilisent
OpenMLS 0.9.0, suite 0x0001, sans extension last-resort. Leur durée maximale est
24 heures, bornée par l'expiration du certificat local ; la date initiale
tolère cinq minutes de décalage. La durée est aussi vérifiée avec l'horloge
système OpenMLS. Racine, appareil, incarnation et clé de signature doivent
correspondre à l'installation. Une substitution de racine ou révocation locale
observée bloque les publications et les préparations de groupe.

La publication conserve les bundles privés après l'ACK : seul un vrai Welcome
les consomme dans la transaction d'admission MLS. Si ce Welcome arrive avant
la récupération de l'ACK de publication, le renvoi est refusé mais le reçu
original peut encore être réconcilié. La préparation suivante retire de son
index uniquement les bundles réellement absents du fournisseur après cette
consommation ; elle ne recrée jamais leur référence.

L'index est borné à 64 bundles conservés et son document privé à 2 Mio, dans
le coffre global de 16 Mio. Le temps seul ne détruit aucune clé : un Welcome
accepté peut encore attendre un appareil hors ligne. Si les clés inutilisées
occupent cette borne, la préparation est refusée. La réconciliation serveur
permettant de retirer des packages expirés jamais admis, ainsi que le traitement
d'une publication définitivement refusée ou d'une révision remplacée sans ACK,
restent à intégrer au parcours réseau complet. Il n'existe pas d'abandon
automatique fondé sur un délai ou sur une simple absence de réponse HTTP.

Cette rétention n'assure pas la forward secrecy des anciennes copies du
coffre ; les garanties et limites du [stockage](README.md) restent applicables.

## Preuves et suite

Neuf scénarios testent le DTO réel, la réouverture, les références MLS exactes,
les révisions décimales, les champs d'ACK substitués, l'ordre des références,
les interruptions de checkpoint de préparation / ACK, l'expiration,
la révocation, les paramètres / horloges invalides, la limite de rétention et
sa libération après une véritable jointure. Une clé récupérée après interruption
permet effectivement une jointure MLS ; une clé déjà consommée ne peut plus
être republiée. La recherche publique expose seulement l'ID et la portée.

La suite complète du coffre passe : 68 scénarios, plus l'enfant de crash exécuté
et tué par son parent. Clippy strict passe avec le backend système. Les derniers
changements du module de publication passent aussi leur suite ciblée. La CI
Linux / Windows / macOS qualifie ses plateformes de compilation / tests ; elle
ne remplace pas les qualifications des trousseaux installés ou des appareils.

Suite de J4 : coordonner le transport et ses observations d'appareil avec cette
outbox, recevoir les commits suivants, livrer les messages chiffrés durables,
puis raccorder le moteur aux fournisseurs et écrans existants. Les archives,
fichiers, admission hors ligne à travers plusieurs époques, import et revue
indépendante demeurent ouverts. `capabilities.e2ee` reste faux.
