# Chantier du serveur natif RocketVibe

Date de lancement : 30 septembre 2026. Branche : `feature/rocketvibe-server`.
Destination : [RFC 0001](rfcs/0001-serveur-rocketvibe-rust.md).

## État synthétique au 5 octobre 2026

Le renouvellement explicite des certificats d'appareil est raccordé dans le
coffre partagé et les paramètres Android / GTK / SwiftUI existants. L'échéance,
l'expiration, la demande à approuver et la reprise de l'enregistrement original
sont visibles ; identité, incarnation, signature et sélection du coffre sont
conservées. Les trois tests du coordinateur passent en 2,20 secondes, notamment
un second appareil expiré approuvé par le contrôleur existant. Les 17 parcours
HTTP / MLS / SQLite bureau passent en 46,35 secondes ; le nouveau parcours
arrête les anciens workers et récupère une réponse perdue sans second POST.
Les huit tests du pont mobile passent en 56,69 secondes ; le nouvel adaptateur
TypeScript couvre aussi réponse perdue et échéance invalide. L'arrêt de deux
vues partageant le worker est revalidé en 1,92 seconde. Typecheck et Clippy
strict passent. Les bindings Swift réels sont régénérés en 1 min 31 s ; le
pont Kotlin réel est construit / généré en 14,85 secondes. Qualification CI de
ce lot, rotation MLS des salons après renouvellement et parcours installés
restent ouverts. L'E2EE de production reste désactivé.

Conversations de texte, fils et citations privées raccordés aux interfaces
GTK / SwiftUI / Android existantes : lecture du journal conservé dans le coffre,
positions exactes, brouillons séparés, envoi et reprise du ciphertext original.
Les qualifications locales et CI sont distinguées ci-dessous ; les citations
Android et la composition mixte passent les validations locales détaillées
ci-dessous. Les dates sont des observations locales, pas des dates d'auteur
certifiées. Les lecteurs de cartes privées dans les salons / fils ordinaires bureau
sont validés par les neuf jobs de la CI native et le build / démarrage macOS de
10f3005. La sélection intersalons et la composition de références privées dans
les salons ordinaires bureau sont raccordées et passent les neuf jobs natifs
de 41cb92c ainsi que le build / démarrage macOS. Les archives complètes, édition / actions,
recherche et fichiers privés
restent à livrer, ainsi que récupération /
révocation visibles et qualification installée. Aucun masque E2EE de production
n'est activé.

Socle Android ajouté : module Expo Kotlin / Rust dans l'app existante, coffre
privé et petits enregistrements plateforme enveloppés par Android Keystore,
build ARM64 / x86-64 et accès lié au compte / appareil HTTP courant. Ouverture
sans initialisation implicite, fermeture terminale après suspension / changement
de scope et résultat tardif refusé. Les deux tests d'instrumentation du vrai
Keystore / ABI / coffre passent sur l'émulateur API 36.1 ; ils incluent le maintien
du verrou OS pendant une écriture dont l'appelant a été fermé. Les 1282 tests
mobiles et le typecheck passent. Cette preuve concerne le stockage et son cycle
de session ; association, groupes, messages et qualification physique Android
restent ouverts. [Détails du pont](../crates/rv-crypto-mobile/README.md).

Association Android raccordée ensuite dans les réglages existants : la cérémonie
locale est maintenant commune au desktop et au pont natif (`rv-crypto::account`).
Création explicite, comparaison de racine sur un autre appareil, demande publique,
aperçu / consentement distincts, approbation et enregistrement original protégé
avant HTTP. La reprise consulte le reçu et ne répète pas un POST déjà accepté.
La révocation signée de l'appareil est mémorisée malgré une omission ultérieure.
Quatre tests du pont Rust passent, dont une association de deux appareils ; les
trois tests Android passent sur le vrai Keystore / ABI, dont la cérémonie et sa
réouverture avec refus d'un reçu substitué. Les 1285 tests mobiles, typecheck,
lint et les seize parcours crypto du cœur desktop passent. Les deux ABI compilent.
Le parcours GUI installé, groupes / conversations mobiles, iOS et qualification
physique restent ouverts. L'E2EE de production demeure désactivé.

Contrôles de confiance Android ajoutés dans les fiches utilisateur actuelles :
premier contact non vérifié, comparaison explicite, ancienne empreinte retenue
lors d'un changement de racine, remplacement contrôlé et aperçu / approbation
séparés des appareils. La consultation ne crée pas de pin ; seuls les retraits
signés d'une racine déjà connue sont appris implicitement. Les consentements
restent opaques et liés à la vue native / annuaire complet. Les six tests Rust
du pont, quatre instrumentations Android réelles et 1286 tests mobiles passent ;
typecheck / lint et Clippy strict du moteur passent. Les deux ABI compilent.
Groupes / conversations mobiles et qualification GUI installée restent ouverts.

Groupes Android raccordés dans les informations du salon et la fiche du DM :
packages explicites, création, ajouts / retraits / rotation et admission /
réadmission / commit reçu, avec aperçu de destinataires puis confirmation séparée.
Le pont utilise les coordinateurs / conversions MLS existants, sans second client
HTTP. Consentement opaque conservé en Rust ; original durable avant HTTP et
reprise par reçu sans second POST. Un abandon est checkpointé avant sa demande.
Le roster frais, les retraits signés des pairs, le droit d'envoyer et l'adhésion /
projection sont revalidés. Un reçu déjà accepté reste récupérable en lecture seule.
Sept tests Rust passent, dont deux acteurs MLS ; cinq tests Android réels passent,
dont création / rotation / réouverture originale et abandon. Les reçus de ces
tests privés sont synthétiques. Les 1291 tests mobiles, typecheck / lint,
Clippy strict et les deux ABI passent ; l'export Hermes passe aussi.
Conversations mobiles, iOS et parcours GUI complet restent ouverts.

Conversations Android de texte raccordées à la liste et au composeur existants :
projection privée du journal retenu, ordre exact en chaînes décimales, brouillons
par fil / grant / admission et sauvegarde locale à chaque frappe. Le journal
opaque est rattrapé à l'ouverture, à la reprise et toutes les dix secondes quand
la vue est active ; aucun texte, brouillon ou paquet privé ne rejoint la SQL
ordinaire. Reprise par reçu avant POST original, abandon checkpointé avant HTTP
et restauration d'un document abandonné dans un brouillon vide. Un changement
d'admission, retrait ou fermeture du runner ferme la vue ; la projection n'est
pas lissée après fermeture. Les heures affichées sont les observations locales ;
la fenêtre est le cache privé retenu (64 messages), pas une archive complète.
Les 1297 tests mobiles passent, ainsi que typecheck / lint. Huit tests du pont
Rust et cinq instrumentations Android passent ; ces dernières utilisent le vrai
Keystore / ABI et couvrent maintenant brouillons / messages privés, original
réouvert et reçu substitué. Leurs reçus restent synthétiques. Fils visibles,
citations / actions / recherche, archives et fichiers privés restent ouverts,
ainsi que les essais des applications installées et la qualification physique.
Aucun masque E2EE activé. La livraison iOS est hors périmètre de RFC 0001.

Fils privés raccordés ensuite aux écrans Android / GTK / SwiftUI existants :
racine et réponses issues du même préfixe vérifié, brouillon propre au fil et
envoi / reprise du ciphertext original. La racine est bornée à la même portée,
grant et admission ; une réponse ne devient pas racine d’un fil imbriqué.
Racine absente du coffre : réponses disponibles lisibles, nouvel envoi refusé,
sans repli sur SQL ordinaire. Les compteurs indiquent les réponses conservées,
pas l’archive complète. GTK ferme la projection en quittant la vue ; Android
réutilise son cycle focus / suspension et la borne d’adhésion existante.
Les 1299 tests mobiles, typecheck / lint et export Hermes passent. Les huit
tests du pont Rust couvrent aussi une vraie réponse MLS à deux acteurs ; les
155 tests du moteur passent (un enfant de crash ignoré volontairement, un test
long de rétention inchangé non rejoué). Le parcours desktop HTTP / MLS / SQLite
vérifie racine, brouillons séparés, réponse perdue / redémarrage sans second POST,
compteurs et retrait. Clippy strict moteur / pont / cœur / FFI passe. Les deux
ABI Android compilent et les cinq tests du vrai Keystore / ABI passent, avec
réponse de fil réouverte et compteur privé ; reçus synthétiques.
Compilation des interfaces GTK / SwiftUI confirmée par les CI de `8356206` ; GUI
installé, archive, citations / actions / recherche et fichiers restent ouverts.
Aucun masque E2EE de production activé.

Les citations privées sont ensuite raccordées aux menus / bandeaux / composeurs
GTK et SwiftUI existants : source racine ou réponse de fil, citation seule,
sélection liée à l'instance / génération, adhésion et admission, puis document
MLS contenant uniquement les références. Résolution par salon dans le coffre
retenu, relecture des admissions avant exposition, deux niveaux, cycles bornés
par salon / message et 1 024 caractères Unicode par extrait. Un parent inaccessible
ne révèle aucun enfant. La fenêtre privée entière est reconstruite pour purger
les anciennes cartes après retrait d'une source. Le banc HTTP / MLS / SQLite
vérifie citation seule, sélection stale refusée, réponse perdue / réouverture et
reçu GET sans second POST. Les 16 parcours crypto desktop passent ; les 155 tests
du moteur passent (un enfant de crash ignoré, le test long de rétention inchangé
non rejoué). Le test des cartes couvre Unicode, profondeur, cycles et source
retirée ; Clippy strict cœur / FFI passe, ainsi que la construction de la DLL
et la génération locale des bindings Swift. Compilation GTK / SwiftUI à confirmer
par la CI de ce nouveau lot. Citations Android, sources mêlant clair / chiffré,
révisions d'édition privée, fichiers cités, archives complètes et parcours GUI
installé restent ouverts. Aucun masque E2EE de production activé.

Citations Android raccordées dans les mêmes menus, bandeaux et composeurs :
source privée racine ou réponse, citation seule, sélection liée au scope /
adhésion / admission et document MLS portant uniquement les références.
Résolution des cartes dans le coffre par salon, deux niveaux et cycles bornés ;
les sources retirées ne révèlent ni extrait ni descendants. La feuille d'actions
évite SQL ordinaire et navigation avec corps privé. L'aperçu est reconstruit
après retour au composeur, effacé au blur / suspension, et les résultats tardifs
ne restaurent pas une sélection remplacée ou annulée. La file SQL refuse toute
sélection privée. Les 1 302 tests mobiles passent, plus les trois nouveaux
scénarios de cycle de vie du bandeau ; typecheck, lint et Hermes passent.
Les huit tests Rust du pont incluent une citation seule MLS entre deux acteurs,
source de fil, sélection stale refusée et paquet original réouvert. Clippy strict
pont / cœur passe. Les deux ABI Android compilent et les cinq instrumentations
du vrai Keystore / ABI passent, incluant citation seule et réouverture ; leurs
reçus sont synthétiques. Les 16 parcours desktop HTTP / MLS / SQLite passent
après correction du serveur de test : maintien périodique de sa socket pour
éviter une fermeture artificielle à 45 secondes sur un runner lent.
La CI Linux du lot desktop `9884ce2` passe ; la CI Windows a révélé cette
simulation muette. Le build / packaging / démarrage macOS passe sur ce même
commit ; l'envoi des artefacts a échoué sur un timeout GitHub et est relancé.
La CI du lot courant reste à confirmer. Sources mixtes, autres actions /
recherche, archives / fichiers privés, revue indépendante et qualification GUI
installée restent ouverts. Aucun masque E2EE de production activé.

Lecture mixte ajoutée aux cartes privées GTK / SwiftUI / Android : sources
retenues du coffre et extraits en clair déjà conservés, avec generation /
adhésion / statut non chiffré vérifiés, descendants reconstruits sans copie
de clair privé dans SQLite et relecture avant exposition. Édition actualise
l’extrait ; retrait, ancienne adhésion et passage du salon source en mode
chiffré le masquent. Le SDK bureau / UniFFI sélectionne aussi une source
ordinaire pour un envoi MLS contenant seulement ses références ; retirer
l’admission d’une sélection privée ne contourne pas sa validation. Le banc
HTTP / MLS / SQLite vérifie une citation seule à sources mixtes, réponse
perdue / réouverture sans second POST, édition et retrait avec nouvelle vue.
Les 16 parcours desktop et 15 tests du cache des citations passent ; 1 307
tests mobiles, typecheck / lint et Hermes passent. Clippy strict cœur / FFI,
construction de la DLL et génération des vrais bindings Swift passent aussi.
La compilation des interfaces et la qualification CI du lot restent à confirmer.
Les sélecteurs intersalons,
la composition Android et les cartes privées dans les salons ordinaires
restent ouverts, ainsi que fichiers, archive, édition privée et qualification
GUI installée. Aucun masque E2EE de production activé.

Composition mixte Android et choix de destination raccordés à la feuille
d’actions et au composeur existants : recherche locale parmi les conversations
rejointes autorisées, références claires vers une destination chiffrée et
références privées vers une autre destination chiffrée. Une sélection de fil
reste adressée au bon composeur. L’ouverture n’envoie rien ; scope, adhésion,
admission et révision des sources sont relus avant préparation MLS. Les témoins
clairs du cache authentifié contiennent seulement adhésion et références ;
aucun extrait n’entre dans la commande native ou dans le document envoyé.
Rust refuse de traiter un groupe déjà enregistré, y compris retiré / en attente,
comme une source claire. Aperçus des deux catégories revérifiés après focus,
effacés au blur et refusés après remplacement de sélection ou de compte.
Les 1 311 tests mobiles passent en 50 secondes, ainsi que typecheck / lint et
Hermes. Les huit tests du pont Rust passent : deux acteurs MLS, envoi mixte,
témoins absents / périmés, rétrogradation refusée et original réouvert. Les deux
ABI Android compilent ; les cinq instrumentations du vrai Keystore / ABI passent
(6,102 secondes de tests, 26 secondes pour Gradle), avec références mixtes et
paquet original retrouvé après réouverture. Leurs reçus restent synthétiques.
Clippy strict du pont / cœur / FFI passe. CI du nouveau lot et parcours GUI installé restent
à qualifier. Sélecteurs bureau, cartes privées dans les salons ordinaires,
archives / fichiers / autres actions / recherche restent ouverts. Aucun masque
E2EE de production activé.

Cartes privées et envoi de leurs références dans les salons ordinaires Android
raccordés aux listes / fils / bandeaux / composeurs actuels. Le lecteur natif
reste distinct du composeur protégé : ni brouillon ni préparation MLS ; garde de
destination, source, scope, adhésion, admission et position, puis relecture avant
exposition. La projection est appliquée après lissage sans modifier les lignes
SQL ni le tampon ordinaire. Blur / suspension / changement de compte / retrait
effacent les cartes et le bandeau privé. La sélection intersalons Android accepte
aussi les destinations ordinaires autorisées. Avant enqueue, lecture native puis
autorisation synchrone volatile / garde SQL ; seule la référence rejoint la file
ordinaire et son original reste récupérable après réponse perdue.
Le serveur réutilise le lecteur du journal MLS et le témoin historique exact de
l’appareil pour valider ces nouvelles références, sans livrer d’extrait privé.
Le nouveau scénario HTTP / PostgreSQL couvre absence de clair, révision périmée,
adhésion de domaine sans admission MLS et reçu conservé après expiration ; il
est compilé par Clippy strict, puis passe réellement en HTTP / PostgreSQL dans
le job `verify` de la CI `37244716038` du commit `b884e1d`.
Les 1 321 tests mobiles passent en 50,2 secondes ; typecheck, lint et export
Hermes (8,3 Mo) passent. Les scénarios du vrai runner avec SQLite couvrent
lecteur natif, refus tardifs, retrait, réponse perdue et reprise du même message
accepté ; leurs appels crypto / HTTP restent simulés. Aucun pont / ABI natif
n’est modifié. La qualification GUI installée, les cartes ordinaires et sélecteurs
bureau, archive / fichiers / actions / recherche privés restent ouverts. Aucun
masque E2EE de production activé.

Les cartes mixtes du cœur bureau conservent maintenant aussi les fichiers de
leurs sources ordinaires, au côté de descendants privés et avec les lecteurs
de fichiers protégés existants. Le retrait masque uniquement la source concernée ;
une source MLS ne peut obtenir de métadonnées de fichier ordinaires. Les deux
tests ciblés de cartes passent sur Windows : fichiers / descendant retiré,
parent retiré, Unicode, profondeur et cycles. Clippy strict cœur / FFI passe
en 22,1 secondes ; qualification CI de cette correction encore ouverte.
La CI verte de `a576db3` révèle un échec de sauvegarde du cache desktop : verrous
incrémentaux créés par Docker en propriétaire `root`, illisibles par `tar` du
runner. Le nettoyage rend maintenant les caches générés au runner, comme le
fait déjà le job Swift. La CI `37244716038` de `b884e1d` sauvegarde effectivement
le cache desktop avec sa clé `native-desktop-fedora-…-b884e1d1041102efea50b4378f23576af43eb8f7`,
sans erreur de permission. Aucun contrôle fonctionnel n’est retiré.

Lecteurs ordinaires bureau raccordés aux listes GTK / SwiftUI existantes, y
compris les fils : un acteur distinct s'attache au coffre enregistré et ne
dispose d'aucune API de brouillon ou d'envoi. Il reconstruit les cartes à partir
des références du cache sans y écrire de texte privé ; un premier passage
rattrape une page bornée par source privée, puis relit adhésions et admissions.
Les corps, fichiers ordinaires, regroupements et marqueurs de non-lus restent
ceux de la présentation existante. Blur / vue masquée / navigation / changement
de compte ferment le lecteur et réaffichent le cache brut. Une génération de
vue, l'adhésion courante et l'égalité de la fenêtre SQL écartent les réponses
tardives. Un changement dans un autre salon invalide aussi les cartes Swift ;
le lecteur actif est rafraîchi toutes les dix secondes.
Les 16 parcours HTTP / MLS / SQLite du cœur passent en 42,25 secondes, dont le
nouveau cas de lecture ordinaire avec cache inchangé, fermeture et retrait du
salon. Le test utilise de vrais documents MLS et un serveur HTTP simulé ; il
ne qualifie pas le rendu GUI. Clippy strict cœur / UniFFI passe en 13,93 secondes,
la DLL est construite et les vrais bindings Swift sont régénérés. Compilation
GTK / SwiftUI et régressions connectées confirmées par les neuf jobs de la CI
native 37247156429 et le build / packaging / démarrage macOS 37247156379 de
10f3005 ; parcours privé GUI installé toujours ouvert. Aucun
masque E2EE de production activé.

