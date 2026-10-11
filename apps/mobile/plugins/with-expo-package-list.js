const { withProjectBuildGradle } = require('expo/config-plugins');

// Expo generates a Kotlin package list but registers it as a Java source.
// Track the generated file explicitly: a cached/cold compile can otherwise
// omit ExpoModulesPackageList, preventing every Expo module from loading.
const MARKER = '// rv-expo-package-list';
const REGISTRATION = `
${MARKER}
subprojects { child ->
    child.plugins.withId('expo-autolinking') {
        def packageList = child.tasks.named('generatePackagesList')
        child.tasks.matching { task ->
            task.name.startsWith('compile') && task.name.endsWith('Kotlin') && !task.name.contains('Test')
        }.configureEach { task ->
            task.dependsOn(packageList)
            task.source(packageList.flatMap { it.outputFile })
        }
    }
}
`;
function registerPackageList(gradle) {
  if (gradle.includes(MARKER)) return gradle;
  if (!gradle.includes('expo-root-project')) throw new Error('with-expo-package-list: Expo root Gradle plugin not found');
  return gradle + REGISTRATION;
}
module.exports = function withExpoPackageList(config) {
  return withProjectBuildGradle(config, config => {
    config.modResults.contents = registerPackageList(config.modResults.contents);
    return config;
  });
};
module.exports.registerPackageList = registerPackageList;