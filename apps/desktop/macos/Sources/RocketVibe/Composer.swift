import AppKit
import AVFoundation
import AVKit
import ImageIO
import RocketVibeCore
import RocketVibeKit
import SwiftUI
import UniformTypeIdentifiers

/// Lets the SwiftUI side act on the text view: insertions keep undo and the cursor.
@MainActor
final class ComposerBridge {
    weak var view: NSTextView?

    /// The text before the cursor.
    var beforeCursor: String {
        guard let view else { return "" }
        let location = view.selectedRange().location
        return (view.string as NSString).substring(to: min(location, (view.string as NSString).length))
    }

    /// Replaces from `start` (in Unicode scalars) up to the cursor.
    func replace(fromScalar start: Int, with text: String) {
        guard let view else { return }
        let before = beforeCursor
        let head = String(String.UnicodeScalarView(before.unicodeScalars.prefix(start)))
        let range = NSRange(location: (head as NSString).length, length: (before as NSString).length - (head as NSString).length)
        view.insertText(text, replacementRange: range)
    }

    func insert(_ text: String) {
        guard let view else { return }
        view.insertText(text, replacementRange: view.selectedRange())
        view.window?.makeFirstResponder(view)
    }
}

enum ComposerKey {
    case up, down, accept, cancel
}

