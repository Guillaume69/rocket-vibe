# Cartes d'intégration natives — P15

`SendMessage.cards` et `Message.cards` portent des pièces jointes structurées.
Une intégration utilise une session normale et `POST /api/v1/rooms/{room}/messages` :
elle doit appartenir au salon et avoir le droit d'y écrire. Aucun webhook
anonyme, rôle privilégié implicite ou marketplace n'est ajouté.

```json
{
  "operation_id": "integration-build-42",
  "text": "",
  "cards": [{
    "author": "CI",
    "title": "Build terminé",
    "url": "https://example.org/build/42",
    "text": "Le paquet est disponible.",
    "color": "#1177aa",
    "fields": [{"title": "Commit", "value": "abcdef", "short": true}]
  }]
}
```

Trois cartes et 16 Kio de JSON au total ; douze champs par carte. Limites UTF-8 :
auteur 256 octets, titre 512, texte 8 192, libellé de champ 128, valeur 2 048,
lien 2 048. Les liens sont HTTP(S), avec hôte, sans userinfo ni contrôles.
La couleur est `#rrggbb`. Les propriétés non reconnues sont refusées ; aucune
image distante, action exécutable ou balise HTML interprétée n'est transportée.
Un titre, du texte ou des champs sont nécessaires. Le texte du message peut
être vide lorsque des cartes sont présentes.

Les cartes entrent dans l'empreinte de l'intention. Une répétition identique
rend le message courant ; un changement de carte sous le même identifiant
est un conflit. Une édition du texte conserve les cartes. La suppression
efface leur JSON et réécrit les anciens événements avec le tombstone courant.
Un index GIN distinct permet de rechercher leur contenu sans modifier l'index
du texte ; les mêmes droits et limites de recherche s'appliquent.

Les projections SQLite et les résultats temporaires de recherche utilisent
les pièces jointes existantes. Les actualisations des citations conservent
les cartes du message. Le cœur GTK fournit le renderer déjà présent ; le
modèle UniFFI ajoute couleur et champs à la carte SwiftUI existante. Mobile
complète le rendu des pièces jointes dans la ligne actuelle, avec les styles
et le renderer Markdown existants. Ces présentations acceptent aussi les
cartes structurées Rocket.Chat dans leur fournisseur actuel.

Vérifications : validation du contrat, droits / rejeu / recherche / édition /
effacement HTTP et PostgreSQL, fournisseur mobile réel avec SQLite et recherche,
rollback et retrait du salon dans les caches, projection UniFFI et widget GTK.
Les modèles Swift compilent localement ; l'interface AppKit est vérifiée par
la CI macOS. L'export Android / Hermes ne qualifie pas une application installée.
