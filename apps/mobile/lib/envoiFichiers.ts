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
import {
  confirmerMedia,
  televerserOctets,
  type FichierAEnvoyer,
  type TransportUpload,
} from './upload.ts';

export type LigneTeleversement = {
  id: string;
  rid: string;
  uri: string;
  nom: string;
  type: string;
  legende: string | null;
  statut: 'en-attente' | 'envoi' | 'echec';
  /** Rendu par `rooms.media`. Non nul = les octets sont déjà chez le serveur. */
  fileId: string | null;
};

export interface DepotTeleversements {
  inserer(ligne: Omit<LigneTeleversement, 'statut' | 'fileId'>): Promise<void>;
  /** Les `en-attente` seulement, dans l'ordre de création. */
  listerAEnvoyer(): Promise<LigneTeleversement[]>;
  /** Saisit la ligne (`en-attente` → `envoi`). `false` si une autre passe l'a prise. */
  prendreEnCharge(id: string): Promise<boolean>;
  /** Rend au rejeu les `envoi` orphelins d'un processus tué, SAUF ceux encore en vol ici. */
  rearmerEnVol(enVolIci: string[]): Promise<void>;
  /** Le geste « Réessayer » : un échec redevient candidat. */
  rearmer(id: string): Promise<void>;
  noterFileId(id: string, fileId: string): Promise<void>;
  /** Le message portant ce fichier est-il DÉJÀ en base ? Local, jamais réseau. */
  fichierDejaPoste(rid: string, fileId: string): Promise<boolean>;
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
 * phrase se fait au point d'affichage (`phraseValidation`, ui/validationFichiers.ts).
 */
export type DetailValidation = { code: 'taille'; maxMo: string } | { code: 'type'; type: string };

export class ErreurValidation extends Error {
  readonly detail: DetailValidation;

  constructor(detail: DetailValidation) {
    // `message` est un diagnostic (logs) — jamais la chaîne affichée.
    super(detail.code === 'taille' ? `taille > ${detail.maxMo} Mo` : `type ${detail.type} refusé`);
    this.name = 'ErreurValidation';
    this.detail = detail;
  }
}

/** `image/*` dans la liste blanche accepte `image/png`, etc. */
export function validerFichier(
  regles: ReglesUpload,
  fichier: { type: string; taille: number | null },
): void {
  if (regles.tailleMax !== null && fichier.taille !== null && fichier.taille > regles.tailleMax) {
    const mo = (regles.tailleMax / 1024 / 1024).toFixed(1);
    throw new ErreurValidation({ code: 'taille', maxMo: mo });
  }
  if (regles.typesAcceptes !== null) {
    const accepte = regles.typesAcceptes.some((motif) => {
      if (motif === fichier.type) return true;
      const [famille, sous] = motif.split('/');
      return sous === '*' && fichier.type.startsWith(`${famille}/`);
    });
    if (!accepte) {
      throw new ErreurValidation({ code: 'type', type: fichier.type });
    }
  }
}

export class MoteurTeleversement {
  private readonly depot: DepotTeleversements;
  private readonly client: ClientRest;
  private readonly transport: TransportUpload;
  private readonly genererId: () => string;
  private readonly ingerer: (doc: Record<string, unknown>) => Promise<void>;
  private readonly supprimerFichierLocal: ((uri: string) => Promise<void>) | undefined;
  private readonly rafraichirSalon: ((rid: string) => Promise<void>) | undefined;
  private enVol = false;
  private repasser = false;
  /** Progression 0..1 du téléversement en cours, par id — pour l'UI. */
  readonly progression = new Map<string, number>();
  private regles: ReglesUpload | null = null;
  /** Faux tant que les `envoi` orphelins du processus d'avant n'ont pas été rendus. */
  private rearme = false;
  /** Ids abandonnés pendant leur propre envoi — vérifiés avant de poster. */
  private readonly abandonnes = new Set<string>();
  /** Interrupteurs des tâches en vol, posés par le transport. */
  private readonly annulations = new Map<string, () => Promise<void>>();
  private readonly auditeurs = new Set<() => void>();

