// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Sans cela, Metro refuse de résoudre les migrations `.sql` de drizzle-kit.
config.resolver.sourceExts.push('sql');

// E2EE : `lib/e2e/crypto.ts` importe l'API `node:crypto`. Dans le bundle RN,
// on la résout vers `react-native-quick-crypto` (module natif Nitro, même API
// OpenSSL). Sous Node (tests) l'alias ne s'applique pas → `node:crypto` natif.
const standardResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // `buffer` pointe vers l'implé feuille (@craftzdog/react-native-buffer), PAS
  // vers le barrel quick-crypto : ce dernier importe lui-même `buffer` à
  // l'init, l'aliaser vers son propre barrel crée un cycle (`require` renvoie
  // un module à moitié initialisé → `Cannot read property 'Certificate'`).
  if (moduleName === 'crypto') {
    return context.resolveRequest(context, 'react-native-quick-crypto', platform);
  }
  if (moduleName === 'buffer') {
    return context.resolveRequest(context, '@craftzdog/react-native-buffer', platform);
  }
  return (standardResolver ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
