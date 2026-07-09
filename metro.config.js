// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Sans cela, Metro refuse de résoudre les migrations `.sql` de drizzle-kit.
config.resolver.sourceExts.push('sql');

module.exports = config;
