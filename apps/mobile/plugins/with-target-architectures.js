const { withGradleProperties } = require('expo/config-plugins');

/**
 * Restreint les libs natives aux ABI réellement ciblées. Le défaut du template
 * RN (armeabi-v7a, arm64-v8a, x86, x86_64) produit un APK de ~150 Mo dont
 * ~55 Mo ne servent jamais ici :
 *   - Pixel physique → arm64-v8a ;
 *   - AVD du Mac (Apple Silicon) → arm64-v8a ;
 *   - AVD du poste Linux → x86_64.
 * x86 (32 bits) et armeabi-v7a n'ont aucune cible. En config plugin et pas en
 * édition manuelle de gradle.properties : android/ est gitignoré (CNG), un
 * \`expo prebuild\` efface toute retouche à la main — c'est arrivé, l'APK a
 * silencieusement regonflé de 60 à 150 Mo.
 */
const ARCHITECTURES = 'arm64-v8a,x86_64';

module.exports = function withTargetArchitectures(config) {
  return withGradleProperties(config, (config) => {
    const props = config.modResults;
    const existing = props.find(
      (p) => p.type === 'property' && p.key === 'reactNativeArchitectures',
    );
    if (existing) {
      existing.value = ARCHITECTURES;
    } else {
      props.push({ type: 'property', key: 'reactNativeArchitectures', value: ARCHITECTURES });
    }
    return config;
  });
};
