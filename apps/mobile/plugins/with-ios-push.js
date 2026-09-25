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
 *   l'AppDelegate, qu'expo-notifications gère déjà ; modules/jeton-fcm lui
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

const CIBLE = 'NotificationService';
const SOURCE_SWIFT = path.join(__dirname, 'ios-notification-service', `${CIBLE}.swift`);
const CIBLE_IOS_MIN = '16.4';

const PODS_MODULAIRES = [
  'FirebaseCore',
  'FirebaseCoreInternal',
  'FirebaseCoreExtension',
  'FirebaseInstallations',
  'FirebaseMessaging',
  'GoogleDataTransport',
  'GoogleUtilities',
  'nanopb',
];

function groupeTrousseau(bundleId) {
  return `$(AppIdentifierPrefix)${bundleId}`;
}

function podfileModulaire(podfile) {
  if (podfile.includes("pod 'FirebaseMessaging', :modular_headers => true")) return podfile;
  const ancre = /^(\s*)use_expo_modules!.*$/m;
  const trouve = podfile.match(ancre);
  if (!trouve) throw new Error('with-ios-push : use_expo_modules! introuvable dans le Podfile');
  const retrait = trouve[1];
  const lignes = PODS_MODULAIRES.map((pod) => `${retrait}pod '${pod}', :modular_headers => true`).join('\n');
  return podfile.replace(ancre, (ligne) => `${ligne}\n${lignes}`);
}

function entitlementsExtension(groupe) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>${groupe}</string>
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
  <string>${CIBLE}</string>
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
    <string>$(PRODUCT_MODULE_NAME).${CIBLE}</string>
  </dict>
</dict>
</plist>
`;

function cibleIosMin(projet) {
  const configurations = projet.pbxXCBuildConfigurationSection();
  for (const cle of Object.keys(configurations)) {
    const reglages = configurations[cle]?.buildSettings;
    if (reglages?.IPHONEOS_DEPLOYMENT_TARGET) return reglages.IPHONEOS_DEPLOYMENT_TARGET;
  }
  return CIBLE_IOS_MIN;
}

function ajouterCible(projet, { bundleId, equipe, version, build }) {
  if (projet.pbxTargetByName(CIBLE)) return projet;
  const iosMin = cibleIosMin(projet);

  const objets = projet.hash.project.objects;
  objets.PBXTargetDependency = objets.PBXTargetDependency || {};
  objets.PBXContainerItemProxy = objets.PBXContainerItemProxy || {};

  const groupe = projet.addPbxGroup(
    [`${CIBLE}.swift`, `${CIBLE}-Info.plist`, `${CIBLE}.entitlements`],
    CIBLE,
    CIBLE,
  );
  projet.addToPbxGroup(groupe.uuid, projet.getFirstProject().firstProject.mainGroup);

  const cible = projet.addTarget(CIBLE, 'app_extension', CIBLE, `${bundleId}.${CIBLE}`);
  projet.addBuildPhase([`${CIBLE}.swift`], 'PBXSourcesBuildPhase', 'Sources', cible.uuid);
  projet.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', cible.uuid);
  projet.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', cible.uuid);

  const configurations = projet.pbxXCBuildConfigurationSection();
  for (const cle of Object.keys(configurations)) {
    const reglages = configurations[cle]?.buildSettings;
    if (reglages?.PRODUCT_NAME !== `"${CIBLE}"`) continue;
    Object.assign(reglages, {
      CODE_SIGN_ENTITLEMENTS: `${CIBLE}/${CIBLE}.entitlements`,
      CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: build,
      GENERATE_INFOPLIST_FILE: 'NO',
      INFOPLIST_FILE: `${CIBLE}/${CIBLE}-Info.plist`,
      IPHONEOS_DEPLOYMENT_TARGET: iosMin,
      MARKETING_VERSION: version,
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      ...(equipe ? { DEVELOPMENT_TEAM: equipe } : {}),
    });
  }
  if (equipe) projet.addTargetAttribute('DevelopmentTeam', equipe, cible);
  return projet;
}

function bundleIdDe(config) {
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
    const groupe = groupeTrousseau(bundleIdDe(config));
    const existants = config.modResults['keychain-access-groups'] ?? [];
    config.modResults['keychain-access-groups'] = [groupe, ...existants.filter((g) => g !== groupe)];
    return config;
  });

  config = withPodfile(config, (config) => {
    config.modResults.contents = podfileModulaire(config.modResults.contents);
    return config;
  });

  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const dossier = path.join(config.modRequest.platformProjectRoot, CIBLE);
      fs.mkdirSync(dossier, { recursive: true });
      fs.copyFileSync(SOURCE_SWIFT, path.join(dossier, `${CIBLE}.swift`));
      fs.writeFileSync(path.join(dossier, `${CIBLE}-Info.plist`), INFO_PLIST_EXTENSION);
      fs.writeFileSync(
        path.join(dossier, `${CIBLE}.entitlements`),
        entitlementsExtension(groupeTrousseau(bundleIdDe(config))),
      );
      return config;
    },
  ]);

  return withXcodeProject(config, (config) => {
    ajouterCible(config.modResults, {
      bundleId: bundleIdDe(config),
      equipe: config.ios?.appleTeamId ?? null,
      version: config.version ?? '1.0.0',
      build: config.ios?.buildNumber ?? '1',
    });
    return config;
  });
}

module.exports = withIosPush;
module.exports.chirurgie = { podfileModulaire, ajouterCible, groupeTrousseau };
