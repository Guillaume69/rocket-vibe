import Dispatch
import RocketVibeCore

/// rv-ffi calls its listener on a tokio thread: this one hops to the main
/// actor, in the order the events came.
final class Relay: Listener {
    let handler: @MainActor @Sendable (Event) -> Void

    init(_ handler: @escaping @MainActor @Sendable (Event) -> Void) {
        self.handler = handler
    }

    func onEvent(event: Event) {
        let handler = handler
        DispatchQueue.main.async { MainActor.assumeIsolated { handler(event) } }
    }
}
