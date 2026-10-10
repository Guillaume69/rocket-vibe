export type Screen = "loading" | "login" | "shell";

export class ViewState {
  private value = { screen: "loading" as Screen, revision: 0, mount: 0 };
  private listeners = new Set<() => void>();
  readonly getSnapshot = () => this.value;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  screen(screen: Screen): void {
    this.value = {
      screen,
      revision: this.value.revision + 1,
      mount: this.value.mount + 1,
    };
    this.emit();
  }
  changed(): void {
    this.value = { ...this.value, revision: this.value.revision + 1 };
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
