/**
 * Slack canvases' engine for the app: the voice module's native bridge to
 * `rv-canvas` (Automerge cannot run under Hermes). Null in a build without it,
 * which keeps Slack notes read-only.
 */

import type { CanvasEngine, CanvasPlan, CanvasRead } from '@rocket-vibe/provider-slack';
import { VoiceNative } from '../modules/voice/index.ts';

function parsed<T>(json: string | null | undefined): T | null {
  if (typeof json !== 'string') return null;
  try { return JSON.parse(json) as T; } catch { return null; }
}

function engine(): CanvasEngine | null {
  const native = VoiceNative;
  if (native === null || typeof native.canvasRead !== 'function') return null;
  return {
    read: (load: string) => parsed<CanvasRead>(native.canvasRead(load)),
    plan: (load: string, markdown: string, session: string, suffix: string, nowSecs: number) =>
      parsed<CanvasPlan>(native.canvasPlan(load, markdown, session, suffix, nowSecs)),
  };
}

export const slackCanvasEngine: CanvasEngine | null = engine();
