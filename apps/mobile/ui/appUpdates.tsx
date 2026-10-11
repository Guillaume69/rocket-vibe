/** One app-wide updater, independent of chat accounts, with durable Android sessions. */
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Linking, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchMobileReleases, selectMobileUpdate, restoreMobileUpdate, updateCheckDue, UpdateCheckError, UPDATE_REPO,
  type CachedReleasePage, type MobileUpdate, type ReleasePageCache } from '../lib/appUpdates.ts';
import { AppUpdater, type UpdaterInfo } from '../modules/app-updater/index.ts';
import { VoiceNative } from '../modules/voice/index.ts';
import { useT } from './i18n.ts';
import type { TranslationKey } from './messages.ts';
import { Tappable } from './tappable.tsx';
import { FONTS, useColors, type Colors } from './theme.ts';

export const hasAppUpdater = AppUpdater !== null;
type Preferences = { auto: boolean; checkedAt: number; retryAt: number; dismissed: string | null };
type State = {
  info: UpdaterInfo | null; release: MobileUpdate | null; preferences: Preferences;
  checking: boolean; checked: boolean; downloading: boolean; preparing: boolean;
  progress: number; error: TranslationKey | null; manualOffer: boolean;
};
let state: State = { info: null, release: null, preferences: { auto: true, checkedAt: 0, retryAt: 0, dismissed: null },
  checking: false, checked: false, downloading: false, preparing: false, progress: 0, error: null, manualOffer: false };
const listeners = new Set<() => void>();
function set(changes: Partial<State>): void { state = { ...state, ...changes }; for (const fn of listeners) fn(); }
function subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
function useUpdate(): State { return useSyncExternalStore(subscribe, () => state); }
const prefsFile = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}app-updates.json` : null;
let writes = Promise.resolve();
function savePreferences(): void {
  const json = JSON.stringify({ ...state.preferences, offer: state.release });
  writes = writes.then(async () => { if (prefsFile) await FileSystem.writeAsStringAsync(prefsFile, json); }).catch(() => {});
}
const cache: ReleasePageCache = {
  async read(page) {
    if (!FileSystem.cacheDirectory) return null;
    try {
      const value = JSON.parse(await FileSystem.readAsStringAsync(`${FileSystem.cacheDirectory}app-update-page-${page}.json`)) as CachedReleasePage;
      return typeof value.etag === 'string' && Array.isArray(value.entries) && value.entries.length <= 100 ? value : null;
    } catch { return null; }
  },
  async write(page, value) {
    if (FileSystem.cacheDirectory) await FileSystem.writeAsStringAsync(`${FileSystem.cacheDirectory}app-update-page-${page}.json`, JSON.stringify(value));
  },
};
const nativeErrors: Record<string, TranslationKey> = {
  voice: 'updates.voice', integrity: 'updates.integrity', signature: 'updates.signature', package: 'updates.package',
  version: 'updates.versionError', device: 'updates.device', storage: 'updates.storage',
  cancelled: 'updates.cancelled', permission: 'updates.permission', blocked: 'updates.blocked',
  foreground: 'updates.foreground', interrupted: 'updates.interrupted', busy: 'updates.busy',
};
function errorKey(error: unknown): TranslationKey {
  const value = error as { code?: string; message?: string } | null;
  return nativeErrors[value?.code ?? ''] ?? nativeErrors[value?.message ?? ''] ?? 'updates.failed';
}
async function refresh(): Promise<void> {
  if (!AppUpdater) return;
  try {
    const info = await AppUpdater.info();
    const changes: Partial<State> = { info };
    if (info.status === 'updated' && state.release?.version === info.version) changes.release = null;
    if (info.target && !state.release && ['ready', 'installing', 'confirmation', 'failed'].includes(info.status)) {
      changes.release = { version: info.target, page: `https://github.com/${UPDATE_REPO}/releases/tag/mobile-v${info.target}`, asset: null, unavailable: null };
    }
    set(changes);
  } catch { /* A transient native read never interferes with chat. */ }
}
let initialized: Promise<void> | null = null;
function initialize(): Promise<void> {
  initialized ??= (async () => {
    let offer: unknown = null;
    if (prefsFile) try {
      const p = JSON.parse(await FileSystem.readAsStringAsync(prefsFile)) as Partial<Preferences> & { offer?: unknown };
      offer = p.offer;
      set({ preferences: { auto: p.auto !== false,
        checkedAt: typeof p.checkedAt === 'number' && Number.isFinite(p.checkedAt) ? p.checkedAt : 0,
        retryAt: typeof p.retryAt === 'number' && Number.isFinite(p.retryAt) ? p.retryAt : 0,
        dismissed: typeof p.dismissed === 'string' ? p.dismissed : null } });
    } catch { /* First launch or a damaged updater preference file uses defaults. */ }
    await refresh();
    if (!state.release && state.info) set({ release: restoreMobileUpdate(offer, state.info.version, state.info.abis) });
  })();
  return initialized;
}
async function check(manual: boolean): Promise<void> {
  if (!AppUpdater || state.checking || state.downloading || state.preparing || state.info?.status === 'installing' || state.info?.status === 'confirmation') return;
  await initialize();
  if (!state.info || state.checking) return;
  const now = Date.now();
  if (!manual && (!state.preferences.auto || !updateCheckDue(state.preferences.checkedAt, now, state.preferences.retryAt))) return;
  if (now < state.preferences.retryAt) { if (manual) set({ error: 'updates.wait' }); return; }
  set({ checking: true, error: null, manualOffer: manual });
  try {
    const releases = await fetchMobileReleases(fetch, cache);
    const release = selectMobileUpdate(releases, state.info.version, state.info.abis);
    set({ release, checked: true, preferences: { ...state.preferences, checkedAt: now, retryAt: 0 } });
  } catch (error) {
    set({ error: manual ? 'updates.checkFailed' : state.error,
      preferences: { ...state.preferences, retryAt: error instanceof UpdateCheckError ? error.retryAt : now + 300000 } });
  } finally { set({ checking: false }); savePreferences(); }
}
function setAutomatic(auto: boolean): void {
  set({ preferences: { ...state.preferences, auto } }); savePreferences();
  if (auto) void check(false);
}
function dismiss(): void {
  set({ preferences: { ...state.preferences, dismissed: state.release?.version ?? null }, manualOffer: false }); savePreferences();
}
async function download(): Promise<void> {
  const release = state.release;
  if (!AppUpdater || !release?.asset || state.downloading || state.preparing) return;
  set({ downloading: true, error: null, progress: 0 });
  try { await AppUpdater.download(release.version, release.asset.url, release.asset.size, release.asset.digest); }
  catch (error) { set({ error: errorKey(error) }); }
  finally { set({ downloading: false }); await refresh(); }
}
async function install(): Promise<void> {
  if (!AppUpdater || state.preparing || state.downloading) return;
  const voice = VoiceNative?.snapshot();
  if (voice && voice.state !== 'idle' && voice.state !== 'disconnected') { set({ error: 'updates.voice' }); return; }
  set({ preparing: true, error: null });
  try {
    const info = await AppUpdater.info();
    if (!info.canInstall) { set({ error: 'updates.permission' }); return; }
    await AppUpdater.install();
  } catch (error) { set({ error: errorKey(error) }); }
  finally { set({ preparing: false }); await refresh(); }
}
async function resumeInstall(): Promise<void> {
  try { await AppUpdater?.resumeInstall(); } catch (error) { set({ error: errorKey(error) }); }
}
async function cancelInstall(): Promise<void> {
  try { await AppUpdater?.cancelInstall(); set({ error: null }); await refresh(); }
  catch (error) { set({ error: errorKey(error) }); }
}
function releaseNotes(): void { if (state.release) void Linking.openURL(state.release.page).catch(() => set({ error: 'updates.failed' })); }

