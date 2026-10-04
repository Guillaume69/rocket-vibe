const { withGradleProperties } = require('expo/config-plugins');

/**
 * Restricts native libs to the ABIs actually targeted. The RN template default
 * (armeabi-v7a, arm64-v8a, x86, x86_64) produces a ~150 MB APK of which ~55 MB
 * is never used here:
 *   - physical Pixel → arm64-v8a;
 *   - Mac AVD (Apple Silicon) → arm64-v8a;
 *   - Linux workstation AVD → x86_64.
 * x86 (32-bit) and armeabi-v7a have no target. As a config plugin rather than a
 * manual edit of gradle.properties: android/ is gitignored (CNG), and an
 * \`expo prebuild\` erases any hand edit. It happened: the APK silently grew
 * back from 60 to 150 MB.
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