Sélection intersalons bureau ajoutée dans les menus existants GTK / SwiftUI :
recherche locale parmi les conversations rejointes où la rédaction est permise,
sans admission ni envoi implicite. La navigation transporte uniquement référence,
instance / génération, adhésion et admission privée éventuelle. Le composeur
destinataire relit la source exacte, en clair ou via le coffre, avant aperçu.
Un acteur QuoteComposer distinct du lecteur ordinaire valide les références
privées pour une destination ordinaire ; la file SQL garde uniquement références
et texte personnel du parent. Ni extrait ni admission ne deviennent autorité
persistée. L'appel ordinaire sans cet acteur refuse encore la source chiffrée.
Texte conservé pendant le préflight ; l'intention et la consommation du seul
brouillon correspondant sont atomiques, tandis qu'un texte plus récent survit.
Navigation, blur, annulation et sélection remplacée ferment / masquent les
aperçus ; une réponse tardive ne réarme pas le bandeau.
Les 56 régressions de stockage passent en 1,13 seconde, les 16 parcours
HTTP / MLS / SQLite en 46,09 secondes, et Clippy strict cœur / UniFFI en
17,64 secondes. La DLL et les vrais bindings Swift sont construits.
Les nouveaux contrôles GTK sous Xvfb et les modèles Swift contre PostgreSQL
exercent le choix de destination et l'envoi intersalons ; exécution CI encore
ouverte, ainsi que les parcours privés GUI installés. Aucun masque activé.

La CI 37250486296 de 7bf7fae a atteint la borne de 90 secondes du banc HTTP
privé contre PostgreSQL. Le même parcours avait passé en 79,36 secondes sur
10f3005. Son exécutable est compilé comme exemple en profil dev : l'optimisation
de l'arithmétique curve25519 déjà utilisée en profil test est aussi appliquée à
ce profil, sans retirer d'assertion ni augmenter la borne. Des repères d'étape
sans contenu privé sont désormais visibles sur stderr, y compris en timeout.
Le check local de l'exemple passe en 5,21 secondes ; sa durée d'exécution et
l'issue des nouveaux parcours GTK / Swift restent à confirmer par CI.
Le build / packaging / démarrage macOS 37250486298 de 7bf7fae passe.
La CI GTK a identifié un champ de salon absent du DTO de présentation :
l'aperçu retrouve son message par ID et revalide la sélection SQL qui porte
le salon exact. Le nouveau test Swift attend maintenant la resynchronisation
déclenchée par sa première création de salon avant la deuxième commande ; les
neuf parcours connectés Swift déjà présents passent sur ce commit.
La CI précédente est désormais terminée : six jobs verts et les trois échecs
ci-dessus. Le sélecteur ne réutilise plus le refus d'envoi en clair pour une
destination chiffrée : les droits inconnus d'un salon rejoint n'excluent pas
celui-ci, tandis qu'un refus effectif connu le masque. Le choix relit les droits
effectifs du serveur avant navigation / préparation, puis revalide le compte
et la source. Le record de gestion Swift expose ce droit indépendamment du mode
chiffré ; le banc existant couvre propriétaire et membre d'un salon en lecture
seule. Qualification de ces corrections encore ouverte.
Clippy strict cœur / UniFFI passe sur les corrections en 2,80 secondes ; la
DLL et les bindings Swift régénérés passent en 53,70 secondes. Formatage,
changelog et inventaire contrôlés ; GTK / modèles Swift et fixture PostgreSQL
seront requalifiés dans la CI du prochain commit.

Les corrections 41cb92c passent le banc HTTP complet en 26,42 secondes, avec
la borne inchangée de 90 secondes. Les neuf jobs natifs sont verts ;
le parcours GTK citations intersalons a passé, ainsi que les régressions
sécurité / e-mail. Le build,
packaging et démarrage macOS 37252377479 passe ; les deux ABI et le vrai
Keystore Android sur émulateur passent dans 37252377488. La CI native
37252377514 est terminée avec succès.

| Jalon | Développement livré | Travail restant pour le fermer |
|---|---|---|
| J0 | Contrats, fixtures communes, inventaire et backlog de parité | Conditions opérateur / export et décisions crypto liées aux jalons suivants |
| J1 | Serveur Rust, compte / salons / DM, journal, cache / reprise et fournisseurs dans les interfaces actuelles | Parcours Android ↔ Windows sur appareils avec coupures et processus tués |
| J2 | Principaux parcours de messagerie, droits, actions, fils, lectures, présence, recherche, profils | Qualification des applications installées et écarts explicités dans les lots ci-dessous |
| J3 | Fichiers, vocaux, cartes, emojis, transports de notifications et réponses / liens | Push Android physique, codecs et qualification des parcours natifs installés |
| J4 | Appels raccordés, identités / coffre crypto, packages / transitions MLS, journal opaque, pages protégées, signatures historiques, règlement des intentions interrompues, réadmission, accès crypto lié à la session, identité / association / renouvellement de certificat, pairs / groupes et conversations GTK / SwiftUI, coffre / association / confiance / groupes et conversations de texte Android, fils et citations privés dans les trois interfaces, lecture mixte, composition / destination intersalons et lecteurs de cartes privées dans les salons ordinaires des trois interfaces | Qualification CI du renouvellement, rotation MLS des salons, récupération / révocation visibles, autres actions / recherche privées, parcours GUI E2EE complet, historique après révocation, archives / fichiers, revue crypto et essais Jitsi réels |
| J5 | Préparation des contrats et de l'administration opérateur | Import reprenable, sauvegarde / restauration, exploitation et pilote de bascule |

La dernière livraison serveur qui passe tous les jobs de sa CI (`41cb92c`) passe les neuf jobs de la CI
`37252377514` : contrôles généraux, suites crypto Linux / Windows / macOS,
banc HTTP / PostgreSQL et fournisseurs bureau GTK / Windows / SwiftUI.
Le job Android `37238019723` passe aussi les deux ABI, le vrai Keystore, la
cérémonie d'association, les contrôles de confiance, groupes, fils et citations sur émulateur.
L'application macOS du lot citations privées `9884ce2` passe sa compilation, son packaging et son
démarrage (`37235042086`, tentative 2 après timeout d’upload GitHub).
Le lot lecture mixte `574f137` passe aussi l’application macOS (`37240191547`).
Le lot composition Android `a576db3` passe le Keystore / ABI (`37242529415`) et
tous les jobs serveur (`37242529465`). Groupes, projection et composeur dans les interfaces
existantes compilent et passent ces régressions. Le parcours GUI E2EE complet
avec plusieurs applications installées reste un critère de sortie distinct.
L'inventaire généré qui avait arrêté la CI du raccordement `60e72f4` est corrigé.
Le journal serveur passe ses neuf scénarios
PostgreSQL / HTTP / MLS et les contrats communs ; aucune capacité E2EE n'est
activée. Le worker privé checkpoint maintenant les pages communes aux messages
et transitions, avec curseur durable et rattrapage de plusieurs époques sur la
même admission. Authentification des signatures expirées sur cette admission
ajoutée ; abandon durable des envois personnels ajouté ensuite avec intention
privée checkpoint avant HTTP et document récupérable. Règlement des transitions
ajouté ensuite : original conservé après succession d'un pair, décision
terminale durable et libération du seul commit non accepté. Réadmission du
même coffre avec nouveau Welcome / package, remplacement atomique et cache
précédent marqué hors projection ajoutés. Le cœur du fournisseur bureau lie
maintenant le worker à sa session et à son client HTTP, avec garde terminale
des résultats tardifs. La cérémonie d'identité / association et les trousseaux
des réglages bureau sont raccordés. Projection privée, brouillons et composeur
GTK / SwiftUI sont intégrés ; retrait / changement de projection ferment la vue
de conversation et masquent son contenu transitoire. Le coffre Android est
raccordé au cycle de session. Le parcours mobile complet et l'historique autorisé
restent ouverts.
Le lot suivant raccorde les pins / appareils aux profils GTK et SwiftUI existants,
avec premier contact non vérifié, comparaison explicite de racine, remplacement
contrôlé d'une racine changée et aperçu opaque de certificat avant approbation.
La consultation n'initialise aucun coffre et n'admet aucun membre MLS. Les
révocations signées paginées restent bloquantes après omission et réouverture ;
l'attachement d'une conversation utilise uniquement l'installation enregistrée.
Les onze parcours crypto du cœur passent sur Windows. La compilation des deux
interfaces et leurs suites passent aussi dans les CI de `ee3f717`. Les caches / temporaires
Rust locaux utilisent D: après l'échec de Cargo sur le disque C: plein ; Docker
local a aussi cessé de démarrer, sans preuve suffisante sur sa cause exacte.

Préparation du lot groupes : lecture protégée de l'état local absent / transition
en attente / reçu accepté, sans création de groupe ni POST implicite. Le vrai
parcours MLS / HTTP avec réponse perdue couvre ces observations et leur reprise ;
les dix-sept tests de livraison passent sur Windows. L'apprentissage d'une
révocation locale dans un autre viewer arrête aussi la conversation déjà ouverte
pour la même incarnation. Les onze parcours du cœur et Clippy cœur / FFI passent.
Les contrôles de groupe dans les informations du salon GTK / SwiftUI sont
maintenant raccordés au même contrôleur Rust : consultation sans mutation,
packages d'invitation explicites, création / admission / mise à jour avec aperçu
des destinataires, confirmation séparée et reprise / abandon des intentions
interrompues. Les appareils déjà admis ne sont pas proposés comme nouveaux
destinataires. Les quatorze parcours du cœur passent sur Windows, dont trois
nouveaux parcours réels MLS / HTTP / SQLite ; la CI reste requise pour qualifier
la compilation des interfaces et le rendu GTK. Aucun composer déverrouillé et
aucune capacité E2EE activée par ce lot.

Les critères externes encore ouverts restent des critères de sortie de la RFC.

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
Quotas : 1 000 salons, 50 racines et 50 réponses récentes par salon depuis P11, 1 Mio par page / 64 Mio au
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

- P19 / J4, état des salons dans les fournisseurs existants (4 octobre 2026) :
  le contrat commun expose `encrypted`, optionnel et faux sur les anciens serveurs.
  Le serveur dérive cet état de l'existence du groupe MLS. Acceptation d'un groupe
  ou d'un message privé publie seulement une mise à jour du salon dans le journal
  ordinaire, au même emplacement global que sa livraison privée et dans la même
  transaction ; un retry exact ne publie pas une seconde activité. Aucun texte,
  ciphertext, clé ou état de groupe ne passe par ce journal. Liste / snapshot /
  détails et changements transmettent l'état aux caches GTK, SwiftUI et mobile.
  Le salon déjà ouvert devient verrouillé dans les vues existantes. Le bouton de
  déverrouillage Rocket.Chat reste réservé à son fournisseur. Nouvel envoi en clair
  refusé avant intention ordinaire ; ancien envoi hors ligne marqué `crypto_required`
  avant HTTP, avec corps conservé. Ce raccordement prépare la projection privée,
  sans la livrer ni activer E2EE. Les badges privés et le rattrapage du journal
  protégé dans les interfaces restent ouverts.
  Vérifications locales : 408 tests bureau réussis (quatre cas ignorés par
  défaut), Clippy strict Fedora ; 288 tests mobiles et TypeScript réussis.
  Contrats Rust et schéma / TypeScript générés vérifiés. Le cas HTTP / PostgreSQL
  étend le banc MLS avec snapshot, liste, détails et deux activités ordinaires
  sans texte privé ni doublon. Clippy serveur passe ; sa compilation de tests
  est interrompue par le moteur Docker, y compris seule avec deux tâches et
  mémoire limitée. Qualification serveur / Swift confiée à la CI de la branche,
  sans considérer cette interruption comme une validation réussie.

- P19 / J4, cérémonie dans les réglages existants (4 octobre 2026) : GTK et
  SwiftUI partagent le parcours Rust de création explicite de racine, demande
  signée d'appareil, confirmation des empreintes et transfert manuel de codes
  publics. Consentement opaque lié au viewer, sans secret de signature ou de
  coffre dans UniFFI. Trousseaux et répertoire privé partagés ; sélection durable
  indexée par URL, instance, époque, compte et appareil HTTP. L'incarnation est
  enregistrée avant initialisation. Grant et corps exact d'enregistrement sont
  checkpointés ensemble ; la reprise consulte d'abord le reçu personnel et
  contrôle tous ses champs. Tests avec vrais grants sur HTTP local : création /
  approbation explicites, réponse perdue récupérée après réouverture, nouvel
  appareil avec racine comparée, refus sans détenteur de racine, fermeture et
  capacité retirée avant écriture. Sélection, verrou de famille, genèse
  interrompue, origine distincte, stockage inaccessible, copie et retrait testés ;
  les huit régressions de checkpoint / verrou passent. Le pont et le modèle
  Swift compilent ; huit tests sans serveur passent (seize cas d'intégration
  ignorés faute de pilote dans ce contrôle local). L'inventaire généré est
  régénéré et vérifié. La section reste conditionnée aux capacités expérimentales
  E2EE : aucune capacité du serveur ou des clients activée. Renouvellement,
  révocation / récupération visibles, pins / groupes, projection de messagerie,
  Android, archives / fichiers, historique après retrait et revue restent ouverts.
  Fedora : suite bureau de 406 tests réussis (quatre cas ignorés par défaut),
  puis huit tests crypto ciblés repassés après les derniers ajustements, Clippy
  strict et build GTK / FFI réussis. Le nouveau cas GTK est exécuté sous Xvfb
  avec assertions sur le dialogue monté, actions disponibles et effacement à
  fermeture ; rendu inspecté. Les trois autres cas ignorés concernent les cartes
  de réunion, les aperçus de liens et le bus de notifications et restent couverts
  par leurs pilotes CI habituels. Une interruption de connexion Docker pendant
  compilation a nécessité une reprise limitée à quatre tâches de compilation.

- P19 / J4, accès crypto du fournisseur bureau (4 octobre 2026) : `rv-core`
  consomme maintenant le coffre privé avec HTTP natif ; mêmes SQLite et client
  HTTP que le fournisseur existant, sans autre compte ni token. Attachement
  explicite après contrôle de l'instance / génération / utilisateur / unique
  appareil courant ; un seul accès par génération et clones partageant le
  dispatch. Garde terminale dans le worker après HTTP et à l'entrée du travail
  privé, mise à jour des capacités depuis la découverte validée et arrêt lors
  de suspension / reconnexion / fin de cycle / shutdown. Références faibles :
  l'accès ne maintient pas le runner fermé en vie. Cinq scénarios bureau réussis
  en 1,97 s avec vrai runner, HTTP, SQLite et package MLS : fermeture avant
  coffre, portée remplacée, ambiguïté d'appareil, reprise byte-identique après
  fermeture pendant POST, annulation du demandeur pendant checkpoint avec
  verrou OS conservé et absence de POST tardif. Suite bureau complète :
  403 succès, zéro échec, trois scénarios d'affichage / bus ignorés dans cette
  exécution ordinaire ; Clippy strict et build GTK / FFI sur tout le workspace.
  Les 17 workers privés HTTP
  repassent en 4,27 s ; Clippy strict avec et sans HTTP. Aucun changement d'écran,
  du fournisseur Rocket.Chat ou du masque E2EE. Cérémonies / adaptateurs de
  trousseau / projection des interfaces, suspension des salons retirés, mobile,
  archives et qualification restent ouverts.
  [Frontière de session bureau](../apps/desktop/docs/NATIVE_CRYPTO.md).

- P19 / J4, réadmission dans le même coffre (4 octobre 2026) : nouveau package /
  Welcome, preview dans un provider temporaire et consentement liant paquet,
  ancien état, pins et certificat courants. Aucune mutation persistante pendant
  la preview. Acceptation atomique : ancien MLS retiré, nouveau package consommé,
  références acceptées conservées, curseur précédent retiré et cache précédent
  marqué hors projection courante. Opérations incertaines réglées avant la
  réadmission ; documents personnels abandonnés encore récupérables.
  `EventKind::Readmission` annonce le remplacement au fournisseur avant sa
  confirmation ; aucune interface ni capacité activée. Six scénarios privés
  réussissent en 5,15 s, dont Welcome corrompu avec signature valide, pins / droits
  périmés, ancien cache, réouverture et checkpoint externe perdu. Régressions
  ciblées : 14 cas de messages hors test lourd de capacité, 12 journaux et
  17 workers HTTP ; Clippy strict avec HTTP. Banc réel HTTP / PostgreSQL réussi
  en 59,00 s : départ / retour, droit d'accès frais, remove / add MLS et Welcome
  dans le même coffre / appareil ; aucun contenu de l'ancienne admission dans
  le nouveau journal. Huit messages, cinq transitions / époques, deux Welcomes
  et deux packages consommés ; treize frames acceptées, zéro message clair.
  La CI du précédent `2959999` passe les suites crypto des trois OS et le banc
  HTTP, mais `verify` refuse trois éléments internes inutilisés sans HTTP.
  Correction : demande d'abandon publique dans l'API du coordinateur protégé,
  conforme à celle des messages ; Clippy strict sans HTTP et suite complète
  par défaut réussis : 135 succès, zéro échec, un enfant de crash ignoré et
  exécuté par son parent, en 160,47 s. Les huit autres jobs du précédent commit
  ont terminé avec succès ; sa CI complète reste rouge à cause de `verify`.
  Suspension / projection dans les apps, archives / fichiers, appareils /
  trousseaux physiques et revue indépendante restent ouverts.
  [Politique du remplacement](../crates/rv-crypto/READMISSION.md).

- P19 / J4, règlement des transitions de groupe (4 octobre 2026) : reçu personnel
  disponible après retrait / expiration, route d'abandon avec intention opaque
  originale, migration 0042 et SDK Rust / TypeScript typés. Acceptation et abandon
  partagent le verrou de l'auteur : un reçu accepté gagne, sinon le marqueur
  durable refuse le POST tardif sans révision / époque / position, ni consommation
  de package. Quota de 256 nouveaux abandons par jour / compte ; rejeu terminal
  exact conservé. Scope d'époque restaurée, autre auteur et substitution refusés.
  Le coffre garde original et intention d'abandon avant HTTP, avec registre lié
  au compte / appareil / incarnation / racine. Genèse abandonnée : groupe non
  accepté supprimé ; rotation abandonnée : seul commit préparé libéré. Le journal
  conserve sa position et l'époque acceptée. Un successeur de pair conserve
  l'ancien original incertain ; nouvelle préparation bloquée jusqu'au règlement.
  Le reçu HTTP accepté reste mémorisé sans avancer une rotation avant sa position.
  Tests locaux : six nouveaux cas protégés, 17 scénarios HTTP privés après correction
  du routage de la fixture, 12 scénarios de journal et cinq cas de règlement serveur
  dont quota (3,48 s), après 31 scénarios de groupe réussis ; contrats, huit tests
  transport TS, typage, ESLint et Clippy strict. Le premier passage privé complet
  compte 141 succès / trois échecs de fixture ; ces trois cas passent au rejeu
  ciblé après correction, la suite complète suivante est confiée à la CI.
  Banc réel worker / HTTP / PostgreSQL : succès en 42,70 s, neuf frames acceptées
  sur trois époques, rotation abandonnée après réponse perdue, reprise sans POST
  de transition supplémentaire, tentative tardive refusée et un seul package
  admis consommé. Stockage externe du banc simulé, aucune preuve de trousseau
  physique ajoutée. Réadmission, projection des apps, archives / fichiers,
  revue et qualifications restent ouverts ; capacité E2EE désactivée.
  [Politique et frontières](../crates/rv-crypto/GROUP_SETTLEMENT.md).

