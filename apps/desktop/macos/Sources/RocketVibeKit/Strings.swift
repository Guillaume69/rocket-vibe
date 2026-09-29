import Foundation
import RocketVibeCore

/// rv-core's French and English catalog, the one the GTK app reads.
public enum Strings {
    /// The language saved by either app (`auto`, `fr`, `en`), else the system's.
    public static func setUp(configDir: String, languages: [String] = Locale.preferredLanguages) {
        let saved = (try? String(contentsOfFile: configDir + "/language", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "auto"
        switch saved {
        case "fr": setFrench(french: true)
        case "en": setFrench(french: false)
        default: setFrench(french: languages.first?.hasPrefix("fr") ?? false)
        }
    }

    public static var french: Bool { t(key: "day.today") == "Aujourd'hui" }
}

public func L(_ key: String) -> String {
    t(key: key)
}

public func L(_ key: String, _ args: [String: String]) -> String {
    tf(key: key, args: args)
}

public func L(_ key: String, count: Int) -> String {
    tn(key: key, n: Int64(count))
}
