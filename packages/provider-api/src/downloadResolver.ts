/**
 * A per-account hook that turns an attachment url into a directly fetchable
 * one just before a download (Teams: a SharePoint/OneDrive share resolved to
 * its short-lived, pre-signed Microsoft Graph download url). A standalone
 * registry so the message row reaches it without importing the sync tree,
 * mirroring `lib/mediaAuth.ts`. Keyed by the account's base url.
 */

type Resolver = (url: string) => Promise<string>;

const resolvers = new Map<string, Resolver>();

/** Register (or replace) the resolver for an account's base url. */
export function setDownloadResolver(baseUrl: string, resolve: Resolver): void {
  resolvers.set(baseUrl, resolve);
}

export function clearDownloadResolver(baseUrl: string): void {
  resolvers.delete(baseUrl);
}

/** The resolver for an account's base url, or undefined when none is set. */
export function downloadResolverFor(baseUrl: string): Resolver | undefined {
  return resolvers.get(baseUrl);
}