- P19 / J4, règlement définitif des envois personnels (4 octobre 2026) : route
  d'abandon reprenant les octets originaux, verrou de compte commun aux envois
  et trace personnelle durable. Un message accepté gagne et conserve son reçu ;
  sinon les POSTs tardifs et la réutilisation de l'opération sont refusés,
  y compris dans les espaces ordinaires / uploads. Aucune position de journal,
  projection claire ou copie du ciphertext n'est créée par l'abandon.
  Le worker checkpoint l'intention avant HTTP et reprend cette décision après
  coupure avant arrivée serveur, réponse perdue, réouverture ou certificat
  expiré. Un statut d'abandon depuis une autre session provoque récupération
  du reçu exact contre la preuve protégée. Marqueur terminal et document privé
  récupérable, libération explicite du corps, ancienne génération consommée
  et nouvelle opération obligatoire. Les messages abandonnés ne bloquent plus
  une rotation ; les transitions préparées restent un règlement distinct.
  Vérifications locales : quatre nouveaux cas PostgreSQL, dont courses entre
  vrais paquets MLS / abandon, retrait / expiry / nouvelle session, namespaces,
  quota persistant et substitutions. Les treize cas de livraison serveur passent
  en 5,82 s ; le workspace natif complet passe ensuite ses 313 tests, avec le
  banc privé ignoré exercé explicitement. Formatage et Clippy strict passent.
  Trois nouveaux cas privés de checkpoint / corps / générations et trois HTTP
  d'abandon sont ajoutés : 14 cas HTTP passent en 3,34 s, dix journaux en 7,06 s.
  La suite de messagerie avant le dernier ajout d'intention persistante passe
  ses 14 cas en 154,29 s ; les cas modifiés sont ensuite revérifiés directement.
  Sept tests du transport mobile, typecheck, lint et génération du contrat
  passent. Banc privé réel HTTP / PostgreSQL : confirmation d'abandon perdue,
  réouverture et récupération exacte, POST tardif refusé, six messages acceptés
  / neuf trames sur trois époques, sept tentatives POST dont une abandonnée,
  un seul marqueur personnel et aucun document clair dans SQL, en 33,09 s.
  Suite crypto complète multi-OS suivie par la CI du lot ; interfaces inchangées,
  aucune capacité activée. Réadmission, projection / ponts des apps, rotations
  après grands sauts de génération, archives / fichiers, revue et qualification
  sur appareils restent ouverts. [Règlement privé](../crates/rv-crypto/SETTLEMENT.md).

- P19 / J4, authentification historique (4 octobre 2026) : vérification
  cryptographique de certificat / transition / paquet séparée de sa validité
  courante. Les publications / admissions / envois actuels gardent `verify(now)`
  côté client et serveur. Le journal lit les époques expirées uniquement avec
  lecteur courant, même admission et clés / racine / incarnation inchangées ;
  pairs approuvés, révocations connues et certificat non futur sont requis.
  Les records privés conservent le rôle historique et la vraie date de réception,
  pour réouverture sans prétendre à une validité courante ou une date d'envoi.
  Quatre cas MLS / SQLite ajoutés passent : trois époques expirées après
  renouvellement du lecteur, réouverture / rejeu, nouvel envoi toujours refusé,
  révocation / signature / futur refusés et rotation propre ancienne préparée
  consommée après le message qui la précède. Les dix cas du journal passent
  en 6,40 s au premier contrôle.
  Vérification complète : formatage / Clippy strict des deux workspaces,
  31 tests serveur E2EE en 9,89 s, banc réel HTTP / PostgreSQL en 35,27 s et
  129 tests privés en 159,96 s, sans filtre et enfant de crash exécuté.
  Les expirations sont prouvées dans le coffre avec horloge de fixture ;
  aucune heure de temps écoulé réel n'est simulée dans le banc HTTP.
  Cérémonie de renouvellement des apps,
  réadmissions / historique après révocation, projection, archives et revue
  crypto restent ouverts. [Politique et preuves](../crates/rv-crypto/JOURNAL.md).

- P19 / J4, pages du journal privé (4 octobre 2026) : fenêtre fixe et curseur
  lié à l'admission ; messages, transitions, ratchets et contenu privé partagent
  une transaction protégée par page. Les positions natives sont exactes ; les
  parents / époques restent chaînés par MLS. Le roster historique provient du
  vrai plan, l'accès propre doit correspondre à l'observation courante. Une
  signature tardive refuse aussi les mutations antérieures de cette page.
  L'ACK exact de rotation propre conserve l'ancienne époque jusqu'aux messages
  qui précèdent son commit. Les consommateurs séparés ne contournent pas le
  journal commencé. Le dernier lot est rejouable depuis le coffre rouvert,
  même après refus d'écriture du checkpoint externe sans résultat publié.
  Six nouveaux scénarios MLS / SQLite passent en 3,86 s : trois époques
  manquées, reprise entre pages, substitutions / gaps / ordre, rollback tardif,
  rotation propre avec message non lu, retrait d'un autre membre et nouvel
  accès refusé, échec de checkpoint. Le banc réel HTTP / PostgreSQL utilise
  les pages et leur rejeu dans les deux coffres : six messages / trois époques,
  ACKs perdus après commit, six POSTs / lignes opaques, neuf trames et aucun
  document clair dans SQL, en 30,15 s.
  Formatage / Clippy strict passent ; 124 tests privés complets en 157,95 s,
  enfant de crash exercé par son parent, aucun filtre. Un scénario HTTP ajouté
  ensuite vérifie lecture interrompue / réouverture, rejeu et refus de route
  substituée sans avancement : onze cas HTTP en 2,84 s, six cas du journal en
  4,03 s et banc PostgreSQL revérifié en 30,93 s. Certificats historiques expirés / révoqués,
  réadmission, projection durable des apps, archive au-delà du cache borné,
  fichiers, ponts et qualifications restent ouverts ; capacité désactivée.
  [Journal protégé](../crates/rv-crypto/JOURNAL.md).

- P19 / J4, worker HTTP des messages protégés (4 octobre 2026) : préparation
  / ratchet / document dans le checkpoint avant réseau, reçu recherché à partir
  des métadonnées historiques avant renvoi. Un 404 permet seulement le retry
  original après nouvelle observation / contrôle des grants, tête, pins et
  expiration ; un ACK exact reste confirmable après retrait / expiry / cooldown.
  Réception contre la tête courante dans une tâche possédée, clair remis après
  checkpoint et vérification d'arrêt. Conversions bornées / canoniques du
  paquet, reçu et Header opaque, digest et métadonnées liées exactement ;
  leur décodage ne remplace pas l'authentification MLS / certificat du coffre.
  Cinq nouveaux scénarios HTTP et deux de conversion passent ; les dix cas du
  worker passent ensemble en 2,85 s et la suite privée complète compte 118
  succès en 162,91 s, avec le crash enfant exercé par son parent et aucun filtre.
  Le banc combiné réel PostgreSQL / HTTP passe en 29,76 s : six messages sur
  trois époques, chaque réponse perdue après commit, Managers / SDK neufs pour
  confirmation, documents riches et replies déchiffrés par les deux coffres.
  SQL conserve six ciphertexts, neuf trames, six POSTs exacts et aucun document
  clair. La fixture consomme chaque époque avant rotation ; elle ne ferme pas
  le rattrapage historique, le préfixe ordonné durable, les refus définitifs /
  réadmissions, la projection, les fichiers / archives, les ponts, la revue et
  les qualifications sur appareils. Formatage / Clippy strict passent ; aucune
  capacité E2EE activée. [Frontière HTTP](../crates/rv-crypto/GROUP_HTTP.md).

- P19 / J4, livraison opaque des messages (4 octobre 2026) : POST de vrai
  ciphertext MLS et preuve certifiée, reçu personnel historique et journal
  commun aux transitions / messages. Position allouée au séquenceur natif dans
  la même transaction ; retry exact sans nouveau ciphertext ni nouvelle trame.
  Quotas persistants et identités d'opération partagées avec les parcours
  ordinaires ; droit d'écriture, tête exacte, appareils / grants et activation
  de tous les pairs gardés jusqu'au commit. Les fences d'activation précèdent
  le verrou du salon, compatibles avec les envois concurrents et les opérateurs.
  Pagination avec watermark fixe, ordre natif exact et témoin d'admission par
  appareil ; une réadhésion avec nouveau Welcome n'expose pas les anciens
  messages. Migration des transitions existantes et de leurs témoins exercée
  avec le SQL exact. Reçu propre disponible après retrait sans accès au contenu.
  Les SDK Rust / TypeScript conservent les positions supérieures à `2^53` et
  bornent les réponses crypto avant JSON ; aucun document clair stocké côté
  serveur. Neuf scénarios PostgreSQL / vrai MLS / HTTP passent en 4,17 s,
  11 scénarios de contrat et six scénarios du transport crypto passent.
  Les 1 273 tests mobiles passent en 55,09 s ; typecheck de toute l'app et lint
  ciblé réussis. Le workspace natif compte 308 succès, avec le banc privé HTTP
  ignoré par défaut et vérifié séparément ; 285 tests de fournisseurs TypeScript,
  formatage / Clippy strict, schéma / générations et inventaire passent.
  Le worker privé,
  préfixe complet historique, projections / interfaces, fichiers, appareils
  physiques et revue restent ouverts. [Contrat](protocol/E2EE_MESSAGES.md).
  Aucun changement d'interface et aucune capacité E2EE activée.

- CI / fichiers, retrait effectif (4 octobre 2026) : le job `verify` de
  `37173763923` échoue sur une assertion de lecture lancée en concurrence avec
  un retrait encore bloqué. Une lecture compatible peut être admise avant le
  commit du retrait ; les verrous de ligne PostgreSQL ne garantissent pas cette
  priorité de file. Le test conserve la preuve du retrait en attente, puis
  attend son commit avant d'exiger le refus du prochain chunk. Une seconde
  réponse capturée avant retrait reste refusée après réadhésion ; une nouvelle
  requête autorisée retrouve le fichier. Les huit scénarios fichiers passent
  localement en 13,38 s, avec formatage / Clippy strict ; aucun changement du
  transport de production. Les trois suites crypto, le banc HTTP privé,
  Swift et le cœur Windows de cette CI sont verts.

- P19 / J4, messages applicatifs protégés (4 octobre 2026) : vrai ciphertext
  MLS avec AAD de routage et preuve d'appareil externe, auteur MLS / certificat
  comparés à la liste active et document riche canonique (Markdown, fil,
  citations à révisions exactes, cartes). Ratchet d'envoi / réception, outbox
  originale, contenu privé, reçu exact et dernière position reçue partagent le
  checkpoint. Écho propre accepté seulement depuis les octets privés originaux ;
  refus tardif sans consommation, retry sans rechiffrement et ACK historique
  sans droit d'envoi. Une rotation attend les messages préparés, même si son
  consentement précède leur préparation ; une transition préparée bloque les
  nouveaux messages. Cache de 64 contenus / 4 Mio, retrait explicite après reçu,
  identités et reçus retenus pour empêcher la réutilisation d'une opération.
  Dix scénarios couvrent échange / réouverture, checkpoints perdus, substituts
  d'AAD / auteur, bornes, vrai commit en attente, ordre et libération du cache.
  Suite privée complète : 111 succès en 164,33 s, avec le scénario enfant
  ignoré exécuté par le parent de crash ; aucun cas filtré. Avant optimisation
  de l'arithmétique de courbe du profil test, les dix scénarios ciblés seuls
  prenaient 271,45 s. Les assertions du coordinateur restent actives ; encodage
  canonique et authentification de signature restent deux étapes distinctes.
  Formatage / Clippy strict passent ; trois régressions publiques et les
  15 scénarios de groupe serveur, dont le worker combiné actuel, passent
  (17,14 s pour ce dernier ensemble). Journal / HTTP / worker de messages,
  projection dans les apps, rattrapage à travers retraits / réadmissions,
  refus définitifs, politique de purge / archive, fichiers, pont Android et
  revue restent ouverts. [Contrat privé](../crates/rv-crypto/MESSAGES.md).
  Le lot reste isolé, sans capacité E2EE activée ni fermeture de J4.

- P19 / J4, banc combiné du worker privé (4 octobre 2026) : binaire séparé
  `delivery_smoke` appelé par le vrai serveur de test Rust / PostgreSQL,
  tokens temporaires via stdin et accès SQL retiré de l'environnement client.
  Appareils / certificats enregistrés par HTTP, deux lots de packages réels,
  genèse / Welcome ciblé, rotations par Alice puis Bob. Première réponse de
  publication et chaque réponse de transition coupées après commit serveur :
  nouveau Manager / SDK recherchant le reçu sans second POST. Parent local
  conservé avant ACK, mêmes nouveaux secrets d'époque chez les pairs, envoi
  en clair refusé. SQL : deux publications, trois transitions / événements,
  un seul Welcome et package consommé. Scénario combiné initial réussi en
  12,62 s ; les 15 scénarios de routes de groupe passent ensemble en 14,05 s,
  puis ce scénario est revérifié sans identifiants SQL côté client en 12,36 s.
  Formatage et Clippy strict des deux workspaces passent. SQLite
  privé réel, checkpoint externe simulé en mémoire : destruction du processus
  privé / trousseaux physiques non qualifiés par ce banc. Job dédié
  `native-crypto-http` exécutant ce test ignoré par défaut avec binaire requis.
  Messages chiffrés, planification / interfaces, rattrapage complet / retraits,
  refus / packages expirés, archives / fichiers / import et revue restent
  ouverts. Aucune capacité activée.

- P19 / J4, portabilité du banc HTTP (4 octobre 2026) : le job macOS de
  `37168795438` révèle un `WouldBlock` à la lecture de socket, puis une
  seconde panique dans le nettoyage. Les sockets acceptées sont explicitement
  bloquantes, leur délai est aligné sur les 15 secondes du SDK et le nettoyage
  conserve l'erreur initiale sans interrompre toute la suite. Formatage /
  Clippy strict et les cinq parcours HTTP passent localement ; CI corrigée
  `37169133442` entièrement verte sur Linux / Windows / macOS. Aucun changement
  du transport de production.

- P19 / J4, worker HTTP privé expérimental (4 octobre 2026) : feature
  optionnelle `native-http` utilisant le SDK existant. Instance / génération,
  compte et unique session courante vérifiés ; clones arrêtés ensemble,
  travail privé possédé hors réseau. Reçu recherché avant retry exact de
  genèse / successeur ou lot de packages, outbox conservée après réponse
  perdue / refus, fusion au reçu exact. Délai POST 429 sauvegardé dans le
  coffre et respecté après recréation, GET de reçu toujours disponible.
  Réception depuis le reçu local, validation de page puis preview /
  confirmation avec roster de nouveau observé. Suite complète initiale :
  100 succès en 45,17 s, plus enfant de crash exécuté par son parent ; cinq
  parcours HTTP ciblés revérifiés après ajout de la rotation perdue, avec
  égalité des nouveaux secrets du pair et aucun POST supplémentaire à la
  réconciliation. Formatage / Clippy strict passent. Ces parcours utilisent
  une fixture réseau déterministe, le vrai MLS et les coffres sur disque ;
  banc combiné worker / serveur / PostgreSQL et publication réseau des
  packages encore ouverts. Planification dans les apps, refus définitifs,
  rattrapage complet / retrait / retour, messages, pont Android, archives /
  fichiers / import, qualifications et revue restent ouverts. Capacité E2EE
  désactivée. CI étendue à cette feature sur les trois OS ; la CI du lot
  précédent `37167174920` est entièrement verte, y compris GTK / Swift / Windows.

- P19 / J4, frontière HTTP du coordinateur (4 octobre 2026) : les DTOs partagés
  portent maintenant genèse / changement, packages, préparation originale,
  reçu et événement vers / depuis le coffre. Scope / roster / nonces contrôlés,
  métadonnées comparées au vrai KeyPackage TLS et sa référence, encodages
  canoniques / grands entiers exacts, preuve / digests / Welcome ciblé et
  chaînage des pages vérifiés. Aucune approbation implicite. Le SDK borne
  succès et erreurs crypto à 4 Mio avant JSON, y compris chunks, en conservant
  le `Retry-After` et les GET disponibles. Six nouveaux scénarios MLS / DTOs,
  quatre tests HTTP du SDK et les 14 scénarios PostgreSQL passent ; suite
  complète du coffre : 96 réussis, plus enfant de crash exécuté par son parent,
  en 43,66 secondes. Chaînage final revérifié par les six tests ciblés ; fmt /
  Clippy strict passent. La CI de préparation `37165856413` est entièrement
  verte sur les trois OS ; CI de ce lot `37167174920` entièrement verte.
  Ordonnanceur connecté / refus / rattrapage complet, retrait local / retour,
  messages chiffrés, pont Android / apps, archives / fichiers / import et
  qualifications / revue restent ouverts. Capacité E2EE désactivée.
  [Frontière privée](../crates/rv-crypto/GROUP_HTTP.md).

- P19 / J4, préparation cliente des successeurs (4 octobre 2026) :
  `preview_change` / `prepare_change` vérifient la tête serveur observée et
  l'ancien arbre MLS, puis préparent rotation / ajout / retrait / remplacement
  dans une transaction protégée. Les nonces changés exigent Remove+Add frais ;
  les appareils conservés gardent indice / référence d'admission. Un appareil
  déjà révoqué peut être retiré ; certificat local renouvelé installé dans la
  vraie feuille. Preuve / arbre / commit / Welcomes originaux sauvegardés avant
  checkpoint et résultat, fusion seulement au reçu exact. Onze nouveaux
  scénarios passent par le coordinateur réel, dont singleton époque zéro,
  reprise disque / checkpoint perdu, remplacement deux retraits / un ajout,
  bornes et références dépensées. Suite complète : 90 tests réussis, plus
  enfant de crash exécuté par son parent, en 38,48 secondes. Formatage et
  Clippy strict passent. La CI de réception `37164702081` est entièrement
  verte sur les trois OS ; sa CI `37165856413` est également entièrement verte.
  Conversion HTTP / ordonnanceur, rattrapage complet / retrait local,
  messages chiffrés, pont Android / apps existantes, archives / fichiers /
  import, qualifications et revue demeurent ouverts. Aucune capacité activée.

