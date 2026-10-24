// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path');

const config = getDefaultConfig(__dirname);
// The provider packages (`packages/`), linked from the repository's npm workspace.
const repository = path.resolve(__dirname, '../..');
config.watchFolders = [...config.watchFolders, path.join(repository, 'packages'), path.join(repository, 'node_modules')];
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules'), path.join(repository, 'node_modules')];
// Without this, Metro refuses to resolve drizzle-kit's `.sql` migrations.
config.resolver.sourceExts.push('sql');

// E2EE: `lib/e2e/crypto.ts` imports the `node:crypto` API. In the RN bundle,
// we resolve it to `react-native-quick-crypto` (Nitro native module, same
// OpenSSL API). Under Node (tests) the alias does not apply -> native `node:crypto`.
const standardResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // `buffer` points to the leaf implementation (@craftzdog/react-native-buffer),
  // NOT to the quick-crypto barrel: the latter itself imports `buffer` at init,
  // aliasing it to its own barrel creates a cycle (`require` returns a
  // half-initialised module -> `Cannot read property 'Certificate'`).
  if (moduleName === 'crypto') {
    return context.resolveRequest(context, 'react-native-quick-crypto', platform);
  }
  if (moduleName === 'buffer') {
    return context.resolveRequest(context, '@craftzdog/react-native-buffer', platform);
  }
  return (standardResolver ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
