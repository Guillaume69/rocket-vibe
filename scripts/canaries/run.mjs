#!/usr/bin/env node
// Checks that the private surfaces the WhatsApp, Slack and Teams integrations
// rely on have not moved, without an account (brain/architecture/canaries.md).
//   node scripts/canaries/run.mjs [whatsapp|teams|slack ...] [--json report.json]
// Exits 1 when a check is broken.
import { writeFileSync } from 'node:fs';
import { slack } from './slack.mjs';
import { teams } from './teams.mjs';
import { whatsapp } from './whatsapp.mjs';

const PROVIDERS = { whatsapp, teams, slack };
const MARK = { ok: 'ok', broken: 'BROKEN', notice: 'notice' };

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const output = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const chosen = args.length > 0 ? args : Object.keys(PROVIDERS);
for (const name of chosen) if (!(name in PROVIDERS)) throw new Error(`unknown provider ${name}`);

const report = {};
for (const name of chosen) {
  let results;
  try {
    results = await PROVIDERS[name]();
  } catch (error) {
    results = [{ id: `${name}.setup`, status: 'broken', detail: error instanceof Error ? error.message : String(error) }];
  }
  report[name] = results;
  console.log(`\n${name}`);
  for (const r of results) console.log(`  ${MARK[r.status].padEnd(7)} ${r.id}: ${r.detail}`);
}
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
process.exitCode = Object.values(report).flat().some((r) => r.status === 'broken') ? 1 : 0;
