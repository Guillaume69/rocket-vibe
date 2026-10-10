/**
 * The settings categories (`app/settings/index.tsx`, one page each under
 * `app/settings/[category].tsx`): the same list, in the same order, as the
 * desktop apps' settings sidebar. A category shows only when it has content
 * for the current account and server; which one does is decided here, pure
 * and tested (`ui/settingsCategories.test.ts`), from flags the screen reads.
 */

import type { IconName } from './icon.tsx';
import type { TranslationKey } from './messages.ts';

export type SettingsCategory =
  | 'account'
  | 'notifications'
  | 'language'
  | 'encryption'
  | 'security'
  | 'devices'
  | 'bots'
  | 'workflows'
  | 'accounts'
  | 'app';

export type CategoryInfo = {
  key: SettingsCategory;
  /** The desktop's icon for the same category (`rv-gtk/src/settings.rs`). */
  icon: IconName;
  label: TranslationKey;
  /** One line under the label: what is inside. */
  hint: TranslationKey;
};

export const SETTINGS_CATEGORIES: readonly CategoryInfo[] = [
  { key: 'account', icon: 'avatar-default', label: 'settings.categoryAccount', hint: 'settings.categoryAccountHint' },
  { key: 'notifications', icon: 'preferences-system-notifications', label: 'settings.categoryNotifications', hint: 'settings.categoryNotificationsHint' },
  { key: 'language', icon: 'preferences-desktop-locale', label: 'settings.categoryLanguage', hint: 'settings.categoryLanguageHint' },
  { key: 'encryption', icon: 'channel-secure', label: 'settings.categoryEncryption', hint: 'settings.categoryEncryptionHint' },
  { key: 'security', icon: 'security-high', label: 'settings.categorySecurity', hint: 'settings.categorySecurityHint' },
  { key: 'devices', icon: 'computer', label: 'settings.categoryDevices', hint: 'settings.categoryDevicesHint' },
  { key: 'bots', icon: 'system-run', label: 'settings.categoryBots', hint: 'settings.categoryBotsHint' },
  { key: 'workflows', icon: 'media-playlist-repeat', label: 'settings.categoryWorkflows', hint: 'settings.categoryWorkflowsHint' },
  { key: 'accounts', icon: 'system-users', label: 'settings.categoryAccounts', hint: 'settings.categoryAccountsHint' },
  { key: 'app', icon: 'emblem-system', label: 'settings.categoryApp', hint: 'settings.categoryAppHint' },
];

/** What the current account and server offer; each flag fills one category. */
export type SettingsContent = {
  /** A RocketVibe server (native provider) rather than Rocket.Chat. */
  native: boolean;
  /** The server delivers push to this app (Rocket.Chat; a native server that takes registrations). */
  push: boolean;
  /** The server has end-to-end encryption to unlock (Rocket.Chat; not Mattermost nor kChat). */
  e2ee: boolean;
  /** Native: the encrypted identity block (`ui/encryptedIdentity.tsx`). */
  encryptedIdentity: boolean;
  /** Native: 2FA, codes, email, reauthentication (`ui/nativeSecurity.tsx`). */
  security: boolean;
  /** Native: device sessions (`ui/devices.tsx`). */
  devices: boolean;
  /** Native: bot accounts, the `bots` capability (`ui/bots.tsx`). */
  bots: boolean;
  /** Native: workflows, the `workflows` capability (`ui/workflows.tsx`). */
  workflows: boolean;
};

export function hasContent(category: SettingsCategory, content: SettingsContent): boolean {
  switch (category) {
    case 'notifications':
      return content.push;
    // Rocket.Chat: the E2EE key lock. Native: the identity block.
    case 'encryption':
      return content.native ? content.encryptedIdentity : content.e2ee;
    case 'security':
      return content.native && content.security;
    case 'devices':
      return content.native && content.devices;
    case 'bots':
      return content.native && content.bots;
    case 'workflows':
      return content.native && content.workflows;
    case 'account':
    case 'language':
    case 'accounts':
    case 'app':
      return true;
  }
}

export function visibleCategories(content: SettingsContent): CategoryInfo[] {
  return SETTINGS_CATEGORIES.filter((c) => hasContent(c.key, content));
}

/** A route parameter that names a category, or `null`. */
export function settingsCategory(value: unknown): SettingsCategory | null {
  return SETTINGS_CATEGORIES.find((c) => c.key === value)?.key ?? null;
}
