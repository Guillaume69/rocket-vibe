import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decrireErreurFournisseur } from './erreurFournisseur.ts';
import { ErreurDeuxFacteurs, ErreurRest } from './rest.ts';
import { NativeError } from '../fournisseurs/rocketvibe/transport.ts';

test('provider diagnostics preserve native request identity and retry delay', () => {
  const error = decrireErreurFournisseur(new NativeError(429,'ticket_limit',30,'request-id'),true);
  assert.equal(error.requeteId,'request-id');
  assert.equal(error.reessayerApres,30);
  assert.equal(error.sessionRejetee,false);
});
test('only an authenticated understood rejection can describe a lost session', () => {
  assert.equal(decrireErreurFournisseur(new NativeError(401,'session_rejected'),false).sessionRejetee,false);
  assert.equal(decrireErreurFournisseur(new NativeError(401,'session_rejected'),true).sessionRejetee,true);
  assert.equal(decrireErreurFournisseur(new ErreurRest('proxy',401),true).sessionRejetee,false);
  const challenge = decrireErreurFournisseur(new ErreurDeuxFacteurs('totp',['totp'],false),true);
  assert.equal(challenge.defiDeuxFacteurs,true);
  assert.equal(challenge.sessionRejetee,false);
  assert.equal(decrireErreurFournisseur(new Error('network'),true).statut,0);
});
