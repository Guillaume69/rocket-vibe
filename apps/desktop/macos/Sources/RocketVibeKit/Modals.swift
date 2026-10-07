import Foundation

/// How an in-window modal sits over the window (the project's rule: a click
/// outside a modal closes it with no action, as Cancel and Escape do).
public enum ModalStyle: Equatable, Sendable {
    /// A small card that sizes itself: a confirmation, a short form.
    case card
    /// A panel of about this size, smaller in a small window.
    case sheet(width: Double, height: Double)
    /// A video, nearly the whole window.
    case media
    /// The whole window, the content drawing its own backdrop (a picture).
    case fullWindow
}

public enum ModalLayout {
    /// What a card keeps clear around it.
    public static let margin = 24.0

    /// The size a modal gets in a window of `width` x `height`: the most a
    /// card may take, or a sheet's and a video's frame.
    public static func size(_ style: ModalStyle, width: Double, height: Double) -> (width: Double, height: Double) {
        switch style {
        case .card:
            return (max(width - 2 * margin, 0), max(height - 2 * margin, 0))
        case let .sheet(w, h):
            return (min(w, width * 0.9), min(h, height * 0.9))
        case .media:
            return (min(1100, width * 0.9), min(800, height * 0.9))
        case .fullWindow:
            return (width, height)
        }
    }
}

/// The modals over the window, newest on top. Only the top one answers a
/// click on the backdrop or Escape, and that is its Cancel: never its action.
public struct ModalStack<Payload> {
    public struct Layer: Identifiable {
        public let id: UUID
        public var payload: Payload
        public let cancel: () -> Void
    }

    public private(set) var layers: [Layer] = []

    public init() {}

    public var top: Layer? { layers.last }
    public var isEmpty: Bool { layers.isEmpty }

    /// Shows a modal over the others; one already shown is refreshed where it is.
    public mutating func show(_ id: UUID, _ payload: Payload, cancel: @escaping () -> Void) {
        let layer = Layer(id: id, payload: payload, cancel: cancel)
        if let index = layers.firstIndex(where: { $0.id == id }) {
            layers[index] = layer
        } else {
            layers.append(layer)
        }
    }

    public mutating func hide(_ id: UUID) {
        layers.removeAll { $0.id == id }
    }

    /// The backdrop clicked, or Escape: the top modal is cancelled.
    public func cancelTop() {
        top?.cancel()
    }
}
