import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ValidationError,
  encryptedFileAttachment,
  UploadEngine,
  readUploadRules,
  validateFile,
  type UploadStore,
  type UploadRow,
} from './uploadQueue.ts';
import { ClientRest, RestError } from './rest.ts';
import type { FileJwk } from './e2e/crypto.ts';
import type { TransportUpload } from './upload.ts';

describe('validerFichier', () => {
  test('la taille maximale du serveur est respectée AVANT le moindre octet', () => {
    const regles = { maxSize: 1000, acceptedTypes: null, encryptedFiles: true };
    validateFile(regles, { type: 'image/png', size: 999 });
    // Le refus porte une DONNÉE (code + params), pas une phrase : c'est le
    // contrat du point d'affichage (ui/fileValidation.ts).
    assert.throws(
      () => validateFile(regles, { type: 'image/png', size: 1001 }),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.detail.code === 'taille' &&
        e.detail.maxMb === '0.0',
    );
  });

  test('la liste blanche accepte les jokers `image/*`', () => {
    const regles = { maxSize: null, acceptedTypes: ['image/*', 'application/pdf'], encryptedFiles: true };
    validateFile(regles, { type: 'image/png', size: null });
    validateFile(regles, { type: 'application/pdf', size: null });
    assert.throws(
      () => validateFile(regles, { type: 'video/mp4', size: null }),
      (e: unknown) =>
        e instanceof ValidationError && e.detail.code === 'type' && e.detail.type === 'video/mp4',
    );
  });

  test('sans réglage, tout passe — le serveur tranchera', () => {
    validateFile({ maxSize: null, acceptedTypes: null, encryptedFiles: true }, { type: 'x/y', size: 1e12 });
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
      sleep: async () => {},
    });
    const regles = await readUploadRules(client);
    assert.equal(regles.maxSize, 104857600);
    assert.deepEqual(regles.acceptedTypes, ['image/*', 'application/pdf']);
  });
});

/**
 * Dépôt en mémoire qui REPRODUIT la sémantique du SQL — en particulier le
 * filtre sur `en-attente` et l'atomicité de la prise en charge. Un faux plus
 * permissif que la vraie base ferait passer des tests que la production
 * échouerait.
 */
function fauxDepot() {
  const lignes = new Map<string, UploadRow>();
  const postes = new Set<string>();
  /** Journal des appels : c'est lui qui distingue « pas marqué » de « marqué en attente ». */
  const appels: string[] = [];
  const depot: UploadStore = {
    insert: async (l) => void lignes.set(l.id, { ...l, status: 'en-attente', fileId: null }),
    listToSend: async () => {
      appels.push('lister');
      return [...lignes.values()].filter((l) => l.status === 'en-attente');
    },
    claim: async (id) => {
      const l = lignes.get(id);
      if (l === undefined || l.status !== 'en-attente') return false;
      l.status = 'envoi';
      appels.push(`prendre:${id}`);
      return true;
    },
    rearmInFlight: async (enVolIci) => {
      appels.push(`rearmerEnVol:[${enVolIci.join(',')}]`);
      for (const l of lignes.values()) {
        if (l.status === 'envoi' && !enVolIci.includes(l.id)) l.status = 'en-attente';
      }
    },
    rearm: async (id) => {
      appels.push(`rearmer:${id}`);
      const l = lignes.get(id);
      if (l) l.status = 'en-attente';
    },
    recordFileId: async (id, fileId) => {
      appels.push(`fileId:${id}=${fileId}`);
      const l = lignes.get(id);
      if (l) l.fileId = fileId;
    },
    fileAlreadyPosted: async (_rid, fileId) => postes.has(fileId),
    markFailed: async (id, erreur) => {
      appels.push(`echec:${id}`);
      const l = lignes.get(id);
      if (l) {
        l.status = 'echec';
        void erreur;
      }
    },
    delete: async (id) => {
      appels.push(`supprimer:${id}`);
      lignes.delete(id);
    },
  };
  return { depot, lignes, appels, postes };
}

