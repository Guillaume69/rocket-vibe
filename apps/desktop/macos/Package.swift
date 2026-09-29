// swift-tools-version: 6.0
import PackageDescription

// rv-ffi's static library, built by scripts/generate.sh.
let rustLib = (Context.environment["RV_FFI_LIB_DIR"] ?? Context.packageDirectory + "/../target/release") + "/librv_ffi.a"

#if os(macOS)
let system: [LinkerSetting] = [
    .linkedFramework("Security"),
    .linkedFramework("SystemConfiguration"),
    .linkedFramework("CoreFoundation"),
]
#else
let system: [LinkerSetting] = ["util", "rt", "pthread", "m", "dl"].map { .linkedLibrary($0) }
#endif

var products: [Product] = [
    .executable(name: "rv-rooms", targets: ["rv-rooms"]),
]
var targets: [Target] = [
    .target(name: "rv_ffiFFI", linkerSettings: [.unsafeFlags([rustLib])] + system),
    .target(name: "RocketVibeCore", dependencies: ["rv_ffiFFI"]),
    .target(name: "RocketVibeKit", dependencies: ["RocketVibeCore"]),
    .executableTarget(name: "rv-rooms", dependencies: ["RocketVibeKit"]),
    .testTarget(name: "RocketVibeKitTests", dependencies: ["RocketVibeKit"]),
]

#if os(macOS)
products.append(.executable(name: "RocketVibe", targets: ["RocketVibe"]))
targets.append(.executableTarget(name: "RocketVibe", dependencies: ["RocketVibeKit"]))
#endif

let package = Package(
    name: "RocketVibeMac",
    platforms: [.macOS(.v15)],
    products: products,
    targets: targets,
    swiftLanguageModes: [.v5]
)
