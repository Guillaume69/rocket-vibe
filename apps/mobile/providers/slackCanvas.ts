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

export const slackCanvasEngine: CanvasEngine | null = VoiceNative && typeof VoiceNative.canvasRead === 'function'
  ? {
      read: (load) => parsed<CanvasRead>(VoiceNative.canvasRead(load)),
      plan: (load, markdown, session, suffix, nowSecs) => parsed<CanvasPlan>(VoiceNative.canvasPlan(load, markdown, session, suffix, nowSecs)),
    }
  : null;
