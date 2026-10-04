/**
 * File de téléversements (7.2) — le pendant de `MoteurEnvoi` pour les
 * fichiers. L'intention (uri locale, nom, type, légende) est persistée AVANT
 * l'envoi : un kill pendant l'upload se rejoue au prochain démarrage.
 *
 * Validation (7.3) : `FileUpload_MaxFileSize` et
 * `FileUpload_MediaTypeWhiteList` sont lus dans `settings.public` et vérifiés
 * AVANT de pousser le moindre octet — refuser après coup gaspille le réseau
 * et laisse des orphelins.
 *
 * Salon chiffré : le fichier part chiffré (une clé AES-CTR à lui), sous
 * l'empreinte de son nom ; son vrai nom, son type, sa clé et la légende ne
 * voyagent que dans le contenu chiffré sous la clé du salon — ce que fait le
 * client web.
 */

import type { EncryptedContent, FileJwk } from './e2e/crypto.ts';
import type { ClientRest } from './rest.ts';
import { RestError } from './rest.ts';
import {
  confirmerMedia,
  uploadBytes,
  type FileToSend,
  type TransportUpload,
} from './upload.ts';

export type UploadRow = {
  id: string;
  rid: string;
  uri: string;
  name: string;
  type: string;
  caption: string | null;
  status: 'en-attente' | 'envoi' | 'echec';
  /** Rendu par `rooms.media`. Non nul = les octets sont déjà chez le serveur. */
  fileId: string | null;
};

