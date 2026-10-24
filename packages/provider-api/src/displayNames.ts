/** The provider's own map, kept current for as long as the session lives. */
export type DisplayNameSource = {
  names(): ReadonlyMap<string, string>;
  statuses(): ReadonlyMap<string, string>;
  mentions?(): ReadonlyMap<string, string>;
  subscribe(listener: () => void): () => void;
};
