import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// AppKit decodes and animates GIFs, including the sticker shelf's thumbnails.
struct SocialImage: NSViewRepresentable {
    let url: String
    func makeNSView(context: Context) -> NSImageView {
        let view = NSImageView(); view.imageScaling = .scaleProportionallyUpOrDown; view.animates = true
        return view
    }
    func updateNSView(_ view: NSImageView, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url; context.coordinator.task?.cancel(); view.image = nil
        guard let link = URL(string: url), link.scheme == "https" else { return }
        context.coordinator.task = Task { @MainActor [weak view] in
            do {
                let (bytes, response) = try await URLSession.shared.bytes(from: link)
                guard let status = response as? HTTPURLResponse, (200..<300).contains(status.statusCode) else { return }
                var data = Data()
                for try await byte in bytes { if Task.isCancelled || data.count >= 8 * 1024 * 1024 { return }; data.append(byte) }
                guard !Task.isCancelled else { return }
                view?.image = NSImage(data: data)
            } catch { }
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    static func dismantleNSView(_ view: NSImageView, coordinator: Coordinator) { coordinator.task?.cancel() }
    final class Coordinator { var url = ""; var task: Task<Void, Never>? }
}

struct SocialPanel: View {
    @Environment(\.closeModal) var dismiss
    let model: RoomModel
    var initialMode = "menu"
    var initialQuery = ""
    var onSent: () -> Void = {}
    @State var mode = "menu"
    @State var query = ""
    @State var searched = ""
    @State var items: [SocialMediaItem] = []
    @State var title = ""
    @State var details = ""
    @State var url = ""
    @State var multiple = false
    @State var closes = false
    @State var date = Date().addingTimeInterval(86400)
    @State var busy = false
    @State var error: String?
    @State var attempts: [String: String] = [:]
    @State var searchVersion = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text(heading).font(.title2.bold()); Spacer(); Button(L("actions.cancel")) { dismiss() } }
            if let error { Text(error).foregroundStyle(Vibe.pink) }
            if mode == "menu" {
                if model.supportsSocial {
                    Button(L("social.poll")) { mode = "poll" }
                    Button(L("social.game")) { mode = "game" }
                }
                Button(L("social.shelf")) { mode = "stickers"; Task { await load() } }
                if model.supportsGiphy { Button("GIF · Powered By GIPHY") { mode = "giphy"; Task { await load() } } }
            } else if mode == "poll" || mode == "game" {
                TextField(L("social.title"), text: $title)
                if mode == "poll" {
                    Text(L("social.options")); TextEditor(text: $details).frame(height: 130)
                    Toggle(L("social.multiple"), isOn: $multiple)
                    Toggle(L("social.closes"), isOn: $closes)
                    if closes { DatePicker(L("social.date"), selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute]) }
                } else {
                    DatePicker(L("social.date"), selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    TextField(L("social.details"), text: $details, axis: .vertical).lineLimit(3...6)
                }
                Button(L("social.post")) { act { try await create(); dismiss() } }.disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } else {
                if mode == "giphy" {
                    HStack { TextField(L("social.search"), text: $query).onSubmit { Task { await load() } }; Button(L("social.search")) { Task { await load() } } }
                }
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 160))], spacing: 12) {
                        ForEach(items, id: \.id) { item in
                            VStack {
                                SocialImage(url: item.url).frame(height: 130).accessibilityLabel(item.title)
                                Text(item.title).lineLimit(2)
                                HStack {
                                    Button(L("composer.send")) { act { try await model.socialSend(item, operation: attempt("send:" + item.url), gif: mode == "giphy", query: searched); onSent(); dismiss() } }
                                    if mode == "giphy" { Button(L("social.save")) { act { try await model.socialSave(item, operation: attempt("save:" + item.url)) } } }
                                    else { Button(L("social.remove")) { act { try await model.socialRemove(item.id); await load() } } }
                                }.disabled(busy)
                            }.padding(10).background(Vibe.card, in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    if items.isEmpty && !busy { Text(L("social.empty")).foregroundStyle(Vibe.muted) }
                }.frame(minHeight: 160, maxHeight: 360)
                if mode == "stickers" {
                    TextField(L("social.title"), text: $title); TextField("https://…", text: $url)
                    Button(L("social.add")) { act { let item = SocialMediaItem(id: "", title: title, url: url); try await model.socialSave(item, operation: attempt("add:" + title + url)); title = ""; url = ""; await load() } }.disabled(busy)
                } else { Text("Powered By GIPHY").font(.caption).foregroundStyle(Vibe.muted) }
            }
            if busy { ProgressView() }
        }.padding(22).frame(width: 560)
        .task { mode = initialMode; query = initialQuery; if mode == "giphy" || mode == "stickers" { await load() } }
        .onDisappear { searchVersion += 1 }
    }
    var heading: String { mode == "poll" ? L("social.poll") : mode == "game" ? L("social.game") : mode == "giphy" ? "GIF · Powered By GIPHY" : L("social.shelf") }
    func attempt(_ key: String) -> String { if let id = attempts[key] { return id }; let id = UUID().uuidString; attempts[key] = id; return id }
    func act(_ operation: @escaping () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        Task { defer { busy = false }; do { try await operation() } catch is CancellationError { } catch { self.error = L("social.failed") } }
    }
    func load() async {
        searchVersion += 1; let version = searchVersion; let heldQuery = query
        do { let found = try await model.socialMedia(gifs: mode == "giphy", query: heldQuery); guard version == searchVersion else { return }; items = found; searched = heldQuery; error = nil }
        catch { if version == searchVersion { self.error = L("social.failed") } }
    }
    func create() async throws {
        let key = "create:" + mode + title + details + String(multiple) + String(closes) + String(date.timeIntervalSince1970)
        if mode == "poll" { try await model.socialPoll(operation: attempt(key), question: title, options: details.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }, multiple: multiple, closesAt: closes ? Int64(date.timeIntervalSince1970) : nil) }
        else { try await model.socialGame(operation: attempt(key), title: title, description: details, startsAt: Int64(date.timeIntervalSince1970)) }
    }
}

