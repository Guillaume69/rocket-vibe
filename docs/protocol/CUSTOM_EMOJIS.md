# Catalogue d'emojis personnalisés — P07 / J3

Le fournisseur RocketVibe utilise les mêmes sélecteurs, complétions, corps de
messages et réactions que Rocket.Chat. Le catalogue est propre à l'instance et
à sa génération ; il ne donne aucun droit sur un salon. La capacité additive
`custom_emojis` est intersectée avec les adaptateurs effectivement installés.

## Administration et images

La CLI opérateur travaille sur la base et le volume configurés pour le serveur :

```sh
rv-server emoji list
rv-server emoji put party_parrot ./parrot.gif --alias vibe_parrot --operation-id import-parrot
rv-server emoji put party_parrot ./replacement.png --alias vibe_parrot --revision 1 --operation-id replace-parrot
rv-server emoji remove party_parrot --revision 2 --operation-id remove-parrot
```

Les révisions des exemples sont à remplacer par celles de `emoji list`.
Une création peut omettre `--revision` ; un remplacement ou retrait exige la
révision courante. Les reçus persistants et le journal opérateur sont partagés
avec l'administration existante. Rejouer une ancienne création après un retrait
renvoie son reçu sans restaurer l'entrée. Réutiliser un ID pour une autre demande
ou une autre génération échoue.

Limites : 512 entrées, huit alias par entrée, noms ASCII minuscules de 1 à 80
caractères (`a-z`, chiffres, `_+-`). Noms et alias sont uniques ; les codes Unicode
standard sont réservés. Chaque image tient dans 1 Mio et 256 × 256 pixels.
PNG et JPEG sont décodés et normalisés en PNG. Les GIF sont conservés après
validation de chaque frame, avec un maximum de 128 frames et 4 Mio de pixels
décodés. SVG, images tronquées et dépassements sont refusés avant publication.

Les objets immuables sont dans le volume privé existant. Leur identifiant opaque
est distinct de leur SHA-256 ; la collecte conserve les images référencées par le
catalogue. Une sauvegarde doit inclure la base et ce volume.

## Lectures et mises à jour

`GET /api/v1/emoji` renvoie `EmojiCatalog { revision, items }`. Chaque `CustomEmoji`
porte ID, nom, alias, ID d'objet, SHA-256, MIME, taille et révision. Tailles et
révisions sont des décimaux exacts. `GET /api/v1/emoji/files/{id}` exige une session
active et une référence courante dans le catalogue ; la lecture garde les preuves
d'authentification jusqu'à la livraison de ses octets. MIME, taille et empreinte
sont vérifiés ; les réponses d'image sont `no-store` et `nosniff`.

Le live annonce `emoji_catalog_revision`, y compris lors d'un état limité. Ce
champ est une indication de revalidation. Une révision plus récente retire les
anciens noms et images pendant que le catalogue authentifié est relu. Les caches
SQLite conservent ce plancher même après redémarrage ; une réponse plus ancienne
ne peut pas rétablir les entrées. Une nouvelle génération purge ce cache.

Les lecteurs exposent des handles `rv-emoji:` au rendu. Le transport du
fournisseur porte le bearer et refuse les redirections. Le cache d'octets est
volatile et borné ; changement de compte, retrait et réponse tardive sont gardés.
Le rendu mobile utilise PNG / GIF locaux et la prise en charge GIF existante ;
GTK et SwiftUI conservent leurs composants d'image et leur comportement actuel.
Le rendu animé et le comportement sur appareils installés restent à qualifier.

Les réactions résolvent un alias vers le nom canonique avant de persister leur
intention. Le reçu est recherché avant de consulter le catalogue courant : une
confirmation perdue reste rejouable après remplacement d'alias ou suppression.
Une réaction existante peut encore être retirée par son nom canonique après la
suppression de l'emoji ; une nouvelle réaction sur ce nom est refusée.

## Vérification

Les tests PostgreSQL exercent import, remplacement, retrait, conflits, reçus,
images privées et réactions. Les caches mobiles et Rust vérifient planchers
supérieurs à `2^53`, rollback, génération, téléchargement tardif et reprise.
Le banc de fichiers existant importe une petite image avec
`apps/server/scripts/seed-test-emoji.sh`, puis exerce le widget GTK et les modèles
Swift. Les validations Android et macOS installés demeurent ouvertes ; ce lot ne
ferme pas globalement P07 ni J3.