export interface UploadStore {
  insert(ligne: Omit<UploadRow, 'status' | 'fileId'>): Promise<void>;
  /** Les `en-attente` seulement, dans l'ordre de création. */
  listToSend(): Promise<UploadRow[]>;
  /** Saisit la ligne (`en-attente` → `envoi`). `false` si une autre passe l'a prise. */
  claim(id: string): Promise<boolean>;
  /** Rend au rejeu les `envoi` orphelins d'un processus tué, SAUF ceux encore en vol ici. */
  rearmInFlight(enVolIci: string[]): Promise<void>;
  /** Le geste « Réessayer » : un échec redevient candidat. */
  rearm(id: string): Promise<void>;
  recordFileId(id: string, fileId: string): Promise<void>;
  /** Le message portant ce fichier est-il DÉJÀ en base ? Local, jamais réseau. */
  fileAlreadyPosted(rid: string, fileId: string): Promise<boolean>;
  markFailed(id: string, erreur: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export type UploadRules = {
  maxSize: number | null;
  /** Liste blanche MIME, `null` = tout accepté. */
  acceptedTypes: string[] | null;
  /** `E2E_Enable_Encrypt_Files` : sans lui, un salon chiffré n'accepte aucun fichier. */
  encryptedFiles: boolean;
};

/** Un fichier chiffré dans un fichier temporaire, prêt à téléverser. */
export type EncryptedFile = { uri: string; key: FileJwk; iv: string; sha256: string; size: number };

/** Ce que la file demande pour envoyer dans un salon chiffré. */
export interface UploadEncryption {
  roomEncrypted(rid: string): Promise<boolean>;
  /** Contenu chiffré pour ce salon, `null` sans clé (verrouillé). */
  encrypt(rid: string, charge: object): EncryptedContent | null;
  encryptFile(uri: string): Promise<EncryptedFile>;
  /** Empreinte SHA-256 (hexadécimal) d'un texte : le nom sous lequel le fichier part. */
  hashedName(nom: string): string;
}

/** La clé du salon manque : la ligne attend le déverrouillage, elle n'échoue pas. */
class AttenteCle extends Error {}

/**
 * La pièce jointe d'un fichier chiffré, telle que le client web la bâtit et la
 * relit : `title_link` désigne le chiffré, la clé et l'empreinte le rendent
 * lisible, et une image, un son ou une vidéo s'annonce comme tel.
 */
export function encryptedFileAttachment(options: {
  fileId: string;
  url: string;
  name: string;
  type: string;
  size: number;
  key: FileJwk;
  iv: string;
  sha256: string;
}): Record<string, unknown> {
  const { fileId, url, name: nom, type, size: taille } = options;
  const base = {
    title: nom,
    type: 'file',
    title_link: url,
    title_link_download: true,
    encryption: { key: options.key, iv: options.iv },
    hashes: { sha256: options.sha256 },
    fileId,
  };
  const genre = /^(image|audio|video)\//.exec(type)?.[1];
  if (genre !== undefined) {
    return { ...base, [`${genre}_url`]: url, [`${genre}_type`]: type, [`${genre}_size`]: taille };
  }
  const point = nom.lastIndexOf('.');
  return { ...base, size: taille, format: point > 0 ? nom.slice(point + 1).toLowerCase() : '' };
}

type ReglagePublic = { _id?: string; value?: unknown };

/**
 * Lit les deux réglages qui gouvernent l'upload. Mémoïsé par l'appelant.
 *
 * ATTENTION : le paramètre `query` de `settings.public` a été SUPPRIMÉ en
 * 7.0 — le serveur l'ignore et pagine à 50, sans jamais renvoyer les
 * `FileUpload_*` (vérifié contre le 8.5 réel : la validation était un
 * no-op). On demande TOUT (`count=0`, comme le relevé de connexion) et on
 * filtre côté client.
 */
export async function readUploadRules(client: ClientRest): Promise<UploadRules> {
  const reponse = await client.get<{ settings?: ReglagePublic[] }>('settings.public', {
    params: { count: 0 },
  });
  let tailleMax: number | null = null;
  let typesAcceptes: string[] | null = null;
  let fichiersChiffres = false;
  for (const reglage of reponse.settings ?? []) {
    if (reglage._id === 'E2E_Enable_Encrypt_Files') fichiersChiffres = reglage.value === true;
    if (reglage._id === 'FileUpload_MaxFileSize' && typeof reglage.value === 'number') {
      tailleMax = reglage.value > 0 ? reglage.value : null;
    }
    if (reglage._id === 'FileUpload_MediaTypeWhiteList' && typeof reglage.value === 'string') {
      const liste = reglage.value
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '');
      typesAcceptes = liste.length > 0 ? liste : null;
    }
  }
  return { maxSize: tailleMax, acceptedTypes: typesAcceptes, encryptedFiles: fichiersChiffres };
}

/**
 * Lignes que CE runtime JS a en vol, tous moteurs confondus. Volontairement au
 * niveau du module et non de l'instance : `SynchroProvider` peut construire un
 * second `MoteurTeleversement` sans arrêter le premier (objet `session` neuf
 * pour le même compte), et les deux partagent la même connexion SQLite. C'est
 * la seule portée où « en vol ici » a un sens.
 */
const EN_VOL_ICI = new Set<string>();

/**
 * Un refus de validation porte une DONNÉE (code + paramètres), pas une phrase :
 * ce module est pur et testé sous Node, il n'embarque aucune langue. La mise en
 * phrase se fait au point d'affichage (`phraseValidation`, ui/fileValidation.ts).
 */
export type DetailValidation =
  | { code: 'size'; maxMb: string }
  | { code: 'type'; type: string }
  | { code: 'encrypted' };

export class ValidationError extends Error {
  readonly detail: DetailValidation;

