import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ErreurValidation,
  MoteurTeleversement,
  lireReglesUpload,
  validerFichier,
  type DepotTeleversements,
  type LigneTeleversement,
} from './envoiFichiers.ts';
import { ClientRest, ErreurRest } from './rest.ts';
import type { TransportUpload } from './upload.ts';

describe('validerFichier', () => {
  test('la taille maximale du serveur est respectée AVANT le moindre octet', () => {
    const regles = { tailleMax: 1000, typesAcceptes: null };
    validerFichier(regles, { type: 'image/png', taille: 999 });
    // Le refus porte une DONNÉE (code + params), pas une phrase : c'est le
    // contrat du point d'affichage (ui/validationFichiers.ts).
    assert.throws(
      () => validerFichier(regles, { type: 'image/png', taille: 1001 }),
      (e: unknown) =>
        e instanceof ErreurValidation &&
        e.detail.code === 'taille' &&
        e.detail.maxMo === '0.0',
    );
  });

  test('la liste blanche accepte les jokers `image/*`', () => {
    const regles = { tailleMax: null, typesAcceptes: ['image/*', 'application/pdf'] };
    validerFichier(regles, { type: 'image/png', taille: null });
    validerFichier(regles, { type: 'application/pdf', taille: null });
    assert.throws(
      () => validerFichier(regles, { type: 'video/mp4', taille: null }),
      (e: unknown) =>
        e instanceof ErreurValidation && e.detail.code === 'type' && e.detail.type === 'video/mp4',
    );
  });

  test('sans réglage, tout passe — le serveur tranchera', () => {
    validerFichier({ tailleMax: null, typesAcceptes: null }, { type: 'x/y', taille: 1e12 });
  });
});