struct Composer: View {
    @Environment(AppModel.self) var app
    let model: RoomModel
    @Binding var staged: [URL]
    @State var recorder = VoiceRecorder()
    @State var editingLast: MessageItem?
    @State var bridge = ComposerBridge()
    @State var suggestions: Suggestions?
    @State var selected = 0
    @State var picking = false
    @State var previewing: URL?
    @State var caption = ""
    @State var original = false

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 6) {
            if let note = model.note {
                PrivateNote(text: note) { model.note = nil }
            }
            if let suggestions {
                SuggestionList(items: suggestions.items, selected: selected) { accept($0) }
            }
            if !staged.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(staged, id: \.self) { url in
                            StagedChip(url: url) { staged.removeAll { $0 == url } }
                                .onTapGesture { previewing = url }
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                HStack(alignment: .bottom, spacing: 8) {
                    Button(action: pick) { Image(systemName: "paperclip").foregroundStyle(Vibe.muted) }
                        .buttonStyle(.borderless)
                        .help(L("attach.choose"))
                        .padding(.bottom, 5)
                    ComposerField(
                        text: $model.draft,
                        placeholder: L("composer.placeholder"),
                        bridge: bridge,
                        onSubmit: send,
                        onUpInEmpty: editLast,
                        onPasteFiles: { staged.append(contentsOf: $0) },
                        onCursor: suggest,
                        onKey: key
                    )
                    .frame(height: height)
                    Button { picking = true } label: { Image(systemName: "face.smiling").foregroundStyle(Vibe.muted) }
                        .buttonStyle(.borderless)
                        .help(L("composer.emoji"))
                        .padding(.bottom, 5)
                        .popover(isPresented: $picking) {
                            EmojiPicker { _, glyph in
                                picking = false
                                bridge.insert(glyph)
                            }
                        }
                    if recorder.recording {
                        Text(recorder.elapsed).monospacedDigit().foregroundStyle(Vibe.pink).padding(.bottom, 5)
                        Button { recorder.cancel() } label: { Image(systemName: "xmark").foregroundStyle(Vibe.muted) }
                            .buttonStyle(.borderless)
                            .help(L("voice.cancel"))
                            .padding(.bottom, 5)
                    } else {
                        Button { Task { await startVoice() } } label: { Image(systemName: "mic").foregroundStyle(Vibe.muted) }
                            .buttonStyle(.borderless)
                            .help(L("voice.record"))
                            .padding(.bottom, 5)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(Vibe.card, in: RoundedRectangle(cornerRadius: 22))
                .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Vibe.line, lineWidth: 1.5))
                if recorder.recording {
                    Button(action: sendVoice) { Image(systemName: "arrow.up") }
                        .buttonStyle(SendButtonStyle())
                        .help(L("voice.send"))
                        .transition(.scale.combined(with: .opacity))
                } else {
                    Button(action: send) { Image(systemName: "arrow.up") }
                        .buttonStyle(SendButtonStyle())
                        .help(L("composer.send"))
                        .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && staged.isEmpty)
                        .keyboardShortcut(.return, modifiers: .command)
                }
            }
            .animation(Vibe.spring, value: recorder.recording)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .sheet(item: Binding(get: { editingLast.map(EditingLast.init) }, set: { editingLast = $0?.message })) { e in
            EditLastSheet(model: model, message: e.message)
        }
        .sheet(item: Binding(get: { previewing.map(Playing.init) }, set: { previewing = $0?.url })) { p in
            StagedPreview(url: p.url, caption: $model.draft, original: $original) {
                staged.removeAll { $0 == p.url }
                previewing = nil
            }
        }
    }

    var height: CGFloat {
        let lines = max(1, model.draft.split(separator: "\n", omittingEmptySubsequences: false).count)
        return min(170, CGFloat(lines) * 20 + 6)
    }

    func suggest(_ before: String) {
        let fresh = app.chat?.suggestions(rid: model.rid, beforeCursor: before)
        if fresh?.start != suggestions?.start || fresh?.items != suggestions?.items { selected = 0 }
        suggestions = fresh
    }

    func accept(_ item: Suggestion) {
        guard let start = suggestions?.start else { return }
        suggestions = nil
        bridge.replace(fromScalar: Int(start), with: item.insert)
    }

    /// Arrows, Return, Tab and Escape drive the suggestions while they show.
    func key(_ key: ComposerKey) -> Bool {
        guard let items = suggestions?.items, !items.isEmpty else { return false }
        switch key {
        case .up: selected = (selected + items.count - 1) % items.count
        case .down: selected = (selected + 1) % items.count
        case .accept: accept(items[min(selected, items.count - 1)])
        case .cancel: suggestions = nil
        }
        return true
    }

    func send() {
        let files = staged
        staged = []
        suggestions = nil
        if files.isEmpty {
            Task {
                if let refusal = await model.send() { app.notice = refusal }
            }
            return
        }
        let caption = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        model.draft = ""
        let reduce = !original
        let outgoing = URL(fileURLWithPath: app.client.cacheDir()).appendingPathComponent("outgoing")
        Task {
            for (i, url) in files.enumerated() {
                var (path, name, temporary) = (url.path, url.lastPathComponent, false)
                var mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                if reduce, let copy = reduceImage(url, mime: mime, into: outgoing) {
                    (path, name, mime, temporary) = (copy.path, url.deletingPathExtension().lastPathComponent + ".jpg", "image/jpeg", true)
                }
                if let refusal = await model.attach(
                    path: path, name: name, mime: mime,
                    caption: i == 0 && !caption.isEmpty ? caption : nil, temporary: temporary)
                {
                    if temporary { try? FileManager.default.removeItem(atPath: path) }
                    app.notice = refusal
                }
            }
        }
    }

    func pick() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        if panel.runModal() == .OK { staged.append(contentsOf: panel.urls) }
    }

    func editLast() {
        editingLast = model.lastMine()
    }

    func startVoice() async {
        let dir = URL(fileURLWithPath: app.client.cacheDir()).appendingPathComponent("outgoing")
        if let error = await recorder.start(in: dir) { app.notice = error }
    }

    func sendVoice() {
        guard let file = recorder.stop() else {
            app.notice = L("voice.empty")
            return
        }
        Task {
            let name = "\(L("voice.file_name"))-\(Int(Date().timeIntervalSince1970)).m4a"
            if let refusal = await model.attach(path: file.path, name: name, mime: "audio/mp4", caption: nil, temporary: true) {
                app.notice = refusal
            }
        }
    }
}

/// A copy fitting 1920 px as JPEG, as the GTK app sends: None when it would
/// not be smaller, or for what is not a still picture.
func reduceImage(_ url: URL, mime: String, into dir: URL) -> URL? {
    guard ["image/jpeg", "image/png", "image/heic", "image/webp", "image/tiff", "image/bmp"].contains(mime),
          let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    else { return nil }
    let width = props[kCGImagePropertyPixelWidth] as? Int ?? 0
    let height = props[kCGImagePropertyPixelHeight] as? Int ?? 0
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    if width <= 1920 && height <= 1920 && size < 1024 * 1024 { return nil }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 1920,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let out = dir.appendingPathComponent("reduced-\(UUID().uuidString.prefix(8)).jpg")
    guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? out : nil
}