  constructor(detail: DetailValidation) {
    // `message` est un diagnostic (logs) — jamais la chaîne affichée.
    super(
      detail.code === 'size'
        ? `taille > ${detail.maxMb} Mo`
        : detail.code === 'type'
          ? `type ${detail.type} refusé`
          : 'fichiers chiffrés désactivés',
    );
    this.name = 'ErreurValidation';
    this.detail = detail;
  }
}

/** `image/*` dans la liste blanche accepte `image/png`, etc. */
export function validateFile(
  regles: UploadRules,
  fichier: { type: string; size: number | null },
  salonChiffre = false,
): void {
  if (salonChiffre && !regles.encryptedFiles) throw new ValidationError({ code: 'encrypted' });
  if (regles.maxSize !== null && fichier.size !== null && fichier.size > regles.maxSize) {
    const mo = (regles.maxSize / 1024 / 1024).toFixed(1);
    throw new ValidationError({ code: 'size', maxMb: mo });
  }
  if (regles.acceptedTypes !== null) {
    const accepte = regles.acceptedTypes.some((motif) => {
      if (motif === fichier.type) return true;
      const [famille, sous] = motif.split('/');
      return sous === '*' && fichier.type.startsWith(`${famille}/`);
    });
    if (!accepte) {
      throw new ValidationError({ code: 'type', type: fichier.type });
    }
  }
}

export class UploadEngine {
  private readonly store: UploadStore;
  private readonly client: ClientRest;
  private readonly transport: TransportUpload;
  private readonly generateId: () => string;
  private readonly ingest: (doc: Record<string, unknown>) => Promise<void>;
  private readonly deleteLocalFile: ((uri: string) => Promise<void>) | undefined;
  private readonly refreshRoom: ((rid: string) => Promise<void>) | undefined;
  private readonly encryption: UploadEncryption | undefined;
  /**
   * Clé de chaque fichier chiffré déjà téléversé, en attente de son confirm.
   * En mémoire seulement : un processus tué entre les deux temps la perd, et
   * le fichier repart alors, chiffré sous une clé neuve.
   */
  private readonly encrypted = new Map<string, EncryptedFile & { hashedName: string }>();
  private inFlight = false;
  private rerun = false;
  /** Progression 0..1 du téléversement en cours, par id — pour l'UI. */
  readonly progress = new Map<string, number>();
  private rules: UploadRules | null = null;
  /** Faux tant que les `envoi` orphelins du processus d'avant n'ont pas été rendus. */
  private rearmed = false;
  /** Ids abandonnés pendant leur propre envoi — vérifiés avant de poster. */
  private readonly discarded = new Set<string>();
  /** Interrupteurs des tâches en vol, posés par le transport. */
  private readonly cancellations = new Map<string, () => Promise<void>>();
  private readonly observers = new Set<() => void>();

