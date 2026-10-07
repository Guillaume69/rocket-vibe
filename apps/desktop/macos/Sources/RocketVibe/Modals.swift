import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// The window's modals, drawn in the window over a dimmed backdrop instead of
/// as macOS sheets and alerts, which a click outside cannot close. A click on
/// the backdrop and Escape cancel the top one, with no action (the project's
/// rule). Views present through `modalOverlay` and `confirmOverlay`.
@MainActor @Observable
final class ModalCenter {
    struct Shown {
        let style: ModalStyle
        let content: AnyView
    }

    private(set) var stack = ModalStack<Shown>()

    var isEmpty: Bool { stack.isEmpty }

    func show(_ id: UUID, style: ModalStyle, content: AnyView, cancel: @escaping () -> Void) {
        stack.show(id, Shown(style: style, content: content), cancel: cancel)
    }

    func hide(_ id: UUID) {
        stack.hide(id)
    }
}

/// What a modal's own Close or Cancel calls: the same as a click outside.
struct CloseModal {
    let run: () -> Void
    func callAsFunction() { run() }
}

private struct CloseModalKey: EnvironmentKey {
    static let defaultValue = CloseModal(run: {})
}

extension EnvironmentValues {
    var closeModal: CloseModal {
        get { self[CloseModalKey.self] }
        set { self[CloseModalKey.self] = newValue }
    }
}

/// Every modal shown, over everything else in the window.
struct ModalHost: View {
    @Environment(ModalCenter.self) var center
    @FocusState private var focused: UUID?

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                ForEach(center.stack.layers) { layer in
                    let size = ModalLayout.size(layer.payload.style, width: Double(geometry.size.width), height: Double(geometry.size.height))
                    ZStack {
                        Color.black.opacity(layer.payload.style == .fullWindow ? 0.3 : 0.5)
                            .contentShape(Rectangle())
                            .onTapGesture { layer.cancel() }
                        framed(layer.payload, width: CGFloat(size.width), height: CGFloat(size.height))
                            .environment(\.closeModal, CloseModal(run: layer.cancel))
                    }
                    .focusable()
                    .focusEffectDisabled()
                    .focused($focused, equals: layer.id)
                    .transition(.opacity)
                }
                if let top = center.stack.top {
                    // Escape: the top modal's Cancel.
                    Button("") { top.cancel() }
                        .keyboardShortcut(.cancelAction)
                        .opacity(0)
                        .frame(width: 0, height: 0)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .allowsHitTesting(!center.isEmpty)
        .animation(.easeOut(duration: 0.14), value: center.stack.layers.map(\.id))
        // Keys go to the modal, not to the composer underneath.
        .onChange(of: center.stack.top?.id, initial: true) { _, top in focused = top }
    }

    @ViewBuilder func framed(_ shown: ModalCenter.Shown, width: CGFloat, height: CGFloat) -> some View {
        switch shown.style {
        case .fullWindow:
            shown.content.frame(width: width, height: height)
        case .card:
            shown.content
                .frame(maxWidth: width, maxHeight: height)
                .background(Vibe.raised)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Vibe.line))
                .shadow(color: .black.opacity(0.5), radius: 24, y: 10)
        case .sheet, .media:
            shown.content
                .frame(width: width, height: height)
                .background(Vibe.night)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Vibe.line))
                .shadow(color: .black.opacity(0.5), radius: 24, y: 10)
        }
    }
}

/// Registers `overlay` with the window's `ModalCenter` while `isPresented`,
/// as `.sheet` would present it; `key` shows it again when what it shows
/// changes while open.
struct ModalOverlayModifier<Overlay: View>: ViewModifier {
    @Environment(ModalCenter.self) private var center: ModalCenter?
    @Environment(\.openURL) private var openURL
    @Binding var isPresented: Bool
    let key: AnyHashable?
    let style: ModalStyle
    let overlay: () -> Overlay
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented, initial: true) { _, shown in
                if shown { show() } else { center?.hide(id) }
            }
            .onChange(of: key) { _, _ in if isPresented { show() } }
            .onDisappear { center?.hide(id) }
    }

    private func show() {
        guard let center else { return }
        let (binding, layer) = ($isPresented, self.id)
        // The presenter's link handling (mentions, rooms) follows its modal.
        let view = AnyView(overlay().environment(\.openURL, openURL))
        center.show(layer, style: style, content: view) { [weak center] in
            binding.wrappedValue = false
            center?.hide(layer)
        }
    }
}

/// One confirming button of a `ConfirmCard`.
struct ModalAction {
    let title: String
    var role: ButtonRole? = nil
    let run: () -> Void
}

/// A question before an action: Cancel (also a click outside or Escape) does
/// nothing; each action runs, then closes.
struct ConfirmCard: View {
    @Environment(\.closeModal) private var close
    let title: String
    let message: String?
    let cancel: String
    let actions: [ModalAction]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            if let message, !message.isEmpty {
                Text(message).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button(cancel) { close() }
                ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                    Button(action.title, role: action.role) {
                        action.run()
                        close()
                    }
                    .foregroundStyle(action.role == .destructive ? Color.red : Vibe.text)
                }
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

extension View {
    /// `.sheet`, drawn in the window: a click outside closes it.
    func modalOverlay<Overlay: View>(isPresented: Binding<Bool>, key: AnyHashable? = nil, style: ModalStyle = .card,
                                     @ViewBuilder content: @escaping () -> Overlay) -> some View {
        modifier(ModalOverlayModifier(isPresented: isPresented, key: key, style: style, overlay: content))
    }

    /// `.sheet(item:)`, drawn in the window.
    func modalOverlay<Item: Identifiable, Overlay: View>(item: Binding<Item?>, style: ModalStyle = .card,
                                                         @ViewBuilder content: @escaping (Item) -> Overlay) -> some View {
        modalOverlay(
            isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }),
            key: item.wrappedValue.map { AnyHashable($0.id) },
            style: style
        ) {
            if let value = item.wrappedValue { content(value) }
        }
    }

    /// `.alert` and `.confirmationDialog`, drawn in the window: a click
    /// outside and Escape are Cancel, never one of `actions`.
    func confirmOverlay(isPresented: Binding<Bool>, title: String, message: String? = nil,
                        cancel: String = L("actions.cancel"), actions: [ModalAction]) -> some View {
        modalOverlay(isPresented: isPresented, style: .card) {
            ConfirmCard(title: title, message: message, cancel: cancel, actions: actions)
        }
    }
}
