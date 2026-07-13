/**
 * Orchestration E2EE : la clé privée en mémoire, le cache des clés de salon, et
 * le déverrouillage. La crypto pure vit dans `crypto.ts` ; ici on gère l'état
 * (verrouillé / déverrouillé), le stockage sécurisé de la clé et le REST.
 *
 * Modèle d'usage — DÉCHIFFREMENT SEUL (lecture) pour ce v1 :
 *   1. `reprendre()` au démarrage : si une clé privée est en Keystore, on
 *      réimporte sans mot de passe → déverrouillé silencieusement.
 *   2. sinon `deverrouiller(motDePasse)` au tap sur un salon chiffré : va
 *      chercher la clé privée chiffrée (`e2e.fetchMyKeys`), la déchiffre, la
 *      persiste.
 *   3. `enregistrerCleSalon(rid, E2EKey)` met la clé AES d'un salon en cache
 *      (déchiffrée par RSA une fois) ; `dechiffrerContenu(rid, content)` est
 *      alors SYNCHRONE — forge l'est — donc branchable au fil de l'ingestion.
 *   4. `verrouiller()` oublie tout, en mémoire et en Keystore.
 *
 * `estDeverrouille` est observable (`souscrire`) pour piloter l'UI via
 * `useSyncExternalStore`.
 */

import {
  dechiffrerCleSalon,
  dechiffrerClePrivee,
  dechiffrerMessage,
  ErreurE2E,
  importerClePriveeRSA,
  keyIdDeE2EKey,
  type ClePriveeRSA,
  type ContenuChiffre,
} from './crypto.ts';

/** Le strict nécessaire de `ClientRest` — pour tester le moteur sans réseau. */
export interface ClientE2E {
  get<T>(chemin: string, options?: { params?: Record<string, unknown> }): Promise<T>;
}

/** Accès au Keystore, injecté (pour tester sans `expo-secure-store`). */
export interface StockageCleE2E {
  lire(): Promise<string | null>;
  enregistrer(jwkJson: string): Promise<void>;
  effacer(): Promise<void>;
}

type ReponseFetchMyKeys = { public_key?: string; private_key?: string };

export class MoteurE2E {
  private readonly client: ClientE2E;
  private readonly stockage: StockageCleE2E;
  /** userId du compte — sel PBKDF2 des clés privées v1 (héritage). */
  private readonly uid: string;

  private clePrivee: ClePriveeRSA | null = null;
  /** rid → octets bruts de la clé AES du salon (déchiffrée une fois). */
  private readonly clesSalon = new Map<string, string>();
  /** rid → `E2EKey` d'abonnement connu, pour (re)calculer la clé au besoin. */
  private readonly e2eKeys = new Map<string, string>();
  private readonly ecouteurs = new Set<() => void>();

  constructor(deps: { client: ClientE2E; stockage: StockageCleE2E; uid: string }) {
    this.client = deps.client;
    this.stockage = deps.stockage;
    this.uid = deps.uid;
  }

  get estDeverrouille(): boolean {
    return this.clePrivee !== null;
  }

  /** Observe les transitions verrouillé ↔ déverrouillé (pour useSyncExternalStore). */
  souscrire(ecouteur: () => void): () => void {
    this.ecouteurs.add(ecouteur);
    return () => this.ecouteurs.delete(ecouteur);
  }

  private notifier(): void {
    for (const e of this.ecouteurs) e();
  }

  /**
   * Reprise silencieuse au démarrage : réimporte la clé privée déjà en Keystore.
   * Rend `true` si on est déverrouillé après coup. Une clé corrompue est effacée
   * plutôt que de bloquer.
   */
  async reprendre(): Promise<boolean> {
    if (this.clePrivee !== null) return true;
    const jwk = await this.stockage.lire();
    if (jwk === null) return false;
    try {
      this.clePrivee = importerClePriveeRSA(jwk);
    } catch {
      await this.stockage.effacer();
      return false;
    }
    this.notifier();
    return true;
  }

  /**
   * Déverrouille avec le mot de passe E2E : récupère la clé privée chiffrée,
   * la déchiffre, la persiste. Lève `ErreurE2E` si le mot de passe est faux.
   */
  async deverrouiller(motDePasse: string): Promise<void> {
    const rep = await this.client.get<ReponseFetchMyKeys>('e2e.fetchMyKeys');
    if (typeof rep.private_key !== 'string') {
      throw new ErreurE2E('aucune clé E2E sur ce compte');
    }
    // `dechiffrerClePrivee` détecte le schéma (v1/v2) ; le uid sert de sel v1.
    const jwk = dechiffrerClePrivee(rep.private_key, motDePasse, this.uid); // lève ErreurE2E si faux
    this.clePrivee = importerClePriveeRSA(jwk);
    await this.stockage.enregistrer(jwk);
    // Les clés de salon connues peuvent maintenant se recalculer à la demande.
    this.clesSalon.clear();
    this.notifier();
  }

  /** Oublie toute clé — mémoire et Keystore. */
  async verrouiller(): Promise<void> {
    this.clePrivee = null;
    this.clesSalon.clear();
    await this.stockage.effacer();
    this.notifier();
  }

  /**
   * Mémorise (et déchiffre si possible) la clé AES d'un salon depuis l'`E2EKey`
   * de son abonnement. Sûr à appeler verrouillé (mémorise l'`E2EKey`, remettra
   * la main dessus au déverrouillage) et de façon répétée (idempotent).
   */
  enregistrerCleSalon(rid: string, e2eKey: string | null): void {
    if (e2eKey === null || e2eKey === '') return;
    this.e2eKeys.set(rid, e2eKey);
    if (this.clePrivee === null || this.clesSalon.has(rid)) return;
    try {
      this.clesSalon.set(rid, dechiffrerCleSalon(e2eKey, this.clePrivee));
    } catch {
      // Clé illisible (autre keyID, blob abîmé) : on n'a rien à cacher, les
      // messages de ce salon resteront au placeholder.
    }
  }

  /** Le keyID (UUID) attendu pour un salon, ou `null` si son `E2EKey` est inconnu. */
  keyIdSalon(rid: string): string | null {
    const k = this.e2eKeys.get(rid);
    return k === undefined ? null : keyIdDeE2EKey(k);
  }

  /**
   * Déchiffre un objet `content` pour un salon. SYNCHRONE (forge l'est) : se
   * branche au fil de l'ingestion. Rend `null` si verrouillé, si la clé du salon
   * manque, ou si le contenu est illisible — l'appelant garde alors le
   * ciphertext pour retenter après déverrouillage.
   */
  dechiffrerContenu(rid: string, content: ContenuChiffre): string | null {
    if (this.clePrivee === null) return null;
    let cle = this.clesSalon.get(rid);
    if (cle === undefined) {
      // Pas encore en cache : tenter depuis l'`E2EKey` connu.
      const e2eKey = this.e2eKeys.get(rid);
      if (e2eKey === undefined) return null;
      try {
        cle = dechiffrerCleSalon(e2eKey, this.clePrivee);
        this.clesSalon.set(rid, cle);
      } catch {
        return null;
      }
    }
    try {
      return dechiffrerMessage(content, cle);
    } catch {
      return null;
    }
  }
}