  constructor(options: {
    store: UploadStore;
    client: ClientRest;
    transport: TransportUpload;
    generateId: () => string;
    ingest: (doc: Record<string, unknown>) => Promise<void>;
    /**
     * Efface le fichier local d'une ligne soldée (succès ou abandon). Injecté
     * plutôt qu'importé : `expo-file-system` n'existe pas sous Node, et ce
     * module doit rester testable sans lui. L'implémentation décide seule si
     * l'URI est bien dans le cache de l'app — on n'efface JAMAIS un fichier
     * que l'utilisateur a choisi ailleurs.
     */
    deleteLocalFile?: (uri: string) => Promise<void>;
    /**
     * Rapatrie les messages récents d'un salon. Appelé UNIQUEMENT quand un
     * `file_id` déjà persisté oblige à savoir si le message existe et que la
     * base locale ne le sait pas — donc jamais sur le chemin nominal.
     */
    refreshRoom?: (rid: string) => Promise<void>;
    encryption?: UploadEncryption;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.transport = options.transport;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.deleteLocalFile = options.deleteLocalFile;
    this.refreshRoom = options.refreshRoom;
    this.encryption = options.encryption;
  }

  /**
   * S'abonner aux changements de `progression` — c'est ce qui fait bouger la
   * barre du bandeau. Un `useRequeteVive` ne suffit pas : la fraction ne vit
   * qu'en mémoire, aucune écriture SQLite ne la porte.
   */
  subscribe(auditeur: () => void): () => void {
    this.observers.add(auditeur);
    return () => void this.observers.delete(auditeur);
  }

  private publish(): void {
    for (const auditeur of this.observers) auditeur();
  }

  private async uploadRules(): Promise<UploadRules> {
    if (this.rules !== null) return this.rules;
    try {
      const regles = await readUploadRules(this.client);
      this.rules = regles; // seul un SUCCÈS est mémoïsé —
      return regles;
    } catch {
      // — un repli permissif mis en cache après un passage hors ligne
      // désactiverait la validation pour toute la session.
      return { maxSize: null, acceptedTypes: null, encryptedFiles: true };
    }
  }

  /**
   * La validation seule, sans rien persister : le composer refuse une pièce
   * dès qu'on la pose, pas au moment d'envoyer. `envoyer` revalide de toute
   * façon — la pièce a pu être réduite entre-temps.
   */
  async validate(fichier: { type: string; size: number | null }, rid?: string): Promise<void> {
    const chiffre = rid !== undefined && (await this.encryption?.roomEncrypted(rid)) === true;
    validateFile(await this.uploadRules(), fichier, chiffre);
  }

  /** Valide (7.3) PUIS persiste l'intention PUIS tente l'envoi. */
  async send(
    rid: string,
    fichier: FileToSend & { size: number | null },
    legende?: string,
  ): Promise<void> {
    const chiffre = (await this.encryption?.roomEncrypted(rid)) === true;
    validateFile(await this.uploadRules(), fichier, chiffre);

    await this.store.insert({
      id: this.generateId(),
      rid,
      uri: fichier.uri,
      name: fichier.name,
      type: fichier.type,
      caption: legende ?? null,
    });
    await this.process();
  }

  /** Rejoue la file, une passe à la fois — même discipline que MoteurEnvoi. */
  async process(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      // Une seule fois par processus, AVANT la première lecture de la file :
      // un `envoi` ne peut avoir été posé que par une exécution précédente,
      // tuée en plein téléversement. Sans ce geste, sa ligne resterait hors du
      // listage à vie et le fichier ne partirait jamais.
      if (!this.rearmed) {
        this.rearmed = true;
        await this.store.rearmInFlight([...EN_VOL_ICI]);
      }
      do {
        this.rerun = false;
        if (!(await this.runPass())) return;
      } while (this.rerun);
    } finally {
      this.inFlight = false;
    }
  }

  /** Le geste explicite « Réessayer » — le seul qui sorte une ligne de l'échec. */
  async retry(id: string): Promise<void> {
    await this.store.rearm(id);
    await this.process();
  }

  private async runPass(): Promise<boolean> {
    for (const ligne of await this.store.listToSend()) {
      // Saisie atomique : si une autre passe l'a déjà prise, on la laisse.
      if (!(await this.store.claim(ligne.id))) continue;
      EN_VOL_ICI.add(ligne.id);
      try {
        this.progress.set(ligne.id, 0);
        this.publish();
        if (!(await this.post(ligne))) return false;
      } catch (e) {
        if (this.discarded.has(ligne.id)) {
          // L'annulation a fait échouer la tâche, c'est le résultat voulu :
          // la ligne est déjà supprimée, il n'y a rien à marquer.
          continue;
        }
        if (e instanceof AttenteCle) {
          await this.store.rearm(ligne.id);
          continue;
        }
        if (e instanceof RestError && e.status === 0) {
          // Injoignable. La ligne doit REDEVENIR `en-attente` : la laisser en
          // `envoi` la sortirait du listage jusqu'au prochain lancement.
          await this.store.rearm(ligne.id);
          return false;
        }
        // `derniere_erreur` est un DIAGNOSTIC (jamais affiché — l'UI montre
        // `ligneMessage.echecReessayer`) : pas une chaîne à traduire.
        await this.store.markFailed(ligne.id, e instanceof Error ? e.message : 'Envoi refusé.');
      } finally {
        EN_VOL_ICI.delete(ligne.id);
        this.progress.delete(ligne.id);
        this.cancellations.delete(ligne.id);
        this.discarded.delete(ligne.id);
        this.publish();
      }
    }
    return true;
  }

