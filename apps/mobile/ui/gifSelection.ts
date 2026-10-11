let sequence = 0;
const requests = new Map<string, (sent: boolean) => void>();
export function requestGifSelection(): { id: string; result: Promise<boolean> } {
  const id = String(++sequence);
  return { id, result: new Promise((resolve) => requests.set(id, resolve)) };
}
export function finishGifSelection(id: string | undefined, sent: boolean): void {
  if (!id) return;
  const answer = requests.get(id);
  requests.delete(id);
  answer?.(sent);
}
