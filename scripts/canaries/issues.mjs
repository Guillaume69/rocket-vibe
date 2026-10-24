#!/usr/bin/env node
// Keeps one GitHub issue per provider in step with a canary report: opened
// (or commented on) while a check is broken, closed once all pass again.
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/canaries/issues.mjs report.json [run URL]
import { readFileSync } from 'node:fs';

const LABEL = 'canary';
const TITLE = { whatsapp: 'Canary: WhatsApp', teams: 'Canary: Teams', slack: 'Canary: Slack' };

export function body(provider, results, run) {
  const rows = results.map((r) => `| ${r.status === 'broken' ? '**broken**' : r.status} | \`${r.id}\` | ${r.detail.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`);
  return [
    `The ${provider} canary found a private surface the apps rely on that moved.`,
    '',
    '| Status | Check | Detail |',
    '|---|---|---|',
    ...rows,
    '',
    run ? `Run: ${run}` : '',
    'See `brain/architecture/canaries.md`. This issue closes itself once every check passes again.',
  ].join('\n');
}

/** What to do with a provider's issue: `open`, `comment`, `close` or nothing. */
export function action(results, issue) {
  const failing = results.some((r) => r.status === 'broken');
  if (failing) return issue ? 'comment' : 'open';
  return issue ? 'close' : null;
}

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
  });
  if (!response.ok && response.status !== 422) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function main() {
  const [file, run] = process.argv.slice(2);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  await github('/labels', { method: 'POST', body: JSON.stringify({ name: LABEL, color: 'b60205', description: 'A private protocol surface moved' }) });
  const open = await github(`/issues?state=open&labels=${LABEL}&per_page=100`);
  for (const [provider, results] of Object.entries(report)) {
    const issue = open.find((i) => i.title === TITLE[provider]);
    const text = body(provider, results, run);
    switch (action(results, issue)) {
      case 'open':
        await github('/issues', { method: 'POST', body: JSON.stringify({ title: TITLE[provider], body: text, labels: [LABEL] }) });
        console.log(`${provider}: opened an issue`);
        break;
      case 'comment':
        await github(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: text }) });
        console.log(`${provider}: commented on #${issue.number}`);
        break;
      case 'close':
        await github(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Every ${provider} check passes again.${run ? ` Run: ${run}` : ''}` }) });
        await github(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
        console.log(`${provider}: closed #${issue.number}`);
        break;
      default:
        console.log(`${provider}: nothing to do`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