  /**
   * Une ligne, en deux temps séparés par une écriture. Rend `false` quand le
   * réseau est mort et qu'il faut arrêter la passe.
   */
  private async post(ligne: UploadRow): Promise<boolean> {
    if ((await this.encryption?.roomEncrypted(ligne.rid)) === true) {
      return this.postEncrypted(ligne, this.encryption as UploadEncryption);
    }
    let fileId = ligne.fileId;

    if (fileId === null) {
      fileId = await uploadBytes({
        client: this.client,
        transport: this.transport,
        rid: ligne.rid,
        file: { uri: ligne.uri, name: ligne.name, type: ligne.type },
        onProgress: (fraction) => this.recordProgress(ligne.id, fraction),
        onCancelable: (annuler) => void this.cancellations.set(ligne.id, annuler),
      });
      // AVANT le confirm : c'est tout l'objet de la colonne.
      await this.store.recordFileId(ligne.id, fileId);
    } else if (await this.alreadyPosted(ligne.rid, fileId)) {
      // Les octets étaient déjà partis ET le message est là : le confirm avait
      // abouti, seule sa réponse s'est perdue. Re-confirmer posterait un
      // doublon. On solde la ligne, sans rien envoyer.
      await this.solder(ligne);
      return true;
    }

    // Dernière fenêtre où « Abandonner » peut encore empêcher le message
    // d'exister : après le confirm, le serveur l'a créé et le stream DDP le
    // livrera de toute façon — on ne peut plus le dé-poster.
    if (this.discarded.has(ligne.id)) return true;

    const message = await confirmerMedia({
      client: this.client,
      rid: ligne.rid,
      fileId,
      message: ligne.caption ?? undefined,
    });
    await this.solder(ligne);
    if (!this.discarded.has(ligne.id)) await this.ingest(message);
    return true;
  }

  /**
   * Le pendant chiffré de `poster`, mêmes deux temps. Rien ne part tant que la
   * clé du salon manque : ni les octets, ni le message.
   */
  private async postEncrypted(
    ligne: UploadRow,
    chiffrement: UploadEncryption,
  ): Promise<boolean> {
    if (chiffrement.encrypt(ligne.rid, {}) === null) throw new AttenteCle();
    let fileId = ligne.fileId;
    let fichier = this.encrypted.get(ligne.id);

    if (fileId !== null && fichier === undefined) {
      if (await this.alreadyPosted(ligne.rid, fileId)) {
        await this.solder(ligne);
        return true;
      }
      fileId = null;
    }

    const meta = (f: EncryptedFile) => ({
      type: ligne.type,
      typeGroup: ligne.type.split('/')[0],
      name: ligne.name,
      encryption: { key: f.key, iv: f.iv },
      hashes: { sha256: f.sha256 },
    });

    if (fileId === null || fichier === undefined) {
      const chiffre = await chiffrement.encryptFile(ligne.uri);
      fichier = { ...chiffre, hashedName: chiffrement.hashedName(ligne.name) };
      const contenuFichier = chiffrement.encrypt(ligne.rid, meta(fichier));
      if (contenuFichier === null) throw new AttenteCle();
      try {
        fileId = await uploadBytes({
          client: this.client,
          transport: this.transport,
          rid: ligne.rid,
          file: { uri: fichier.uri, name: fichier.hashedName, type: 'application/octet-stream' },
          onProgress: (fraction) => this.recordProgress(ligne.id, fraction),
          onCancelable: (annuler) => void this.cancellations.set(ligne.id, annuler),
          fields: { content: JSON.stringify(contenuFichier) },
        });
      } finally {
        await this.deleteLocalFile?.(fichier.uri).catch(() => {});
      }
      this.encrypted.set(ligne.id, fichier);
      await this.store.recordFileId(ligne.id, fileId);
    }

    if (this.discarded.has(ligne.id)) return true;

    const piece = { _id: fileId, name: ligne.name, type: ligne.type, size: fichier.size };
    const jointe = encryptedFileAttachment({
      fileId,
      url: `/file-upload/${fileId}/${fichier.hashedName}`,
      name: ligne.name,
      type: ligne.type,
      size: fichier.size,
      key: fichier.key,
      iv: fichier.iv,
      sha256: fichier.sha256,
    });
    const content = chiffrement.encrypt(ligne.rid, {
      msg: ligne.caption ?? '',
      attachments: [jointe],
      files: [piece],
      file: piece,
    });
    const fileContent = chiffrement.encrypt(ligne.rid, meta(fichier));
    if (content === null || fileContent === null) throw new AttenteCle();

    const message = await confirmerMedia({
      client: this.client,
      rid: ligne.rid,
      fileId,
      body: { msg: '', t: 'e2e', content, fileContent },
    });
    this.encrypted.delete(ligne.id);
    await this.solder(ligne);
    if (!this.discarded.has(ligne.id)) await this.ingest(message);
    return true;
  }

