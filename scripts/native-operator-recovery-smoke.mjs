// Only the disposable pilot database. No code/token is emitted, even on failure.
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
if (process.env.DATABASE_URL !== 'postgres://pilot:native-pilot-disposable-db-password@postgres/pilot') throw new Error('Disposable pilot database required');
const run = args => spawnSync('/src/target/debug/rv-server',args,{encoding:'utf8'});
const issued = run(['recover-user','mobile-recovery','--hours','1']);
if (issued.status !== 0) throw new Error('Recovery issuance failed');
const value = JSON.parse(issued.stdout);
if (!/^[0-9a-f]{64}$/.test(value.token)) throw new Error('Invalid recovery secret');
const listing = run(['list-recovery-codes']);
if (listing.status !== 0) throw new Error('Recovery listing failed');
const rows = JSON.parse(listing.stdout);
assert(rows.some(row=>row.id===value.recovery.id));
assert(rows.every(row=>!('token' in row)&&!('token_hash' in row)));
assert.equal(run(['revoke-recovery-code',value.recovery.id]).status,0);
assert.equal(run(['revoke-recovery-code',value.recovery.id]).status,0);
assert.notEqual(run(['recover-user','mobile-recovery','--hours','25']).status,0);
console.log('Operator recovery CLI: issuance, metadata-only listing, idempotent revocation and policy passed');