struct SuggestionList: View {
    @Environment(AppModel.self) var app
    let items: [Suggestion]
    let selected: Int
    let pick: (Suggestion) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                HStack(spacing: 8) {
                    if let glyph = item.glyph {
                        Text(glyph)
                    } else if let image = item.image {
                        RemoteImage(path: image, width: 18, height: 18)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.label)
                        if let detail = item.detail {
                            Text(detail).font(.vibe(11.5)).foregroundStyle(Vibe.muted).lineLimit(1)
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(i == selected ? Vibe.line : .clear)
                .contentShape(Rectangle())
                .onTapGesture { pick(item) }
            }
        }
        .vibeCard(radius: 10)
        .frame(maxWidth: 320, alignment: .leading)
    }
}

/// A slash command's answer, which the server shows to me alone.
struct PrivateNote: View {
    let text: String
    let close: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("command.only_you")).font(.vibe(12, .bold)).foregroundStyle(Vibe.mint)
                Text(markdown).font(.vibe(13)).textSelection(.enabled)
            }
            Spacer()
            Button(action: close) { Image(systemName: "xmark").foregroundStyle(Vibe.muted) }
                .buttonStyle(.borderless)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Vibe.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .leading) { Rectangle().fill(Vibe.mint).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    var markdown: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

struct StagedChip: View {
    let url: URL
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let image = NSImage(contentsOf: url), UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
                Image(nsImage: image).resizable().scaledToFill().frame(width: 22, height: 22).clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                Image(systemName: "doc")
            }
            Text(url.lastPathComponent).lineLimit(1)
            Text(ByteCountFormatter.string(fromByteCount: Int64((try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0), countStyle: .file))
                .font(.caption).foregroundStyle(.secondary)
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain)
                .help(L("attach.remove"))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Vibe.card, in: Capsule())
        .overlay(Capsule().strokeBorder(Vibe.line))
    }
}

/// A staged file before it leaves: the picture, the caption (the composer's
/// text), whether images keep their original quality.
struct StagedPreview: View {
    @Environment(\.dismiss) var dismiss
    let url: URL
    @Binding var caption: String
    @Binding var original: Bool
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(url.lastPathComponent).font(.headline)
            if let image = NSImage(contentsOf: url), UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
                Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 360)
                Toggle(L("attach.original"), isOn: $original)
            } else {
                Image(systemName: "doc").font(.system(size: 48))
            }
            TextField(L("composer.placeholder"), text: $caption, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button(L("attach.remove"), role: .destructive, action: remove)
                Spacer()
                Button(L("actions.save")) { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding()
        .frame(width: 480)
    }
}

struct EditingLast: Identifiable {
    let message: MessageItem
    var id: String { message.id }
}

/// Up arrow in an empty composer: my last message, to edit.
struct EditLastSheet: View {
    @Environment(\.dismiss) var dismiss
    @Environment(AppModel.self) var app
    let model: RoomModel
    let message: MessageItem
    @State var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L("actions.edit")).font(.headline)
            TextField("", text: $text, axis: .vertical)
                .lineLimit(2...12)
                .textFieldStyle(.roundedBorder)
                .onSubmit(save)
            HStack {
                Text(L("edit.hint")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(L("actions.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L("actions.save"), action: save).keyboardShortcut(.defaultAction)
            }
        }
        .padding()
        .frame(width: 460)
        .onAppear { text = message.text ?? "" }
    }

    func save() {
        let edited = text.trimmingCharacters(in: .whitespacesAndNewlines)
        dismiss()
        guard !edited.isEmpty, edited != message.text else { return }
        Task {
            do { try await model.edit(message, text: edited) } catch { app.notice = L("edit.too_late") }
        }
    }
}

