/**
 * Orchestration E2EE : la clé privée en mémoire, le cache des clés de salon, et
 * le déverrouillage. La crypto pure vit dans `crypto.ts` ; ici on gère l'état
 * (verrouillé / déverrouillé), le stockage sécurisé de la clé et le REST.
 *
 * Modèle d'usage :
 *   1. `reprendre()` au démarrage : si une clé privée est en Keystore, on
 *      réimporte sans mot de passe → déverrouillé silencieusement.
 *   2. sinon `deverrouiller(motDePasse)` au tap sur un salon chiffré : va
 *      chercher la clé privée chiffrée (`e2e.fetchMyKeys`), la déchiffre, la
 *      persiste.
 *   3. `enregistrerCleSalon(rid, E2EKey)` met la clé AES d'un salon en cache
 *      (déchiffrée par RSA une fois) ; `dechiffrerContenu(rid, content)` est
 *      alors SYNCHRONE, donc branchable au fil de l'ingestion ; `chiffrer(rid,
 *      charge)` l'est aussi, pour l'envoi.
 *   4. `verrouiller()` oublie tout, en mémoire et en Keystore.
 *
 * `estDeverrouille` est observable (`souscrire`) pour piloter l'UI via
 * `useSyncExternalStore`.
 */

import {
  encryptMessage,
  decryptRoomKey,
  decryptPrivateKey,
  decryptPayload,
  E2EError,
  importRsaPrivateKey,
  keyIdOfE2EKey,
  type RsaPrivateKey,
  type EncryptedContent,
} from './crypto.ts';

/** Le strict nécessaire de `ClientRest` — pour tester le moteur sans réseau. */
export interface ClientE2E {
  get<T>(chemin: string, options?: { params?: Record<string, unknown> }): Promise<T>;
}

/** Accès au Keystore, injecté (pour tester sans `expo-secure-store`). */
export interface E2EKeyStorage {
  read(): Promise<string | null>;
  save(jwkJson: string): Promise<void>;
  clear(): Promise<void>;
}

type ReponseFetchMyKeys = { public_key?: string; private_key?: string };

export class E2EEngine {
  private readonly client: ClientE2E;
  private readonly storage: E2EKeyStorage;
  /** userId du compte — sel PBKDF2 des clés privées v1 (héritage). */
  private readonly uid: string;

  private privateKey: RsaPrivateKey | null = null;
  /** rid → octets bruts de la clé AES du salon (déchiffrée une fois). */
  private readonly roomKeys = new Map<string, Buffer>();
  /** rid → `E2EKey` d'abonnement connu, pour (re)calculer la clé au besoin. */
  private readonly e2eKeys = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(deps: { client: ClientE2E; storage: E2EKeyStorage; uid: string }) {
    this.client = deps.client;
    this.storage = deps.storage;
    this.uid = deps.uid;
  }

  get isUnlocked(): boolean {
    return this.privateKey !== null;
  }

  /** Observe les transitions verrouillé ↔ déverrouillé (pour useSyncExternalStore). */
  subscribe(ecouteur: () => void): () => void {
    this.listeners.add(ecouteur);
    return () => this.listeners.delete(ecouteur);
  }

  private notifier(): void {
    for (const e of this.listeners) e();
  }

  /**
   * Reprise silencieuse au démarrage : réimporte la clé privée déjà en Keystore.
   * Rend `true` si on est déverrouillé après coup. Une clé corrompue est effacée
   * plutôt que de bloquer.
   */
  async resume(): Promise<boolean> {
    if (this.privateKey !== null) return true;
    const jwk = await this.storage.read();
    if (jwk === null) return false;
    try {
      this.privateKey = importRsaPrivateKey(jwk);
    } catch {
      await this.storage.clear();
      return false;
    }
    this.notifier();
    return true;
  }