- P19 / J4, réception cliente protégée de commits (4 octobre 2026) : vraie
  rotation / ajout / retrait après admission, auteur MLS / indice / clé reliés
  à la preuve signée et pins. AAD liant opération / parent / versions / appareils
  sans digests circulaires ; contexte / arbre / feuilles contrôlés séparément.
  Références d'ajout comparées aux vrais packages MLS, Welcomes limités aux
  nouvelles admissions, mémoire des références observées après retrait.
  Commit local préparé remplacé seulement après succès transactionnel ; refus
  tardif après fusion restaurant état / ratchets / outbox. ACK propre et reçu
  exact suivant un groupe actif, reprise après checkpoint perdu, configuration
  d'arbre conservée sur les groupes rejoints. Onze nouveaux scénarios passent ;
  suite complète : 79 réussis, plus enfant de crash exécuté par son parent.
  Clippy strict et CI `37164702081` verte sur les trois OS ; import Unix du test de publication
  conditionné pour corriger le refus Clippy Windows de `37162727300`.
  Tous ses autres jobs sont verts, y compris le banc de fichiers Windows et GTK.
  Préparation publique poursuivie au lot suivant ; rattrapage complet / retrait local,
  messages, transports / ponts / apps, archives / fichiers / import et revue
  restent ouverts. [Contrat privé](../crates/rv-crypto/GROUP_COMMITS.md).
  Capacité E2EE non activée.

- Qualification bureau, banc de reprise des fichiers (4 octobre 2026) : la CI
  du roster `37161366000` valide serveur / mobile, Swift et crypto sur les trois
  OS, mais son test Windows d'ACK d'upload perdu observe parfois la file après
  un retry déjà terminé. Le mock garde désormais chaque réponse perdue jusqu'à
  arrêt effectif de sa session, puis ouvre séparément préparation et ACK du
  processus suivant. Les deux tests de fichiers et Clippy ciblé passent dans
  le banc Fedora existant ; confirmation Windows attendue dans la CI suivante.
  Aucun code de production ni interface n'est modifié par cette correction.

- P19 / J4, publication cliente protégée (4 octobre 2026) : vrais KeyPackages
  générés dans le coffre avec la demande HTTP exacte et références MLS, avant
  remise après checkpoint. DTOs `rv-protocol` utilisés directement ; ID neuf
  généré en transaction, lot original retrouvé après coupure / redémarrage.
  ACK comparé champ par champ et conservé, reprise historique après perte de
  checkpoint / expiration, aucune nouvelle autorisation implicite. Lookup
  limité à portée / ID, refus de renvoi après consommation réelle par Welcome.
  Révocation locale observée bloquant aussi les préparations de groupe.
  Borne de 64 bundles, libération après vraie admission sans destruction fondée
  sur le temps seul. Neuf nouveaux tests passent, 68 scénarios du coffre au
  total et enfant de crash exécuté par son parent ; Clippy strict backend
  système passe. Réconciliation réseau des refus / expirés, commits suivants,
  messages, ponts et apps, archive / fichiers / import et revue restent ouverts.
  E2EE demeure désactivé. [Contrat du lot](../crates/rv-crypto/PACKAGES.md).

- P19 / J4, observation autorisée du roster (4 octobre 2026) : route / SDK Rust
  et TypeScript exposant politique, versions d'adhésion / activation de chaque
  membre actif et métadonnées publiques de tête. Même vue SQL que la validation
  des plans ; liste triée / complète, refus au-delà de 128 membres sans page
  partielle. Lecture permise avant inscription crypto, sans admission MLS ni
  approbation de clé. Session / adhésion / époque protégées pendant remise HTTP,
  corps borné par la lease et l'expiration de session ; `no-store` partout.
  Six nouveaux scénarios PostgreSQL vérifient confidentialité, compte inactif,
  départ / retour / réactivation, verrous réellement observés, limite et
  restauration ; 14 tests de groupes passent. Le vrai SDK obtient les nonces
  par HTTP et signe une transition acceptée, sans accès SQL côté client.
  Contrats / SDK Rust, six tests TS crypto / parité, typecheck / lint, Clippy,
  schéma / génération / inventaire passent. Réception des commits / messages,
  transitions suivantes, raccordement du coffre aux transports / apps,
  archives / fichiers / import et revue restent ouverts. Capacité non activée.

- P19 / J4, admission cliente protégée (4 octobre 2026) : preview du vrai Welcome
  sans consommation persistante, confirmation puis jointure atomique. Comparaison
  de chaque feuille / certificat / pin, package réellement consommé, incarnation,
  auteur MLS, ID / contexte / arbre / époque et adhésions / activations courantes.
  Preuve publique valablement signée mais incohérente avec MLS refusée ; refus
  applicatif tardif annulant toute consommation et écriture. Groupe et reçu
  conservés ensemble, récupération exacte après checkpoint perdu / réouverture.
  Huit nouveaux scénarios passent ; suite complète : 59 réussis et enfant
  réellement exécuté / tué via son parent, Clippy strict sans avertissement.
  Le filtre CI distingue désormais le moteur privé des formats publics ; les
  lots isolés évitent serveur / mobile / pilotes inchangés, toute consommation
  par une autre crate réactive leurs régressions. Un changement de workflow
  conserve toutes les validations. Réception des commits / messages, transitions
  suivantes, transport / ponts / apps, archives / fichiers / import et revue
  restent ouverts ; aucune capacité E2EE activée.

- P19 / J4, genèse cliente protégée (4 octobre 2026) : vrai groupe MLS préparé
  dans le coffre, indices issus de l'arbre validé, confirmation opaque liée aux
  pins / certificat / politique / nonces / packages et portée. Incarnation de
  feuille explicitement liée à celle du coffre ; état MLS et demande signée
  sauvegardés avant émission. Commit gardé en attente jusqu'au reçu exact,
  reprise des mêmes octets après arrêt / checkpoint perdu, reçu substitué refusé
  avant fusion. Changement de confiance / expiration bloque le retry sans
  supprimer la recherche du reçu accepté. Neuf tests ciblés passent, avec vraie
  jointure dans un second coffre et mêmes secrets d'époque, soit 51 scénarios
  crypto vérifiés ; formatage et Clippy strict avec backend natif passent.
  Le lot serveur `0dce551` a sa CI `37155993042` entièrement verte, y compris
  les clients existants et la matrice crypto Linux / Windows / macOS.
  [Contrat et suite ouverte](protocol/E2EE_GROUPS.md). Réception / transitions
  suivantes, outbox de messages, raccordement HTTP / apps et pont Android,
  archives / fichiers / import et revue restent ouverts. Capacité non activée.

- P19 / J4, transitions de groupes serveur (3 octobre 2026) : preuve signée
  liée au contexte / arbre / commit / destinataires, parent / révision / époque,
  politique et nonces d'adhésion / activation. Références MLS consommées avec
  tête / événement / Welcomes ciblés et reçu durable, dans une seule transaction.
  Verrous par incarnation couvrant aussi le créateur sans package, refus des
  nouvelles écritures claires après genèse et d'une conversion avec historique /
  upload clair actif. Lectures liées à la session / incarnation / adhésion,
  avec échéance monotone conservée pendant sérialisation et corps HTTP.
  Routes / SDK Rust / TypeScript, fixtures exactes et vecteur Node indépendant.
  Vrai commit d'ajout / jointure / contexte / arbre, ciphertext local, retrait,
  rejeu / restart, package déjà consommé, départ / retour, mutation concurrente,
  autre appareil et réponse expirée vérifiés contre PostgreSQL.
  Vérifications : 18 scénarios serveur E2EE / échéances, 3 tests de preuve de
  groupe publique, tests protocol / SDK Rust, 21 tests transport / parité TS,
  typecheck et lint ciblé passent ; Clippy sans avertissement et vérificateur
  Node/OpenSSL passent ; les régressions serveur de livraison et de fichiers
  passent aussi. [Contrat](protocol/E2EE_GROUPS.md). Moteur de groupe / vérification client,
  outbox / livraison des messages, pont Android, interfaces existantes,
  archives / fichiers / import et revue encore ouverts ; capacité non activée.

Les entrées relatent les lots livrés du plus récent au plus ancien. La matrice de
parité donne les conditions de sortie actuelles ; les limites des anciens lots
sont conservées avec leurs résultats de vérification.

- P19 / J4, premier raccordement serveur de l'annuaire public (3 octobre 2026) :
  formats / vérificateurs communs extraits dans `rv-crypto-public`, sans coffre
  privé dans les dépendances serveur. Enregistrement lié à la session courante,
  preuve de possession / grant signé, racine immuable, renouvellement conditionnel,
  remplacement avec révocation signée persistante ; vérification OpenMLS réelle
  des KeyPackages, références retirées conservées et lots atomiques. Reçus exacts
  retrouvés après réponse perdue, limite crypto et quotas, annuaire privé / no-store,
  SDK Rust et TypeScript sans changement d'interface. Huit tests PostgreSQL / HTTP
  ciblés et les 42 tests crypto vérifient ces chemins ; schéma et fixtures publics
  couvrent les révisions exactes. Vingt tests TypeScript ciblés, typage / lint,
  Clippy sans avertissement et vecteurs Node indépendants passent. L'admission, consommation unique / Welcome,
  groupes / outbox MLS et intégration aux apps restent ouverts. E2EE reste faux.
  Le lot précédent `9cc6fd6` a tous ses jobs CI `37146743934` verts.
  [Contrat et limites](protocol/E2EE_DIRECTORY.md).

- P19 / J4, sauvegarde et récupération de racine (3 octobre 2026) : code OS
  aléatoire 256 bits distinct du mot de passe / session, représentation bornée
  avec checksum de saisie, paquet XChaCha20Poly1305 lié à la racine / backup / date
  et nonce de 24 bytes. Seule la graine racine est exportée chiffrée ; pas de
  ratchet, feuille, pin, révocation ou historique. Première restauration dans
  un coffre / fournisseur vierge, clé publique dérivée vérifiée et transaction
  annulable. Reçu du paquet exact sauvegardé avec la racine : checkpoint perdu
  puis rejeu ne remettent pas à zéro une nouvelle feuille / demande.
  Huit tests dédiés passent : mauvais code / altération / portée / limites,
  clair incohérent, refus de coffre actif, réouverture / refus transactionnel /
  checkpoint perdu, soit 42 crypto Linux plus l'enfant réellement tué. Formatage,
  Clippy sans avertissement et les vecteurs identité / ajout indépendants passent.
  Le lot précédent `6d30d7e` a sa CI `37145272953` verte : serveur / mobile et
  trois plateformes crypto ; clients longs évités car crate isolée.
  La sauvegarde récupérable
  ne revendique pas de forward secrecy ; un ancien code et paquet restent
  utilisables tant que la racine n'est pas remplacée. Cérémonie et outbox de
  sauvegarde dans les apps existantes, délégation de contrôle, service de
  livraison, archive / fichiers / pont Android et revue restent ouverts.
  E2EE demeure désactivé. [Format et invariants](../crates/rv-crypto/RECOVERY.md).

- P19 / J4, ajout d'appareil et reçu privé durable (3 octobre 2026) : clé de
  feuille / incarnation neuves, demande signée liée à la racine attendue,
  preuve de possession et fenêtre de 10 minutes. Confirmation locale opaque
  liée à la demande / racine / registre et expiration ; accord de racine lié
  au certificat exact. Rejeu rendant le Grant original, refus d'un aperçu
  ancien, ID substitué, Grant d'une autre demande / clé et écriture d'objet
  local périmé. Registre borné, purge des reçus expirés et marqueur d'horloge
  monotone ; refus avant réouverture d'une ancienne fenêtre. Onze tests dédiés,
  soit 34 crypto Linux plus l'enfant réellement tué, passent ; vrai KeyPackage
  signé par la nouvelle clé, coffre disque réouvert, refus transactionnel et
  Grant retrouvé après échec de checkpoint. Clippy / formatage passent, vecteur
  public Rust et indépendant Node / OpenSSL également. Le lot identités
  `654d5ac` a sa CI `37143957558` verte : serveur / mobile et matrice crypto
  Linux / Windows / macOS ; pilotes clients longs évités car crate isolée.
  Livraison / cérémonie dans les apps actuelles, délégation de contrôle,
  récupération, politique de salon / archive / fichiers / pont Android et
  revue restent ouverts. E2EE demeure désactivé.
  [Parcours et format](../crates/rv-crypto/ENROLLMENT.md).

- P19 / J4, identités certifiées et approbation locale (3 octobre 2026) : racine
  Ed25519 cliente, certificat lié à l'instance / UID / appareil / incarnation /
  clé MLS, pins explicites et vérification hors bande. La signature seule ne
  donne aucun accès : un vrai KeyPackage validé par OpenMLS doit présenter la
  clé certifiée et l'appareil approuvé. Racine changée suspendue, remplacement
  confirmé effaçant les anciennes approbations, révocations additives après
  réouverture, refus d'une confirmation ancienne et d'une nouvelle clé sous la
  même incarnation. Racine privée et décisions sauvegardées dans le coffre
  transactionnel ; aucune API d'export privé. Neuf tests dédiés passent, soit
  23 tests crypto Linux plus l'enfant réellement tué ; Clippy avec trousseau et
  tous les targets sans avertissement. Vecteur public accepté par Rust et par
  un vérificateur indépendant Node / OpenSSL. Le lot précédent `845ef86` est
  confirmé par tous les jobs verts du workflow `37140904530`, dont les trois
  plateformes crypto et les régressions serveur / mobile / bureau / Swift.
  Demande signée / preuve de possession, cérémonie de nouvel appareil,
  récupération, politique de salon et livraison restent ouvertes, avec archive,
  fichiers, pont Android et revue. Aucune capacité E2EE activée ; J4 reste ouvert.
  [Format et règles](../crates/rv-crypto/IDENTITY.md).

- P19 / J4, checkpoint et trousseau système (3 octobre 2026) : coordinateur Rust
  `protected::Manager`, verrou OS possédé jusqu'au terme de l'écriture plateforme,
  vérification du prédécesseur / confirmation protégée avant résultat réseau / UI.
  Répertoire canonique lié à l'entrée pour refuser une base copiée sous un autre
  verrou, genèse authentifiée vide reprise après checkpoint initial perdu,
  tombstone sans clé avant purge SQLite et refus d'une incarnation retirée.
  Backend keyring 3.6.3 avec features natives explicites Linux / macOS / Windows ;
  aucun repli mock. Quatorze tests Linux passent, avec erreurs / ambiguïtés du
  trousseau, copie locale, retrait, worker abandonné et descripteur hérité.
  Le pilote du vrai Secret Service Linux passe : concurrent refusé, processus
  tué avant checkpoint, nouveau bus / daemon, reprise de l'outbox et retrait.
  Clippy avec backend et exemple, formatage, syntaxe et vérification du périmètre
  CI sur vrais commits jetables passent. Une matrice crypto Linux / Windows /
  macOS garde ses checks propres ; les longs pilotes clients restent requis
  dès qu'un client / serveur / workflow change ou consomme la crate.
  Le coffre précédent `fdaaf33` a ses quatre jobs CI verts (`37138503102`), dont
  tests disque / arrêts forcés Windows. Pont Android, raccordement aux apps,
  trousseaux installés / ACL Windows / coupure électrique, destruction des
  anciennes clés, identités / livraison / archive et revue restent ouverts.
  E2EE reste désactivé. [Contrat du coffre](../crates/rv-crypto/README.md).

- P19 / J4, coffre privé transactionnel (3 octobre 2026) : crate Rust isolée
  [`rv-crypto`](../crates/rv-crypto/README.md), clé / nonce OS, XChaCha20Poly1305,
  portée authentifiée et fournisseur OpenMLS / enregistrements privés dans un
  même commit SQLite. Un refus détruit le fournisseur temporaire ; une réception
  altérée ne consomme donc pas l'état durable. Checkpoint extérieur protégé
  exigé, blocage jusqu'à sauvegarde du marqueur et reprise du seul successeur
  authentifié après crash entre SQLite / trousseau. Tête ancienne restaurée,
  portée changée, writer périmé, échec SQL et état trop grand sont refusés.
  Six tests Linux passent : échange MLS après vraie réouverture disque, arrêt
  forcé avant puis après commit, AEAD / portée / limites / permissions / liens.
  Formatage, Clippy sans avertissement, syntaxe CI et lock racine inchangé passent ;
  ces tests rejoignent le check serveur. Le prototype précédent `f34e91e` est
  confirmé par les quatre jobs verts du workflow `37135884643`.
  Trousseaux réels / verrou de checkpoint, initialisation interrompue, purge,
  destruction des anciennes clés de stockage, identités / livraison / archive et
  pont mobile restent ouverts. Aucun client ne dépend encore du coffre et
  aucune forward secrecy du stockage durable n'est annoncée. E2EE reste
  désactivé ; P19 / J4 ne sont pas terminés. [Spécification](rfcs/0002-e2ee-native.md).

- P18 / P19 / J4, spécification et prototype crypto (3 octobre 2026) :
  [RFC 0002](rfcs/0002-e2ee-native.md) détaille identité / appareils, livraison
  ordonnée, retraits, persistance, archive récupérable et compatibilité RC.
  Le choix de travail MLS utilise OpenMLS 0.9.0 / RustCrypto 0.6.0, suite 0x0001,
  dans une crate de faisabilité et un lock séparés, sans dépendance des apps.
  Trois scénarios vérifient Welcome / échange, altération / rejeu, retrait et
  appareil neuf sans historique automatique. Deux comportements imposent des
  gardes applicatives : réception altérée consommant une clé avant refus, envoi
  possible dans l'ancienne époque avec commit préparé. Restaurer les écritures
  puis recharger le groupe permet de reprendre la réception dans le prototype.
  Le stockage est en mémoire et la livraison simulée ; ce n'est pas un coffre
  durable, un audit ou une qualification de l'app. Les trois tests, formatage,
  Clippy sans avertissement, syntaxe du check CI et isolation du lock passent.
  E2EE demeure désactivé.

