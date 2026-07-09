/**
 * `babel-plugin-inline-import` permet à `drizzle-orm/expo-sqlite/migrator`
 * d'importer les fichiers `.sql` générés par drizzle-kit comme des chaînes.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['inline-import', { extensions: ['.sql'] }]],
  };
};
