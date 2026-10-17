import { useCallback } from 'react';

import { type CardAction, pressCardAction } from '../lib/integrationCards.ts';
import { openExternalLink } from './externalLink.ts';
import { useT } from './i18n.ts';
import { setPrivateNote } from './privateNoteStore.ts';
import { useSync } from './sync.tsx';
import { notify } from './toast.tsx';

/** Presses a card button, or picks `selected` in a card menu, of post `postId` in room `rid`; `null` where the server has no card buttons. */
export function useCardAction(rid: string, postId: string | null | undefined): ((action: CardAction, selected?: string) => Promise<boolean>) | null {
  const sync = useSync();
  const t = useT();
  const kind = sync.phase === 'ready' ? sync.provider.identity.kind : null;
  const actions = sync.phase === 'ready' && (kind === 'mattermost' || kind === 'kchat') ? sync.actions : null;
  const available = actions?.cardAction !== undefined && !!postId;
  const run = useCallback(
    async (action: CardAction, selected?: string) => {
      if (actions?.cardAction === undefined || !postId) return false;
      const target = actions;
      return pressCardAction(() => target.cardAction!(postId, action.id, action.cookie, selected), {
        note: (text) => setPrivateNote({ rid, text }),
        open: openExternalLink,
        failed: () => notify(t('card.actionFailed')),
      });
    },
    [actions, postId, rid, t],
  );
  return available ? run : null;
}