- P20 / J4, raccordement mobile aux appels existants (3 octobre 2026) : boutons
  du salon / profil, carte d'activité et même écran WebView dirigés vers le
  fournisseur du compte. Migration SQLite 0032 : une intention de démarrage par
  salon, ID conservé après réponse perdue / redémarrage, aucun départ automatique
  à la reconnexion. Purge à retrait / réadhésion / restauration, acquittement exact,
  sondes de disponibilité par compte et gardes de vue / session / adhésion.
  Dix tests ciblés passent, plus les migrations et régressions des caches / runner.
  Le banc PostgreSQL existant monte la vraie liaison mobile avec HTTP / WebSocket
  et SQLite disque : activité projetée dans la carte, confirmation perdue, reprise
  du même ID après réouverture, entrée caméra / micro et URL tardive refusée après
  démontage. Typage, lint et export Android / Hermes passent ; inventaire à
  369 fichiers / 450 occurrences. Le lot bureau `1e957ae` est confirmé par les
  quatre jobs du workflow natif `37131483850` et macOS `37131483848`, tous verts.
  Le lot mobile `0444253` est confirmé par le workflow `37134341411`, avec ses
  quatre jobs Linux / Windows / Swift, régressions mobiles et export Android verts.
  Le service Jitsi réel, les médias / modération et les apps sur appareils restent
  à qualifier ; P20 / J4 restent ouverts. [Contrat](protocol/MEETINGS.md).

- P20 / J4, raccordement bureau aux appels existants (3 octobre 2026) : boutons
  du salon et du profil, carte rejoindre / infos et fenêtres GTK / SwiftUI
  dirigés vers le fournisseur du compte. L'activité native conserve l'ID de
  réunion jusqu'aux cartes existantes. Le cœur SQLite conserve le démarrage
  avant HTTP ; le prochain clic reprend le même ID après coupure / redémarrage,
  sans lancement automatique. Purge à la réadhésion / restauration et acquittement
  limité à l'intention originale ; URL privées transitoires, liens partagés sans
  JWT, vérification HTTPS / origine / conférence / expiration et gardes de compte,
  navigation et adhésion. Un appel de profil attend la projection du nouveau DM
  par le journal avant d'utiliser son adhésion. Capacité bureau activée seulement
  avec un serveur configuré ; capacité mobile encore désactivée.
  Quatre tests de stockage / URL, trois scénarios HTTP (rejeu après réouverture,
  mauvaise portée / révocation / restauration, DM créé depuis un profil), la
  vraie carte GTK sous Xvfb et huit tests Swift avec bindings régénérés passent.
  Clippy cœur / FFI / GTK, formatage, 17 tests du protocole, générateur et inventaire
  (368 fichiers, 450 occurrences) passent. Le workflow serveur Jitsi `9a1c884`,
  `37129062962`, est entièrement vert (quatre jobs). La compilation macOS de
  l'interface de ce nouveau lot reste à confirmer en CI ; mobile, service Jitsi
  réel / médias / modération et applications installées restent ouverts.
  [Contrat](protocol/MEETINGS.md) ; P20 / J4 ne sont pas déclarés terminés.

- P20 / J4, serveur et transports Jitsi (3 octobre 2026) : configuration HTTPS
  privée opérateur, HS256 limité à une conférence / domaine / audience / application,
  durée ≤ 120 s ; lien partagé sans jeton. Démarrage lié à l'adhésion / époque,
  reçus durables et une conférence active par salon ; activité structurée unique.
  Entrée privée, fin autorisée et bail de remise protègent la réponse contre une
  fin / révocation concurrente. Les capacités clientes restent désactivées jusqu'au
  raccordement aux écrans d'appel existants. Quatre tests PostgreSQL / HTTP avec
  transport mobile et vérificateur Node indépendant passent, ainsi qu'un test de
  configuration, 17 tests du protocole, 16 régressions du transport TypeScript,
  typecheck mobile, lint sans avertissement et Clippy des trois crates touchées.
  Quota de nouvelles opérations, reprise des reçus après maintenance, session
  révoquée et expiration précise du JWT sont couverts. Vérifications et limites du service
  réel dans le [contrat](protocol/MEETINGS.md). Ce lot ne ferme pas P20 / J4.

- P21 / J3, réactivation de réponse Linux via portail v2 (3 octobre 2026) :
  sonde du portail / but `im.reply-with-text` et GLib ≥ 2.86 avant sélection,
  payload natif avec actions exportées dès le startup, cible et texte reçus
  via `org.freedesktop.Application.ActivateAction` dans un tuple `((ss)s)`.
  Capture durable et validation privées restent dans le cœur / fenêtre existants.
  Affichage et retrait sont sérialisés par portée pour qu'une réponse tardive
  de `AddNotification` ne conserve pas un toast retiré ou remplacé. Diagnostic
  cohérent avec le backend choisi ; fournisseurs historiques conservés.
  Deux tests de capacités / payload, un serveur D-Bus jetable avec affichage
  retardé / remplacé / retiré, Clippy GTK et le vrai binaire compilé passent.
  Le script D-Bus ferme GTK, constate la perte du nom et compare les PID avant /
  après une réactivation avec cible et texte Unicode ; paramètres malformés refusés.
  Aucun compte utilisateur / installation n'est modifié. Le backend Plasma v1
  consulté n'annonce pas ce parcours ; il garde la réponse en direct. Portail v2
  installé / Plasma, compte privé et notifications OS restent à qualifier.
  Les deux CI du clic persistant `43ec7ea` sont entièrement vertes :
  `37125203094` (quatre jobs) et `37125203112` (macOS).
  Le workflow du portail v2 `9413bae` est également entièrement vert :
  `37127332646`, quatre jobs dont le script D-Bus avec sa limite CI de 30 s.
  P21 / J3 ne sont pas déclarés terminés. [Contrat et sources](protocol/PUSH.md).

- P21 / J3, clic hors ligne persistant (3 octobre 2026) : destination minimale
  conservée dans le SQLite de configuration avant reprise du compte, sans texte
  ou bearer. Une réservation synchrone avant attente du trousseau garde le dernier
  clic ; capture et acquittement tardifs ne peuvent remplacer / effacer le nouveau.
  GTK et SwiftUI reprennent le compte exact avant le compte par défaut, puis
  valident message / racine / adhésion / époque dans les mêmes écrans. Le registre
  OS retiré et un snapshot borné ne perdent pas la destination capturée. Erreurs
  réseau temporaires conservées pour reprise ; refus permanents retirés. Navigation
  explicite, nouveau lien, changement de compte et logout annulent l'attente.
  Vérifications : douze tests Rust ciblés (notifications, liens et anciennes
  réponses), dont huit scénarios HTTP du clic avec SQLite disque, réouverture
  après 503, racine hors cache, suppression, réadhésion, restauration, clic
  remplacé et annulation pendant résolution ; métadonnées trop grandes refusées.
  Huit tests Swift avec bindings régénérés et Clippy cœur / FFI / GTK passent.
  Le vrai binaire GTK compilé est lancé par D-Bus en XDG jetable : description
  et dispatch de l'action au startup passent, avec refus d'une portée étrangère.
  Les deux workflows du lot précédent `d90fdde` sont terminés avec succès :
  `37122994121` (quatre jobs) et `37122994132` (macOS).
  KDE à processus arrêté, notifications système installées et liens importés
  J5 restent ouverts. [Contrat](protocol/PUSH.md).

- P21 / J3, réponses hors ligne avant validation réseau (3 octobre 2026) : GTK
  et SwiftUI inscrivent la réponse et son reçu dans l'outbox du compte exact avant
  reprise / HTTP, même si la racine du fil n'est pas en cache. Métadonnées de la
  destination et marqueur de tentative sont durables, sans copie de texte ou
  bearer ; transactions `IMMEDIATE` pour deux captures concurrentes, plafond de
  256 réponses non résolues sans éviction. Le flusher ordinaire et un retry manuel
  ne peuvent contourner le contrôle privé du message / racine / adhésion / époque.
  Refus permanents et texte restent dans les états d'échec habituels ; purge du
  salon / compte et restauration retirent les intentions. Le retrait d'un toast
  après lecture ne perd pas une réponse déjà acceptée. Après une confirmation
  perdue, le message de l'ID d'envoi est relu sous les mêmes gardes avant tout
  nouveau POST, même si la cible de notification est supprimée depuis.
  Vérifications : 62 tests Rust ciblés (notifications, liens, transactions de
  projection), dont capture sans HTTP, réouverture disque, racine absente,
  concurrence de connexions, retrait / réadhésion, génération changée, suppression
  et perte de réponse après commit ; huit tests Swift et compilation des modèles
  avec les bindings régénérés ; Clippy cœur / FFI / GTK sans avertissement.
  La CI `37121052414` du lot COM `bf4cf8f` est entièrement verte, y compris son
  nouveau test Windows entre processus. Le clic de navigation encore en attente
  hors ligne reste en mémoire ; KDE à froid, parcours installés et liens importés
  J5 restent ouverts. [Contrat](protocol/PUSH.md).

- P21 / J3, activateur de réponse Windows (3 octobre 2026) : serveur COM local
  `INotificationActivationCallback`, CLSID stable et enregistrement HKCU / raccourcis
  Inno Setup, nettoyage à la désinstallation. Le switch de lancement COM est retiré
  avant parsing GTK ; compte / adhésion / époque sont contrôlés par le chemin natif
  livré au lot précédent. AUMID, arguments et texte UTF-16 bornés sont vérifiés.
  Le handler COM remplace le handler WinRT en mémoire lorsqu'il est enregistré,
  pour ne pas soumettre deux fois une réponse du fournisseur Rocket.Chat.
  Neuf tests Windows passent, dont un second vrai processus qui instancie la
  classe COM du premier et lui transmet la réponse ; aucun registre du compte
  Windows de l'utilisateur n'est modifié par le banc. Sept tests portables,
  formatage Fedora et Clippy Linux / Windows sans avertissement passent ; le
  workflow Windows ajoute ces vérifications à son job existant.
  La CI AppKit `37119774771` du lot `abd21db` est terminée avec succès :
  le défaut de visibilité du menu est corrigé. Les jobs modèles Swift, cœur
  Windows, serveur / mobile et banc GTK de `37119774779` sont verts : les deux
  workflows du lot précédent sont terminés avec succès.
  Le lancement depuis un toast réel d'une app installée reste à qualifier,
  ainsi que KDE à froid, les actions attendant durablement le réseau et les
  liens importés J5 ; [contrat](protocol/PUSH.md).

- P21 / J3, actions de notification persistantes (3 octobre 2026) : registre
  SQLite de 256 destinations sans contenu ou bearer, écrit avant remise à l'OS.
  Les callbacks GTK / SwiftUI retrouvent le compte exact, attendent ses salons /
  connexion, relisent message / racine en privé et gardent l'adhésion initiale.
  Réponse et ID sont inscrits atomiquement dans l'outbox avec un reçu local :
  un callback identique après réouverture ne crée pas de second envoi. Startup
  GApplication pour GNOME, protocole enregistré pour le clic Windows, traitement
  de la reprise dans AppModel SwiftUI. Cinq tests cœur, dont réouverture SQLite
  sur disque et véritable HTTP / WebSocket, sept tests du pont OS, Clippy des
  quatre crates et huit tests Swift avec bindings régénérés passent. Le vrai
  binaire GTK est activé comme service D-Bus dans un XDG jetable : description de
  l'action `(ss)`, dispatch d'une portée étrangère sans compte et fermeture passent.
  Ce banc de démarrage est ajouté à la CI après la construction existante, sans
  reconstruire le binaire. Les installations Linux ajoutent le service et les
  clés desktop nécessaires. La CI
  macOS précédente a révélé la visibilité interne de `membershipIsCurrent` dans
  le menu de lien ; elle est rendue publique pour la vue de l'app. Les jobs
  serveur / mobile, GTK, modèles Swift et cœur Windows du lot `830dd1b` sont
  tous verts : sa CI native-server est terminée avec succès. La CI AppKit attend
  le correctif de visibilité dans cette livraison. Réponse Windows à processus arrêté, remise à froid KDE,
  action hors ligne avant validation réseau, essais installés et liens importés
  J5 restent ouverts ; [contrat](protocol/PUSH.md).

- P21 / J3, liens natifs et menus existants (3 octobre 2026) : service HTTP(S)
  complet, instance / époque et destinataire de notification distincts, parsing
  strict sans repli de portée, compte courant ou correspondance unique au bureau,
  geste explicite Android avec validation avant bascule. GTK / SwiftUI attendent
  la connexion et les salons, refusent les résultats d'un ancien compte / lien ;
  résolution HTTP du message / vraie racine avec barrières d'adhésion et génération.
  Les trois menus actuels copient un permalien partageable sans bearer ou compte
  de l'auteur ; les sauts natifs comparent les positions décimales, les fils
  existants révèlent la réponse. Cinq tests Rust (dont HTTP réel), 22 contrôles
  mobiles, huit tests Swift via bindings régénérés, typage / Clippy bureau et
  export Android Hermes et compilation Kotlin du récepteur Android passent.
  Parcours installés, actions de notification
  bureau persistées à froid et résolution des liens importés J5 encore ouverts.
  [Contrat](protocol/ROOM_LINKS.md).

- P17, correction après CI `74c787e` (3 octobre 2026) : la compilation macOS est
  verte ; le test serveur de rejeu / confidentialité a révélé que l'annotation
  personnelle ajoutée aux lectures HTTP n'était pas présente dans la synchro.
  Les lots HTTP / WebSocket renseignent maintenant les mentions capturées pour
  leur seul lecteur, sans modifier les étoiles ou le journal partagé. Un test
  PostgreSQL contrôle destinataire, auteur et @here dans le flux ; le scénario
  HTTP de rejeu / confidentialité passe avec l'attente personnelle mise à jour.
  Le test conserve son contrôle indépendant de l'absence d'étoiles privées.

- P17 / J3, raccord des notifications bureau (3 octobre 2026) : créations live
  capturées avec le curseur SQLite, histoire / rattrapage / éditions silencieux,
  déduplication, préférences et barrières de lecture / adhésion. Le contrat
  `Message.personal_mention` renseigne les lecteurs depuis la capture serveur,
  sans propriété personnelle dans le journal partagé. GTK et SwiftUI conservent
  leurs notifications, avec navigation vers le message / fil et réponse via la
  file d'envoi normale ; les références OS sont épinglées au compte / époque.
  Quatre tests du cœur, dont vrai WebSocket et réponses de fils, sept tests
  PostgreSQL / HTTP et neuf tests du contrat passent. Clippy bureau / serveur et
  typage mobile passent ; bindings / modèles Swift recompilés et six tests
  locaux Swift passent. Les neuf tests d'intégration Swift sans serveur sont
  explicitement ignorés, sans être comptés comme preuves. Compilation AppKit
  à confirmer en CI macOS ; notifications système installées et actions au
  démarrage à froid P21 restent ouvertes.
  La CI du push Android `66b032b` est entièrement verte. [Contrat](protocol/PUSH.md).

- P17 / J3, push serveur et raccord Android (3 octobre 2026) : registre lié à
  la famille de session, capture atomique des tâches, leases / retries bornés,
  OAuth FCM HTTP v1 et payload d'identifiants uniquement. La lecture privée
  conserve les barrières de droits jusqu'à livraison. Le plugin Kotlin actuel
  récupère le contenu via WorkManager et garde les notifications de conversation,
  avec réponse native idempotente, déduplication et liens épinglés au compte.
  La rotation FCM reprend aussi en arrière-plan les familles natives déjà
  inscrites, sans bearer dans la file WorkManager. Six tests serveur PostgreSQL
  / HTTP, neuf tests du contrat et 29 contrôles mobiles ciblés passent, ainsi que
  typage / lint, Clippy, export Android / Hermes et compilation réelle du plugin
  Kotlin dans l'app Android. Le cache Gradle créé pour ce chantier a été déplacé
  sur D: après saturation de C: ; la dépendance Guava expose maintenant le
  `ListenableFuture` utilisé pour acquitter l'inscription durable d'une réponse.
  Les CI serveur, bureau Linux / Windows et macOS du lot cartes `6c85995` sont
  vertes. Firebase réel et Android physique app arrêtée restent ouverts.
  Notifications bureau : prochain lot P17. [Contrat](protocol/PUSH.md).

- P15 / J3, cartes d'intégration et activation (3 octobre 2026) : contrat
  `SendMessage.cards` / `Message.cards`, trois pièces et 16 Kio au total,
  texte / liens / champs bornés et propriétés inconnues refusées. Même envoi,
  permissions, empreinte de rejeu, journal et tombstone que les messages.
  L'index GIN des cartes complète la recherche du texte. SQLite, recherche
  temporaire et actualisation des citations conservent les pièces ; GTK
  utilise son renderer existant, mobile et SwiftUI complètent leurs cartes
  actuelles avec les champs manquants pour les deux fournisseurs.
  Deux tests du contrat, 24 tests mobiles ciblés, typage / lint, export
  Android / Hermes, projection
  SQLite bureau et modèle UniFFI, widget GTK et six tests locaux Swift passent.
  La CI macOS du lecteur précédent `1e073b1` est verte, ainsi que les modèles
  Swift et le cœur Windows. Le serveur annonce maintenant `structured_cards`,
  et `link_previews` si un volume d'objets est configuré ; le banc mobile des images
  n'altère plus la découverte. Les bancs PostgreSQL / HTTP vérifient droits,
  rejeu, recherche, édition et effacement, ainsi que le fournisseur mobile
  réel et sa présentation. [Contrat](protocol/INTEGRATION_CARDS.md).
  Clippy serveur et bureau sans avertissement ; schéma / types / inventaire
  synchronisés (356 fichiers de production, 443 occurrences).
  Compilation macOS du lot cartes et qualification des applications installées
  restent ouvertes ; P15 n'est pas fermé globalement, le chiffré appartient à J4.

- P15 / J3, raccordement desktop des aperçus (3 octobre 2026) : projection
  SQLite et résultats temporaires de recherche dans les cartes d'article,
  d'image et de vidéo GTK / SwiftUI existantes. Les chemins privés ne portent
  ni origine ni credentials ; le lecteur partagé contrôle l'image et le
  message courant après HTTP, puis l'adhésion et la génération après décodage.
  Cache borné, réutilisation après réaction, retrait après édition / révocation
  et nouvelle preuve après réadhésion, même pour un chemin opaque identique.
  Les images directes utilisent les visionneuses existantes ; l'enregistrement
  revalide l'accès avant publication du fichier. Deux nouveaux tests du cœur
  avec HTTP / WebSocket / SQLite passent, parmi 361 régressions cœur / UniFFI.
  Le vrai widget GTK sous Xvfb affiche la texture, réutilise le cache puis la
  retire et la recharge après changement d'adhésion ; ce parcours rejoint la CI.
  Clippy cœur / FFI / GTK sans avertissement, formatage, bindings et six tests
  locaux Swift passent ; seize parcours Swift connectés restent conditionnés
  à leurs bancs et ne sont pas exécutés dans ce contrôle. La compilation
  AppKit / SwiftUI doit passer la CI macOS du commit. La capacité serveur reste
  désactivée dans ce lot. Intégrations structurées, activation et qualification
  d'applications installées restent ouvertes ; P15 n'est pas fermé globalement.