struct SocialCardView: View {
    @Environment(AppModel.self) var app
    let social: SocialItem
    let message: MessageItem
    let model: RoomModel
    @State var choices: Set<UInt32> = []
    @State var busy = false
    @State var attempts: [String: String] = [:]
    var own: [UInt32] { social.options.enumerated().compactMap { $0.element.voters.contains(model.socialUser) ? UInt32($0.offset) : nil } }
    var date: Date? { guard let at = social.at else { return nil }; let parser=ISO8601DateFormatter(); parser.formatOptions=[.withInternetDateTime,.withFractionalSeconds]; return parser.date(from: at) ?? ISO8601DateFormatter().date(from: at) }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { time in
            VStack(alignment: .leading, spacing: 10) {
                Text(social.title).font(.headline)
                if social.kind == .image, let url = social.url {
                    SocialImage(url: url).frame(width: 320, height: 220)
                    if let by = social.poweredBy { Text("Powered By " + by).font(.caption) }
                    Button(L("social.save")) { act("save") { op in try await model.socialSave(SocialMediaItem(id: message.id, title: social.title, url: url), operation: op) } }
                } else if social.kind == .poll {
                    let closed = social.closed || date.map { $0 <= time.date } == true
                    ForEach(Array(social.options.enumerated()), id: \.offset) { i, option in
                        Toggle(option.label + " · " + String(option.voters.count), isOn: Binding(get: { choices.contains(UInt32(i)) }, set: { checked in if !social.multiple { choices = [] }; if checked { choices.insert(UInt32(i)) } else { choices.remove(UInt32(i)) } })).disabled(closed || busy)
                    }
                    if closed { Text(L("social.closed")).foregroundStyle(Vibe.muted) }
                    else {
                        HStack {
                            Button(L("social.vote")) { answer(choices.sorted()) }
                            Button(L("social.clear")) { answer([]) }
                            if message.authorId == model.socialUser { Button(L("social.close")) { act("close") { op in try await model.socialClose(id: message.id, operation: op) } } }
                        }
                    }
                } else {
                    if let date { Text(date, format: .dateTime.weekday().day().month().hour().minute()) }
                    Text(social.description).textSelection(.enabled)
                    let labels = [L("social.going"), L("social.maybe"), L("social.declined")]
                    let groups = [social.going, social.maybe, social.declined]
                    HStack { ForEach(0..<3) { i in Button(labels[i] + " · " + String(groups[i].count)) { answer([UInt32(i)]) }.tint(groups[i].contains(model.socialUser) ? Vibe.pink : Vibe.muted) } }.disabled(date.map { $0 <= time.date } == true)
                    if let date, date > time.date { Button(L("reminders.title")) { app.remind(message, roomName: model.room.name, due: Int64(max(Date().timeIntervalSince1970 + 60, date.timeIntervalSince1970 - 600))) } }
                    Button(L("voice_session.join")) { Task { await app.voice?.join(model.rid) } }
                }
            }.padding(14).background(Vibe.card, in: RoundedRectangle(cornerRadius: 14)).disabled(busy || !model.supportsSocialMedia)
        }
        .onAppear { choices = Set(own) }.onChange(of: own) { _, value in choices = Set(value) }
    }
    func answer(_ values: [UInt32]) { act("answer:" + values.description) { op in try await model.socialAnswer(id: message.id, operation: op, choices: values) } }
    func act(_ key: String, operation: @escaping (String) async throws -> Void) {
        guard !busy else { return }; busy = true
        let id = attempts[key] ?? UUID().uuidString; attempts[key] = id
        Task { defer { busy = false }; do { try await operation(id); attempts.removeValue(forKey: key) } catch is CancellationError { } catch { app.notice = L("social.failed") } }
    }
}

struct VoiceReactionsView: View {
    let voice: VoiceModel
    @State var reactions: [VoiceBurst] = []
    var body: some View {
        if let room = voice.state.room, voice.state.phase == .connected, voice.native.supportedFeatures().contains("voice_reactions"), voice.native.socialAvailable(room: room) {
            VStack(spacing: 3) {
                HStack { ForEach(reactions, id: \.id) { Text($0.emoji).font(.title).transition(.scale.combined(with: .opacity)) } }
                Menu { ForEach(["👏", "😂", "❤️", "🎉", "👍", "👋"], id: \.self) { emoji in Button(emoji) { Task { do { try await voice.native.reactVoice(room: room, emoji: emoji, operation: UUID().uuidString) } catch { voice.onNotice?(L("social.failed")) } } } } } label: { Image(systemName: "face.smiling") }.help(L("social.react"))
            }.task(id: room) { while !Task.isCancelled { let fresh = voice.native.voiceReactions(room: room); withAnimation(.easeOut(duration: 0.2)) { reactions = fresh }; try? await Task.sleep(for: .milliseconds(250)) } }
        }
    }
}
