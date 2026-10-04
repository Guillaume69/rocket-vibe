/**
 * Smoothing of a value that changes in bursts, extracted from the room screen
 * (`app/` has no tests) so the pacing decision is provable under Node, and
 * shareable (the thread has the same need).
 *
 * Leading/trailing throttle: the value follows, but never faster than
 * `timeoutMs`. On the room screen, each prepend shifts the content by its
 * height when scrolled up into history: group the burst into a single shift.
 * We smooth the PROJECTION, not the database.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * The pure decision: publish now, or in how long.
 * `lastRenderMs` is 0 before the first render: the elapsed time then exceeds
 * any delay, so the first value goes through immediately.
 */
export function smoothingDecision(
  lastRenderMs: number,
  nowMs: number,
  timeoutMs: number,
): { immediate: true } | { immediate: false; waitMs: number } {
  const elapsed = nowMs - lastRenderMs;
  if (elapsed >= timeoutMs) return { immediate: true };
  return { immediate: false, waitMs: timeoutMs - elapsed };
}

export function useSmoothedData<T>(
  value: T,
  timeoutMs: number,
  /** Injectable clock: the hook's tests stay possible without waiting. */
  now: () => number = Date.now,
): T {
  const [smoothed, setSmoothed] = useState(value);
  const lastRender = useRef(0);

  useEffect(() => {
    const decision = smoothingDecision(lastRender.current, now(), timeoutMs);
    if (decision.immediate) {
      lastRender.current = now();
      setSmoothed(value);
      return;
    }
    const timer = setTimeout(() => {
      lastRender.current = now();
      setSmoothed(value);
    }, decision.waitMs);
    return () => clearTimeout(timer);
  }, [value, timeoutMs, now]);

  return smoothed;
}
