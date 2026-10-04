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
  insert(row: Omit<UploadRow, 'status' | 'fileId'>): Promise<void>;
  /** Les `en-attente` seulement, dans l'ordre de création. */
  listToSend(): Promise<UploadRow[]>;
  /** Saisit la ligne (`en-attente` → `envoi`). `false` si une autre passe l'a prise. */
  claim(id: string): Promise<boolean>;
  /** Rend au rejeu les `envoi` orphelins d'un processus tué, SAUF ceux encore en vol ici. */
  rearmInFlight(inFlightHere: string[]): Promise<void>;
  /** Le geste « Réessayer » : un échec redevient candidat. */
  rearm(id: string): Promise<void>;
  recordFileId(id: string, fileId: string): Promise<void>;
  /** Le message portant ce fichier est-il DÉJÀ en base ? Local, jamais réseau. */
  fileAlreadyPosted(rid: string, fileId: string): Promise<boolean>;
  markFailed(id: string, error: string): Promise<void>;
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
  encrypt(rid: string, payload: object): EncryptedContent | null;
  encryptFile(uri: string): Promise<EncryptedFile>;
  /** Empreinte SHA-256 (hexadécimal) d'un texte : le nom sous lequel le fichier part. */
  hashedName(name: string): string;
}

/** La clé du salon manque : la ligne attend le déverrouillage, elle n'échoue pas. */
class KeyWait extends Error {}

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
  const { fileId, url, name, type, size } = options;
  const base = {
    title: name,
    type: 'file',
    title_link: url,
    title_link_download: true,
    encryption: { key: options.key, iv: options.iv },
    hashes: { sha256: options.sha256 },
    fileId,
  };
  const kind = /^(image|audio|video)\//.exec(type)?.[1];
  if (kind !== undefined) {
    return { ...base, [`${kind}_url`]: url, [`${kind}_type`]: type, [`${kind}_size`]: size };
  }
  const dot = name.lastIndexOf('.');
  return { ...base, size, format: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
}

type PublicSetting = { _id?: string; value?: unknown };

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
  const response = await client.get<{ settings?: PublicSetting[] }>('settings.public', {
    params: { count: 0 },
  });
  let maxSize: number | null = null;
  let acceptedTypes: string[] | null = null;
  let encryptedFiles = false;
  for (const setting of response.settings ?? []) {
    if (setting._id === 'E2E_Enable_Encrypt_Files') encryptedFiles = setting.value === true;
    if (setting._id === 'FileUpload_MaxFileSize' && typeof setting.value === 'number') {
      maxSize = setting.value > 0 ? setting.value : null;
    }
    if (setting._id === 'FileUpload_MediaTypeWhiteList' && typeof setting.value === 'string') {
      const list = setting.value
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '');
      acceptedTypes = list.length > 0 ? list : null;
    }
  }
  return { maxSize, acceptedTypes, encryptedFiles };
}

/**
 * Lignes que CE runtime JS a en vol, tous moteurs confondus. Volontairement au
 * niveau du module et non de l'instance : `SynchroProvider` peut construire un
 * second `MoteurTeleversement` sans arrêter le premier (objet `session` neuf
 * pour le même compte), et les deux partagent la même connexion SQLite. C'est
 * la seule portée où « en vol ici » a un sens.
 */
const IN_FLIGHT_HERE = new Set<string>();

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
        ? `size > ${detail.maxMb} MB`
        : detail.code === 'type'
          ? `type ${detail.type} refused`
          : 'encrypted files disabled',
    );
    this.name = 'ValidationError';
    this.detail = detail;
  }
}

