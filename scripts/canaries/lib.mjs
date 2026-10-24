import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function source(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** The first capture of `pattern` in a repository file; a canary that cannot find what it checks must fail, not pass. */
export function pick(path, pattern, what) {
  const match = pattern.exec(source(path));
  if (!match) throw new Error(`cannot read ${what} from ${path}`);
  return match[1];
}

export function ok(id, detail) {
  return { id, status: 'ok', detail };
}

export function broken(id, detail) {
  return { id, status: 'broken', detail };
}

export function notice(id, detail) {
  return { id, status: 'notice', detail };
}

export async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, text, json };
}

/** Runs one check, turning any throw into a broken result under its id. */
export async function check(id, run) {
  try {
    return await run();
  } catch (error) {
    return broken(id, error instanceof Error ? error.message : String(error));
  }
}
