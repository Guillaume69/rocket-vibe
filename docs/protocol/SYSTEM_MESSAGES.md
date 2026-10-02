# Activité structurée des salons — P07

Le champ additif `Message.system` décrit une action du serveur. Il est absent
des messages ordinaires et des anciennes réponses v1. Il contient un `kind`
typé et les seules données nécessaires : nom, sujet, description, annonce,
confidentialité, lecture seule, utilisateur cible et rôles avant / après.
La création, l'arrivée, le départ, l'ajout et le retrait de membres sont couverts.
Les futures activités de fichiers, appels et administration suivront leurs lots.

L'auteur de la ligne reste le compte qui a réalisé l'action. Aucune phrase
traduite, aucun arbre Markdown et aucun identifiant de type Rocket.Chat ne
voyagent dans ce champ. `SendMessage` refuse ce champ ; le client ne peut pas
créer une activité serveur en envoyant du texte. La base impose texte vide,
absence de références citées et absence de tombstone pour ces lignes.

La ligne, sa position et son événement de journal sont écrits dans la transaction
du changement de salon. Les reçus de commandes et les opérations sans changement
évitent les doublons. Une mise à jour de plusieurs champs produit une ligne par
champ modifié ; un conflit de révision annule toute la transaction. Les événements
de ces lignes et les pages d'historique utilisent les mêmes ACL que les messages.
Un membre retiré reçoit le retrait du salon, sans l'activité privée qui suit.

Ces lignes ne créent ni non-lus, ni mentions, ni séparateur de nouveaux messages.
Elles n'acceptent ni édition, ni suppression, ni réaction, ni épingle, ni étoile,
ni sélection comme source de citation. Les lectures peuvent avancer au-delà
d'une activité visible sans transformer cette activité en message non lu.

Les adapters convertissent les données vers les lignes système existantes,
avec leur auteur et leur paramètre. SQLite conserve cette projection dans la
transaction de synchronisation. Le cœur bureau sert GTK et UniFFI / SwiftUI ;
le mobile utilise `texteSysteme`. Français et anglais sont disponibles. Les
événements Rocket.Chat continuent à passer par leur normaliseur historique.

Le scénario HTTP / PostgreSQL vérifie les rejeux, conflits, tentatives de
falsification, actions refusées, compteurs, synchronisation et retrait privé.
Les tests de projection vérifient les lignes et leur traduction. Le banc GTK
inspecte la ligne dans le widget existant ; le banc Swift exerce les modèles
partagés contre le serveur et le stockage sécurisé. La qualification visuelle
des applications installées Android / Windows / macOS reste ouverte.