- P15 / J3, raccordement mobile des aperçus (3 octobre 2026) : les cartes
  d'article, d'image et de vidéo existantes lisent la projection SQLite native.
  Les références privées sont liées au message / descripteur / adhésion et au
  lecteur du compte ; cache borné, quatre lectures simultanées, recherche
  temporaire et retrait des pixels après édition / suppression / révocation.
  Une réaction sans changement d'image conserve le cache. La visionneuse
  garde zoom et enregistrement ; l'export relit le message courant, contrôle
  l'accès avant la copie et efface son fichier temporaire.
  Vérifications : 48 tests ciblés finaux passent ; suite mobile générale
  de 1 241 tests sans échec, typecheck, schéma / types générés, Clippy Rust et
  export Android / Hermes réussis. Le banc PostgreSQL utilise HTTP, WebSocket
  et SQLite réels pour lecture privée, cache et retrait après édition.
  Lint ciblé réussi ; les règles React Compiler déjà en défaut dans la
  visionneuse ont été désactivées uniquement pour son contrôle local, sans
  modifier la configuration ni son code de gestes existant.
  Le test CI des fichiers attend maintenant le verrou exact de la révocation,
  évitant de confondre une libération de réponse précédente ; sa régression
  PostgreSQL passe. GTK / SwiftUI, intégrations structurées, activation serveur
  et qualification d'applications installées restent ouverts dans P15.

- P15 / J3, collecte des aperçus (3 octobre 2026) : métadonnées natives bornées,
  tâches PostgreSQL avec génération de contenu, baux, retries et échéance ;
  le réseau tourne hors transaction. DNS public intégralement vérifié puis
  épinglé, redirections revalidées, refus des réseaux privés / loopback et de
  l'authentification distante. HTML / images bornés ; vignettes normalisées en
  PNG et servies avec session / adhésion / message courant vérifiés. Le transport
  Rust vérifie empreinte et dimensions. [Contrat](protocol/LINK_PREVIEWS.md).
  Vérifications : 18 tests ciblés passent, dont sept avec PostgreSQL et une
  lecture SDK / HTTP réelle ; refus DNS mixtes, limites chunked, expiration
  pendant une attente réelle du journal, révision / suppression / epoch et
  droits de lecture couverts. Clippy workspace sans avertissement, corpus et
  contrats Rust, régression édition / suppression et CLI opérateur passent ;
  le cœur bureau compile avec le contrat additif et son lockfile synchronisé.
  Schéma / types TypeScript synchronisés, typecheck et 14 tests SQLite mobiles
  passent ; aucune refonte de l'interface n'est livrée dans ce lot serveur.
  La capacité reste désactivée jusqu'au raccordement des cartes existantes
  mobile / GTK / SwiftUI ; caches / invalidation, vidéos et cartes d'intégration
  restent ouverts. Le test de santé opérateur suit maintenant la dernière
  migration compilée, corrigeant l'échec CI `33` contre attente figée `32`.

- P07 / J3, emojis personnalisés (3 octobre 2026) : catalogue opérateur versionné,
  reçus / audit partagés, import PNG / JPEG normalisé et GIF borné, noms / alias
  uniques sans masquer Unicode, images privées avec contrôle de taille / empreinte.
  Le live annonce les révisions ; les caches SQLite masquent les entrées retirées
  et refusent les catalogues tardifs, y compris après redémarrage. Les sélecteurs,
  complétions, corps de messages et réactions existants mobile / GTK / SwiftUI
  utilisent ce catalogue et leurs lecteurs protégés. Une réaction perdue conserve
  son nom canonique après changement d'alias ; un emoji retiré ne peut plus être
  ajouté, mais sa réaction existante peut être retirée. Vérifications : 4 parcours
  PostgreSQL, 1 230 tests mobiles, typage / lint et export Android / Hermes ; 359
  tests du cœur bureau / UniFFI, clippy et 2 tests ciblés de plancher / image / masque
  de capacité. Le vrai widget GTK passe 11 contrôles ; modèles Swift fichiers /
  emojis contre le serveur et Secret Service passent en 3 s. Le fournisseur mobile
  réel HTTP / WebSocket / SQLite affiche les pixels privés, canonicalise la réaction
  et retire noms / pixels après une suppression opérateur. La CI du lot précédent
  est verte sur les clients bureau ; sa seule erreur mobile était l'assertion de
  tables oubliant `native_upload_intents`, corrigée et vérifiée ici. Compilation
  macOS du nouveau lot, Android installé et animation desktop restent à qualifier ;
  P07 / J3 restent ouverts. [Contrat](protocol/CUSTOM_EMOJIS.md). Suite : P15 cartes.

- P14 / P07, fichiers cités (3 octobre 2026) : les résolutions autorisées incluent
  les descripteurs du message source courant, sans créer de lien ni de droit dans
  le salon destinataire. Les caches conservent les fichiers dans la source liée
  à son adhésion, sans historique artificiel ni copie privée de descendant dans
  le parent. Suppression, vue indisponible plus récente, retrait / réadhésion et
  génération ferment aussi la lecture d'un ancien manifest encore en cache.
  Les cartes mobile / GTK / SwiftUI existantes reprennent les images protégées
  et résument documents / vocaux / vidéos, jusque dans le second niveau de
  citation. Contrat additif généré, Clippy serveur et bureau réussis ; 7 parcours
  PostgreSQL de citations / fichiers, 34 tests mobiles ciblés, typecheck / lint
  et 370 tests bureau passent. Le composeur GTK passe 8 contrôles sous Xvfb ;
  les modèles Swift passent citation / lecture de fichier et le parcours existant
  connexion / actions / fils / reprise. Deux assertions CI qui attendaient encore
  les fichiers désactivés ont été corrigées en conservant la vérification de
  l'intersection des capacités serveur / client. La compilation macOS et les
  interfaces installées, les codecs et le module mobile restent à qualifier ;
  P14 n'est pas fermé globalement. Prochain point J3 : catalogue d'emojis custom.

- P14 / J3, raccordement desktop (3 octobre 2026) : composeurs, progression,
  retry / abandon et lecteurs GTK / SwiftUI existants raccordés. Copie privée,
  empreinte et intentions SQLite durables ; reprise après réponses perdues,
  réception du message courant et abandon hors ligne. Cache streamé / vérifié,
  Range pour réutilisation, recherche temporaire, fermeture après retrait et
  chemin privé pour les lecteurs Swift. Deux tests SQLite passent ; le banc
  PostgreSQL et le composeur GTK sous Xvfb passent sans screenshot. Les modèles
  Swift réels sont compilés et testés avec Secret Service. Codecs, applications
  installées et fichiers cités restent ouverts ; pas de fermeture globale P14.
- P14 / J3, raccordement mobile (3 octobre 2026) : file `televersements`, progression,
  retry / abandon et lecteurs / partage actuels raccordés. Intention SQLite 0030
  atomique avec fichier privé d'origine, empreinte, adhésion et deux IDs stables.
  Reprise réelle HTTP / PostgreSQL / SQLite après réponses de préparation,
  transfert et confirmation perdues : un message par intention. Abandon hors ligne
  prouvé après redémarrage, sans message. Cache privé streamé et vérifié avant
  renommage, URLs de lecteurs sans credentials, revalidation des lectures / Range,
  retrait des caches au changement de génération et fichiers de recherche temporaires.
  Le module Expo Android / iOS transmet depuis le disque sans redirection ; absent,
  le bouton reste désactivé. 103 tests ciblés passent en 5,8 s ; typecheck / lint,
  autolinking Android et export Hermes réussis. La compilation native du nouveau
  module et les lecteurs installés ne sont pas validés par cet export : reconstruction
  APK / iOS et appareils restent à qualifier. GTK / SwiftUI et fichiers cités sont
  les raccordements suivants, J4 conserve la responsabilité du chiffré.

- P14 / J3, fichiers côté serveur et transports (3 octobre 2026) : réservation
  liée à l'adhésion / génération, streaming sur le volume, taille / SHA-256 /
  signature vérifiés, leases de transfert et confirmation atomique du message.
  Quotas logiques, annulation / expiration, reprise sans second message et
  téléchargement protégé avec Range et revalidation par trame. Descripteurs dans
  historique / snapshots / journal, tombstones sans fichiers ; légende vide et
  conservation du fichier après édition. Sept tests PostgreSQL dédiés passent
  en 3,1 s, incluant le transport TypeScript réel avec deux réponses perdues,
  annulation en cours et retrait du lecteur entre deux trames. Streaming Rust
  explicitement exercé ; 28 tests serveur, 7 transports, 6 profils / avatars et
  9 contrats passés, ainsi que Clippy ; contrôle d'édition répété après adaptation
  de la légende. 21 tests SDK TypeScript, typecheck / lint et 9 contrôles du cœur
  bureau passent. Les verrous de dépendances incluent le streaming du SDK sans
  changer les versions HTTP des drivers. Contrat : [FILES.md](protocol/FILES.md).
  Les outboxes, pièces jointes / lecteurs des trois interfaces existantes sont
  la suite immédiate ; qualification installée, fichiers cités et chiffrés restent
  ouverts. Les deux CI du lot d'administration `ff4a75f` sont entièrement vertes.
  Aucun nouveau client n'est créé.

- P23, administration opérateur (3 octobre 2026) : CLI de comptes / droits /
  désactivation, salons / membres / réglages, listes paginées, audit et diagnostic.
  Les commandes rendent des reçus persistants ; un ancien reçu ne réapplique pas
  son état après une réactivation et un même ID concurrent ne crée qu'un salon.
  Révocation des appareils sous le verrou de remise, conservation des comptes /
  mots de passe / facteurs / conversations et propagation par le journal existant.
  L'audit transactionnel exclut secrets et messages ; le rôle opérateur reste
  distinct des droits d'application. Vérifications : Clippy serveur et 14 tests
  PostgreSQL (5 administration, 4 invitations, 5 récupération), dont un scénario
  du vrai binaire CLI et une attente du verrou de remise. Neuf scénarios Swift
  connectés à PostgreSQL / Secret Service passent en 31,3 s après correction de
  l'attente de reconnexion du test de profil ; compilation incrémentale 12,4 s.
  Le scénario GTK attend aussi la connexion du compte pair avant son profil :
  Clippy, compilation Fedora et 44 contrôles du vrai binaire passent.
  La compilation des vues macOS du lot précédent est verte dans la CI 37093755876.
  Contrat dans [ADMINISTRATION.md](protocol/ADMINISTRATION.md). Qualification
  installée, import / restauration et exploitation J5 restent ouverts ; suite J3.

- P16, identités des DM bureau (3 octobre 2026) : listes et en-têtes GTK / SwiftUI
  existants affichent le nom et la photo protégée courants de leur interlocuteur.
  Projection commune du cœur, lien SQLite par UID et adhésion, reprise hors ligne,
  purge après retrait / changement d'adhésion ou d'autorité et refus d'une photo
  live antérieure à cette adhésion. Le bouton d'information ouvre la même fiche
  publique par UID. Retrait de photo efface les pixels du DM. La CI macOS a relevé
  le chargement du profil attaché à la section Appareils ; il appartient maintenant
  à la vue Réglages qui possède ce modèle. Vérifications : 13 tests ciblés Rust
  et clippy ; 43 contrôles du vrai binaire GTK, incluant nom / photo dans le DM,
  fiche par UID et retrait. Bindings et modèles Swift compilés ; parcours connecté
  contre PostgreSQL / Secret Service réussi en 6,7 s (compilation incrémentale
  14,3 s), avec renommage et retrait d'avatar dans le DM de l'autre compte.
  Compilation des vues macOS à confirmer par
  CI et qualifications installées encore ouvertes ; suite indépendante : P23.

- P16, formulaires personnels bureau (3 octobre 2026) : GTK réutilise son éditeur
  et SwiftUI son formulaire, derrière le fournisseur du compte. Profil / statut,
  photo PNG de 512 pixels, langue et notifications passent par les intentions
  communes ; email vérifié privé dans Sécurité, preuve récente / reprise / abandon.
  Révisions de brouillon conservées face à un changement concurrent ; notification
  de profil sans annulation d'un avatar courant. Vérifications : 12 tests Rust /
  clippy ; 39 contrôles du binaire GTK avec enregistrement du profil ; modèle Swift
  contre PostgreSQL / Secret Service en 1,4 s. Erreur d'accès à l'ID de session
  détectée par macOS corrigée, vues à revalider par CI. Métadonnées / photos de
  liste DM bureau et qualification installée restent ouvertes dans P16.

- P16, fiches publiques bureau (3 octobre 2026) : mêmes dialogs GTK / SwiftUI et
  mêmes tuiles de messages, profils par UID, renommages live et DM par UID stable.
  Avatars authentifiés bornés à 128 entrées / 32 Mio / quatre téléchargements,
  retrait / remplacement et réponses tardives protégés. Le cœur et UniFFI
  partagent les commandes personnelles persistantes (profil / préférences / photo)
  sans dupliquer les données privées dans le cache public. Vérifications ciblées
  SQLite / HTTP : redémarrage, génération, réponse perdue et rejeu sans rétablir
  un ancien profil : 12 tests ciblés en 1,8 s et clippy bureau passent. Scénarios
  ajoutés aux bancs GTK et Swift existants ; compilation Swift locale vérifiée,
  exécution avec serveur réservée au banc CI. Les éditeurs
  personnels et réglages bureau restent à raccorder ; P16 reste ouvert.

- P16, profil personnel mobile (3 octobre 2026) : « Mon profil » et les paramètres
  existants éditent nom / pseudo / bio / statut, photo PNG bornée et langue native.
  Email privé en lecture seule avec renvoi au parcours vérifié P02 ; confirmation
  d'identité existante pour une preuve récente. Migration SQLite 0029, intentions
  originales de profil / préférences / avatar, octets immuables, reprise après
  réponse perdue et redémarrage, refus conservés et abandon explicite. Les resets
  ordinaires préservent les commandes du compte ; une autre génération les purge.
  Les préférences non modifiées sont conservées ; le réglage push reste masqué
  jusqu'à P17. Vérifications : 40 tests ciblés en 1,5 s, typage / lint, banc réel
  HTTP / PostgreSQL / WebSocket / SQLite en 9,7 s (compilation 3,3 s), incluant
  rejeu après réponse perdue sans écraser une modification concurrente plus récente.
  La CI du lot public précédent est verte sur ses quatre jobs. Raccordement des
  fiches / réglages / caches et intentions GTK / SwiftUI, puis qualification
  installée restent à poursuivre ; P16 reste ouvert.

- P16, fiches publiques mobiles (3 octobre 2026) : la feuille de profil existante
  s'ouvre depuis les auteurs / mentions avec les données de son fournisseur.
  Préchargement gardé au changement de compte, identités / versions d'avatars
  propagées par le live vers SQLite, lectures antérieures refusées. Les tuiles
  de photos des messages, DM et fiches reçoivent des PNG locaux issus du transport
  authentifié ; cache mémoire borné, concurrence limitée à quatre et purge à la
  fermeture. Retrait / remplacement efface les pixels y compris en cas de réponse
  tardive. Le bouton Message résout l'UID courant même après un renommage.
  Vérifications : 25 tests mobiles ciblés, typage / lint et banc réel HTTP /
  PostgreSQL / WebSocket / SQLite ; ce parcours ne qualifie pas l'écran Android.
  Éditeur personnel / préférences mobiles et raccordement GTK / SwiftUI restent
  la suite de P16 ; aucun autre client ni interface n'est créé.

- P16 / J2–J3, socle profils (3 octobre 2026) : API publiques sans email,
  profil personnel avec adresse vérifiée privée, commandes de nom / bio / statut
  et préférences versionnées séparément. Changement de pseudo protégé par preuve
  récente ; reçus personnels idempotents, conflits et budget partagé de 20/minute.
  Avatars PNG / JPEG sur volume local : décodage borné, réencodage sans métadonnées,
  finalisation durable avant référence SQL, téléchargements authentifiés et
  invalidation immédiate des anciennes URLs. Nettoyage des orphelins après crash,
  contrôle de remise et statuts conservés entre appareils. DTO / schéma commun et
  transports Rust / TypeScript disponibles ; stamps publics de profil dans les
  photos live, sans changement du journal. Les masques clients restent fermés :
  intentions persistantes et raccordement aux fiches / réglages / caches existants
  mobile, GTK et SwiftUI sont la prochaine étape, avant de déclarer P16 livré.
  Vérifications ciblées : 5 tests API PostgreSQL, 2 régressions live, 7 tests du
  transport natif, 14 tests du protocole ; Clippy de toutes les cibles des trois
  crates racine. 19 tests des transports mobiles, typage / lint, schéma généré
  et inventaire conformes. Le cache live bureau passe son test ciblé.
  La CI garde tous ses contrôles ; images Fedora / Swift / serveur / check
  désormais mises en cache via Buildx, caches Cargo enregistrés par commit avec
  reprise depuis les dépendances correspondantes. L'efficacité de ces caches
  reste à mesurer sur les prochains runs ; aucune durée gagnée n'est revendiquée.

- P13 / J2, recherche (3 octobre 2026) : index textuel PostgreSQL du texte écrit,
  accès limité aux membres actuels, racines / réponses paginées par position
  exacte et réponse plafonnée à 50 messages / 512 Kio. Édition / suppression
  actualisent l'index ; une citation n'indexe pas le texte privé de sa source.
  Budget séparé de 20 recherches / minute / appareil et barrière de remise sur
  session / adhésions. Résultats temporaires raccordés aux mêmes écrans mobile,
  GTK et SwiftUI, sans écriture d'historique ou de curseur. Leur contexte distingue
  comptes / salons ; pertes d'accès, mutations et suspension les périment,
  tandis qu'une actualisation de lecture les conserve. Relance par Entrée.
  Vérifications : 211 tests Rust racine, Clippy ; 221 tests unitaires desktop
  (204 cœur, 11 bindings, 6 GTK), Clippy de toutes les cibles et compilation GTK ;
  1 193 tests mobiles, typage / lint, fixture et inventaire générés conformes.
  Le fournisseur mobile réel PostgreSQL / WebSocket / SQLite vérifie résultats
  hors fenêtre, fils, droits, rendu existant et suspension. GTK passe 36 contrôles
  réels, dont recherche / nouvelle requête / suspension, sans capture. Le modèle
  Swift connecté passe avec bindings et trousseau réels. Les deux CI P12 du
  commit `d6a94f3` sont vertes. Partie P13 / J4 encore ouverte : index local du
  déchiffré, indication de l'historique disponible et purge au verrouillage.
  Qualification installée ouverte. [Contrat P13](protocol/SEARCH.md).

