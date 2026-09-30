/** Native protocol adapter for the existing screens; NativeChat owns journal/outbox commits. */
import type { Session } from '../../lib/auth.ts';
import type { Capacites, Fournisseur, Listener, OutboxFichiers } from '../../lib/fournisseur.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { NativeChat } from './chat.ts';
import { NativeStore, localMessage } from './store.ts';
import { decodeNative } from './validation.ts';
import { NativeError } from './transport.ts';

export const CAPACITES_ROCKETVIBE: Capacites = {
  typing:false, presence:false, push:false, e2ee:false, emojisCustom:false,
  appelVideo:false, recherche:false, modeleFil:'tmid',
  fichiers:false, fils:false, reactions:false, marques:false, profil:false, infosSalon:false, citations:false,
};
const unsupported = async (): Promise<never> => { throw new NativeError(501,'unsupported_feature'); };
const noSubscription = () => () => {};

export function creerFournisseurRV(session: Session, client: ClientRest, genererId: () => string, store: NativeStore, options: ConstructorParameters<typeof NativeChat>[3] = {}): Fournisseur {
  const chat = new NativeChat(session,store,genererId,{revoke: token => client.surJetonRefuse?.(token),...options});
  const listener: Listener = {
    get etat() { return chat.status.online ? 'authentifie' : 'ferme'; },
    connecter: () => chat.connect(), fermer: () => chat.stop(), verifierVie: async () => chat.status.online,
    souscrire:noSubscription, surEvenement:noSubscription, surPerte:noSubscription,
    souscriptionsArmees:async () => {}, reinitialiser:() => {},
  };
  const fichiers: OutboxFichiers = {
    progression:new Map(), abonner:noSubscription, valider:unsupported,
    envoyer:unsupported, traiter:unsupported, reessayer:unsupported, abandonner:unsupported,
  };
  return {
    native:{chat,store}, ordreMessages:'sequence', capacites:CAPACITES_ROCKETVIBE, listener,
    traducteur:{
      traduireEvenement:() => ({sorte:'silence'}),
      versMessage:brut => localMessage(decodeNative('Message',brut)),
      versSalon:() => null, versAbonnement:() => null,
    },
    actions:{
      reagir:unsupported, modifier:unsupported, supprimer:unsupported, epingler:unsupported,
      desepingler:unsupported, etoiler:unsupported, listerEpingles:unsupported, listerEtoiles:unsupported,
      marquerLu:async () => {},
      ouvrirOuCreerDm:async username => ({rid:await chat.direct(username), salonBrut:{}}),
    },
    souscriptionsInitiales:() => [], souscriptionsSalon:() => [],
    chargerHistorique:async (_moteur,rid,_type,latest) => {
      const before = await store.oldestPosition(rid);
      await chat.history(rid,latest !== undefined);
      const after = await store.oldestPosition(rid);
      return {plusAncien:null, aRecule:after !== undefined && (before === undefined || BigInt(after) < BigInt(before))};
    },
    chargerFil:unsupported,
    creerEnvoi:() => ({
      envoyer:async (rid,text,fil) => {
        if (fil) return unsupported();
        return chat.send(rid,text);
      },
      traiter:async () => chat.refresh(),
      reessayer:id => chat.retry(id),
      abandonner:id => chat.abandon(id),
    }),
    creerTeleversement:() => fichiers,
    rattraperGlobal:async () => {}, rattraperSalon:async () => {}, reconcilier:async () => {},
  };
}