  constructor(options: {
    depot: DepotTeleversements;
    client: ClientRest;
    transport: TransportUpload;
    genererId: () => string;
    ingerer: (doc: Record<string, unknown>) => Promise<void>;
    /**
     * Efface le fichier local d'une ligne soldée (succès ou abandon). Injecté
     * plutôt qu'importé : `expo-file-system` n'existe pas sous Node, et ce
     * module doit rester testable sans lui. L'implémentation décide seule si
     * l'URI est bien dans le cache de l'app — on n'efface JAMAIS un fichier
     * que l'utilisateur a choisi ailleurs.
     */
    supprimerFichierLocal?: (uri: string) => Promise<void>;
    /**
     * Rapatrie les messages récents d'un salon. Appelé UNIQUEMENT quand un
     * `file_id` déjà persisté oblige à savoir si le message existe et que la
     * base locale ne le sait pas — donc jamais sur le chemin nominal.
     */
    rafraichirSalon?: (rid: string) => Promise<void>;
  }) {
    this.depot = options.depot;
    this.client = options.client;
    this.transport = options.transport;
    this.genererId = options.genererId;
    this.ingerer = options.ingerer;
    this.supprimerFichierLocal = options.supprimerFichierLocal;
    this.rafraichirSalon = options.rafraichirSalon;
  }

  /**
   * S'abonner aux changements de `progression` — c'est ce qui fait bouger la
   * barre du bandeau. Un `useRequeteVive` ne suffit pas : la fraction ne vit
   * qu'en mémoire, aucune écriture SQLite ne la porte.
   */
  abonner(auditeur: () => void): () => void {
    this.auditeurs.add(auditeur);
    return () => void this.auditeurs.delete(auditeur);
  }

  private publier(): void {
    for (const auditeur of this.auditeurs) auditeur();
  }

  private async reglesUpload(): Promise<ReglesUpload> {
    if (this.regles !== null) return this.regles;
    try {
      const regles = await lireReglesUpload(this.client);
      this.regles = regles; // seul un SUCCÈS est mémoïsé —
      return regles;
    } catch {
      // — un repli permissif mis en cache après un passage hors ligne
      // désactiverait la validation pour toute la session.
      return { tailleMax: null, typesAcceptes: null };
    }
  }

  /**
   * La validation seule, sans rien persister : le composer refuse une pièce
   * dès qu'on la pose, pas au moment d'envoyer. `envoyer` revalide de toute
   * façon — la pièce a pu être réduite entre-temps.
   */
  async valider(fichier: { type: string; taille: number | null }): Promise<void> {
    validerFichier(await this.reglesUpload(), fichier);
  }

  /** Valide (7.3) PUIS persiste l'intention PUIS tente l'envoi. */
  async envoyer(
    rid: string,
    fichier: FichierAEnvoyer & { taille: number | null },
    legende?: string,
  ): Promise<void> {
    validerFichier(await this.reglesUpload(), fichier);

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
      // Une seule fois par processus, AVANT la première lecture de la file :
      // un `envoi` ne peut avoir été posé que par une exécution précédente,
      // tuée en plein téléversement. Sans ce geste, sa ligne resterait hors du
      // listage à vie et le fichier ne partirait jamais.
      if (!this.rearme) {
        this.rearme = true;
        await this.depot.rearmerEnVol([...EN_VOL_ICI]);
      }
      do {
        this.repasser = false;
        if (!(await this.unePasse())) return;
      } while (this.repasser);
    } finally {
      this.enVol = false;
    }
  }

  /** Le geste explicite « Réessayer » — le seul qui sorte une ligne de l'échec. */
  async reessayer(id: string): Promise<void> {
    await this.depot.rearmer(id);
    await this.traiter();
  }