function Action({ c, title, onPress, disabled = false }: { c: Colors; title: string; onPress(): void; disabled?: boolean }) {
  return <Tappable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title}
    android_ripple={{ color: c.ripple }} style={({ pressed }) => [styles.action, { borderColor: c.border,
      backgroundColor: c.background, opacity: pressed || disabled ? 0.5 : 1 }]}>
    <Text style={{ color: c.cyan, fontFamily: FONTS.bodyBold }}>{title}</Text>
  </Tappable>;
}
/** Used by Settings and by the account-independent update page. */
export function AppUpdatesCard({ c }: { c: Colors }) {
  const s = useUpdate(), t = useT();
  useEffect(() => { void initialize(); }, []);
  if (!AppUpdater) return null;
  const session = s.info?.status === 'installing' || s.info?.status === 'confirmation';
  const locked = s.checking || s.downloading || s.preparing || session;
  const ready = s.info?.target === s.release?.version && (s.info?.status === 'ready' || s.info?.status === 'failed');
  const error = s.error ?? (s.info?.error ? nativeErrors[s.info.error] ?? 'updates.failed' : null);
  return <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
    <Text style={[styles.title, { color: c.text }]}>{t('updates.title')}</Text>
    {s.info && <Text style={[styles.help, { color: c.dimmed }]}>{t('updates.installed', { version: s.info.version })}</Text>}
    <View style={styles.row}>
      <Text style={[styles.help, { color: c.text, flex: 1 }]}>{t('updates.automatic')}</Text>
      <Switch value={s.preferences.auto} disabled={!s.info} onValueChange={setAutomatic} accessibilityLabel={t('updates.automatic')} />
    </View>
    <Action c={c} title={t(s.checking ? 'updates.checking' : 'updates.check')} disabled={!s.info || locked} onPress={() => { void check(true); }} />
    {(!s.info || s.checking || s.preparing) && <ActivityIndicator color={c.cyan} />}
    {s.checked && !s.checking && !s.release && !error && <Text style={[styles.help, { color: c.dimmed }]}>{t('updates.current')}</Text>}
    {s.release && <>
      <Text style={[styles.title, { color: c.text }]}>{t('updates.available', { version: s.release.version })}</Text>
      {s.release.asset && <Text style={[styles.help, { color: c.dimmed }]}>{t('updates.size', { size: (s.release.asset.size / 1048576).toFixed(1) })}</Text>}
      <Action c={c} title={t('updates.notes')} onPress={releaseNotes} />
      {s.release.unavailable && <Text style={[styles.help, { color: c.dimmed }]}>{t(s.release.unavailable === 'device' ? 'updates.device' : 'updates.unavailable')}</Text>}
      {s.downloading && <>
        <Text style={[styles.help, { color: c.text }]}>{t(s.progress >= 1 ? 'updates.verifying' : 'updates.downloading', { percent: Math.floor(s.progress * 100) })}</Text>
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.floor(s.progress * 100) }}
          style={[styles.track, { backgroundColor: c.border }]}><View style={{ height: 6, width: `${Math.floor(s.progress * 100)}%`, backgroundColor: c.cyan }} /></View>
        <Action c={c} title={t('common.cancel')} onPress={() => AppUpdater?.cancelDownload()} />
      </>}
      {s.release.asset && (!ready || error !== null) && !s.downloading && !session && <Action c={c} title={t('updates.download')} disabled={locked} onPress={() => { void download(); }} />}
      {ready && !session && <>
        <Text style={[styles.help, { color: c.dimmed }]}>{t('updates.ready')}</Text>
        {s.info?.canInstall === false && <Action c={c} title={t('updates.allow')} disabled={locked} onPress={() => {
          void AppUpdater?.openInstallSettings().catch(error => set({ error: errorKey(error) }));
        }} />}
        <Action c={c} title={t('updates.install')} disabled={locked || s.info?.canInstall === false} onPress={() => { void install(); }} />
      </>}
      {session && <>
        <Text style={[styles.help, { color: c.dimmed }]}>{t('updates.confirmation')}</Text>
        {s.info?.status === 'confirmation' && <Action c={c} title={t('updates.confirm')} onPress={() => { void resumeInstall(); }} />}
        <Action c={c} title={t('updates.cancelInstall')} onPress={() => { void cancelInstall(); }} />
      </>}
    </>}
    {error && <Text accessibilityRole="alert" style={[styles.help, { color: c.errorText }]}>{t(error)}</Text>}
  </View>;
}