  /**
   * « Ce fichier est-il déjà posté ? » — la question dont dépend tout le
   * chantier, parce que **le serveur ne sait pas y répondre** : un second
   * `rooms.mediaConfirm` sur le même `fileId` répond 200 en rendant le PREMIER
   * message, alors qu'il vient d'en créer un second (sondé sur 8.5, voir
   * CLAUDE.md). La réponse est donc indiscernable d'un succès ; seule la base
   * locale peut trancher.
   *
   * Encore faut-il qu'elle SACHE. Le cas qui la prend en défaut est justement
   * celui qu'on vise : au redémarrage après un kill, aucun écran de salon n'est
   * monté, donc `stream-room-messages` n'est souscrit sur rien et la table
   * `messages` ignore tout du message créé par le confirm perdu. On ne re-pose
   * alors pas la question au hasard : on RAFRAÎCHIT ce salon-là, une fois, puis
   * on redemande. Un appel REST ciblé, payé seulement dans le cas rare d'une
   * réponse perdue — jamais sur le chemin nominal.
   */
  private async alreadyPosted(rid: string, fileId: string): Promise<boolean> {
    if (await this.store.fileAlreadyPosted(rid, fileId)) return true;
    if (this.refreshRoom === undefined) return false;
    try {
      await this.refreshRoom(rid);
    } catch {
      // Rafraîchissement impossible : on ne sait toujours pas. Voir plus bas
      // le choix assumé entre le doublon et la perte.
      return false;
    }
    return this.store.fileAlreadyPosted(rid, fileId);
  }

  /** Ligne soldée : plus de file, plus de fichier temporaire. */
  private async solder(ligne: UploadRow): Promise<void> {
    await this.store.delete(ligne.id);
    await this.deleteLocalFile?.(ligne.uri).catch(() => {});
  }

  /**
   * Ne réveille l'UI qu'au changement de POURCENT ENTIER. Le transport rend la
   * main à chaque bloc : re-rendre l'écran de salon à cette cadence coûterait
   * plus cher que le téléversement lui-même.
   */
  private recordProgress(id: string, fraction: number): void {
    const avant = this.progress.get(id) ?? 0;
    this.progress.set(id, fraction);
    if (Math.floor(fraction * 100) !== Math.floor(avant * 100)) this.publish();
  }

  /**
   * Abandon. Trois gestes, pas un : la ligne part de la file, la tâche en vol
   * est INTERROMPUE (sans quoi les octets continuaient de monter et le fichier
   * apparaissait dans le salon après l'abandon), et l'intention est notée pour
   * que la passe qui court n'ingère rien.
   *
   * `uri` permet d'effacer aussi le fichier temporaire — l'appelant l'a sous
   * la main, le moteur non (la ligne vient d'être supprimée).
   */
  async discard(id: string, uri?: string): Promise<void> {
    this.discarded.add(id);
    this.encrypted.delete(id);
    await this.store.delete(id);
    const annuler = this.cancellations.get(id);
    if (annuler !== undefined) await annuler().catch(() => {});
    if (uri !== undefined) await this.deleteLocalFile?.(uri).catch(() => {});
    this.progress.delete(id);
    this.publish();
  }
}
