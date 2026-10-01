# P02 — e-mail vérifié, SMTP et récupération

## État réel

Le transport `apps/server/src/mail.rs` est livré : relais SMTP avec STARTTLS
obligatoire ou TLS implicite, configuration privée montée, modèles de message
texte bornés, quatre envois simultanés au plus et échéance totale de 30 secondes.
L'absence de configuration laisse ce transport désactivé. Il ne déclenche aucun
envoi et ne publie aucune capacité e-mail à lui seul.

Les adresses vérifiées, défis e-mail, file durable, routes / SDK et formulaires
restent à implémenter. La présence de `SecondFactor::Email` dans les types et de
`FactorStatus.email=false` ne signifie pas que ce parcours soit disponible.

## Configuration du transport

`RV_SMTP_CONFIG_FILE` désigne un fichier JSON régulier de 16 Kio au plus. Sous
Unix il doit être privé, par exemple mode 600 ; les liens symboliques sont
refusés. Le chargement échoue avec un message fixe si un champ est invalide,
sans afficher le contenu ou les identifiants. Exemple sans secret réel :
[`docker/smtp.example.json`](../../docker/smtp.example.json). La copie locale
`docker/smtp.json` est exclue de Git et du contexte de construction Docker.
Monter le fichier en lecture seule et fournir son chemin dans le conteneur.

`tls` accepte `starttls` ou `implicit_tls`. Choisir le port de ce service
(habituellement 587 / 465) ; aucune option de TLS opportuniste ou de suppression
de validation des certificats n'est proposée. `username` et `password` sont
présents ensemble ou absents ensemble pour un relais ne nécessitant pas de login.
`from` est une adresse seule, sans nom affiché ni en-tête additionnel.

Le transport utilise [lettre 0.11.23](https://docs.rs/lettre/0.11.23/lettre/transport/smtp/struct.AsyncSmtpTransport.html)
avec Tokio / rustls et sans traces SMTP. Les diagnostics bruts du relais ne sont
jamais propagés : ils peuvent inclure destinataire ou contenu privé. Le travail
réel possède son permis même si l'appel HTTP qui l'attend est annulé. Une erreur
ou échéance rend `mail_delivery_unconfirmed` : la livraison peut déjà avoir eu
lieu. Il faudra reprendre le même contenu depuis la file, sans créer un nouveau code.

## Contrat de la suite du chantier

1. **Adresse privée vérifiée.** Le compte actif confirme son identité sur la
   famille existante avant d'ajouter / changer une adresse. Un défi confirme
   l'accès à la nouvelle boîte. L'adresse n'entre pas dans l'annuaire public.
   Les tokens restent liés à UID, instance, génération, version d'autorité et
   opération initiale. Une réponse perdue reprend le reçu original. Changement
   d'adresse ou d'autorité rend les anciens défis inutilisables.
2. **File SMTP durable.** Enregistrer un défi et son message dans la même
   transaction. Chiffrer les codes et charges de livraison avec la clé opérateur
   hors PostgreSQL. Les workers revendiquent des lots bornés avec un lease,
   vérifient expiration / autorité, puis font SMTP hors des verrous métier.
   Les retries renvoient le même code jusqu'à son échéance ; pas de transaction
   de conversation suspendue en attendant SMTP. Le journal d'exploitation ne
   contient ni code, corps, adresse complète ni credentials.
3. **Défi e-mail explicite.** Le serveur propose cette méthode seulement avec
   adresse vérifiée et configuration adéquate. L'utilisateur la choisit ; pas
   de repli implicite depuis TOTP. Bornes d'envoi / essais / durée persistent
   après restart et s'appliquent par compte, défi, adresse et IP. Le candidat
   privé et la preuve commitée suivent les mêmes règles que TOTP / secours.
4. **Récupération du mot de passe.** La demande anonyme fournit une réponse
   uniforme et des quotas, sans révéler l'existence du compte ou de sa boîte.
   Seule une adresse déjà vérifiée reçoit le code. La confirmation conserve UID,
   conversations et clés E2EE, révoque les anciennes familles et garde les
   facteurs existants. Elle reprend le mécanisme de récupération actuel ; elle
   ne crée pas de session et ne dispense pas du second facteur au login suivant.
5. **Clients existants.** Ajouter ces actions aux paramètres et formulaires
   actuels mobile / GTK / SwiftUI avec capacités additives. Coffres privés par
   portée, saisies transitoires, sortie / suspension / changement de compte
   bloquant les callbacks, reprise originale après ACK perdu. Les écrans
   Rocket.Chat continuent leur propre parcours.

## Qualification

Cinq tests du transport couvrent la configuration et les injections d'en-tête,
fichier privé / symlink / taille, refus d'un relais sans STARTTLS avant tout
credential / destinataire / contenu, un vrai échange SMTP sur loopback et
annulation conservant le permis du travail réel. Le relais en clair n'existe
que dans la construction privée de ces tests.

Il reste à qualifier un vrai échange TLS et ses certificats, la file après
restart / réponse SMTP perdue, les expirations / quotas et les concurrents,
les trois parcours clients, puis le relais réel avec accès opérateur. Un test
SMTP loopback ne valide pas la délivrabilité d'un fournisseur extérieur.
