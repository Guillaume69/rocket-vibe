import Foundation
import RocketVibeCore

/// What pressing a card's button or choosing in its menu came to.
public enum CardPressOutcome: Sendable, Equatable {
    case failed
    case done(URL?)
}

public enum CardMenus {
    /// The menu's chosen label, else the label of its initial value when listed, else its name.
    public static func label(_ menu: CardMenu, name: String, chosen: String?) -> String {
        if let chosen { return chosen }
        if let initial = menu.initial, let option = menu.options.first(where: { $0.value == initial }) { return option.label }
        return name
    }

    /// The listed options whose label holds `term`, ignoring case.
    public static func filter(_ options: [MenuOption], _ term: String) -> [MenuOption] {
        let term = term.trimmingCharacters(in: .whitespaces)
        guard !term.isEmpty else { return options }
        return options.filter { $0.label.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
}
