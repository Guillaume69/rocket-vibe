/** The room list's folded sections, per account (`Account.key`), in localStorage. */

export type FoldStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

const PREFIX = "rv-fold:";
const own = (account: string, section: string) =>
  PREFIX + account + ":" + section;

export function isFolded(
  storage: FoldStorage,
  account: string,
  section: string,
): boolean {
  return storage.getItem(own(account, section)) === "true";
}

export function setFolded(
  storage: FoldStorage,
  account: string,
  section: string,
  folded: boolean,
): void {
  if (folded) storage.setItem(own(account, section), "true");
  else storage.removeItem(own(account, section));
}

/**
 * The browser holds one account at a time: on its activation, the folds of
 * the others go, and the folds kept before they were per account (under the
 * section's title, `labels`) become this account's.
 */
export function adoptFolds(
  storage: FoldStorage,
  account: string,
  labels: Readonly<Record<string, string>>,
): void {
  const keys: string[] = [];
  for (let at = 0; at < storage.length; at++) {
    const key = storage.key(at);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  for (const [section, label] of Object.entries(labels))
    if (
      storage.getItem(PREFIX + label) === "true" &&
      storage.getItem(own(account, section)) === null
    )
      storage.setItem(own(account, section), "true");
  for (const key of keys)
    if (!key.startsWith(PREFIX + account + ":")) storage.removeItem(key);
}
