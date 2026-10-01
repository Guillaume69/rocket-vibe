# P02 — e-mail vérifié, SMTP et récupération

## État réel

Le transport `apps/server/src/mail.rs` est livré : relais SMTP avec STARTTLS
obligatoire ou TLS implicite, configuration privée montée, modèles de message
texte bornés, quatre envois simultanés au plus et échéance totale de 30 secondes.
La migration 0016 et les routes privées permettent au compte actif de vérifier
une adresse. Le défi et sa charge chiffrée sont enregistrés ensemble dans
PostgreSQL ; le worker reprend leur livraison après restart. Les SDK Rust et
TypeScript exposent le parcours. La capacité additive `email_verification` est
annoncée seulement avec transport SMTP et clé opérateur configurés.

Les formulaires mobile / GTK / SwiftUI, le retrait d'une adresse, le second
facteur e-mail et la récupération par e-mail restent à implémenter. La présence
de `SecondFactor::Email` dans les types et de `FactorStatus.email=false` ne
signifie pas que ces deux dernières opérations soient disponibles.

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
Le champ facultatif `ca_file` permet d'ajouter un certificat d'autorité PEM
monté en lecture seule : fichier régulier sans symlink, de 1 Mio au plus.
Le certificat du relais doit toujours correspondre au nom configuré ; aucune
option ne désactive cette validation. Sans ce champ, les autorités usuelles
du transport sont utilisées.

Le transport utilise [lettre 0.11.23](https://docs.rs/lettre/0.11.23/lettre/transport/smtp/struct.AsyncSmtpTransport.html)
avec Tokio / rustls et sans traces SMTP. Les diagnostics bruts du relais ne sont
jamais propagés : ils peuvent inclure destinataire ou contenu privé. Le travail
réel possède son permis même si l'appel HTTP qui l'attend est annulé. Une erreur
ou échéance rend `mail_delivery_unconfirmed` : la livraison peut déjà avoir eu
lieu. Il faudra reprendre le même contenu depuis la file, sans créer un nouveau code.

## Adresse vérifiée et livraison durable

Les réponses privées portent `Cache-Control: no-store`. Le GET conserve aussi
la barrière de livraison d'autorisation du serveur. L'adresse n'est pas ajoutée
au DTO `User`, à l'annuaire, au journal de conversation ou au cache public.

| Route `/api/v1` | Fonction |
| --- | --- |
| `GET /me/email` | Adresse vérifiée éventuelle, version de contact, tête de vérification et contexte de compte / appareil / instance / génération |
| `POST /me/email/verification/start` | Admission bornée puis création atomique du défi et de la livraison |
| `POST /me/email/verification/resume` | Relecture du candidat original ou du reçu déjà accepté |
| `POST /me/email/verification/confirm` | Validation du code, changement de contact et reçu de cinq minutes |
| `POST /me/email/verification/retire` | Rotation conditionnelle de la tête de vérification de cet appareil |

Le client prépare un candidat privé de 64 caractères hexadécimaux, une opération
et les versions initiales avant start. Tous les appels épinglent UID, appareil,
instance et génération. Start et la première confirmation exigent une preuve
complète récente sur la famille actuelle. L'acceptation change la version du
contact et la tête de vérification ; elle ne renouvelle ni bearer, appareil,
facteur, mot de passe, ni âge de la preuve.

Le code comporte huit chiffres, expire après quinze minutes et tolère cinq
essais erronés au plus. Une réponse perdue reprend le même candidat / opération
et le reçu accepté sans consommer une nouvelle preuve ou prolonger son échéance.
Un contact changé depuis un autre appareil, un changement de facteur,
d'autorité ou de génération rend le candidat ancien inutilisable. Le retrait
peut annuler ce candidat même après un changement de contact sur un autre
appareil ; un retrait ancien ne peut pas annuler une nouvelle tête.

Les admissions persistent indépendamment de la transaction HTTP : trois par
compte et par adresse en quinze minutes, dix par IP en quinze minutes et 120
globalement par minute. Un rejeu identique ne facture pas une deuxième admission.
La file contient au plus 1 000 messages non livrés encore valides. Une admission
refusée rend `email_delivery_limit` avec `Retry-After` ; ce délai ne bloque pas
statut, reprise, confirmation ou retrait dans les SDK.

La charge contient l'adresse et le code, chiffrés avec la clé opérateur hors
PostgreSQL. Son authentification inclut le job et toute la portée / les versions
initiales. Chaque worker revendique au plus quatre jobs, avec lease de deux
minutes et vérification de l'autorité / d'une session valide avant SMTP.
L'expiration de la session ou de la preuve pendant l'attente du budget de file
est relue avant création du message. Les verrous métier ne couvrent pas l'envoi.
Huit tentatives au plus reprennent exactement cette charge avant
l'échéance originale, avec délai de cinq secondes par tentative, plafonné à une
minute. Un ACK SMTP perdu peut entraîner plusieurs messages portant le même
code. La confirmation ou l'acceptation du relais efface la charge chiffrée.

La reprise expose `queued`, `sending`, `deferred`, `accepted` ou `exhausted`.
`accepted` signifie que le relais a accepté SMTP, pas que la boîte finale a reçu
le message. Aucun diagnostic SMTP brut, code ou contenu privé n'est journalisé.

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

Les tests du transport couvrent la configuration et les injections d'en-tête,
fichier privé / symlink / taille, refus d'un relais sans STARTTLS avant tout
credential / destinataire / contenu, un vrai échange SMTP sur loopback et
annulation conservant le permis du travail réel. Le relais en clair n'existe
que dans la construction privée de ces tests.

Un vrai échange rustls sur loopback valide STARTTLS obligatoire et TLS implicite
avec certificat de test. Les relais non approuvés et les certificats pour un
autre nom sont refusés avant credential ou code. Les fixtures publiques ne
constituent pas une autorité à installer en production.

Les tests PostgreSQL / HTTP avec le SDK Rust couvrent reçu idempotent, session
inchangée, reprise après ACK SMTP perdu et nouveau runtime, retrait avant start
ou confirmation retardés, appareils concurrents, changement d'autorité,
expirations, quotas persistants, essais erronés et confidentialité de l'annuaire.
Les tests TypeScript couvrent portée HTTP, candidat original, validation des
états et accès aux lectures / reprises pendant un cooldown de livraison.

Il reste à qualifier les trois parcours clients et le relais réel avec accès
opérateur. Un test SMTP / TLS loopback ne valide pas la délivrabilité d'un
fournisseur extérieur. P02 reste ouvert pour les fonctionnalités listées dans
l'état réel et la qualification sur appareils.