/** Mounted once at the root, before login as well as in chat. */
export function AppUpdateHost() {
  const s = useUpdate(), c = useColors(), t = useT(), insets = useSafeAreaInsets();
  useEffect(() => {
    if (!AppUpdater) return;
    const progress = AppUpdater.addListener('progress', p => set({ progress: Math.min(1, p.downloaded / Math.max(1, p.total)) }));
    const foreground = () => { void refresh().then(() => check(false)); };
    void initialize().then(foreground);
    const app = AppState.addEventListener('change', value => { if (value === 'active') foreground(); });
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      if (state.info?.status === 'installing' || state.info?.status === 'confirmation') void refresh();
      else if (!state.downloading && !state.preparing) void check(false);
    }, 2000);
    return () => { progress.remove(); app.remove(); clearInterval(timer); };
  }, []);
  if (!AppUpdater || !s.release || !s.preferences.auto || s.manualOffer ||
    s.preferences.dismissed === s.release.version || s.downloading || s.preparing ||
    s.info?.status === 'installing' || s.info?.status === 'confirmation') return null;
  return <View style={[styles.notice, { backgroundColor: c.deepCard, borderColor: c.border, bottom: insets.bottom + 82 }]}>
    <Text style={[styles.help, { color: c.text }]}>{t('updates.available', { version: s.release.version })}</Text>
    <View style={styles.row}>
      <Action c={c} title={t('updates.view')} onPress={() => router.push('/app-update')} />
      <Action c={c} title={t('updates.later')} onPress={dismiss} />
    </View>
  </View>;
}
const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  title: { fontFamily: FONTS.title, fontSize: 16 },
  help: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  action: { borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  notice: { position: 'absolute', left: 16, right: 16, padding: 14, gap: 10, borderWidth: 1, borderRadius: 16 },
});