- P12, présence / saisie (3 octobre 2026) : baux PostgreSQL UNLOGGED par appareil,
  présence de 60 s et saisie de 10 s ; renouvellement actif, arrêt et émission
  limitée côté clients. Photos WebSocket négociées séparément du journal,
  expiration locale de 8 s, identité réelle du correspondant d'un DM et jetons
  d'adhésion vérifiés ; retrait / réadhésion, session révoquée et restauration
  ne réaniment pas une ancienne saisie. Les composeurs et indicateurs GTK /
  SwiftUI / mobile existants sont raccordés. `@here` capture seulement les
  membres online / busy au premier envoi ; édition et connexion ultérieure
  n'ajoutent aucun ping. Aucun état temporaire n'entre dans l'outbox ou SQLite.
  Vérifications : 209 tests Rust racine, Clippy, contrats générés ; 349 tests
  cœur / bindings desktop, 6 tests GTK et Clippy workspace ; 1 191 tests mobiles, types et
  lint, puis 3 tests ciblés de l'horloge monotone. Deux fournisseurs mobiles
  réels PostgreSQL / WebSocket / SQLite vérifient la saisie via le moteur
  existant, le correspondant du DM, arrêt / suspension et purge d'adhésion.
  GTK passe 33 contrôles de widgets / composeurs sous Xvfb et Secret Service,
  dont 6 nouveaux contrôles présence / saisie, sans screenshot. Deux parcours
  Swift connectés passent avec le trousseau réel, dont présence / émission /
  arrêt / suspension. La CI du précédent lot `33a7084` est entièrement verte.
  Qualification des applications installées ouverte. [Contrat P12](protocol/LIVE.md).

- P11, fils (3 octobre 2026) : racines / réponses séparées, compteurs et dernière
  réponse, pages de fil et lectures monotones par fil livrés côté Rust / transports.
  Même écran mobile et mêmes panneaux GTK / SwiftUI : réponse durable gardant
  sa racine après redémarrage, brouillon propre, citations dans le fil et compteur
  dans le salon sans seconde racine. Suppression de racine : anciennes réponses
  consultables, ancien envoi committé rejouable, nouvel envoi refusé et brouillon
  conservé. Retrait / réadhésion : purge des données privées et callbacks anciens
  refusés. Les snapshots gardent 50 racines et 50 réponses par salon.
  Le fournisseur mobile réel contre PostgreSQL vérifie confirmation perdue,
  redémarrage SQLite, rejeu après suppression, lectures indépendantes et retrait.
  GTK exécute les menus / composeurs / cartes réels sans capture ; les modèles
  Swift ouvrent, répondent, citent et reprennent le brouillon dans le panneau existant.
  Vérifications : deux scénarios PostgreSQL de fils, quatre scénarios SQLite du
  cœur bureau, tests de cache mobile et fixture commune Rust / TypeScript exacte.
  Validation globale : 207 tests serveur / protocole (deux cibles corrigées puis
  revalidées), 361 tests bureau, 1 187 tests mobiles puis le contrat partagé à
  16 tests après ajout de sa fixture de fil. Clippy, compilation GTK, génération
  Swift, typecheck / lint et inventaire passent. Le parcours GTK comporte 27
  contrôles réussis ; le parcours Swift connecté passe. Qualification Android / Windows / macOS
  installés encore ouverte. [Contrat P11](protocol/THREADS.md).

- P07, citations imbriquées (3 octobre 2026) : résolution personnalisée sur deux
  niveaux, huit références par source, droit et position propres à chaque enfant.
  Le journal partagé reste constitué de références ; une source parente ne
  conserve aucune copie privée descendante. Les caches bureau / mobile réutilisent
  les cartes existantes, coupent les cycles et actualisent les dépendances
  indirectes après édition, suppression ou retrait. Une réponse tardive ne
  restaure pas le texte retiré, même après réouverture du cache mobile.
  Vérifications : 205 tests serveur / protocole, 357 tests bureau et 1 185 tests
  mobiles ; formatage, Clippy, typecheck, lint, schéma généré et inventaire passent.
  Le vrai composeur / widget GTK passe 15 contrôles. Le parcours des modèles
  Swift connectés à PostgreSQL / trousseau vérifie l'envoi imbriqué puis la purge
  du seul enfant supprimé (un test exécuté, aucun saut).
  Contrat : [citations natives](protocol/QUOTES.md). Les fichiers cités et
  les essais sur applications installées restent ouverts ; P07 n'est pas clos.

- P07, activité structurée des salons (3 octobre 2026) : création, membres,
  réglages et rôles publiés dans la transaction de leur action ; rejeux sans
  doublon, compteurs sans activité système, actions de message refusées.
  Projection dans les lignes traduites mobile / GTK / SwiftUI existantes,
  conservée en SQLite, sans nouveau composant ni écran.
  Contrat : [messages système](protocol/SYSTEM_MESSAGES.md).
  Vérifications locales : 203 cas Rust natifs couverts par la suite globale
  et les reprises ciblées des hypothèses d'historique ; 356 tests desktop ;
  1 183 tests mobiles puis les projections et le séparateur finaux ciblés
  (31 tests), typecheck / lint. Le vrai widget GTK et les modèles Swift
  contre PostgreSQL / trousseau passent ; aucun test Swift sauté. Les CI du
  commit précédent ont validé SwiftUI, Windows, serveur / mobile, citations
  GTK et modèles Swift ; le banc GTK email distant reste en cours à ce relevé.
  La qualification des applications installées reste ouverte.

- P07, contrôles de citation des applications existantes : action Répondre,
  bandeaux / cartes et composeurs GTK, SwiftUI et mobile utilisent des références
  natives ; les permaliens Rocket.Chat gardent leur chemin historique. La mise
  en file transmet la sélection liée à l'adhésion, accepte une citation seule
  et conserve les mots après rejet local. Un retrait / une modification de source
  purge les aperçus ouverts ; le libellé indisponible est traduit dans les cartes
  actuelles. Le renderer GTK affiche maintenant ces cartes même sans session
  Rocket.Chat, condition qui empêchait leur affichage dans le lot de cache seul.
  Citations plates activées par `quotes` côté serveur et intersection des capacités
  client / serveur. Le parcours GTK sous Xvfb clique sur le menu de réponse réel,
  confirme l'envoi, inspecte les widgets de carte, supprime la source et vérifie
  aperçu purgé / mots conservés ; scripts reproductibles ajoutés à la CI native.
  Les vrais modèles Swift et le trousseau passent le scénario correspondant ; le
  fournisseur mobile passe PostgreSQL / HTTP, réponse perdue, SQLite sur disque,
  retrait et rejeu identique. Les essais sans serveur configuré ou avec mauvaise
  fixture ne sont pas utilisés comme preuves.
  Régression : 201 tests du workspace natif, 1 182 tests mobiles et 355 tests
  du workspace bureau réussis,
  typecheck / lint, export Android, Clippy et compilation GTK passent. Les contrôles
  supplémentaires de rendu / masquage sont vérifiés après ajustement. La CI du lot
  `43f2f3e` est verte (`native-server` 37063060051, `desktop-swiftui` 37063059954).
  Citations imbriquées et fichiers cités J3, messages système / emojis custom et
  qualification installée restent ouverts ; P07 n'est pas clos.
  [Contrat](protocol/QUOTES.md).

- P07, corps durables d'envoi de citations : le cœur bureau, le moteur mobile et
  le pont UniFFI sélectionnent les sources confirmées depuis le cache existant.
  La mise en file revérifie révision, génération et adhésion source / destination
  dans la transaction locale ; seules les références ordonnées voyagent vers
  le serveur. Réouverture SQLite, reset, retrait de source et retry conservent le
  corps initial. Les cartes optimistes existantes perdent l'extrait privé après
  retrait, et les anciennes intentions texte conservent leur rejeu.
  Le moteur mobile réel, HTTP / PostgreSQL et SQLite sur disque vérifient réponse
  perdue après commit, retrait, reprise sans doublon, conflit sur source éditée
  et nouvelle sélection. Aucun écran ni composant desktop / mobile n'est créé
  ou remplacé ; le raccordement aux contrôles actuels reste la prochaine étape.
  La CI `37056782968` du lot précédent a révélé une édition périmée qui perdait
  son brouillon avant mise en file. Bureau et mobile conservent maintenant cette
  intention en échec avec `revision_conflict` sans l'envoyer ; le scénario Swift
  qui échouait passe contre le serveur réel et le stockage sécurisé.
  Vérifications locales : 1 181 tests mobiles et 355 tests du workspace bureau
  réussis, sans échec ni test ignoré ; typecheck, lint, Clippy tous targets et
  compilation GTK réussis. Le test Swift réel passe après compilation neuve.
  Les objets Swift CI ont un cache distinct, sans reprise de sources différentes,
  pour éviter de réutiliser des objets après modification des bindings UniFFI.
  La capacité `quotes`, le libellé indisponible, les contrôles de réponse et les
  essais installés Android / macOS / Windows restent ouverts : ce lot ne ferme
  pas P07. [Contrat](protocol/QUOTES.md).

- P07, conservation des citations lors d'une édition : les commandes existantes
  GTK / SwiftUI / mobile capturent les références ordonnées dans SQLite avec
  leur texte, révision attendue et nonce. Retrait de la source, reset et reprise
  conservent le corps initial ; l'adaptateur l'envoie dans `content.quotes`.
  Une ancienne édition sans corps capturé s'arrête en gardant son brouillon pour
  une nouvelle soumission. Les migrations sont additives et aucune vue d'édition
  ni transport Rocket.Chat n'est remplacé. Tests ciblés : 53 mobile et 43 cache
  bureau réussis, avec source inaccessible, valeurs exactes, perte de réponse,
  réouverture SQLite et migration ; typecheck, lint et Clippy du cœur passent.
  Régression complète : 1 179 tests mobiles et 353 tests du workspace bureau
  réussis, sans échec ni test ignoré ; export Android, Clippy de tous les targets
  et reconstruction du binaire GTK réussis. Inventaire, génération du protocole
  et changelogs valides. Ces résultats locaux ne valident pas une installation
  physique des apps.
  L'envoi de citations depuis les contrôles actuels et les essais installés
  restent ouverts ; capacité `quotes` toujours désactivée.

- P07, cache mobile des citations : migration SQLite additive pour références
  ordonnées et vues sources, avec adhésion et position exacte indépendantes de
  la réponse citante. Éditions / suppressions / pertes d'accès actualisent la
  colonne `pieces_jointes` observée par le composant `Citation` existant.
  Réouverture, reset, changement de génération, rollback du curseur et réponses
  tardives sont couverts dans la vraie base. Les textes natifs ressemblant à un
  préfixe de citation Rocket.Chat sont conservés sur mobile et bureau ; le
  traitement des citations officielles reste disponible.
  Vérifications : 38 tests ciblés puis 1 176 tests mobiles complets réussis,
  sans échec ni test ignoré ; typecheck, lint et export Android / Hermes passent.
  Cœur bureau : six tests des pièces / citations et neuf tests du cache passent,
  avec Clippy sur le workspace. L'historique et les positions supérieures à la
  précision JavaScript restent intacts à la migration. Le cache ne ferme pas
  les essais physiques Android / macOS / Windows. Les libellés indisponibles,
  commandes durables de réponse / édition, citations imbriquées et fichiers cités
  restent ouverts ; la capacité `quotes` demeure désactivée.

- P07, cache bureau des citations : références ordonnées et vues sources sont
  persistées séparément dans SQLite. Les éditions / tombstones reçus d'une source
  actualisent ses citations dans les autres salons. Retrait, nouvelle adhésion et
  reset purgent ses extraits ; anciennes révisions, anciennes adhésions et résultats
  indisponibles sont arbitrés sans restaurer un texte supprimé. Une réponse HTTP
  peut actualiser la vue source sans remplacer une réponse citante plus récente.
  Les lectures de liste et sélection projettent ces données dans les cartes GTK /
  SwiftUI existantes, avec leur Markdown, sans toucher aux écrans.
  Vérifications ciblées : neuf tests du cache SQLite réussis, dont réouverture,
  rollback du curseur, retrait / réadhésion, absence datée, suppression, ordre de
  références et valeurs au-delà de la précision JavaScript ; deux tests des modèles
  UniFFI réussis, dont une source citée hors de la fenêtre d'historique et son
  tombstone dans les vrais modèles partagés. Régression complète : 351 tests du
  workspace bureau réussis, Clippy sans avertissement, binaire GTK reconstruit ;
  inventaire et changelog valides.
  Cache mobile, libellé indisponible, menus de réponse et intentions durables restent
  à raccorder ; capacité `quotes` toujours désactivée et P07 toujours ouvert.

- P07, positions de résolution des citations : extrait, adhésion source et
  position d'instance sont lus dans une seule vue SQL. Les résultats sans extrait
  portent aussi cette position ; un message source supprimé conserve la durée
  d'adhésion du lecteur, protégée par la preuve de remise. Cela fournit aux caches
  existants l'ordre nécessaire pour rejeter les extraits tardifs après suppression
  ou retrait, indépendamment de la révision de la réponse. Les valeurs restent
  exactes au-delà de la précision JavaScript et le texte est borné en caractères
  Unicode. Aucun écran ni composant de message n'est remplacé.
  Vérifications ciblées : cinq tests PostgreSQL de citations, deux protections
  de remise et huit tests du contrat Rust réussis ; Clippy du workspace serveur,
  génération des types, typecheck mobile et un test du contrat mobile passent.
  La CI native du commit `fc1d6ac` est verte (`37047824309`) : vérification serveur /
  mobile, GTK, cœur Windows et modèles Swift.
  Raccordement et purge dans les caches clients restent le point suivant ;
  la capacité `quotes` demeure désactivée.

- P07, références de citations côté serveur : commandes bornées et reçus
  incluant les références, résolution des extraits selon l'adhésion du lecteur,
  révision actuelle et durée d'adhésion de la source, effacement au tombstone.
  Le journal partagé garde les références sans extrait. Les lectures de message,
  historique, épingles / étoiles, snapshots et replay personnalisent le rendu.
  La preuve de livraison garde aussi les salons sources des extraits ; les
  transactions de citations croisées prennent les salons dans un ordre unique.
  La capacité reste désactivée jusqu'au raccordement des cartes et des caches
  existants des trois clients. [Contrat et conditions de sortie](protocol/QUOTES.md).
  Vérification locale : 199 tests du workspace serveur réussis contre PostgreSQL,
  dont citations personnalisées / journal, reçus et tombstones, citations croisées
  concurrentes et deux protections de remise des sources ; Clippy serveur et
  workspace desktop sans avertissement. Le test de cache desktop concerné par
  le DTO passe ; typecheck mobile et quatre tests du rendu natif passent. Schéma,
  types générés, emojis et inventaire ne divergent pas.
  Le contrôle CI du lot de documents `d278c3e` a exposé l'ancienne hypothèse de
  taille du scénario de snapshot ; le jeu de données inclut maintenant le coût
  du document dans le JSON, avec les mêmes budgets et refus d'un résultat partiel.
  La CI du commit `8563f22`, correction comprise, est verte : workflow serveur /
  mobile / desktop / modèles Swift `37044250870` et SwiftUI macOS `37044732568`.

- P07, documents natifs vers les renderers existants : `Message.text` reste la
  source et `body` fournit un document typé `native1`, sans arbre `md` Rocket.Chat
  ni HTML rendu dans le protocole. Les adaptateurs du fournisseur traduisent ce
  document vers les mêmes widgets GTK / SwiftUI / mobile ; aucun écran ou
  composeur n'est remplacé. Les marqueurs des composeurs existants conservent
  gras / italique / barré. Reconnaissance des mentions et présentation partagent
  le parseur, avec exclusions par occurrence, limites de profondeur / parcours,
  et repli intégral en texte brut. Quinze cas vérifient styles, code, citations
  de texte, tâches, listes imbriquées, liens, échappements, Unicode et emojis.
  Les arbres locaux bureau / mobile sont comparés exactement ; les runs du
  cœur commun servent également SwiftUI. Le vrai parcours PostgreSQL / HTTP /
  mobile vérifie le corpus, SQLite, édition, refus d'un ancien replay, effacement
  du corps dans le journal et ACL. Vérification locale : 340 tests bureau et
  1 164 tests mobiles de la suite complète, puis 2 tests de rendu bureau et
  34 tests mobiles ciblés après l'ajustement des marqueurs ; formatage / Clippy,
  typecheck / lint et export Android Hermes réussis. Les 11 cas PostgreSQL
  passent avec le corpus final. Le vrai GTK connecté au serveur montre les
  deux messages riches dans les widgets actuels à 435 px, avec document en
  SQLite et composeur contenu dans la fenêtre. Les bindings / modèles Swift
  se construisent sous Linux : 6 tests réussis et 11 sauts liés à l'environnement,
  puis le test connecté de gestion des salons réussit en 3,58 s. La qualification
  des applications installées Android / macOS / Windows reste ouverte.
  Citations de messages avec ACL,
  messages système et catalogue natif d'emojis restent la suite P07 ; réponses
  P11 / présence P12 ne sont pas annoncées par ce rendu. [Contrat](protocol/MARKDOWN.md).

- P05, contrôles de lecture existants : badges confirmés racines + réponses et
  mentions, séparateur lié à la position d'ouverture et minuteries d'ID visibles
  raccordés dans GTK / SwiftUI / mobile. La durée d'adhésion de l'écran est
  revérifiée dans la transaction SQLite ; les positions restent des chaînes
  exactes et seuls les compteurs d'affichage sont bornés. Un acquittement ne
  déplace pas la barre d'ouverture et une rafale ne repousse pas le timer.
  GTK vérifie les bounds des widgets liés, la fenêtre active et le focus dans
  le contenu ; SwiftUI suit visibilité, fenêtre au clavier et panneaux. Le
  mobile utilise les indices visibles de FlashList et ses données affichées,
  au premier plan sur la route active ; sortie / arrière-plan flush seulement
  les IDs déjà vus. Aucun retry ne substitue le dernier message du cache.
  Vérifications : 339 tests bureau, Clippy / compilation GTK Fedora ; 1 160
  tests mobiles, typecheck / lint et export Android Hermes. Les dix parcours
  PostgreSQL passent, dont le contrôleur mobile utilisé par la vue, le vrai
  fournisseur, réponse perdue, callback fermé et ancien témoin après réadhésion.
  Les bindings / modèles Swift et six tests locaux passent ; le parcours
  connecté lit un premier message en gardant le suivant non lu, conserve la
  barre et refuse les modèles antérieurs après réinvitation. Le vrai GTK vérifie
  fenêtre masquée sans lecture, position visible sauvegardée hors ligne, badges
  conservés puis effacés sur acquittement, et barre conservée. Capture à 435
  pixels inspectée. Inventaire : 318 fichiers / 443 occurrences. Les deux
  workflows du lot de lectures `0a2147b` sont verts (`37032625434`,
  `37032625413`), dont les nouvelles vues SwiftUI sur macOS ; qualification
  des applications installées ouverte. Réponses P11 et `@here` P12 restent leurs
  lots suivants.