  /**
   * Déverrouille avec le mot de passe E2E : récupère la clé privée chiffrée,
   * la déchiffre, la persiste. Lève `ErreurE2E` si le mot de passe est faux.
   */
  async unlock(motDePasse: string): Promise<void> {
    const rep = await this.client.get<ReponseFetchMyKeys>('e2e.fetchMyKeys');
    if (typeof rep.private_key !== 'string') {
      throw new E2EError('aucune clé E2E sur ce compte');
    }
    // `dechiffrerClePrivee` détecte le schéma (v1/v2) ; le uid sert de sel v1.
    const jwk = decryptPrivateKey(rep.private_key, motDePasse, this.uid); // lève ErreurE2E si faux
    this.privateKey = importRsaPrivateKey(jwk);
    await this.storage.save(jwk);
    // Les clés de salon connues peuvent maintenant se recalculer à la demande.
    this.roomKeys.clear();
    this.notifier();
  }

  /** Oublie toute clé — mémoire et Keystore. */
  async lock(): Promise<void> {
    this.privateKey = null;
    this.roomKeys.clear();
    await this.storage.clear();
    this.notifier();
  }

  /**
   * Mémorise (et déchiffre si possible) la clé AES d'un salon depuis l'`E2EKey`
   * de son abonnement. Sûr à appeler verrouillé (mémorise l'`E2EKey`, remettra
   * la main dessus au déverrouillage) et de façon répétée — idempotent tant que
   * l'`E2EKey` ne CHANGE pas.
   *
   * Quand elle change, c'est une ROTATION (un membre retiré du salon en
   * provoque une) : le cache `clesSalon` porte alors la clé AES périmée, et
   * `dechiffrerContenu` la consulte EN PREMIER — tous les messages suivants se
   * figeraient au placeholder 🔒 jusqu'au redémarrage, sans indice de cause.
   * D'où la purge : la clé se recalculera à la demande, depuis la neuve.
   */
  saveRoomKey(rid: string, e2eKey: string | null): void {
    if (e2eKey === null || e2eKey === '') return;
    const ancienne = this.e2eKeys.get(rid);
    this.e2eKeys.set(rid, e2eKey);
    if (ancienne !== undefined && ancienne !== e2eKey) this.roomKeys.delete(rid);
    if (this.privateKey === null || this.roomKeys.has(rid)) return;
    try {
      this.roomKeys.set(rid, decryptRoomKey(e2eKey, this.privateKey));
    } catch {
      // Clé illisible (autre keyID, blob abîmé) : on n'a rien à cacher, les
      // messages de ce salon resteront au placeholder.
    }
  }

  /** Le keyID (UUID) attendu pour un salon, ou `null` si son `E2EKey` est inconnu. */
  roomKeyId(rid: string): string | null {
    const k = this.e2eKeys.get(rid);
    return k === undefined ? null : keyIdOfE2EKey(k);
  }

  /**
   * Déchiffre un objet `content` pour un salon : son texte, et les pièces
   * jointes (JSON) d'un fichier. SYNCHRONE : se branche au fil de l'ingestion.
   * Rend `null` si verrouillé, si la clé du salon manque, ou si le contenu est
   * illisible — l'appelant garde alors le ciphertext pour retenter après
   * déverrouillage.
   */
  decryptContent(rid: string, content: EncryptedContent): { text: string; attachments: string | null } | null {
    const cle = this.roomKey(rid);
    if (cle === null) return null;
    try {
      const { msg, attachments } = decryptPayload(content, cle);
      return { text: msg, attachments: attachments === null ? null : JSON.stringify(attachments) };
    } catch {
      return null;
    }
  }

  /**
   * Chiffre une charge (`{msg}`…) pour un salon, sous sa clé courante et son
   * keyID. Rend `null` si verrouillé ou si la clé du salon manque : l'envoi
   * attend alors, il ne part jamais en clair.
   */
  encrypt(rid: string, charge: object): EncryptedContent | null {
    const cle = this.roomKey(rid);
    const kid = this.roomKeyId(rid);
    if (cle === null || kid === null) return null;
    try {
      return encryptMessage(charge, cle, kid);
    } catch {
      return null;
    }
  }

  private roomKey(rid: string): Buffer | null {
    if (this.privateKey === null) return null;
    const connue = this.roomKeys.get(rid);
    if (connue !== undefined) return connue;
    // Pas encore en cache : tenter depuis l'`E2EKey` connu.
    const e2eKey = this.e2eKeys.get(rid);
    if (e2eKey === undefined) return null;
    try {
      const cle = decryptRoomKey(e2eKey, this.privateKey);
      this.roomKeys.set(rid, cle);
      return cle;
    } catch {
      return null;
    }
  }
}
