import { useCallback } from 'react';

import type { CardAction } from '../lib/integrationCards.ts';
import { openExternalLink } from './externalLink.ts';
import { useT } from './i18n.ts';
import { setPrivateNote } from './privateNoteStore.ts';
import { useSync } from './sync.tsx';
import { notify } from './toast.tsx';

/** Presses a card button of post `postId` in room `rid`; `null` where the server has no card buttons. */
export function useCardAction(rid: string, postId: string | null | undefined): ((action: CardAction) => Promise<void>) | null {
  const sync = useSync();
  const t = useT();
  const kind = sync.phase === 'ready' ? sync.provider.identity.kind : null;
  const actions = sync.phase === 'ready' && (kind === 'mattermost' || kind === 'kchat') ? sync.actions : null;
  const available = actions?.cardAction !== undefined && !!postId;
  const run = useCallback(
    async (action: CardAction) => {
      if (actions?.cardAction === undefined || !postId) return;
      try {
        const answer = await actions.cardAction(postId, action.id, action.cookie);
        if (answer.ephemeralText !== null) setPrivateNote({ rid, text: answer.ephemeralText });
        if (answer.gotoLocation !== null && /^https?:\/\//i.test(answer.gotoLocation)) openExternalLink(answer.gotoLocation);
      } catch {
        notify(t('card.actionFailed'));
      }
    },
    [actions, postId, rid, t],
  );
  return available ? run : null;
}