describe('lireReglesUpload', () => {
  test('lit MaxFileSize et MediaTypeWhiteList depuis settings.public', async () => {
    const client = new ClientRest('http://x', {
      fetch: async () =>
        new Response(
          JSON.stringify({
            settings: [
              { _id: 'FileUpload_MaxFileSize', value: 104857600 },
              { _id: 'FileUpload_MediaTypeWhiteList', value: 'image/*, application/pdf' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      dormir: async () => {},
    });
    const regles = await lireReglesUpload(client);
    assert.equal(regles.tailleMax, 104857600);
    assert.deepEqual(regles.typesAcceptes, ['image/*', 'application/pdf']);
  });
});

/**
 * Dépôt en mémoire qui REPRODUIT la sémantique du SQL — en particulier le
 * filtre sur `en-attente` et l'atomicité de la prise en charge. Un faux plus
 * permissif que la vraie base ferait passer des tests que la production
 * échouerait.
 */
function fauxDepot() {
  const lignes = new Map<string, LigneTeleversement>();
  const postes = new Set<string>();
  /** Journal des appels : c'est lui qui distingue « pas marqué » de « marqué en attente ». */
  const appels: string[] = [];
  const depot: DepotTeleversements = {
    inserer: async (l) => void lignes.set(l.id, { ...l, statut: 'en-attente', fileId: null }),
    listerAEnvoyer: async () => {
      appels.push('lister');
      return [...lignes.values()].filter((l) => l.statut === 'en-attente');
    },
    prendreEnCharge: async (id) => {
      const l = lignes.get(id);
      if (l === undefined || l.statut !== 'en-attente') return false;
      l.statut = 'envoi';
      appels.push(`prendre:${id}`);
      return true;
    },
    rearmerEnVol: async (enVolIci) => {
      appels.push(`rearmerEnVol:[${enVolIci.join(',')}]`);
      for (const l of lignes.values()) {
        if (l.statut === 'envoi' && !enVolIci.includes(l.id)) l.statut = 'en-attente';
      }
    },
    rearmer: async (id) => {
      appels.push(`rearmer:${id}`);
      const l = lignes.get(id);
      if (l) l.statut = 'en-attente';
    },
    noterFileId: async (id, fileId) => {
      appels.push(`fileId:${id}=${fileId}`);
      const l = lignes.get(id);
      if (l) l.fileId = fileId;
    },
    fichierDejaPoste: async (_rid, fileId) => postes.has(fileId),
    marquerEchec: async (id, erreur) => {
      appels.push(`echec:${id}`);
      const l = lignes.get(id);
      if (l) {
        l.statut = 'echec';
        void erreur;
      }
    },
    supprimer: async (id) => {
      appels.push(`supprimer:${id}`);
      lignes.delete(id);
    },
  };
  return { depot, lignes, appels, postes };
}

const FICHIER = { uri: 'file:///a.png', nom: 'a.png', type: 'image/png', taille: 10 };

/** Une promesse qu'on dénoue à la main — jamais un délai. */
function verrou() {
  let ouvrir!: () => void;
  const attendre = new Promise<void>((r) => {
    ouvrir = r;
  });
  return { attendre, ouvrir };
}

function clientConfirmant() {
  return new ClientRest('http://x', {
    fetch: async (url) => {
      const corps = String(url).includes('mediaConfirm')
        ? { success: true, message: { _id: 'm1', rid: 'r1' } }
        : { settings: [] };
      return new Response(JSON.stringify(corps), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    dormir: async () => {},
  });
}

describe('MoteurTeleversement', () => {
  test('valider refuse sans rien persister, et les réglages ne sont lus qu’une fois', async () => {
    const { depot, lignes } = fauxDepot();
    let lectures = 0;
    const client = new ClientRest('http://x', {
      fetch: async () => {
        lectures++;
        return new Response(
          JSON.stringify({
            settings: [
              { _id: 'FileUpload_MaxFileSize', value: 100 },
              { _id: 'FileUpload_MediaTypeWhiteList', value: 'image/*' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
      dormir: async () => {},
    });
    const moteur = new MoteurTeleversement({
      depot,
      client,
      transport: async () => assert.fail('valider ne téléverse rien'),
      genererId: () => 'id-fichier-000000000000',
      ingerer: async () => {},
    });

    await moteur.valider({ type: 'image/png', taille: 99 });
    await assert.rejects(moteur.valider({ type: 'image/png', taille: 101 }), (e: unknown) => {
      return e instanceof ErreurValidation && e.detail.code === 'taille';
    });
    await assert.rejects(moteur.valider({ type: 'application/pdf', taille: 1 }), (e: unknown) => {
      return e instanceof ErreurValidation && e.detail.code === 'type';
    });
    assert.equal(lignes.size, 0);
    assert.equal(lectures, 1);
  });

  test('persiste AVANT l’envoi, téléverse, confirme, ingère, purge', async () => {
    const { depot, lignes } = fauxDepot();
    const ingeres: unknown[] = [];
    const transport: TransportUpload = async (_url, _entetes, _fichier, surProgression) => {
      surProgression?.(0.5);
      assert.equal(lignes.size, 1, "l'intention est persistée avant que l'octet parte");
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'id-fichier-000000000000',
      ingerer: async (doc) => void ingeres.push(doc),
    });

    await moteur.envoyer('r1', { uri: 'file:///a.png', nom: 'a.png', type: 'image/png', taille: 10 });

    assert.equal(lignes.size, 0, 'purgé au succès');
    assert.equal(ingeres.length, 1, 'le message confirmé repasse par la synchro');
  });

  test('un refus serveur marque `echec`, rejouable', async () => {
    const { depot, lignes } = fauxDepot();
    const transport: TransportUpload = async () => ({
      statut: 413,
      corps: JSON.stringify({ success: false, error: 'trop gros' }),
    });
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'id-fichier-000000000000',
      ingerer: async () => {},
    });
    await moteur.envoyer('r1', { uri: 'file:///a.png', nom: 'a.png', type: 'image/png', taille: 10 });
    assert.equal([...lignes.values()][0]?.statut, 'echec');
    assert.equal(moteur.progression.size, 0, 'la progression ne survit pas à l’échec');
  });

  /**
   * Le SEUL chemin qui laissait une ligne invisible : le réseau injoignable
   * n'est pas un refus. La ligne doit rester `en-attente` — c'est ce statut
   * que le bandeau du salon doit afficher, sans quoi le fichier disparaît de
   * l'écran sans le moindre signe et l'utilisateur le renvoie.
   */
  test('réseau injoignable : la ligne reste `en-attente`, rien n’est marqué en échec', async () => {
    const { depot, lignes, appels } = fauxDepot();
    const transport: TransportUpload = async () => {
      throw new ErreurRest('Upload : serveur injoignable.', 0);
    };
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'id-fichier-000000000000',
      ingerer: async () => {},
    });

    await moteur.envoyer('r1', FICHIER);

    assert.equal(lignes.size, 1, 'l’intention survit — le rejeu la reprendra');
    assert.equal([...lignes.values()][0]?.statut, 'en-attente');
    assert.ok(
      !appels.some((a) => a.startsWith('echec:')),
      'un injoignable n’est pas un refus : marquerEchec ne doit PAS être appelé',
    );
    assert.equal(moteur.progression.size, 0, 'la progression est vidée même sur abandon de passe');
  });

  test('un injoignable arrête la passe : la ligne suivante n’est pas tentée', async () => {
    const { depot, lignes, appels } = fauxDepot();
    let tentatives = 0;
    const transport: TransportUpload = async () => {
      tentatives++;
      throw new ErreurRest('Upload : serveur injoignable.', 0);
    };
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'x',
      ingerer: async () => {},
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });
    await depot.inserer({ id: 't2', rid: 'r1', ...FICHIER, legende: null });

    await moteur.traiter();

    assert.equal(tentatives, 1, 'insister sur un réseau mort gaspille les octets de t2');
    assert.equal(appels.filter((a) => a === 'lister').length, 1, 'aucune passe supplémentaire');
    // Les DEUX doivent rester rejouables : t1 ré-armée après sa prise en
    // charge, t2 jamais touchée.
    assert.deepEqual(
      [...lignes.values()].map((l) => l.statut),
      ['en-attente', 'en-attente'],
    );
  });

  /**
   * Le piège du statut `envoi` : il sort la ligne du listage. Si une panne
   * réseau la laissait dans cet état, le fichier ne repartirait plus jamais
   * — le défaut d'origine, en pire, puisqu'il survivrait au redémarrage.
   */
  test('une ligne prise en charge puis coupée redevient rejouable, pas figée en `envoi`', async () => {
    const { depot, lignes } = fauxDepot();
    let coupe = true;
    const transport: TransportUpload = async () => {
      if (coupe) throw new ErreurRest('Upload : serveur injoignable.', 0);
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'x',
      ingerer: async () => {},
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    await moteur.traiter();
    assert.equal([...lignes.values()][0]?.statut, 'en-attente');

    coupe = false;
    await moteur.traiter();
    assert.equal(lignes.size, 0, 'le réseau revenu, la même ligne part enfin');
  });

  test('un `envoi` orphelin d’un processus tué est repris au premier `traiter()`', async () => {
    const { depot, lignes } = fauxDepot();
    const transport: TransportUpload = async () => ({
      statut: 200,
      corps: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'x',
      ingerer: async () => {},
    });
    // L'état que laisse un kill en plein téléversement.
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });
    await depot.prendreEnCharge('t1');
    assert.equal([...lignes.values()][0]?.statut, 'envoi');

    await moteur.traiter();

    assert.equal(lignes.size, 0, 'sans le ré-armement, la ligne serait restée hors du listage');
  });

  test('un échec n’est PAS rejoué tout seul ; « Réessayer » le ré-arme', async () => {
    const { depot, lignes } = fauxDepot();
    let refuse = true;
    let tentatives = 0;
    const transport: TransportUpload = async () => {
      tentatives++;
      if (refuse) return { statut: 413, corps: JSON.stringify({ success: false, error: 'gros' }) };
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'x',
      ingerer: async () => {},
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    await moteur.traiter();
    assert.equal([...lignes.values()][0]?.statut, 'echec');
    assert.equal(tentatives, 1);

    // Ce que fait `apresRattrapage` à CHAQUE raccordement.
    await moteur.traiter();
    await moteur.traiter();
    assert.equal(tentatives, 1, 'la vidéo refusée ne repousse plus ses octets à chaque flap');

    refuse = false;
    await moteur.reessayer('t1');
    assert.equal(tentatives, 2, 'le geste explicite, LUI, retente');
    assert.equal(lignes.size, 0);
  });

  /**
   * Le cas de la réponse perdue : les octets sont partis, le serveur a créé le
   * message, mais `mediaConfirm` n'a jamais répondu. Rejouer depuis le début
   * postait un DOUBLON et laissait un orphelin de plus sur le serveur.
   */
  test('un `mediaConfirm` perdu ne re-téléverse rien et ne poste pas de doublon', async () => {
    const { depot, lignes, postes, appels } = fauxDepot();
    let octets = 0;
    let confirms = 0;
    const transport: TransportUpload = async () => {
      octets++;
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          // La réponse se perd : `ClientRest` en fait un statut 0.
          throw new TypeError('Network request failed');
        }
        return new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      dormir: async () => {},
    });
    const ingeres: unknown[] = [];
    const moteur = new MoteurTeleversement({
      depot,
      client,
      transport,
      genererId: () => 'x',
      ingerer: async (d) => void ingeres.push(d),
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    await moteur.traiter();
    assert.equal(octets, 1);
    assert.equal(confirms, 1);
    assert.ok(appels.includes('fileId:t1=f1'), 'le fileId est noté AVANT le confirm');
    assert.equal([...lignes.values()][0]?.statut, 'en-attente', 'rejouable');

    // Entre-temps, le stream DDP a livré le message que le confirm avait créé.
    postes.add('f1');

    await moteur.traiter();

    assert.equal(octets, 1, 'les octets ne repartent pas — c’est tout l’objet de file_id');
    assert.equal(confirms, 1, 'et AUCUN second message n’est posté');
    assert.equal(lignes.size, 0, 'la ligne est soldée sur la foi de la base locale');
    assert.equal(ingeres.length, 0, 'le message est déjà là, ingéré par le stream');
  });

  test('reprise après réponse perdue : si le message n’est PAS là, seul le confirm repart', async () => {
    const { depot, lignes } = fauxDepot();
    let octets = 0;
    let confirms = 0;
    const transport: TransportUpload = async () => {
      octets++;
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    let premier = true;
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          if (premier) {
            premier = false;
            throw new TypeError('Network request failed');
          }
          return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      dormir: async () => {},
    });
    const ingeres: unknown[] = [];
    const moteur = new MoteurTeleversement({
      depot,
      client,
      transport,
      genererId: () => 'x',
      ingerer: async (d) => void ingeres.push(d),
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    await moteur.traiter();
    await moteur.traiter();

    assert.equal(octets, 1, 'un seul passage des octets');
    assert.equal(confirms, 2, 'le confirm, lui, est bien retenté');
    assert.equal(lignes.size, 0);
    assert.equal(ingeres.length, 1);
  });

  /**
   * Le trou du garde-fou local : au redémarrage après un kill, aucun écran de
   * salon n'est monté, donc `stream-room-messages` n'est souscrit sur rien et
   * la base ignore le message créé par le confirm perdu. Sans rafraîchissement
   * ciblé, on re-confirmerait — et le serveur POSTE alors un doublon (sondé
   * sur 8.5 : il répond 200 en rendant le premier message).
   */
  test('base locale muette : on rafraîchit le salon AVANT de conclure, une seule fois', async () => {
    const { depot, lignes, postes } = fauxDepot();
    let confirms = 0;
    const rafraichis: string[] = [];
    const transport: TransportUpload = async () => ({
      statut: 200,
      corps: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          throw new TypeError('Network request failed');
        }
        return new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      dormir: async () => {},
    });
    const moteur = new MoteurTeleversement({
      depot,
      client,
      transport,
      genererId: () => 'x',
      ingerer: async () => {},
      // Le rattrapage rapporte le message : c'est ce que fait `rattraperSalon`.
      rafraichirSalon: async (rid) => {
        rafraichis.push(rid);
        postes.add('f1');
      },
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    await moteur.traiter(); // les octets partent, le confirm se perd
    assert.equal(confirms, 1);
    assert.deepEqual(rafraichis, [], 'aucun rafraîchissement sur le chemin nominal');

    await moteur.traiter(); // reprise : la base ne sait pas encore

    assert.deepEqual(rafraichis, ['r1'], 'un appel ciblé, sur CE salon');
    assert.equal(confirms, 1, 'et surtout : pas de second confirm');
    assert.equal(lignes.size, 0);
  });

  test('rafraîchissement impossible : on ne bloque pas la file dessus', async () => {
    const { depot, lignes } = fauxDepot();
    let confirms = 0;
    const transport: TransportUpload = async () => ({
      statut: 200,
      corps: JSON.stringify({ file: { _id: 'f1' } }),
    });
    let premier = true;
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          confirms++;
          if (premier) {
            premier = false;
            throw new TypeError('Network request failed');
          }
          return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      dormir: async () => {},
    });
    const moteur = new MoteurTeleversement({
      depot,
      client,
      transport,
      genererId: () => 'x',
      ingerer: async () => {},
      rafraichirSalon: async () => {
        throw new Error('rattrapage impossible');
      },
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    await moteur.traiter();
    await moteur.traiter();

    // Choix assumé : dans le doute, confirmer. Perdre le fichier serait pire
    // qu'un doublon visible et effaçable.
    assert.equal(confirms, 2);
    assert.equal(lignes.size, 0, 'la ligne finit soldée, pas bloquée à vie');
  });

  test('abandonner interrompt la tâche en vol et n’ingère rien', async () => {
    const { depot, lignes } = fauxDepot();
    const entree = verrou();
    const barriere = verrou();
    let annule = false;
    const transport: TransportUpload = async (_u, _e, _f, _p, surAnnulable) => {
      surAnnulable?.(async () => {
        annule = true;
        barriere.ouvrir();
      });
      entree.ouvrir();
      await barriere.attendre;
      // Une tâche annulée ne rend pas de fileId : `uploadAsync` a rendu null.
      if (annule) throw new Error('Téléversement annulé.');
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const ingeres: unknown[] = [];
    const effaces: string[] = [];
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'x',
      ingerer: async (d) => void ingeres.push(d),
      supprimerFichierLocal: async (uri) => void effaces.push(uri),
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    const passe = moteur.traiter();
    await entree.attendre;
    await moteur.abandonner('t1', FICHIER.uri);
    await passe;

    assert.ok(annule, 'la FileSystemUploadTask est vraiment interrompue');
    assert.equal(lignes.size, 0);
    assert.equal(ingeres.length, 0, 'le fichier ne doit pas apparaître après un abandon');
    assert.deepEqual(effaces, [FICHIER.uri], 'et le temporaire part avec lui');
  });

  /**
   * L'annulation peut PERDRE la course : `cancelAsync` n'a plus de prise une
   * fois `rooms.media` terminé. Deux gardes couvrent cette fenêtre, et il faut
   * les éprouver séparément — la première évite de poster, la seconde évite
   * d'afficher ce qu'on n'a pas pu ne pas poster.
   */
  test('abandon entre les octets et le confirm : AUCUN message n’est posté', async () => {
    const { depot, lignes } = fauxDepot();
    const entree = verrou();
    const barriere = verrou();
    let confirms = 0;
    const transport: TransportUpload = async () => {
      entree.ouvrir();
      await barriere.attendre; // l'abandon tombe ici, l'upload est fini
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) confirms++;
        return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      dormir: async () => {},
    });
    const ingeres: unknown[] = [];
    const moteur = new MoteurTeleversement({
      depot,
      client,
      transport,
      genererId: () => 'x',
      ingerer: async (d) => void ingeres.push(d),
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    const passe = moteur.traiter();
    await entree.attendre;
    await moteur.abandonner('t1');
    barriere.ouvrir();
    await passe;

    assert.equal(confirms, 0, 'c’est le confirm qui CRÉE le message : ne pas l’envoyer');
    assert.equal(ingeres.length, 0);
    assert.equal(lignes.size, 0);
  });

  test('abandon PENDANT le confirm : le message posté n’est pas ingéré', async () => {
    const { depot } = fauxDepot();
    const entree = verrou();
    const barriere = verrou();
    const transport: TransportUpload = async () => ({
      statut: 200,
      corps: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) {
          entree.ouvrir();
          await barriere.attendre; // l'abandon tombe pendant la requête
        }
        return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      dormir: async () => {},
    });
    const ingeres: unknown[] = [];
    const moteur = new MoteurTeleversement({
      depot,
      client,
      transport,
      genererId: () => 'x',
      ingerer: async (d) => void ingeres.push(d),
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    const passe = moteur.traiter();
    await entree.attendre;
    await moteur.abandonner('t1');
    barriere.ouvrir();
    await passe;

    // Honnêteté du test : le serveur A créé le message, et le stream DDP le
    // livrera. On ne prétend pas l'avoir dé-posté — seulement ne pas l'avoir
    // nous-mêmes remonté à l'écran.
    assert.equal(ingeres.length, 0, 'ce moteur n’ingère pas ce que l’usager a abandonné');
  });

  test('le fichier temporaire est effacé au succès', async () => {
    const { depot } = fauxDepot();
    const effaces: string[] = [];
    const transport: TransportUpload = async () => ({
      statut: 200,
      corps: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'id-fichier-000000000000',
      ingerer: async () => {},
      supprimerFichierLocal: async (uri) => void effaces.push(uri),
    });

    await moteur.envoyer('r1', FICHIER);

    assert.deepEqual(effaces, [FICHIER.uri], 'sinon le cache enfle sans fin');
  });

  test('un échec d’effacement ne fait pas échouer l’envoi', async () => {
    const { depot, lignes } = fauxDepot();
    const transport: TransportUpload = async () => ({
      statut: 200,
      corps: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'id-fichier-000000000000',
      ingerer: async () => {},
      supprimerFichierLocal: async () => {
        throw new Error('fichier déjà purgé par Android');
      },
    });

    await moteur.envoyer('r1', FICHIER);

    assert.equal(lignes.size, 0, 'le message est posté : le ménage est secondaire');
  });

  /**
   * `traiter()` est appelé à chaque raccordement ET à chaque envoi : deux
   * passes simultanées re-téléverseraient les mêmes octets. La garde
   * `enVol`/`repasser` doit fondre la demande concurrente dans une SEULE
   * repasse — sinon un fichier envoyé pendant le flush resterait en attente
   * jusqu'au prochain déclencheur.
   */
  test('un `traiter()` concurrent devient une repasse, pas une passe simultanée', async () => {
    const { depot, appels } = fauxDepot();
    const entree = verrou();
    const barriere = verrou();
    let premier = true;
    const transport: TransportUpload = async () => {
      if (premier) {
        premier = false;
        entree.ouvrir();
        await barriere.attendre;
      }
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'x',
      ingerer: async () => {},
    });
    await depot.inserer({ id: 't1', rid: 'r1', ...FICHIER, legende: null });

    const premierePasse = moteur.traiter();
    await entree.attendre; // la passe est VRAIMENT en vol — aucun délai d'attente
    await moteur.traiter(); // doit se contenter de noter la repasse et rendre
    assert.equal(
      appels.filter((a) => a === 'lister').length,
      1,
      'la demande concurrente ne relit pas la file pendant que l’autre passe court',
    );

    barriere.ouvrir();
    await premierePasse;

    assert.equal(
      appels.filter((a) => a === 'lister').length,
      2,
      'la repasse notée est bien exécutée À LA FIN de la première',
    );
    assert.equal(moteur.progression.size, 0);
  });

  test('la progression est vidée après un succès', async () => {
    const { depot } = fauxDepot();
    const vues: number[] = [];
    const transport: TransportUpload = async (_u, _e, _f, surProgression) => {
      surProgression?.(0.25);
      surProgression?.(1);
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'id-fichier-000000000000',
      ingerer: async () => {
        vues.push(moteur.progression.get('id-fichier-000000000000') ?? -1);
      },
    });

    await moteur.envoyer('r1', FICHIER);

    assert.deepEqual(vues, [1], 'la fraction est bien tenue à jour pendant l’envoi');
    assert.equal(moteur.progression.size, 0, 'et retirée ensuite — sinon la barre reste à 100 %');
  });
});
