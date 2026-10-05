/**
 * Debounced search with a sequence guard: the idiom shared by both search
 * screens (spotlight, `chat.search`), which had already diverged on clearing
 * the error message before being merged here.
 *
 * - one request per typing PAUSE, not per key: REST is rate-limited;
 * - the sequence guard drops LATE responses: without it, the slow response
 *   for "a" would overwrite the fresh results for "ab" (the client's replay
 *   on 429 makes the case very real);
 * - empty query = COMPLETE, immediate reset: results, error message AND
 *   `answered`; a "search failed" banner does not survive clearing the field.
 */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * `empty` and `search` must be STABLE (module-level constant,
 * `useCallback`): their identity reruns the effect, and a value recreated on
 * every render would loop debounce → response → render → debounce.
 */
export function useDebouncedSearch<T>(
  query: string,
  empty: T,
  search: (clean: string) => Promise<T>,
  failureMessage: string,
  timeoutMs = 300,
): {
  results: T;
  message: string | null;
  /**
   * The setter is exposed because the error banner is SHARED with the screen's
   * actions (start a DM, join a channel), and a successful search also clears
   * a past action's error.
   */
  setMessage: Dispatch<SetStateAction<string | null>>;
  /**
   * The query the displayed results come from: "searching" is DERIVED
   * (`clean !== '' && answered !== clean`) instead of living in state set by
   * the effect; otherwise, during the debounce of a new keystroke, the screen
   * would show a false "no results".
   */
  answered: string;
} {
  const [results, setResults] = useState<T>(empty);
  const [message, setMessage] = useState<string | null>(null);
  const [answered, setAnswered] = useState('');
  const sequence = useRef(0);
  const clean = query.trim();

  useEffect(() => {
    const n = ++sequence.current;
    const timer = setTimeout(
      () => {
        if (clean === '') {
          setResults(empty);
          setMessage(null);
          setAnswered('');
          return;
        }
        search(clean)
          .then((r) => {
            if (sequence.current !== n) return;
            setResults(r);
            setMessage(null);
            setAnswered(clean);
          })
          .catch(() => {
            if (sequence.current !== n) return;
            setMessage(failureMessage);
            setAnswered(clean);
          });
      },
      clean === '' ? 0 : timeoutMs,
    );
    return () => clearTimeout(timer);
  }, [clean, empty, search, failureMessage, timeoutMs]);

  return { results, message, setMessage, answered };
}