/// AppKit's text view: native editing, the system spell checker, text
/// services and Edit > Emoji & Symbols. Return sends, Shift-Return starts a
/// new line.
struct ComposerField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let bridge: ComposerBridge
    let onSubmit: () -> Void
    let onUpInEmpty: () -> Void
    let onPasteFiles: ([URL]) -> Void
    let onCursor: (String) -> Void
    let onKey: (ComposerKey) -> Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        let view = ComposerTextView(frame: .zero)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = view
        view.delegate = context.coordinator
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.font = NSFont(name: "Nunito-Regular", size: 14.5) ?? .systemFont(ofSize: NSFont.systemFontSize + 1)
        view.textColor = NSColor(Vibe.text)
        view.insertionPointColor = NSColor(Vibe.pink)
        view.isContinuousSpellCheckingEnabled = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.drawsBackground = false
        view.textContainerInset = NSSize(width: 2, height: 2)
        view.setAccessibilityLabel(placeholder)
        view.string = text
        view.onPasteFiles = onPasteFiles
        bridge.view = view
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        bridge.view = view
        if view.string != text {
            view.string = text
            view.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField

        init(_ parent: ComposerField) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
            cursorMoved(view)
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            cursorMoved(view)
        }

        func cursorMoved(_ view: NSTextView) {
            let location = min(view.selectedRange().location, (view.string as NSString).length)
            parent.onCursor((view.string as NSString).substring(to: location))
        }

        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.moveUp(_:)):
                if parent.onKey(.up) { return true }
                if view.string.isEmpty {
                    parent.onUpInEmpty()
                    return true
                }
                return false
            case #selector(NSResponder.moveDown(_:)):
                return parent.onKey(.down)
            case #selector(NSResponder.insertTab(_:)):
                return parent.onKey(.accept)
            case #selector(NSResponder.cancelOperation(_:)):
                return parent.onKey(.cancel)
            case #selector(NSResponder.insertNewline(_:)):
                if parent.onKey(.accept) { return true }
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    view.insertNewlineIgnoringFieldEditor(nil)
                } else {
                    parent.onSubmit()
                }
                return true
            default:
                return false
            }
        }
    }
}

/// Files pasted from Finder become chips, not text.
final class ComposerTextView: NSTextView {
    var onPasteFiles: (([URL]) -> Void)?

    override func paste(_ sender: Any?) {
        let urls = NSPasteboard.general.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        if let urls, !urls.isEmpty {
            onPasteFiles?(urls)
            return
        }
        super.paste(sender)
    }
}

/// Voice messages: the microphone to AAC in .m4a, as the Android app sends them.
@MainActor @Observable
final class VoiceRecorder {
    var recording = false
    var elapsed = "0:00"
    var recorder: AVAudioRecorder?
    var file: URL?
    var ticker: Timer?

    func start(in dir: URL) async -> String? {
        guard await AVCaptureDevice.requestAccess(for: .audio) else { return L("voice.failed") }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("voice-\(UUID().uuidString.prefix(8)).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
        ]
        guard let recorder = try? AVAudioRecorder(url: url, settings: settings), recorder.record() else {
            return L("voice.failed")
        }
        self.recorder = recorder
        file = url
        recording = true
        elapsed = "0:00"
        ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let recorder = self.recorder else { return }
                let s = Int(recorder.currentTime)
                self.elapsed = String(format: "%d:%02d", s / 60, s % 60)
            }
        }
        return nil
    }

    /// The recording, or nil when it is too short to be one.
    func stop() -> URL? {
        let duration = recorder?.currentTime ?? 0
        recorder?.stop()
        finish()
        guard duration >= 0.5 else {
            if let file { try? FileManager.default.removeItem(at: file) }
            return nil
        }
        return file
    }

    func cancel() {
        recorder?.stop()
        if let file { try? FileManager.default.removeItem(at: file) }
        finish()
    }

    func finish() {
        ticker?.invalidate()
        ticker = nil
        recorder = nil
        recording = false
    }
}

struct PlayerView: View {
    @Environment(\.dismiss) var dismiss
    let url: URL
    @State var player: AVPlayer?

    var body: some View {
        VStack(spacing: 0) {
            VideoPlayer(player: player)
                .frame(minWidth: 480, minHeight: 300)
            HStack {
                Spacer()
                Button(L("actions.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(8)
        }
        .onAppear {
            let p = AVPlayer(url: url)
            player = p
            p.play()
        }
        .onDisappear { player?.pause() }
    }
}
