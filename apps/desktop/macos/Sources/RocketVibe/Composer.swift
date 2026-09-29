import AppKit
import AVFoundation
import AVKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI
import UniformTypeIdentifiers

struct Composer: View {
    @Environment(AppModel.self) var app
    let model: RoomModel
    @Binding var staged: [URL]
    @State var recorder = VoiceRecorder()
    @State var editingLast: MessageItem?
    @State var editText = ""

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 6) {
            if !staged.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(staged, id: \.self) { url in
                            HStack(spacing: 6) {
                                Image(systemName: "doc")
                                Text(url.lastPathComponent).lineLimit(1)
                                Button { staged.removeAll { $0 == url } } label: { Image(systemName: "xmark.circle.fill") }
                                    .buttonStyle(.plain)
                                    .help(L("attach.remove"))
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(.quaternary.opacity(0.5), in: Capsule())
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button(action: pick) { Image(systemName: "paperclip") }
                    .buttonStyle(.borderless)
                    .help(L("attach.choose"))
                ComposerField(
                    text: $model.draft,
                    placeholder: L("composer.placeholder"),
                    onSubmit: send,
                    onUpInEmpty: editLast,
                    onPasteFiles: { staged.append(contentsOf: $0) }
                )
                .frame(height: height)
                .padding(6)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor)))
                if recorder.recording {
                    Text(recorder.elapsed).monospacedDigit().foregroundStyle(.red)
                    Button { recorder.cancel() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .help(L("voice.cancel"))
                    Button(action: sendVoice) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        .buttonStyle(.borderless)
                        .help(L("voice.send"))
                } else {
                    Button { Task { await startVoice() } } label: { Image(systemName: "mic") }
                        .buttonStyle(.borderless)
                        .help(L("voice.record"))
                    Button(action: send) { Image(systemName: "paperplane.fill") }
                        .buttonStyle(.borderless)
                        .help(L("composer.send"))
                        .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && staged.isEmpty)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .sheet(item: Binding(get: { editingLast.map(EditingLast.init) }, set: { editingLast = $0?.message })) { e in
            EditLastSheet(model: model, message: e.message)
        }
    }

    var height: CGFloat {
        let lines = max(1, model.draft.split(separator: "\n", omittingEmptySubsequences: false).count)
        return min(160, CGFloat(lines) * 18 + 6)
    }

    func send() {
        let files = staged
        staged = []
        if files.isEmpty {
            Task { await model.send() }
            return
        }
        let caption = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        model.draft = ""
        Task {
            for (i, url) in files.enumerated() {
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                if let refusal = await model.attach(
                    path: url.path, name: url.lastPathComponent, mime: mime,
                    caption: i == 0 && !caption.isEmpty ? caption : nil, temporary: false)
                {
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

/// AppKit's text view: native editing, the system spell checker and text
/// services. Return sends, Shift-Return starts a new line.
struct ComposerField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let onSubmit: () -> Void
    let onUpInEmpty: () -> Void
    let onPasteFiles: ([URL]) -> Void

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
        view.font = .systemFont(ofSize: NSFont.systemFontSize + 1)
        view.isContinuousSpellCheckingEnabled = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.drawsBackground = false
        view.textContainerInset = NSSize(width: 2, height: 2)
        view.setAccessibilityLabel(placeholder)
        view.string = text
        view.onPasteFiles = onPasteFiles
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
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
        }

        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            if selector == #selector(NSResponder.insertNewline(_:)) {
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    view.insertNewlineIgnoringFieldEditor(nil)
                } else {
                    parent.onSubmit()
                }
                return true
            }
            if selector == #selector(NSResponder.moveUp(_:)) && view.string.isEmpty {
                parent.onUpInEmpty()
                return true
            }
            return false
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
