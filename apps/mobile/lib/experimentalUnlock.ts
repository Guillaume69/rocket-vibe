/** Nine individual activations, with a two-second maximum gap. */
export class ExperimentalUnlock {
  #count = 0;
  #last: number | null = null;
  tap(now: number): boolean {
    if (this.#last === null || now < this.#last || now - this.#last > 2000) this.#count = 0;
    this.#last = now;
    this.#count++;
    if (this.#count !== 9) return false;
    this.#count = 0; this.#last = null; return true;
  }
}
