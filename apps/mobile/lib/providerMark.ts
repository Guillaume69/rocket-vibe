import type { ProviderKind } from '@rocket-vibe/provider-api/provider';

/** The provider mark (`assets/brands/<mark>.png`, `scripts/brand-tiles/NOTICE.md`)
 *  a server rail tile shows while its server's own icon is unknown, absent or
 *  unreadable; a Vibez server shows the app's icon instead. */
export type ProviderMark = 'rocketchat' | 'mattermost' | 'kchat' | 'slack' | 'teams' | 'whatsapp';

export function providerMark(kind: ProviderKind): ProviderMark | null {
  return kind === 'vibez' ? null : kind;
}
