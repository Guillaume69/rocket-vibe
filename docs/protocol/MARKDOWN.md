# Rendu natif dans les clients existants — P07

Les interfaces GTK / SwiftUI / mobile restent celles du client existant. Le
fournisseur Rocket.Chat conserve son normaliseur et son rendu historiques.
Le fournisseur RocketVibe adapte les données natives aux mêmes widgets ; aucun
nouvel écran, thème, composeur ou client n'est introduit par ce lot.

## Texte et document

`Message.text` reste la source. Le champ additif optionnel `body` contient un
`Document` de format `native1`, avec des nœuds typés : texte, styles, code,
paragraphes, titres, citations de texte, listes / tâches, liens, mentions et
codes d'emoji. Le protocole n'expose pas d'arbre `md` Rocket.Chat ni de HTML rendu.
Le serveur calcule le document depuis la source ; envoi et édition n'acceptent
aucun document de présentation ni droit fourni par le client.

Le parseur utilise la structure CommonMark de `pulldown-cmark`, les listes de
tâches et le barré. Les conventions des composeurs existants priment pour les
styles : `*gras*` / `**gras**`, `_italique_` / `__italique__`, `~barré~` /
`~~barré~~`. Les marqueurs présents dans le code restent littéraux. Les titres
sont projetés vers les quatre tailles déjà présentes dans les widgets.

Le document est traduit aux frontières Rust / TypeScript vers les modèles de
présentation existants. Le cœur commun sert GTK et les runs SwiftUI / UniFFI.
SQLite conserve le document ou sa projection avec la révision du message ; une
réponse ancienne ne remplace pas une édition. Le bureau reparcourt la source
avec le parseur natif pour les anciens caches ou messages sans document. Le
mobile conserve son repli historique pour un ancien serveur qui omet `body` et
les messages optimistes antérieurs à la confirmation.

## Contextes et bornes

La reconnaissance des mentions pour le rendu et les notifications utilise le
même parseur. Code, citations, labels / destinations de liens, images, URL
brutes, adresses email et échappements ne déclenchent pas de mention. Une
occurrence normale ne rend pas active une occurrence identique dans une
citation ou un lien. La résolution des destinataires actifs et la politique
d'édition restent celles de [P05](READ_STATE.md). `@here` reste littéral jusqu'à
P12. Les mentions de salons sont textuelles ; les profils / références résolues
restent leurs lots de parité suivants.

HTML et images Markdown conservent leur texte littéral. Un URL d'image tiers ne
reçoit aucune requête authentifiée par ce rendu. Les renderers existants filtrent
les liens externes ; une destination `javascript:` n'exécute rien. Un permalien
sans citation native résolue reste visible, au lieu de masquer sa source.
Les emojis standard utilisent le catalogue local existant ; un code custom
inconnu reste lisible. Ce document n'active pas le catalogue custom / fichiers.

Les sources restent limitées à 32 768 octets. Le parseur borne sa profondeur à
32 et son parcours à 4 096 événements ; au-delà, il conserve toute la source en
texte brut. Cette présentation ne crée pas de mention active. Le validateur
mobile vérifie les discriminateurs avant les enfants et borne sa récursion,
pour refuser les arbres hostiles sans parcourir des alternatives impossibles.
Les documents entrent dans les budgets existants de journal / snapshot / lot.

## Vérification et suite

[Corpus natif partagé](native-rendering.fixture.json) : quinze cas traversent le
parseur Rust, le document sérialisé, les modèles de présentation bureau et mobile,
les paragraphes GTK et les runs utilisés par SwiftUI. Les arbres locaux sont
comparés exactement, avec contrôles indépendants du texte et des styles du
composeur. Le vrai serveur HTTP / PostgreSQL et le transport mobile exercent
le même corpus, SQLite, édition, ancien replay, suppression du corps dans le
journal et refus d'un compte hors salon. La limite de profondeur et le volume
d'une source dense sont vérifiés séparément.

Le binaire GTK connecté au serveur PostgreSQL est également vérifié dans une
fenêtre de 435 px : deux messages riches atteignent les widgets actuels, le
document est conservé en SQLite et le composeur tient dans la fenêtre. Les
bindings / modèles Swift se construisent sous Linux et leur test connecté de
gestion des salons passe avec ce contrat. Le bundle Android Hermes est exporté.

La qualification des applications installées Android / macOS / Windows reste
ouverte. Les [références de citations et extraits par lecteur](QUOTES.md) sont
livrés côté serveur ; leur raccordement aux cartes existantes, les messages
système structurés et le catalogue natif d'emojis restent P07. Les citations
de messages ne sont pas remplacées par les citations de texte Markdown.
