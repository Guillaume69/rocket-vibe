/**
 * Which room screens are mounted, and which one the user is looking at.
 *
 * `chat.syncMessages` handles ONE room at a time and REST is rate-limited, so
 * catch-up only targets the room on screen. That still means knowing which
 * one it is.
 *
 * A single variable (`activeRoom = rid` on mount, `null` on unmount) is not
 * enough: the navigation stack can hold TWO room screens.
 * `ui/notifications.tsx` does a `push` from anywhere, `app/profile.tsx` a
 * `replace`. On going back, the top one's cleanup set `null` while a room was
 * still shown, and `catchUpAll` returned without catching up anything. The
 * defect was hidden by the REDUNDANT catch-up the screen ran on its own side;
 * having removed it (`lib/catchUp.ts` now serializes) would turn that debt
 * into real loss.
 *
 * OBJECTS, not strings: two screens can carry the same rid (deep link to an
 * already open room), and it is the EXACT declaration that must be removed,
 * not the first matching occurrence.
 *
 * One stack PER SESSION, hence the factory: it lives in the closure of
 * `ui/sync.tsx`, not at module level. A screen surviving the end of a session
 * must not declare a room to the next session.
 */

export type OpenRoomsStack = {
  /** On opening a room screen. Returns what removes it on leaving. */
  declare: (rid: string) => () => void;
  /** The top room: the one the user is looking at. */
  top: () => string | undefined;
};

export function createOpenRoomsStack(): OpenRoomsStack {
  const stack: { rid: string }[] = [];
  return {
    declare: (rid) => {
      const declaration = { rid };
      stack.push(declaration);
      return () => {
        const i = stack.indexOf(declaration);
        if (i !== -1) stack.splice(i, 1);
      };
    },
    top: () => stack[stack.length - 1]?.rid,
  };
}
