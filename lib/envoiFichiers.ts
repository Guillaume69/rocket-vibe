/**
 * File de téléversements (7.2) — le pendant de `MoteurEnvoi` pour les
 * fichiers. L'intention (uri locale, nom, type, légende) est persistée AVANT
 * l'envoi : un kill pendant l'upload se rejoue au prochain démarrage.
 *
 * Validation (7.3) : `FileUpload_MaxFileSize` et
 * `FileUpload_MediaTypeWhiteList` sont lus dans `settings.public` et vérifiés
 * AVANT de pousser le moindre octet — refuser après coup gaspille le réseau
 * et laisse des orphelins.
 */

import type { ClientRest } from './rest.ts';
import { ErreurRest } from './rest.ts';
import { televerser, type FichierAEnvoyer, type TransportUpload } from './upload.ts';

export type LigneTeleversement = {
  id: string;
  rid: string;
  uri: string;
  nom: string;
  type: string;
  legende: string | null;
  statut: 'en-attente' | 'echec';
};

export interface DepotTeleversements {
  inserer(ligne: Omit<LigneTeleversement, 'statut'>): Promise<void>;
  listerAEnvoyer(): Promise<LigneTeleversement[]>;
  marquerEchec(id: string, erreur: string): Promise<void>;
  supprimer(id: string): Promise<void>;
}

export type ReglesUpload = {
  tailleMax: number | null;
  /** Liste blanche MIME, `null` = tout accepté. */
  typesAcceptes: string[] | null;
};

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
export async function lireReglesUpload(client: ClientRest): Promise<ReglesUpload> {
  const reponse = await client.get<{ settings?: ReglagePublic[] }>('settings.public', {
    params: { count: 0 },
  });
  let tailleMax: number | null = null;
  let typesAcceptes: string[] | null = null;
  for (const reglage of reponse.settings ?? []) {
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
  return { tailleMax, typesAcceptes };
}

export class ErreurValidation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurValidation';
  }
}

/** `image/*` dans la liste blanche accepte `image/png`, etc. */
export function validerFichier(
  regles: ReglesUpload,
  fichier: { type: string; taille: number | null },
): void {
  if (regles.tailleMax !== null && fichier.taille !== null && fichier.taille > regles.tailleMax) {
    const mo = (regles.tailleMax / 1024 / 1024).toFixed(1);
    throw new ErreurValidation(`Fichier trop lourd (maximum ${mo} Mo).`);
  }
  if (regles.typesAcceptes !== null) {
    const accepte = regles.typesAcceptes.some((motif) => {
      if (motif === fichier.type) return true;
      const [famille, sous] = motif.split('/');
      return sous === '*' && fichier.type.startsWith(`${famille}/`);
    });
    if (!accepte) {
      throw new ErreurValidation(`Type ${fichier.type} refusé par le serveur.`);
    }
  }
}

export class MoteurTeleversement {
  private readonly depot: DepotTeleversements;
  private readonly client: ClientRest;
  private readonly transport: TransportUpload;
  private readonly genererId: () => string;
  private readonly ingerer: (doc: Record<string, unknown>) => Promise<void>;
  private enVol = false;
  private repasser = false;
  /** Progression 0..1 du téléversement en cours, par id — pour l'UI. */
  readonly progression = new Map<string, number>();
  private regles: ReglesUpload | null = null;

  constructor(options: {
    depot: DepotTeleversements;
    client: ClientRest;
    transport: TransportUpload;
    genererId: () => string;
    ingerer: (doc: Record<string, unknown>) => Promise<void>;
  }) {
    this.depot = options.depot;
    this.client = options.client;
    this.transport = options.transport;
    this.genererId = options.genererId;
    this.ingerer = options.ingerer;
  }

  /** Valide (7.3) PUIS persiste l'intention PUIS tente l'envoi. */
  async envoyer(
    rid: string,
    fichier: FichierAEnvoyer & { taille: number | null },
    legende?: string,
  ): Promise<void> {
    let regles = this.regles;
    if (regles === null) {
      try {
        regles = await lireReglesUpload(this.client);
        this.regles = regles; // seul un SUCCÈS est mémoïsé —
      } catch {
        // — un repli permissif mis en cache après un passage hors ligne
        // désactiverait la validation pour toute la session.
        regles = { tailleMax: null, typesAcceptes: null };
      }
    }
    validerFichier(regles, fichier);

    await this.depot.inserer({
      id: this.genererId(),
      rid,
      uri: fichier.uri,
      nom: fichier.nom,
      type: fichier.type,
      legende: legende ?? null,
    });
    await this.traiter();
  }

  /** Rejoue la file, une passe à la fois — même discipline que MoteurEnvoi. */
  async traiter(): Promise<void> {
    if (this.enVol) {
      this.repasser = true;
      return;
    }
    this.enVol = true;
    try {
      do {
        this.repasser = false;
        if (!(await this.unePasse())) return;
      } while (this.repasser);
    } finally {
      this.enVol = false;
    }
  }

  private async unePasse(): Promise<boolean> {
    for (const ligne of await this.depot.listerAEnvoyer()) {
      try {
        this.progression.set(ligne.id, 0);
        const message = await televerser({
          client: this.client,
          transport: this.transport,
          rid: ligne.rid,
          fichier: { uri: ligne.uri, nom: ligne.nom, type: ligne.type },
          message: ligne.legende ?? undefined,
          surProgression: (fraction) => this.progression.set(ligne.id, fraction),
        });
        await this.depot.supprimer(ligne.id);
        await this.ingerer(message);
      } catch (e) {
        if (e instanceof ErreurRest && e.statut === 0) return false;
        await this.depot.marquerEchec(ligne.id, e instanceof Error ? e.message : 'Envoi refusé.');
      } finally {
        this.progression.delete(ligne.id);
      }
    }
    return true;
  }

  async abandonner(id: string): Promise<void> {
    await this.depot.supprimer(id);
  }
}