const FICHIER = { uri: 'file:///a.png', name: 'a.png', type: 'image/png', size: 10 };

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
    sleep: async () => {},
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
      sleep: async () => {},
    });
    const moteur = new UploadEngine({
      store: depot,
      client,
      transport: async () => assert.fail('valider ne téléverse rien'),
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
    });

    await moteur.validate({ type: 'image/png', size: 99 });
    await assert.rejects(moteur.validate({ type: 'image/png', size: 101 }), (e: unknown) => {
      return e instanceof ValidationError && e.detail.code === 'taille';
    });
    await assert.rejects(moteur.validate({ type: 'application/pdf', size: 1 }), (e: unknown) => {
      return e instanceof ValidationError && e.detail.code === 'type';
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
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async (doc) => void ingeres.push(doc),
    });

    await moteur.send('r1', { uri: 'file:///a.png', name: 'a.png', type: 'image/png', size: 10 });

    assert.equal(lignes.size, 0, 'purgé au succès');
    assert.equal(ingeres.length, 1, 'le message confirmé repasse par la synchro');
  });

  test('un refus serveur marque `echec`, rejouable', async () => {
    const { depot, lignes } = fauxDepot();
    const transport: TransportUpload = async () => ({
      status: 413,
      body: JSON.stringify({ success: false, error: 'trop gros' }),
    });
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
    });
    await moteur.send('r1', { uri: 'file:///a.png', name: 'a.png', type: 'image/png', size: 10 });
    assert.equal([...lignes.values()][0]?.status, 'echec');
    assert.equal(moteur.progress.size, 0, 'la progression ne survit pas à l’échec');
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
      throw new RestError('Upload : serveur injoignable.', 0);
    };
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
    });

    await moteur.send('r1', FICHIER);

    assert.equal(lignes.size, 1, 'l’intention survit — le rejeu la reprendra');
    assert.equal([...lignes.values()][0]?.status, 'en-attente');
    assert.ok(
      !appels.some((a) => a.startsWith('echec:')),
      'un injoignable n’est pas un refus : marquerEchec ne doit PAS être appelé',
    );
    assert.equal(moteur.progress.size, 0, 'la progression est vidée même sur abandon de passe');
  });

  test('un injoignable arrête la passe : la ligne suivante n’est pas tentée', async () => {
    const { depot, lignes, appels } = fauxDepot();
    let tentatives = 0;
    const transport: TransportUpload = async () => {
      tentatives++;
      throw new RestError('Upload : serveur injoignable.', 0);
    };
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });
    await depot.insert({ id: 't2', rid: 'r1', ...FICHIER, caption: null });

    await moteur.process();

    assert.equal(tentatives, 1, 'insister sur un réseau mort gaspille les octets de t2');
    assert.equal(appels.filter((a) => a === 'lister').length, 1, 'aucune passe supplémentaire');
    // Les DEUX doivent rester rejouables : t1 ré-armée après sa prise en
    // charge, t2 jamais touchée.
    assert.deepEqual(
      [...lignes.values()].map((l) => l.status),
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
      if (coupe) throw new RestError('Upload : serveur injoignable.', 0);
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    await moteur.process();
    assert.equal([...lignes.values()][0]?.status, 'en-attente');

    coupe = false;
    await moteur.process();
    assert.equal(lignes.size, 0, 'le réseau revenu, la même ligne part enfin');
  });

  test('un `envoi` orphelin d’un processus tué est repris au premier `traiter()`', async () => {
    const { depot, lignes } = fauxDepot();
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    // L'état que laisse un kill en plein téléversement.
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });
    await depot.claim('t1');
    assert.equal([...lignes.values()][0]?.status, 'envoi');

    await moteur.process();

    assert.equal(lignes.size, 0, 'sans le ré-armement, la ligne serait restée hors du listage');
  });

  test('un échec n’est PAS rejoué tout seul ; « Réessayer » le ré-arme', async () => {
    const { depot, lignes } = fauxDepot();
    let refuse = true;
    let tentatives = 0;
    const transport: TransportUpload = async () => {
      tentatives++;
      if (refuse) return { status: 413, body: JSON.stringify({ success: false, error: 'gros' }) };
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    await moteur.process();
    assert.equal([...lignes.values()][0]?.status, 'echec');
    assert.equal(tentatives, 1);

    // Ce que fait `apresRattrapage` à CHAQUE raccordement.
    await moteur.process();
    await moteur.process();
    assert.equal(tentatives, 1, 'la vidéo refusée ne repousse plus ses octets à chaque flap');

    refuse = false;
    await moteur.retry('t1');
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
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
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
      sleep: async () => {},
    });
    const ingeres: unknown[] = [];
    const moteur = new UploadEngine({
      store: depot,
      client,
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingeres.push(d),
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    await moteur.process();
    assert.equal(octets, 1);
    assert.equal(confirms, 1);
    assert.ok(appels.includes('fileId:t1=f1'), 'le fileId est noté AVANT le confirm');
    assert.equal([...lignes.values()][0]?.status, 'en-attente', 'rejouable');

    // Entre-temps, le stream DDP a livré le message que le confirm avait créé.
    postes.add('f1');

    await moteur.process();

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
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
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
      sleep: async () => {},
    });
    const ingeres: unknown[] = [];
    const moteur = new UploadEngine({
      store: depot,
      client,
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingeres.push(d),
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    await moteur.process();
    await moteur.process();

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
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
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
      sleep: async () => {},
    });
    const moteur = new UploadEngine({
      store: depot,
      client,
      transport,
      generateId: () => 'x',
      ingest: async () => {},
      // Le rattrapage rapporte le message : c'est ce que fait `rattraperSalon`.
      refreshRoom: async (rid) => {
        rafraichis.push(rid);
        postes.add('f1');
      },
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    await moteur.process(); // les octets partent, le confirm se perd
    assert.equal(confirms, 1);
    assert.deepEqual(rafraichis, [], 'aucun rafraîchissement sur le chemin nominal');

    await moteur.process(); // reprise : la base ne sait pas encore

    assert.deepEqual(rafraichis, ['r1'], 'un appel ciblé, sur CE salon');
    assert.equal(confirms, 1, 'et surtout : pas de second confirm');
    assert.equal(lignes.size, 0);
  });

  test('rafraîchissement impossible : on ne bloque pas la file dessus', async () => {
    const { depot, lignes } = fauxDepot();
    let confirms = 0;
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
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
      sleep: async () => {},
    });
    const moteur = new UploadEngine({
      store: depot,
      client,
      transport,
      generateId: () => 'x',
      ingest: async () => {},
      refreshRoom: async () => {
        throw new Error('rattrapage impossible');
      },
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    await moteur.process();
    await moteur.process();

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
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const ingeres: unknown[] = [];
    const effaces: string[] = [];
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingeres.push(d),
      deleteLocalFile: async (uri) => void effaces.push(uri),
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    const passe = moteur.process();
    await entree.attendre;
    await moteur.discard('t1', FICHIER.uri);
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
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        if (String(url).includes('mediaConfirm')) confirms++;
        return new Response(JSON.stringify({ success: true, message: { _id: 'm1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });
    const ingeres: unknown[] = [];
    const moteur = new UploadEngine({
      store: depot,
      client,
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingeres.push(d),
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    const passe = moteur.process();
    await entree.attendre;
    await moteur.discard('t1');
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
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
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
      sleep: async () => {},
    });
    const ingeres: unknown[] = [];
    const moteur = new UploadEngine({
      store: depot,
      client,
      transport,
      generateId: () => 'x',
      ingest: async (d) => void ingeres.push(d),
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    const passe = moteur.process();
    await entree.attendre;
    await moteur.discard('t1');
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
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
      deleteLocalFile: async (uri) => void effaces.push(uri),
    });

    await moteur.send('r1', FICHIER);

    assert.deepEqual(effaces, [FICHIER.uri], 'sinon le cache enfle sans fin');
  });

  test('un échec d’effacement ne fait pas échouer l’envoi', async () => {
    const { depot, lignes } = fauxDepot();
    const transport: TransportUpload = async () => ({
      status: 200,
      body: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
      deleteLocalFile: async () => {
        throw new Error('fichier déjà purgé par Android');
      },
    });

    await moteur.send('r1', FICHIER);

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
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'x',
      ingest: async () => {},
    });
    await depot.insert({ id: 't1', rid: 'r1', ...FICHIER, caption: null });

    const premierePasse = moteur.process();
    await entree.attendre; // la passe est VRAIMENT en vol — aucun délai d'attente
    await moteur.process(); // doit se contenter de noter la repasse et rendre
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
    assert.equal(moteur.progress.size, 0);
  });

  test('la progression est vidée après un succès', async () => {
    const { depot } = fauxDepot();
    const vues: number[] = [];
    const transport: TransportUpload = async (_u, _e, _f, surProgression) => {
      surProgression?.(0.25);
      surProgression?.(1);
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new UploadEngine({
      store: depot,
      client: clientConfirmant(),
      transport,
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {
        vues.push(moteur.progress.get('id-fichier-000000000000') ?? -1);
      },
    });

    await moteur.send('r1', FICHIER);

    assert.deepEqual(vues, [1], 'la fraction est bien tenue à jour pendant l’envoi');
    assert.equal(moteur.progress.size, 0, 'et retirée ensuite — sinon la barre reste à 100 %');
  });
});

describe('MoteurTeleversement — salon chiffré', () => {
  const CONTENU = { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: 'aXY=', ciphertext: 'Y3Q=' };
  const JWK: FileJwk = { kty: 'oct', alg: 'A256CTR', k: 'Y2xl', ext: true, key_ops: ['encrypt', 'decrypt'] };

  function chiffrement(options: { key?: () => boolean } = {}) {
    const charges: object[] = [];
    const fichiersChiffres: string[] = [];
    return {
      charges,
      fichiersChiffres,
      encryption: {
        roomEncrypted: async (rid: string) => rid === 'p1',
        encrypt: (_rid: string, charge: object) => {
          if (options.key && !options.key()) return null;
          charges.push(charge);
          return CONTENU;
        },
        encryptFile: async (uri: string) => {
          fichiersChiffres.push(uri);
          return { uri: `${uri}.chiffre`, key: JWK, iv: 'Y3RyMTY=', sha256: 'abc', size: 10 };
        },
        hashedName: (nom: string) => `hache(${nom})`,
      },
    };
  }

  function clientQuiConfirme(corpsConfirmes: unknown[], reglages: unknown[] = []) {
    return new ClientRest('http://x', {
      fetch: async (url, init) => {
        const confirm = String(url).includes('mediaConfirm');
        if (confirm) corpsConfirmes.push(JSON.parse(String(init?.body)));
        const corps = confirm ? { success: true, message: { _id: 'm1', rid: 'p1' } } : { settings: reglages };
        return new Response(JSON.stringify(corps), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      sleep: async () => {},
    });
  }

  test('le fichier part chiffré sous l’empreinte de son nom ; nom, clé et légende ne voyagent que chiffrés', async () => {
    const { depot, lignes } = fauxDepot();
    const { encryption: c, charges } = chiffrement();
    const envois: { file: unknown; fields: unknown }[] = [];
    const confirmes: unknown[] = [];
    const effaces: string[] = [];
    const moteur = new UploadEngine({
      store: depot,
      client: clientQuiConfirme(confirmes, [{ _id: 'E2E_Enable_Encrypt_Files', value: true }]),
      transport: async (_url, _entetes, fichier, _p, _a, champs) => {
        envois.push({ file: fichier, fields: champs });
        return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
      },
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
      deleteLocalFile: async (uri) => void effaces.push(uri),
      encryption: c,
    });

    await moteur.send('p1', { uri: 'file:///cache/a.png', name: 'vacances.png', type: 'image/png', size: 10 }, 'la plage');

    assert.deepEqual(envois, [
      {
        file: { uri: 'file:///cache/a.png.chiffre', name: 'hache(vacances.png)', type: 'application/octet-stream' },
        fields: { content: JSON.stringify(CONTENU) },
      },
    ]);
    assert.deepEqual(confirmes, [{ msg: '', t: 'e2e', content: CONTENU, fileContent: CONTENU }]);
    const message = charges.find((ch) => 'attachments' in ch) as { msg: string; attachments: Record<string, unknown>[] };
    assert.equal(message.msg, 'la plage');
    assert.equal(message.attachments[0].title, 'vacances.png');
    assert.equal(message.attachments[0].image_url, '/file-upload/f1/hache(vacances.png)');
    assert.deepEqual(message.attachments[0].encryption, { key: JWK, iv: 'Y3RyMTY=' });
    assert.deepEqual(effaces, ['file:///cache/a.png.chiffre', 'file:///cache/a.png']);
    assert.equal(lignes.size, 0);
  });

  test('verrouillé : rien ne part, la ligne attend sans échouer', async () => {
    const { depot, lignes, appels } = fauxDepot();
    let cle = false;
    const { encryption: c } = chiffrement({ key: () => cle });
    let envois = 0;
    const moteur = new UploadEngine({
      store: depot,
      client: clientQuiConfirme([], [{ _id: 'E2E_Enable_Encrypt_Files', value: true }]),
      transport: async () => {
        envois++;
        return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
      },
      generateId: () => 'id-fichier-000000000000',
      ingest: async () => {},
      encryption: c,
    });

    await moteur.send('p1', FICHIER);
    assert.equal(envois, 0);
    assert.equal([...lignes.values()][0].status, 'en-attente');
    assert.ok(!appels.some((a) => a.startsWith('echec')));

    cle = true;
    await moteur.process();
    assert.equal(envois, 1);
    assert.equal(lignes.size, 0);
  });

  test('clé perdue entre les deux temps (processus tué) : le fichier repart, chiffré à neuf', async () => {
    const { depot, lignes } = fauxDepot();
    const { encryption: c, fichiersChiffres } = chiffrement();
    await depot.insert({ id: 'l1', rid: 'p1', uri: 'file:///cache/a.png', name: 'a.png', type: 'image/png', caption: null });
    await depot.recordFileId('l1', 'f-ancien');
    const confirmes: unknown[] = [];
    const moteur = new UploadEngine({
      store: depot,
      client: clientQuiConfirme(confirmes),
      transport: async () => ({ status: 200, body: JSON.stringify({ file: { _id: 'f-neuf' } }) }),
      generateId: () => 'x',
      ingest: async () => {},
      encryption: c,
    });

    await moteur.process();
    assert.deepEqual(fichiersChiffres, ['file:///cache/a.png']);
    assert.equal(confirmes.length, 1);
    assert.equal(lignes.size, 0);
  });

  test('serveur sans fichiers chiffrés : refusé dès la pose', async () => {
    const { depot } = fauxDepot();
    const moteur = new UploadEngine({
      store: depot,
      client: clientQuiConfirme([], [{ _id: 'E2E_Enable_Encrypt_Files', value: false }]),
      transport: async () => assert.fail('rien ne part'),
      generateId: () => 'x',
      ingest: async () => {},
      encryption: chiffrement().encryption,
    });
    await assert.rejects(moteur.validate({ type: 'image/png', size: 1 }, 'p1'), (e: unknown) => {
      return e instanceof ValidationError && e.detail.code === 'chiffre';
    });
    await moteur.validate({ type: 'image/png', size: 1 }, 'r-clair');
  });
});

describe('jointeDeFichierChiffre', () => {
  const cle: FileJwk = { kty: 'oct', alg: 'A256CTR', k: 'k', ext: true, key_ops: ['encrypt', 'decrypt'] };
  const commun = { fileId: 'f1', url: '/file-upload/f1/h', size: 42, key: cle, iv: 'iv', sha256: 'abc' };

  test('une image s’annonce comme image', () => {
    const j = encryptedFileAttachment({ ...commun, name: 'a.jpg', type: 'image/jpeg' });
    assert.equal(j.image_url, '/file-upload/f1/h');
    assert.equal(j.image_type, 'image/jpeg');
    assert.equal(j.image_size, 42);
    assert.equal(j.title_link, '/file-upload/f1/h');
  });

  test('un autre fichier porte son poids et son format', () => {
    const j = encryptedFileAttachment({ ...commun, name: 'Rapport.PDF', type: 'application/pdf' });
    assert.equal(j.size, 42);
    assert.equal(j.format, 'pdf');
    assert.equal(j.image_url, undefined);
  });
});
