import type { DdpEvent, DdpState } from '../../lib/ddp.ts';
import type { Listener } from '../../lib/provider.ts';

/**
 * The real-time seat of a Slack account, without a stream yet: "connected"
 * at once so the sync runs its REST catch-up and the screens never wait on a
 * socket. The RTM socket takes this place, same interface.
 */
export class SlackIdleListener implements Listener {
  state: DdpState = 'closed';

  async connect(_authToken: string): Promise<void> {
    this.state = 'authenticated';
  }

  subscribe(_name: string, _eventKey: string): () => void {
    return () => {};
  }

  onEvent(_listener: (event: DdpEvent) => void): () => void {
    return () => {};
  }

  onLoss(_listener: () => void): () => void {
    return () => {};
  }

  close(): void {
    this.state = 'closed';
  }

  async checkAlive(): Promise<boolean> {
    return this.state === 'authenticated';
  }

  async armedSubscriptions(): Promise<void> {}

  reset(): void {}
}