/** `image/*` dans la liste blanche accepte `image/png`, etc. */
export function validateFile(
  rules: UploadRules,
  file: { type: string; size: number | null },
  roomEncrypted = false,
): void {
  if (roomEncrypted && !rules.encryptedFiles) throw new ValidationError({ code: 'encrypted' });
  if (rules.maxSize !== null && file.size !== null && file.size > rules.maxSize) {
    const mo = (rules.maxSize / 1024 / 1024).toFixed(1);
    throw new ValidationError({ code: 'size', maxMb: mo });
  }
  if (rules.acceptedTypes !== null) {
    const accepted = rules.acceptedTypes.some((pattern) => {
      if (pattern === file.type) return true;
      const [family, sub] = pattern.split('/');
      return sub === '*' && file.type.startsWith(`${family}/`);
    });
    if (!accepted) {
      throw new ValidationError({ code: 'type', type: file.type });
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
  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => void this.observers.delete(listener);
  }

  private publish(): void {
    for (const listener of this.observers) listener();
  }

  private async uploadRules(): Promise<UploadRules> {
    if (this.rules !== null) return this.rules;
    try {
      const rules = await readUploadRules(this.client);
      this.rules = rules; // seul un SUCCÈS est mémoïsé —
      return rules;
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
  async validate(file: { type: string; size: number | null }, rid?: string): Promise<void> {
    const encrypted = rid !== undefined && (await this.encryption?.roomEncrypted(rid)) === true;
    validateFile(await this.uploadRules(), file, encrypted);
  }

  /** Valide (7.3) PUIS persiste l'intention PUIS tente l'envoi. */
  async send(
    rid: string,
    file: FileToSend & { size: number | null },
    caption?: string,
  ): Promise<void> {
    const encrypted = (await this.encryption?.roomEncrypted(rid)) === true;
    validateFile(await this.uploadRules(), file, encrypted);

    await this.store.insert({
      id: this.generateId(),
      rid,
      uri: file.uri,
      name: file.name,
      type: file.type,
      caption: caption ?? null,
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
        await this.store.rearmInFlight([...IN_FLIGHT_HERE]);
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
    for (const row of await this.store.listToSend()) {
      // Saisie atomique : si une autre passe l'a déjà prise, on la laisse.
      if (!(await this.store.claim(row.id))) continue;
      IN_FLIGHT_HERE.add(row.id);
      try {
        this.progress.set(row.id, 0);
        this.publish();
        if (!(await this.post(row))) return false;
      } catch (e) {
        if (this.discarded.has(row.id)) {
          // L'annulation a fait échouer la tâche, c'est le résultat voulu :
          // la ligne est déjà supprimée, il n'y a rien à marquer.
          continue;
        }
        if (e instanceof KeyWait) {
          await this.store.rearm(row.id);
          continue;
        }
        if (e instanceof RestError && e.status === 0) {
          // Injoignable. La ligne doit REDEVENIR `en-attente` : la laisser en
          // `envoi` la sortirait du listage jusqu'au prochain lancement.
          await this.store.rearm(row.id);
          return false;
        }
        // `derniere_erreur` est un DIAGNOSTIC (jamais affiché — l'UI montre
        // `ligneMessage.echecReessayer`) : pas une chaîne à traduire.
        await this.store.markFailed(row.id, e instanceof Error ? e.message : 'Send refused.');
      } finally {
        IN_FLIGHT_HERE.delete(row.id);
        this.progress.delete(row.id);
        this.cancellations.delete(row.id);
        this.discarded.delete(row.id);
        this.publish();
      }
    }
    return true;
  }

  /**
   * Une ligne, en deux temps séparés par une écriture. Rend `false` quand le
   * réseau est mort et qu'il faut arrêter la passe.
   */
  private async post(row: UploadRow): Promise<boolean> {
    if ((await this.encryption?.roomEncrypted(row.rid)) === true) {
      return this.postEncrypted(row, this.encryption as UploadEncryption);
    }
    let fileId = row.fileId;

    if (fileId === null) {
      fileId = await uploadBytes({
        client: this.client,
        transport: this.transport,
        rid: row.rid,
        file: { uri: row.uri, name: row.name, type: row.type },
        onProgress: (fraction) => this.recordProgress(row.id, fraction),
        onCancelable: (cancel) => void this.cancellations.set(row.id, cancel),
      });
      // AVANT le confirm : c'est tout l'objet de la colonne.
      await this.store.recordFileId(row.id, fileId);
    } else if (await this.alreadyPosted(row.rid, fileId)) {
      // Les octets étaient déjà partis ET le message est là : le confirm avait
      // abouti, seule sa réponse s'est perdue. Re-confirmer posterait un
      // doublon. On solde la ligne, sans rien envoyer.
      await this.solder(row);
      return true;
    }

    // Dernière fenêtre où « Abandonner » peut encore empêcher le message
    // d'exister : après le confirm, le serveur l'a créé et le stream DDP le
    // livrera de toute façon — on ne peut plus le dé-poster.
    if (this.discarded.has(row.id)) return true;

    const message = await confirmerMedia({
      client: this.client,
      rid: row.rid,
      fileId,
      message: row.caption ?? undefined,
    });
    await this.solder(row);
    if (!this.discarded.has(row.id)) await this.ingest(message);
    return true;
  }

  /**
   * Le pendant chiffré de `poster`, mêmes deux temps. Rien ne part tant que la
   * clé du salon manque : ni les octets, ni le message.
   */
  private async postEncrypted(
    row: UploadRow,
    encryption: UploadEncryption,
  ): Promise<boolean> {
    if (encryption.encrypt(row.rid, {}) === null) throw new KeyWait();
    let fileId = row.fileId;
    let file = this.encrypted.get(row.id);

    if (fileId !== null && file === undefined) {
      if (await this.alreadyPosted(row.rid, fileId)) {
        await this.solder(row);
        return true;
      }
      fileId = null;
    }

    const meta = (f: EncryptedFile) => ({
      type: row.type,
      typeGroup: row.type.split('/')[0],
      name: row.name,
      encryption: { key: f.key, iv: f.iv },
      hashes: { sha256: f.sha256 },
    });

    if (fileId === null || file === undefined) {
      const encrypted = await encryption.encryptFile(row.uri);
      file = { ...encrypted, hashedName: encryption.hashedName(row.name) };
      const encryptedContent = encryption.encrypt(row.rid, meta(file));
      if (encryptedContent === null) throw new KeyWait();
      try {
        fileId = await uploadBytes({
          client: this.client,
          transport: this.transport,
          rid: row.rid,
          file: { uri: file.uri, name: file.hashedName, type: 'application/octet-stream' },
          onProgress: (fraction) => this.recordProgress(row.id, fraction),
          onCancelable: (cancel) => void this.cancellations.set(row.id, cancel),
          fields: { content: JSON.stringify(encryptedContent) },
        });
      } finally {
        await this.deleteLocalFile?.(file.uri).catch(() => {});
      }
      this.encrypted.set(row.id, file);
      await this.store.recordFileId(row.id, fileId);
    }

    if (this.discarded.has(row.id)) return true;

    const plainAttachment = { _id: fileId, name: row.name, type: row.type, size: file.size };
    const attachment = encryptedFileAttachment({
      fileId,
      url: `/file-upload/${fileId}/${file.hashedName}`,
      name: row.name,
      type: row.type,
      size: file.size,
      key: file.key,
      iv: file.iv,
      sha256: file.sha256,
    });
    const content = encryption.encrypt(row.rid, {
      msg: row.caption ?? '',
      attachments: [attachment],
      files: [plainAttachment],
      file: plainAttachment,
    });
    const fileContent = encryption.encrypt(row.rid, meta(file));
    if (content === null || fileContent === null) throw new KeyWait();

    const message = await confirmerMedia({
      client: this.client,
      rid: row.rid,
      fileId,
      body: { msg: '', t: 'e2e', content, fileContent },
    });
    this.encrypted.delete(row.id);
    await this.solder(row);
    if (!this.discarded.has(row.id)) await this.ingest(message);
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
  private async solder(row: UploadRow): Promise<void> {
    await this.store.delete(row.id);
    await this.deleteLocalFile?.(row.uri).catch(() => {});
  }

  /**
   * Ne réveille l'UI qu'au changement de POURCENT ENTIER. Le transport rend la
   * main à chaque bloc : re-rendre l'écran de salon à cette cadence coûterait
   * plus cher que le téléversement lui-même.
   */
  private recordProgress(id: string, fraction: number): void {
    const before = this.progress.get(id) ?? 0;
    this.progress.set(id, fraction);
    if (Math.floor(fraction * 100) !== Math.floor(before * 100)) this.publish();
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
    const cancel = this.cancellations.get(id);
    if (cancel !== undefined) await cancel().catch(() => {});
    if (uri !== undefined) await this.deleteLocalFile?.(uri).catch(() => {});
    this.progress.delete(id);
    this.publish();
  }
}