  private async unePasse(): Promise<boolean> {
    for (const ligne of await this.depot.listerAEnvoyer()) {
      // Saisie atomique : si une autre passe l'a déjà prise, on la laisse.
      if (!(await this.depot.prendreEnCharge(ligne.id))) continue;
      EN_VOL_ICI.add(ligne.id);
      try {
        this.progression.set(ligne.id, 0);
        this.publier();
        if (!(await this.poster(ligne))) return false;
      } catch (e) {
        if (this.abandonnes.has(ligne.id)) {
          // L'annulation a fait échouer la tâche, c'est le résultat voulu :
          // la ligne est déjà supprimée, il n'y a rien à marquer.
          continue;
        }
        if (e instanceof ErreurRest && e.statut === 0) {
          // Injoignable. La ligne doit REDEVENIR `en-attente` : la laisser en
          // `envoi` la sortirait du listage jusqu'au prochain lancement.
          await this.depot.rearmer(ligne.id);
          return false;
        }
        // `derniere_erreur` est un DIAGNOSTIC (jamais affiché — l'UI montre
        // `ligneMessage.echecReessayer`) : pas une chaîne à traduire.
        await this.depot.marquerEchec(ligne.id, e instanceof Error ? e.message : 'Envoi refusé.');
      } finally {
        EN_VOL_ICI.delete(ligne.id);
        this.progression.delete(ligne.id);
        this.annulations.delete(ligne.id);
        this.abandonnes.delete(ligne.id);
        this.publier();
      }
    }
    return true;
  }

  /**
   * Une ligne, en deux temps séparés par une écriture. Rend `false` quand le
   * réseau est mort et qu'il faut arrêter la passe.
   */
  private async poster(ligne: LigneTeleversement): Promise<boolean> {
    let fileId = ligne.fileId;

    if (fileId === null) {
      fileId = await televerserOctets({
        client: this.client,
        transport: this.transport,
        rid: ligne.rid,
        fichier: { uri: ligne.uri, nom: ligne.nom, type: ligne.type },
        surProgression: (fraction) => this.noterProgression(ligne.id, fraction),
        surAnnulable: (annuler) => void this.annulations.set(ligne.id, annuler),
      });
      // AVANT le confirm : c'est tout l'objet de la colonne.
      await this.depot.noterFileId(ligne.id, fileId);
    } else if (await this.dejaPoste(ligne.rid, fileId)) {
      // Les octets étaient déjà partis ET le message est là : le confirm avait
      // abouti, seule sa réponse s'est perdue. Re-confirmer posterait un
      // doublon. On solde la ligne, sans rien envoyer.
      await this.solder(ligne);
      return true;
    }

    // Dernière fenêtre où « Abandonner » peut encore empêcher le message
    // d'exister : après le confirm, le serveur l'a créé et le stream DDP le
    // livrera de toute façon — on ne peut plus le dé-poster.
    if (this.abandonnes.has(ligne.id)) return true;

    const message = await confirmerMedia({
      client: this.client,
      rid: ligne.rid,
      fileId,
      message: ligne.legende ?? undefined,
    });
    await this.solder(ligne);
    if (!this.abandonnes.has(ligne.id)) await this.ingerer(message);
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
  private async dejaPoste(rid: string, fileId: string): Promise<boolean> {
    if (await this.depot.fichierDejaPoste(rid, fileId)) return true;
    if (this.rafraichirSalon === undefined) return false;
    try {
      await this.rafraichirSalon(rid);
    } catch {
      // Rafraîchissement impossible : on ne sait toujours pas. Voir plus bas
      // le choix assumé entre le doublon et la perte.
      return false;
    }
    return this.depot.fichierDejaPoste(rid, fileId);
  }

  /** Ligne soldée : plus de file, plus de fichier temporaire. */
  private async solder(ligne: LigneTeleversement): Promise<void> {
    await this.depot.supprimer(ligne.id);
    await this.supprimerFichierLocal?.(ligne.uri).catch(() => {});
  }

  /**
   * Ne réveille l'UI qu'au changement de POURCENT ENTIER. Le transport rend la
   * main à chaque bloc : re-rendre l'écran de salon à cette cadence coûterait
   * plus cher que le téléversement lui-même.
   */
  private noterProgression(id: string, fraction: number): void {
    const avant = this.progression.get(id) ?? 0;
    this.progression.set(id, fraction);
    if (Math.floor(fraction * 100) !== Math.floor(avant * 100)) this.publier();
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
  async abandonner(id: string, uri?: string): Promise<void> {
    this.abandonnes.add(id);
    await this.depot.supprimer(id);
    const annuler = this.annulations.get(id);
    if (annuler !== undefined) await annuler().catch(() => {});
    if (uri !== undefined) await this.supprimerFichierLocal?.(uri).catch(() => {});
    this.progression.delete(id);
    this.publier();
  }
}
