import type { ProviderKind } from './provider.ts';

export type Session = {
  baseUrl: string;
  authToken: string;
  userId: string;
  username: string;
  /** Server type: decides which driver to instantiate. Always `rocketchat` here. */
  kind: ProviderKind;
  /**
   * The server's `Site_Url`, read by the login probe. It is the ONLY URL the
   * server recognises at the head of a quote permalink (`lib/quote.ts`);
   * `baseUrl` may differ (proxy alias, IP, port, http/https: the emulator
   * bench case, `10.0.2.2:3300` vs `localhost:3300`). `null` for a session
   * older than the field or a missing setting: we then fall back on
   * `baseUrl`, the historical behaviour.
   */
  siteUrl: string | null;
  /** Identity pinned during native login; never infer it from a stored URL. */
  nativeInstanceId?: string;
  nativeDataEpoch?: string;
  /** Session family registered for Android push, persisted for the native receiver. */
  nativePushDeviceId?: string;
  nativeExpiresAt?: string;
  /** Exists only in SecureStore while an opaque-session renewal is unresolved. */
  nativeRenewal?: {operation_id:string;next_token:string};
  /** Slack's `d` cookie, byte-exact, kept beside its xoxc token and never anywhere else. */
  slackCookie?: string;
  /** The Slack workspace (`T…`) the token was validated for. */
  slackTeamId?: string;
  /** A Teams account's tenant, and its refresh token, which Microsoft rotates. */
  teamsTenantId?: string;
  teamsRefresh?: string;
};

/** Where a provider reports that the server refused the session's token. */
export type TokenRejection = { onTokenRejected: ((token: string) => void) | null };
