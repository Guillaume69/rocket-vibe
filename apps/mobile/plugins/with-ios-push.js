/* global __dirname */
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withPodfile,
  withXcodeProject,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Le push iOS, par FCM comme Android (voir docs/PUSH.md, « iOS ») :
 *
 * - `FirebaseAppDelegateProxyEnabled = false` : Firebase ne swizzle pas
 *   l'AppDelegate, qu'expo-notifications gère déjà ; modules/fcm-token lui
 *   remet le jeton APNs à la main ;
 * - les pods Firebase en `modular_headers` : le module Swift jeton-fcm importe
 *   FirebaseMessaging, et FirebaseCoreInternal (Swift) dépend de
 *   GoogleUtilities, qui ne définit pas de module sans ça ;
 * - la Notification Service Extension (ios-notification-service/), cible
 *   `NotificationService`, qui va chercher le contenu par `push.get` ;
 * - un groupe de trousseau partagé par l'app et l'extension, EN TÊTE de la
 *   liste de l'app : c'est le groupe par défaut où expo-secure-store écrit, donc
 *   là où l'extension lit la session.
 */

const TARGET = 'NotificationService';
const SOURCE_SWIFT = path.join(__dirname, 'ios-notification-service', `${TARGET}.swift`);
// Session et langue lues au trousseau : même source que la réponse depuis la
// notification (modules/notification-reply), compilée dans les deux cibles.
const SOURCE_SESSION = path.join(__dirname, '..', 'modules', 'notification-reply', 'ios', 'SessionPush.swift');
const IOS_MIN_TARGET = '16.4';

const MODULAR_PODS = [
  'FirebaseCore',
  'FirebaseCoreInternal',
  'FirebaseCoreExtension',
  'FirebaseInstallations',
  'FirebaseMessaging',
  'GoogleDataTransport',
  'GoogleUtilities',
  'nanopb',
];

function keychainGroup(bundleId) {
  return `$(AppIdentifierPrefix)${bundleId}`;
}

function modularPodfile(podfile) {
  if (podfile.includes("pod 'FirebaseMessaging', :modular_headers => true")) return podfile;
  const anchor = /^(\s*)use_expo_modules!.*$/m;
  const found = podfile.match(anchor);
  if (!found) throw new Error('with-ios-push : use_expo_modules! introuvable dans le Podfile');
  const inset = found[1];
  const rows = MODULAR_PODS.map((pod) => `${inset}pod '${pod}', :modular_headers => true`).join('\n');
  return podfile.replace(anchor, (row) => `${row}\n${rows}`);
}

function extensionEntitlements(group) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>${group}</string>
  </array>
</dict>
</plist>
`;
}

const INFO_PLIST_EXTENSION = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>${TARGET}</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).${TARGET}</string>
  </dict>
</dict>
</plist>
`;

function iosMinTarget(project) {
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const settings = configurations[key]?.buildSettings;
    if (settings?.IPHONEOS_DEPLOYMENT_TARGET) return settings.IPHONEOS_DEPLOYMENT_TARGET;
  }
  return IOS_MIN_TARGET;
}

function addTarget(project, { bundleId, team, version, build }) {
  if (project.pbxTargetByName(TARGET)) return project;
  const iosMin = iosMinTarget(project);

  const objects = project.hash.project.objects;
  objects.PBXTargetDependency = objects.PBXTargetDependency || {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

  const group = project.addPbxGroup(
    [`${TARGET}.swift`, 'SessionPush.swift', `${TARGET}-Info.plist`, `${TARGET}.entitlements`],
    TARGET,
    TARGET,
  );
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);

  const target = project.addTarget(TARGET, 'app_extension', TARGET, `${bundleId}.${TARGET}`);
  project.addBuildPhase([`${TARGET}.swift`, 'SessionPush.swift'], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const settings = configurations[key]?.buildSettings;
    if (settings?.PRODUCT_NAME !== `"${TARGET}"`) continue;
    Object.assign(settings, {
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: build,
      GENERATE_INFOPLIST_FILE: 'NO',
      INFOPLIST_FILE: `${TARGET}/${TARGET}-Info.plist`,
      IPHONEOS_DEPLOYMENT_TARGET: iosMin,
      MARKETING_VERSION: version,
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      ...(team ? { DEVELOPMENT_TEAM: team } : {}),
    });
  }
  if (team) project.addTargetAttribute('DevelopmentTeam', team, target);
  return project;
}

function bundleIdOf(config) {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId) throw new Error('with-ios-push : ios.bundleIdentifier manquant dans app.json');
  return bundleId;
}

function withIosPush(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.FirebaseAppDelegateProxyEnabled = false;
    return config;
  });

  config = withEntitlementsPlist(config, (config) => {
    const group = keychainGroup(bundleIdOf(config));
    const existing = config.modResults['keychain-access-groups'] ?? [];
    config.modResults['keychain-access-groups'] = [group, ...existing.filter((g) => g !== group)];
    return config;
  });

  config = withPodfile(config, (config) => {
    config.modResults.contents = modularPodfile(config.modResults.contents);
    return config;
  });

  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const folder = path.join(config.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(folder, { recursive: true });
      fs.copyFileSync(SOURCE_SWIFT, path.join(folder, `${TARGET}.swift`));
      fs.copyFileSync(SOURCE_SESSION, path.join(folder, 'SessionPush.swift'));
      fs.writeFileSync(path.join(folder, `${TARGET}-Info.plist`), INFO_PLIST_EXTENSION);
      fs.writeFileSync(
        path.join(folder, `${TARGET}.entitlements`),
        extensionEntitlements(keychainGroup(bundleIdOf(config))),
      );
      return config;
    },
  ]);

  return withXcodeProject(config, (config) => {
    addTarget(config.modResults, {
      bundleId: bundleIdOf(config),
      team: config.ios?.appleTeamId ?? null,
      version: config.version ?? '1.0.0',
      build: config.ios?.buildNumber ?? '1',
    });
    return config;
  });
}

module.exports = withIosPush;
module.exports.internals = { modularPodfile, addTarget, keychainGroup };
