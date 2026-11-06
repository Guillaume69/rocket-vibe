/**
 * A Slack canvas read and written natively: the app supplies the engine (on
 * Android the desktop's `rv-canvas` over JNI, Hermes having no WebAssembly for
 * Automerge); without one, canvases stay read-only.
 */
export type CanvasRead = { markdown: string; version: string; thread: string; document: string; title: string };
export type CanvasPlan = { data: string; changed: number };

export type CanvasEngine = {
  /** A `load-data` answer (base64) read; null when unreadable. */
  read(load: string): CanvasRead | null;
  /** The `data_binary` (base64) of a save of `markdown` over that answer; empty `data` when nothing changed. */
  plan(load: string, markdown: string, session: string, suffix: string, nowSecs: number): CanvasPlan | null;
};

/** `request_binary` of `load-data/editor/1` for a Quip thread, as the web client sends it. */
export function loadRequest(thread: string): string {
  const bytes = new TextEncoder().encode(thread);
  const field = (number: number, payload: number[]) => [(number << 3) | 2, payload.length, ...payload];
  const message = [...field(1, [...bytes]), ...field(3, [0x08, 0x01, ...field(2, [...bytes])]), ...field(5, [...new TextEncoder().encode('editor')]), 0x30, 0x01];
  let binary = '';
  for (const byte of message) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A fresh editing session: 12 hex characters naming it, 8 more for its Automerge actor. */
export function canvasSession(random: () => number = Math.random): { id: string; suffix: string } {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('');
  return { id: hex(12), suffix: hex(8) };
}
