/** Session-owned protected copies. Native file operations are injected for race tests. */
import { createHash } from 'crypto';
import { isMediaLeaseCurrent, type MediaLease } from './mediaAuth.ts';
import { sameOrigin } from './origin.ts';

export type MediaProgress = (written: number, total: number) => void;
export type MediaFiles = {
  prepare: () => Promise<void>;
  mkdir: (folder: string) => Promise<void>;
  download: (url: string, path: string, headers: Record<string, string>, progress?: MediaProgress) => Promise<number>;
  move: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
};
type Copies = { folder: string; ready: Map<string, string>; pending: Map<string, Promise<string>>; failedAt: Map<string, number> };
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export class AuthorizedMediaCache {
  private copies = new Map<MediaLease, Copies>();
  private prepared: Promise<void> | undefined;
  private root: string;
  private runId: string;
  private files: MediaFiles;
  constructor(root: string, runId: string, files: MediaFiles) {
    this.root = root;
    this.runId = runId;
    this.files = files;
  }

  prepare(): Promise<void> {
    return this.prepared ??= this.files.prepare().catch(error => { this.prepared = undefined; throw error; });
  }

  private state(lease: MediaLease): Copies {
    let state = this.copies.get(lease);
    if (state === undefined) {
      const account = digest(JSON.stringify([lease.origin, lease.userId]));
      state = { folder: `${this.root}${account}/${this.runId}-${lease.generation}/`, ready: new Map(), pending: new Map(), failedAt: new Map() };
      this.copies.set(lease, state);
    }
    return state;
  }

  peek(lease: MediaLease, uri: string, name = 'image'): string | null {
    return isMediaLeaseCurrent(lease) ? this.copies.get(lease)?.ready.get(JSON.stringify([uri, name])) ?? null : null;
  }

  async close(lease: MediaLease): Promise<void> {
    const state = this.copies.get(lease);
    this.copies.delete(lease);
    if (state !== undefined) {
      state.ready.clear();
      // Remove now; a download still in flight removes its own directory again.
      await this.files.remove(state.folder);
    }
  }

  get(lease: MediaLease, uri: string, name = 'image', progress?: MediaProgress): Promise<string> {
    if (!isMediaLeaseCurrent(lease)) return Promise.reject(new Error('Media session closed.'));
    if (!sameOrigin(uri, lease.origin)) return Promise.reject(new Error('Media origin refused.'));
    const state = this.state(lease);
    const key = JSON.stringify([uri, name]);
    const ready = state.ready.get(key);
    if (ready !== undefined) return Promise.resolve(ready);
    const pending = state.pending.get(key);
    if (pending !== undefined) return pending;
    if (Date.now() - (state.failedAt.get(key) ?? -Infinity) < 30_000) return Promise.reject(new Error('Media retry deferred.'));
    if (name === '.' || name === '..' || /[/\\]/.test(name)) return Promise.reject(new Error('Invalid media filename.'));
    const folder = `${state.folder}${digest(uri)}/`;
    const target = `${folder}${name}`;
    const partial = `${target}.part`;
    const check = (): void => { if (!isMediaLeaseCurrent(lease)) throw new Error('Media session closed.'); };
    const run = (async () => {
      try {
        await this.prepare();
        check();
        await this.files.mkdir(folder);
        check();
        const status = await this.files.download(uri, partial, { ...lease.headers }, (written, total) => {
          if (isMediaLeaseCurrent(lease)) progress?.(written, total);
        });
        check();
        if (status < 200 || status >= 300) throw new Error(`Media download refused (HTTP ${status}).`);
        await this.files.move(partial, target);
        check();
        state.ready.set(key, target);
        state.failedAt.delete(key);
        return target;
      } catch (error) {
        state.failedAt.set(key, Date.now());
        await this.files.remove(partial).catch(() => {});
        throw error;
      } finally {
        state.pending.delete(key);
        if (!isMediaLeaseCurrent(lease)) await this.files.remove(state.folder).catch(() => {});
      }
    })();
    state.pending.set(key, run);
    return run;
  }
}
