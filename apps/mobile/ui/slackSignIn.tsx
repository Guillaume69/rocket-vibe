import { SlackError } from '../providers/slack/client.ts';
import type { TranslateFn } from './messages.ts';

export function slackFailure(error: unknown, t: TranslateFn): string {
  if (!(error instanceof SlackError)) return t('slack.failed');
  if (error.rejectsSession) return t('slack.rejected');
  if (error.code === 'invalid_credentials') return t('slack.invalidCredentials');
  if (error.code === 'identity_mismatch') return t('slack.identityMismatch');
  if (error.code === 'invalid_handoff' || error.code === 'expired_handoff' || error.code === 'pairing_closed') return t('slack.invalidHandoff');
  return `${t('slack.failed')} (${error.code}${error.retryAfter !== null ? `, ${error.retryAfter}s` : ''})`;
}