- P05, favoris dans les interfaces existantes : GTK et SwiftUI proposent l'action
  dans la fiche et le menu du salon ; le mobile conserve le bouton de sa fiche.
  Le fournisseur actif utilise le protocole natif ou la route Rocket.Chat
  officielle. Seul l'état personnel confirmé change le classement. Le clic
  capture révision de favori et durée d'adhésion, vérifiées dans la transaction
  SQLite avant création d'une intention. Reprendre conserve l'ID original ; un
  refus exige l'effacement de cet ID exact. GTK garde sa fiche mise en cache hors
  ligne pour présenter la demande, sans rétablir d'anciennes métadonnées.
  Vérifications : 336 tests bureau, formatage / Clippy et compilation GTK Fedora ;
  1 153 tests mobiles, typecheck / lint et export Android Hermes. Les dix parcours
  PostgreSQL passent, dont le fournisseur mobile appelé par le bouton, avec
  perte des réponses HTTP et récupération sans seconde écriture. Les bindings
  Swift compilent, six tests locaux passent et le parcours connecté avec Secret
  Service vérifie attente hors ligne, confirmations et rejet d'un ancien clic.
  Le vrai binaire GTK vérifie menu, attente visible, ajout / retrait confirmés et
  refus du clic obsolète ; la fiche à 435 pixels est inspectée. Inventaire :
  315 fichiers / 443 occurrences. Après correction de l'affectation de l'erreur
  du favori dans la vue SwiftUI, les deux workflows `49a88dd` sont verts
  (`37025290486`, `37025290897`), dont la compilation macOS des vues. Les essais
  sur appareils restent ouverts. Le raccordement suivant des badges, séparateurs
  et minuteries est consigné dans l'incrément ci-dessus.

- P05, buffers des salons ouverts : les composeurs GTK / SwiftUI / mobile
  attachent lecture, sauvegarde, effacement et envoi de brouillon à la durée
  d'adhésion qui les a ouverts. Le contrôle et l'écriture SQLite sont atomiques.
  Retrait ou nouvelle adhésion effacent les buffers / formulaires privés ; un
  ancien cleanup ne peut écraser le nouveau brouillon. Les changements de rôle
  conservent le texte. Le mobile attend sa première lecture du témoin avant de
  monter le composeur ; GTK et Swift ferment les vues dont le témoin a changé.
  Vérifications : 335 tests bureau complets, Clippy / compilation Fedora et dix
  tests unitaires ciblés du dernier garde ; 1 152 tests mobiles, typecheck / lint
  et export Android Hermes. Les dix parcours PostgreSQL passent, dont le vrai
  dépôt mobile conservé après retrait / réadhésion manqués. Le parcours GTK
  existant vérifie rôle / brouillon puis départ / composeur vide. Les bindings
  et modèles Swift compilent, six tests locaux passent ; le parcours connecté
  avec Secret Service vérifie réinvitation et rejet des anciens saves / sends.
  Inventaire : 312 fichiers / 414 occurrences. Les quatre jobs du lot durable
  `2eb3ecb` sont verts (`37014714087`). Badges, favoris et minuteries des interfaces
  existantes restent à raccorder ; les essais sur appareils restent ouverts.

- P05, intentions durables mobile / bureau : SQLite conserve la position du
  message confirmé réellement observé, puis regroupe les observations par
  maximum exact. Le favori garde son ID, sa révision attendue et sa valeur
  originale ; après réponse perdue le runner lit son reçu avant tout PUT.
  Un reçu confirmé reste sauvegardé jusqu'à une lecture actuelle couvrant sa
  version, sans rétablir une préférence historique. Les formes refusées exigent
  l'effacement de leur ID exact ; retrait / nouvelle adhésion ou génération
  purgent les deux queues. Les délais de lecture et de favori sont séparés : le
  quota de lecture conserve socket, envois et favoris disponibles.
  Vérifications : 332 tests bureau complets, puis quatre parcours HTTP / SQLite
  ciblés, Clippy et compilation GTK Fedora ; 1 149 tests mobiles complets puis
  quatre parcours réseau ciblés (dont un nouveau), typecheck / lint et export
  Android Hermes. Les dix parcours PostgreSQL passent : le runner mobile réel
  manque deux réponses, récupère les reçus sans seconde écriture, conserve un
  message ultérieur non lu et purge ses queues après réadhésion. Inventaire :
  310 fichiers / 414 occurrences. Les quatre jobs CI du cache `19871f0` sont
  verts (`37009882605`). Boutons, badges, timers et nettoyage des buffers ouverts
  des interfaces existantes restent à raccorder avant activation des capacités.

- P05, cache confirmé mobile / bureau : SQLite sépare versions des métadonnées
  et de l'état personnel. Les nouvelles lectures ne font pas reculer le nom du
  salon ni invalider ses droits ; les réponses anciennes ne restaurent aucun
  favori. Le témoin d'adhésion détecte également un retrait / une réadhésion
  manqués, purge l'ancien contenu privé / brouillons / intentions et invalide
  les réponses en vol. Un rôle modifié conserve la durée d'adhésion. Le premier
  témoin purge les intentions d'un cache ancien qui n'en possédait pas ; le
  bureau récupère les témoins déjà présents dans ses anciens payloads de salon.
  Vérifications : 322 tests bureau et Clippy / compilation GTK dans Fedora ;
  1 138 tests mobiles complets puis huit cas ciblés (dont un nouveau), typecheck
  / lint et export Android Hermes. Les dix parcours de lectures et les quinze parcours natifs / salons
  existants contre PostgreSQL passent, avec vraie migration / base SQLite mobile,
  snapshot après retrait / réadhésion manqués et rejet d'une réponse antérieure.
  Inventaire : 308 fichiers / 414 occurrences. La CI du serveur / transports
  P05 `c4a9f95` a ses quatre jobs verts (`37006738251`). Les files durables de
  lecture / favori et les contrôles existants restent le prochain incrément.

- P05, mentions côté serveur : pseudos exacts des adhérents actifs résolus lors
  du premier envoi, `@all`, répétitions dédupliquées et priorité de la mention
  nominative sur le groupe. Code, citations, liens, échappements et noms encodés
  ne déclenchent aucun faux destinataire. Une édition retire les mentions
  supprimées sans notifier un nouveau destinataire ; lecture / suppression et
  réadhésion retirent les anciens badges. `@here` dépend des baux de présence
  P12 et reste du texte jusqu'à ce lot. Vérifications : 186 tests du workspace
  natif passent, dont six cas Markdown et dix parcours de lectures PostgreSQL /
  HTTP. Le vrai transport mobile exerce également mentions, édition et lecture.
  Le quota de 60 avancements réels conserve lectures / favoris disponibles.
  Contrôleurs durables et raccordement aux interfaces existantes P05 restent ouverts.

- P05, premier lot serveur / transports : états personnels attachés aux salons
  après contrôle des destinataires / adhésions, sans données privées dans le
  journal partagé. Lectures par maximum sur deux appareils, compteurs de racines
  excluant l'envoi propre et diminuant à la suppression, favoris explicites avec
  révision indépendante et reçus personnels. Retrait / réadhésion renouvelle la
  durée d'adhésion et purge la préférence ; un rôle modifié ne la renouvelle pas.
  Les anciens reçus ne restaurent aucune préférence. Six scénarios PostgreSQL /
  HTTP passent, dont le transport mobile réel avec réponse perdue et récupération
  du reçu sans seconde écriture. Le workspace natif complet passe ses 175 tests,
  puis le sixième scénario dédié ajouté passe également (176 au total).
  Les 1 131 tests mobiles, typecheck / lint, et les 314 tests bureau, Clippy /
  compilation GTK dans Fedora passent ; schéma / types et inventaire reproductibles.
  Les mentions, contrôleurs durables et UI P05 restent ouverts ; capacités clientes
  encore masquées et réponses réservées à P11. [Contrat](protocol/READ_STATE.md).

- P04, composeurs existants : GTK / SwiftUI / mobile utilisent le droit effectif
  `send`, avec exception des propriétaires / modérateurs dans un salon en lecture
  seule. Les fiches gardent le réglage global. SQLite lie ces indications au
  compte, à la génération et à la version du salon ; une nouvelle version les
  invalide. Retrait / réadhésion et réponses tardives ne restaurent aucun droit.
  Les lectures concurrentes sont regroupées et les drafts / intentions d'envoi
  existants restent durables. Le serveur demeure l'autorité de chaque envoi.
  Vérifications : 314 tests bureau, formatage / Clippy / binaire GTK, 1 128 tests
  mobiles complets puis trois cas ciblés de droits (dont un nouveau), typecheck /
  lint et export Android Hermes. Six tests locaux Swift et le parcours connecté
  PostgreSQL / Secret Service passent : membre bloqué, propriétaire autorisé,
  promotion puis rétrogradation actualisant le composeur. Le fournisseur mobile
  réel / PostgreSQL vérifie aussi refus HTTP du membre et envoi du modérateur.
  GTK exécute le même passage propriétaire / membre dans le formulaire et le
  composeur réels, puis transfert / départ et purge, à 435 pixels ; sa capture
  est inspectée.
  Le développement P04 est terminé ; les qualifications des applications
  installées restent ouvertes. Le prochain lot est P05, lectures / non-lus,
  mentions et favoris personnels de salons. La CI macOS du lot `a4df1fd`
  (`37000328250`) et ses quatre jobs natifs (`37000328247`) sont verts.

- P04, contrôles dans les fiches existantes : mobile / GTK / SwiftUI exposent
  les réglages, la liste paginée des membres, les rôles et le départ selon les
  droits actuels et capacités du fournisseur. Les formulaires conservent leur
  révision ; reprise d'une commande originale, effacement explicite d'un refus
  et relecture des droits avant révision du formulaire sont accessibles.
  Aucun identifiant d'opération n'est affiché. Les parcours Rocket.Chat restent
  sélectionnés par leur fournisseur. P04 reste ouvert pour les droits effectifs
  de rédaction dans les composeurs, déjà imposés côté serveur.
  Vérifications locales : 312 tests bureau, formatage / Clippy / binaire GTK,
  1 126 tests mobiles, typecheck / lint sans avertissement et export Android
  Hermes. Les bindings / modèles Swift compilent ; six tests locaux passent,
  onze restent conditionnés à leurs bancs. Le nouveau parcours Swift connecté
  passe avec PostgreSQL et Secret Service réels : réglages, promotion d'un
  deuxième propriétaire, rétrogradation et départ, refus du dernier propriétaire
  et effacement explicite. Le fournisseur mobile réel reprend un reçu après
  perte de réponse sans second PATCH contre PostgreSQL. GTK exécute les réglages,
  rôles, transfert / départ et refus du dernier propriétaire à 435 pixels ; les
  captures sont inspectées. Les applications installées restent à qualifier.

- P04, intentions de réglages / rôles / départ : SQLite sauvegarde la commande
  originale avant HTTP sur bureau et mobile, puis consulte le reçu personnel
  avant chaque reprise. Une réponse perdue et un redémarrage ne réappliquent pas
  la mutation ; les révisions ne sont jamais réactualisées silencieusement.
  Les refus définitifs gardent le formulaire jusqu'à effacement explicite ; les
  erreurs temporaires utilisent le backoff existant. Retrait / changement de
  génération purgent les intentions privées ; un reçu ne projette aucun réglage.
  Les trois commandes sont vérifiées avec vrai HTTP et bases SQLite sur disque,
  plus conflits, reçus étrangers, erreurs de lecture, retrait et fermeture.
  Vérifications : 312 tests bureau, Clippy / formatage, 1 124 tests mobiles,
  typecheck / lint sans avertissement et inventaire Rocket.Chat à jour.
  Les contrôles des trois fiches restent le lot suivant : leurs capacités de
  mutation sont encore masquées. Les CI des fiches `6a081df` sont entièrement
  vertes : quatre jobs natifs (`36988516194`) et macOS (`36988516235`).

- P02, dernier raccordement de récupération e-mail : les formulaires existants
  mobile / GTK / SwiftUI proposent une demande anonyme et une reprise explicites.
  Ouverture et countdown n'effectuent aucun appel réseau ; le reçu générique ne
  prétend pas confirmer l'existence du compte ou la livraison. Une demande expirée,
  acquittée ou liée à une ancienne génération reste conservée jusqu'à son
  effacement local explicite. Le code reçu / nouveau mot de passe utilisent le
  parcours de récupération déjà livré, suivi de la double authentification normale.
  GTK et Swift partagent le nouveau coordinateur `Form`, avec candidat privé,
  révisions de vue et annulation des actions tardives ; aucun nonce traverse FFI.
  Vérifications : 306 tests bureau, formatage / Clippy / binaire GTK, six tests
  locaux Swift, 1 113 tests mobile, typage / lint sans avertissement et export
  Android Hermes. Dix tests Swift connectés restent conditionnés à leurs bancs.
  Le formulaire GTK et le vrai Secret Service sont exécutés deux fois contre une
  fixture HTTP jetable : ouverture sans POST, demande explicite unique et anonyme,
  aucun compte activé ; les captures à 435 pixels sont inspectées. Cette fixture
  ne constitue pas un essai SMTP / PostgreSQL, déjà couvert côté serveur.
  Les trousseaux installés Android / Windows / macOS et SMTP externe restent à
  qualifier avec les appareils / accès nécessaires. La CI du lot de coffres
  `cd69389` (`36975796250`) est entièrement verte (quatre jobs).
  Le développement fonctionnel e-mail est clos pour ce stade ; le prochain lot
  est P04, rôles et paramètres serveur / salon. Pas de nouveau lot SMTP prévu.

- P04, fiches de salon existantes : lectures neutres dans le fournisseur mobile,
  modèle `RoomInfo` partagé GTK et binding `RoomDetails` SwiftUI existant.
  Sujet, description, annonce, nombre de membres et lecture seule sont affichés
  sans nouvel écran de chat. L'annonce `room_info` est intersectée avec le client ;
  les favoris natifs restent masqués jusqu'à P05. Le propriétaire conserve son
  formulaire GTK d'invitation. Les changements de révision rafraîchissent les
  fiches, y compris un sujet modifié sans changement de nom. Fermeture du compte,
  retrait du salon et génération remplacée écartent les réponses tardives.
  Vérifications : 307 tests bureau, Clippy / binaire GTK, 1 118 tests mobiles,
  typecheck / lint sans avertissement et export Android Hermes frais. Bindings /
  modèles Swift compilés : six tests locaux passent, dix parcours conditionnés
  à leurs bancs ; le parcours connecté des modèles existants passe contre le
  vrai PostgreSQL et Secret Service, avec modification de sujet sur un autre
  appareil. GTK rend la fiche à 435 pixels, actualise le sujet pendant son
  ouverture puis ferme le dialogue après retrait du lecteur ; les trois captures
  sont inspectées. Le banc est jetable, les trousseaux installés Android / Windows
  / macOS restent à qualifier. Les commandes durables et contrôles de paramètres,
  rôles et départ sont le prochain lot P04. Le socle précédent `fcb411d` a ses
  quatre jobs CI verts (`36984189328`).

- P04, détails / rôles / paramètres côté serveur et transports : migration 0022,
  métadonnées bornées, liste des membres paginée et révision opaque indépendante
  des messages. Les propriétaires règlent visibilité / lecture seule / textes
  et rôles ; transfert explicite et départ protègent le dernier propriétaire.
  L'administrateur n'a aucun accès privé implicite. Les commandes originales
  disposent de reçus personnels, également après rétrogradation / départ, sans
  rejouer un ancien réglage ou supprimer une réadhésion. Les invitations, retraits
  et adhésions publient maintenant une révision fraîche pour tous les membres.
  Les snapshots concernés sont invalidés et la livraison des détails / membres
  retient sa version jusqu'à soumission réelle du corps HTTP. Vérifications :
  170 tests du workspace natif, dont huit scénarios PostgreSQL / HTTP dédiés
  et un test de livraison obsolète ; le vrai transport TypeScript exerce transfert,
  rétrogradation et reçu après départ contre ce serveur. 1 116 tests mobiles,
  typecheck / lint, 306 tests bureau et Clippy passent. Schéma / types / inventaire
  sont vérifiés. [Contrat et limites P04](protocol/ROOMS.md). Le raccordement
  durable aux trois écrans existants reste le prochain lot ; P04 reste ouvert.
  Le lot e-mail précédent `2b46b48` a ses deux CI entièrement vertes : native
  `36979565276` (quatre jobs) et macOS `36979565203`.

- P02, coffres de demande de récupération e-mail : le coordinateur Rust commun
  GTK / Swift et le coffre mobile conservent l'opération originale avant HTTP,
  sans code reçu / mot de passe / adresse / bearer. Namespace privé par URL et
  pseudo, scope d'instance / génération, délai local conservateur d'une heure,
  acquittement générique et fermeture locale protégée contre les anciennes vues.
  Lire ne fait aucun envoi ; une réponse ambiguë reprend le même candidat et une
  demande expirée n'est jamais remplacée automatiquement. Le verrou OS bureau
  reste détenu par l'écriture réelle du trousseau après annulation de l'appelant.
  Le mobile utilise SecureStore et une file commune aux instances du coffre.
  Le `Retry-After` reçu reste conservé après recréation du coffre ; le SDK Rust
  partage aussi ce cooldown entre clones en laissant la découverte disponible.
  Douze nouveaux tests Rust et douze TypeScript passent, ainsi que les 303 tests
  bureau, Clippy, 1 113 régressions mobile, typecheck et lint. L'inventaire est
  régénéré : 296 fichiers parcourus / 344 occurrences. Les boutons de
  demande GTK / SwiftUI / mobile et leurs parcours connectés restent à raccorder.

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
  délivrabilité extérieure ni un trousseau installé. La CI native `36971804421`
  du commit `be42f85` passe ses quatre jobs, y compris les bancs connectés GTK /
  Swift / mobile existants. Le PostgreSQL de tests est supprimé après vérification.

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
