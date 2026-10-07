import AppKit
import AVFoundation
import RocketVibeCore
import RocketVibeKit
import SwiftUI

// Voice on a RocketVibe server, as the GTK app shows it (rv-gtk's
// chat_voice.rs): the people of each room's session under its row, the voice
// page (tiles sharing the page, a shared screen on a stage), the "Voice
// connected" panel, the menu beside the microphone, the share picker, the
// stage full screen. The session itself runs in the `rv-voice` sidecar,
// through rv-ffi; `VoiceModel` follows it.

/// The volumes offered for someone, as Discord's steps.
private let personVolumes: [Float] = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

private func percent(_ value: Float) -> String { "\(Int((value * 100).rounded())) %" }

/// Someone's volume here and a mute for this side only, in their context menu.
struct PersonMenu: View {
    let voice: VoiceModel
    let member: VoiceMember

    var body: some View {
        let volume = voice.volume(of: member.id)
        Toggle(L("voice_person.mute"), isOn: Binding(get: { member.mutedHere }, set: { muted in
            Task { await voice.setPerson(member.id, volume: volume, muted: muted) }
        }))
        Picker(L("voice_person.volume"), selection: Binding(get: { volume }, set: { level in
            Task { await voice.setPerson(member.id, volume: level, muted: member.mutedHere) }
        })) {
            ForEach(personVolumes, id: \.self) { Text(percent($0)).tag($0) }
        }
    }
}

/// The icons after someone's name: muted, deafened, muted here, camera, screen.
struct MemberIcons: View {
    let member: VoiceMember
    var size: CGFloat = 11

    var body: some View {
        HStack(spacing: 4) {
            if member.muted { Image(systemName: "mic.slash.fill").foregroundStyle(Vibe.pink) }
            if member.deafened { Image(systemName: "speaker.slash.fill").foregroundStyle(Vibe.pink) }
            if member.mutedHere { Image(systemName: "speaker.minus.fill").foregroundStyle(Vibe.sun).help(L("voice_person.muted_here")) }
            if member.screen { Image(systemName: "display").foregroundStyle(Vibe.muted) }
            if member.camera { Image(systemName: "video.fill").foregroundStyle(Vibe.muted) }
        }
        .font(.system(size: size))
    }
}

/// An avatar whose ring lights up while its person speaks.
struct SpeakingAvatar: View {
    let member: VoiceMember
    let size: CGFloat

    var body: some View {
        Avatar(path: member.avatar, name: member.name, size: size)
            .padding(max(2, size / 22))
            .overlay(
                RoundedRectangle(cornerRadius: size / 3 + 3)
                    .strokeBorder(member.speaking ? Vibe.mint : .clear, lineWidth: max(2, size / 22))
                    .shadow(color: member.speaking ? Vibe.mint.opacity(0.6) : .clear, radius: 6)
            )
            .animation(.easeOut(duration: member.speaking ? 0.12 : 0.32), value: member.speaking)
    }
}

/// The people of a room's session, under its row in the list.
struct VoiceOccupants: View {
    @Environment(AppModel.self) var app
    let voice: VoiceModel
    let room: String

    var body: some View {
        let _ = voice.revision
        let members = voice.members(room)
        if !members.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(members, id: \.id) { member in
                    HStack(spacing: 7) {
                        SpeakingAvatar(member: member, size: 20)
                        Text(member.name).font(.vibe(12.5, .bold)).foregroundStyle(Vibe.soft).lineLimit(1)
                        Spacer(minLength: 4)
                        MemberIcons(member: member)
                    }
                    .contentShape(Rectangle())
                    .contextMenu { if !member.local { PersonMenu(voice: voice, member: member) } }
                }
            }
            .padding(.leading, 46)
            .padding(.bottom, 4)
        }
    }
}

/// A camera or a screen of the session (this side's own included), redrawn
/// when a new frame came: the frames reach the app over the sidecar's loopback
/// stream, rv-ffi hands the latest one.
struct VoiceVideo: View {
    let native: NativeChat
    let identity: String
    var screen = false
    var fill = false
    /// A share picker's thumbnail rather than someone's video.
    var thumbnail = false
    @State var image: CGImage?
    @State var serial: UInt64 = 0

    var body: some View {
        ZStack {
            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.medium)
                    .aspectRatio(contentMode: fill ? .fill : .fit)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .task(id: identity) {
            serial = 0
            image = nil
            while !Task.isCancelled {
                poll()
                try? await Task.sleep(nanoseconds: 40_000_000)
            }
        }
    }

    func poll() {
        let frame = thumbnail
            ? native.voiceThumbnail(source: identity, since: serial)
            : native.voiceFrame(identity: identity, screen: screen, since: serial)
        guard let frame else {
            if serial != 0 { serial = 0; image = nil }
            return
        }
        guard !frame.rgba.isEmpty, frame.width > 0, frame.height > 0 else { return }
        serial = frame.serial
        image = Self.picture(frame)
    }

    static func picture(_ frame: VoiceFrame) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(frame.rgba) as CFData) else { return nil }
        return CGImage(width: Int(frame.width), height: Int(frame.height), bitsPerComponent: 8, bitsPerPixel: 32,
                       bytesPerRow: Int(frame.width) * 4, space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}

/// Columns, then a tile's size, for `count` 16:9 tiles in a size: the column
/// count whose tiles come out largest (rv-gtk's tile_grid.rs).
func arrangeTiles(_ count: Int, in size: CGSize, gap: CGFloat = 12) -> (columns: Int, tile: CGSize) {
    var best = (columns: 1, tile: CGSize.zero)
    for columns in 1...max(1, count) {
        let rows = CGFloat((max(1, count) + columns - 1) / columns)
        let cellW = (size.width - gap * CGFloat(columns - 1)) / CGFloat(columns)
        let cellH = (size.height - gap * (rows - 1)) / rows
        let w = max(0, min(cellW, cellH * 16 / 9))
        if w > best.tile.width { best = (columns, CGSize(width: w, height: w * 9 / 16)) }
    }
    return best
}

/// Someone on the voice page: their camera filling the tile, or their avatar in
/// its middle, their name in a corner, the border lit while they speak.
struct VoiceTile: View {
    let voice: VoiceModel
    let member: VoiceMember
    let mine: Bool

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 16).fill(Vibe.card)
            if mine && member.camera {
                VoiceVideo(native: voice.native, identity: member.id, fill: true)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            } else {
                SpeakingAvatar(member: member, size: 96).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack(spacing: 6) {
                Text(member.local ? L("voice_session.you", ["name": member.name]) : member.name)
                    .font(.vibe(13, .heavy)).lineLimit(1)
                MemberIcons(member: member)
            }
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background(Vibe.ink.opacity(0.78), in: RoundedRectangle(cornerRadius: 8))
            .padding(10)
        }
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(member.speaking ? Vibe.mint : Vibe.line, lineWidth: 2))
        .shadow(color: member.speaking ? Vibe.mint.opacity(0.35) : .clear, radius: 12)
        .animation(.easeOut(duration: member.speaking ? 0.12 : 0.32), value: member.speaking)
        .contextMenu { if !member.local { PersonMenu(voice: voice, member: member) } }
    }
}

/// Everyone as tiles sharing all the room there is.
struct VoiceTiles: View {
    let voice: VoiceModel
    let members: [VoiceMember]
    let mine: Bool

    var body: some View {
        GeometryReader { geometry in
            let arranged = arrangeTiles(members.count, in: geometry.size)
            let columns = arranged.columns, tile = arranged.tile
            let rows = stride(from: 0, to: members.count, by: columns).map { Array(members[$0..<min($0 + columns, members.count)]) }
            VStack(spacing: 12) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 12) {
                        ForEach(row, id: \.id) { member in
                            VoiceTile(voice: voice, member: member, mine: mine).frame(width: tile.width, height: tile.height)
                        }
                    }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }
}

/// Someone beside a shared screen: a small camera or the avatar, and the name.
struct MiniCard: View {
    let voice: VoiceModel
    let member: VoiceMember

    var body: some View {
        VStack(spacing: 4) {
            if member.camera {
                VoiceVideo(native: voice.native, identity: member.id, fill: true)
                    .frame(width: 160, height: 90).clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                SpeakingAvatar(member: member, size: 44)
            }
            Text(member.name).font(.vibe(12, .bold)).lineLimit(1)
        }
        .padding(8)
        .frame(width: 176)
        .background(Vibe.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(member.speaking ? Vibe.mint : Vibe.line, lineWidth: 2))
        .contextMenu { if !member.local { PersonMenu(voice: voice, member: member) } }
    }
}

/// The room's one shared screen, a button and a double click to see it full screen.
struct VoiceStage: View {
    let voice: VoiceModel
    let sharer: VoiceMember

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 20).fill(Vibe.night)
            VoiceVideo(native: voice.native, identity: sharer.id, screen: true)
                .clipShape(RoundedRectangle(cornerRadius: 18))
        }
        .overlay(alignment: .bottomLeading) {
            Text(L("voice_session.screen_of", ["name": sharer.name]))
                .font(.vibe(12, .bold))
                .padding(.horizontal, 9).padding(.vertical, 3)
                .background(Vibe.ink.opacity(0.82), in: RoundedRectangle(cornerRadius: 8))
                .padding(10)
        }
        .overlay(alignment: .topTrailing) {
            Button { FullScreenStage.show(voice: voice) } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                .buttonStyle(.borderless)
                .padding(8)
                .background(Vibe.ink.opacity(0.7), in: Circle())
                .padding(10)
                .help(L("voice_session.fullscreen"))
        }
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Vibe.line, lineWidth: 2))
        .onTapGesture(count: 2) { FullScreenStage.show(voice: voice) }
    }
}

/// The shared screen alone on the whole display, following a takeover;
/// Escape, a double click or the button come back.
@MainActor
final class FullScreenStage: NSObject, NSWindowDelegate {
    private static var open: FullScreenStage?
    private let window: NSWindow

    static func show(voice: VoiceModel) {
        guard open == nil else { return }
        let stage = FullScreenStage(voice: voice)
        open = stage
        stage.window.makeKeyAndOrderFront(nil)
        stage.window.toggleFullScreen(nil)
    }

    static func close() { open?.window.close() }

    private init(voice: VoiceModel) {
        // On the screen the app's window is on.
        let screen = NSApp.keyWindow?.screen ?? NSScreen.main
        window = NSWindow(contentRect: screen?.frame ?? NSRect(x: 0, y: 0, width: 1280, height: 720),
                          styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = .black
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self
        window.contentView = NSHostingView(rootView: FullStageView(voice: voice, close: { FullScreenStage.close() }))
    }

    func windowWillClose(_ notification: Notification) { FullScreenStage.open = nil }
}

struct FullStageView: View {
    let voice: VoiceModel
    let close: () -> Void

    var body: some View {
        let _ = voice.revision
        let sharer = voice.state.members.first { $0.screen }
        ZStack(alignment: .topTrailing) {
            Color.black
            if let sharer { VoiceVideo(native: voice.native, identity: sharer.id, screen: true) }
            Button(action: close) { Image(systemName: "arrow.down.right.and.arrow.up.left") }
                .buttonStyle(.borderless)
                .padding(10)
                .background(.black.opacity(0.6), in: Circle())
                .padding(16)
                .help(L("voice_session.exit_fullscreen"))
                .keyboardShortcut(.cancelAction)
        }
        .onTapGesture(count: 2, perform: close)
        // The share over: nothing left to show.
        .onChange(of: sharer == nil) { _, gone in if gone { close() } }
    }
}

/// The menu beside the microphone, as in Discord: devices, the microphone's
/// volume and live level, the speakers' volume, the noise remover, deafen, and
/// the way to the voice settings.
struct VoiceMenu: View {
    @Environment(\.openSettings) var openSettings
    let voice: VoiceModel
    @State var devices: VoiceDevices?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading("voice_menu.input_device")
            devicePicker(input: true)
            heading("voice_menu.output_device")
            devicePicker(input: false)
            Divider()
            heading("voice_menu.input_volume")
            VolumeSlider(value: voice.listening.inputVolume) { level in Task { await voice.setInputVolume(level) } }
            heading("voice_menu.input_level")
            LevelMeter(voice: voice)
            heading("voice_menu.output_volume")
            VolumeSlider(value: voice.listening.outputVolume) { level in Task { await voice.setOutputVolume(level) } }
            Divider()
            Toggle(L("voice_settings.noise"), isOn: Binding(get: { voice.listening.noiseSuppression },
                                                          set: { on in Task { await voice.setNoiseSuppression(on) } }))
                .help(L("voice_settings.noise_hint"))
            Toggle(L("voice_menu.deafen"), isOn: Binding(get: { voice.state.deafened },
                                                         set: { on in Task { await voice.setDeafened(on) } }))
            Button(L("voice_menu.settings")) { openSettings() }.buttonStyle(.link)
        }
        .padding(14)
        .frame(width: 300)
        .task { devices = await voice.devices() }
    }

    func heading(_ key: String) -> some View {
        Text(L(key)).font(.vibe(11, .heavy)).foregroundStyle(Vibe.muted)
    }

    @ViewBuilder func devicePicker(input: Bool) -> some View {
        if let devices {
            let list = input ? devices.inputs : devices.outputs
            Picker("", selection: Binding(get: { input ? devices.input : devices.output }, set: { id in
                Task { await voice.select(input: input, id: id); self.devices = await voice.devices() }
            })) {
                ForEach(list, id: \.id) { Text($0.name).tag($0.id) }
            }
            .labelsHidden()
        } else {
            Text(L("voice_settings.loading")).foregroundStyle(.secondary)
        }
    }
}

/// The settings' voice section: which microphone and speakers, the noise
/// remover. (A screen's sound carrying the call is the Windows and Linux
/// sidecars' only: on macOS a share sends no sound.)
struct VoiceSettings: View {
    let voice: VoiceModel
    @State var devices: VoiceDevices?
    @State var failed = false

    var body: some View {
        Section(L("voice_settings.title")) {
            devicePicker("voice_settings.input", input: true)
            devicePicker("voice_settings.output", input: false)
            Toggle(isOn: Binding(get: { voice.listening.noiseSuppression },
                                 set: { on in Task { await voice.setNoiseSuppression(on) } })) {
                Text(L("voice_settings.noise"))
                Text(L("voice_settings.noise_hint"))
            }
        }
        .task {
            devices = await voice.devices()
            failed = devices == nil
        }
    }

    @ViewBuilder func devicePicker(_ title: String, input: Bool) -> some View {
        if let devices {
            Picker(L(title), selection: Binding(get: { input ? devices.input : devices.output }, set: { id in
                Task { await voice.select(input: input, id: id); self.devices = await voice.devices() }
            })) {
                ForEach(input ? devices.inputs : devices.outputs, id: \.id) { Text($0.name).tag($0.id) }
            }
        } else {
            LabeledContent(L(title), value: L(failed ? "voice_settings.failed" : "voice_settings.loading"))
        }
    }
}

/// A volume slider, 0 to 200 %, set when the drag ends.
struct VolumeSlider: View {
    @State var value: Float
    let set: (Float) -> Void

    init(value: Float, set: @escaping (Float) -> Void) {
        _value = State(initialValue: value)
        self.set = set
    }

    var body: some View {
        HStack {
            Slider(value: $value, in: 0...2, onEditingChanged: { editing in if !editing { set(value) } })
            Text(percent(value)).font(.vibe(12, .bold)).frame(width: 48, alignment: .trailing)
        }
    }
}

/// The microphone's level as segments, read twenty times a second.
struct LevelMeter: View {
    let voice: VoiceModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.05)) { _ in
            let lit = Int((voice.inputLevel * 24).rounded())
            HStack(spacing: 3) {
                ForEach(0..<24, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 2).fill(index < lit ? Vibe.mint : Vibe.line)
                }
            }
            .frame(height: 12)
        }
    }
}

/// Microphone (and its menu), sound, screen and leave: the panel's set is
/// `compact`, without the screen.
struct VoiceControls: View {
    @Environment(AppModel.self) var app
    let voice: VoiceModel
    var compact = false
    @State var menu = false
    @State var picker = false

    var body: some View {
        let state = voice.state
        let muted = !state.microphone || !state.canPublish
        HStack(spacing: compact ? 6 : 14) {
            control(muted ? "mic.slash.fill" : "mic.fill", off: muted,
                    help: !state.canPublish ? "voice_session.listening" : muted ? "voice_session.unmute" : "voice_session.mute") {
                Task { await voice.toggleMicrophone() }
            }
            .disabled(!state.canPublish)
            Button { menu.toggle() } label: { Image(systemName: "chevron.up").font(.system(size: 10, weight: .bold)) }
                .buttonStyle(.borderless)
                .help(L("voice_menu.open"))
                .popover(isPresented: $menu, arrowEdge: .top) { VoiceMenu(voice: voice) }
            control(state.deafened ? "speaker.slash.fill" : "headphones", off: state.deafened,
                    help: state.deafened ? "voice_session.undeafen" : "voice_session.deafen") {
                Task { await voice.toggleDeafen() }
            }
            // No camera button: the sidecar captures none on macOS (voice.md); others' cameras show.
            if !compact {
                control("rectangle.inset.filled.on.rectangle", on: state.sharing,
                        help: state.sharing ? "voice_session.stop_screen" : "voice_session.share_screen") {
                    if state.sharing { Task { await voice.stopSharing() } } else { picker = true }
                }
                .disabled(!state.canPublish)
                .sheet(isPresented: $picker) { SharePicker(voice: voice) }
            }
            Button { Task { await voice.leave() } } label: {
                Image(systemName: "phone.down.fill")
                    .frame(width: compact ? 26 : 46, height: compact ? 26 : 46)
                    .background(compact ? Color.clear : Vibe.pink, in: Circle())
                    .foregroundStyle(compact ? Vibe.pink : Vibe.ink)
            }
            .buttonStyle(.plain)
            .help(L("voice_session.leave"))
        }
    }

    func control(_ icon: String, off: Bool = false, on: Bool = false, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .frame(width: compact ? 26 : 46, height: compact ? 26 : 46)
                .background(compact ? Color.clear : on ? Vibe.mint : Vibe.card, in: Circle())
                .foregroundStyle(on && !compact ? Vibe.ink : off ? Vibe.pink : Vibe.text)
        }
        .buttonStyle(.plain)
        .help(L(help))
    }
}

/// "Voice connected": above the account bar while a session lives; a click shows its page.
struct VoicePanel: View {
    @Environment(AppModel.self) var app
    let voice: VoiceModel

    var body: some View {
        if let room = voice.state.room {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(L(status)).font(.vibe(13, .heavy))
                        .foregroundStyle(voice.state.phase == .connected ? Vibe.mint : Vibe.sun)
                    Text(app.rooms.first { $0.rid == room }?.name ?? "").font(.vibe(11.5)).foregroundStyle(Vibe.muted).lineLimit(1)
                }
                .contentShape(Rectangle())
                .onTapGesture { app.showVoice(room) }
                Spacer()
                VoiceControls(voice: voice, compact: true)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(Vibe.ink)
            .overlay(alignment: .top) { Rectangle().fill(Vibe.line).frame(height: 1) }
        }
    }

    var status: String {
        switch voice.state.phase {
        case .connected: return "voice_session.connected"
        case .reconnecting: return "voice_session.reconnecting"
        default: return "voice_session.connecting"
        }
    }
}

/// A room's voice page: who is in its session as tiles, the shared screen, Join
/// or the controls; its chat one click away.
struct VoicePage: View {
    @Environment(AppModel.self) var app
    let voice: VoiceModel
    let room: Room

    var body: some View {
        let _ = voice.revision
        let state = voice.state
        let mine = state.room == room.rid
        let members = voice.members(room.rid)
        let sharer = mine ? members.first(where: { $0.screen }) : nil
        VStack(spacing: 16) {
            if let status { Text(status).font(.vibe(13, .bold)).foregroundStyle(mine && state.phase == .connected ? Vibe.mint : Vibe.muted) }
            if members.isEmpty {
                Spacer()
                Text(L("voice_session.empty")).foregroundStyle(Vibe.muted)
                Spacer()
            } else if let sharer {
                HStack(spacing: 14) {
                    VoiceStage(voice: voice, sharer: sharer)
                    ScrollView { VStack(spacing: 10) { ForEach(members, id: \.id) { MiniCard(voice: voice, member: $0) } } }
                        .frame(width: 184)
                }
            } else {
                VoiceTiles(voice: voice, members: members, mine: mine)
            }
            if mine {
                VoiceControls(voice: voice)
            } else if voice.joining != room.rid {
                Button(L("voice_session.join")) { Task { await voice.join(room.rid) } }
                    .buttonStyle(VibeButtonStyle())
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 20)
        .background(Vibe.night)
        .navigationTitle(room.name)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button(L("voice_session.open_chat")) { voice.shown = nil }
            }
        }
    }

    var status: String? {
        let state = voice.state
        let mine = state.room == room.rid
        let ringing = mine && state.members.count < 2
            && voice.calls.contains { $0.room == room.rid && $0.state == "ringing" }
        let key: String?
        switch (mine, state.phase) {
        case (true, _) where ringing: key = "voice_session.ringing"
        case (true, .connected): key = "voice_session.connected"
        case (true, .reconnecting): key = "voice_session.reconnecting"
        case (true, _): key = "voice_session.connecting"
        case (false, _) where voice.joining == room.rid: key = "voice_session.connecting"
        default: key = nil
        }
        guard let key else { return nil }
        return mine && state.encrypted ? L("voice_session.secure", ["status": L(key)]) : L(key)
    }
}

/// What to share, as in Discord: the screens and the windows with their
/// thumbnails, and the quality, kept for the next share. Where the system picks
/// (none listed), only the quality.
struct SharePicker: View {
    @Environment(\.dismiss) var dismiss
    let voice: VoiceModel
    @State var sources: [VoiceSource]?
    @State var windows = false
    @State var chosen: String?
    @State var height: UInt32 = 1080
    @State var fps: UInt32 = 15

    var body: some View {
        VStack(spacing: 14) {
            Text(L("voice_share.title")).font(.vibeTitle(18, .bold))
            if let sources, !sources.isEmpty {
                Picker("", selection: $windows) {
                    Text(L("voice_share.screens")).tag(false)
                    Text(L("voice_share.windows")).tag(true)
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 260)
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 12)], spacing: 12) {
                        ForEach(Array(sources.filter { $0.window == windows }.enumerated()), id: \.element.id) { index, source in
                            sourceCard(source, index: index)
                        }
                    }
                }
            } else {
                Spacer()
                Text(L(sources == nil ? "voice_share.loading" : "voice_share.portal")).foregroundStyle(Vibe.muted)
                Spacer()
            }
            HStack(spacing: 12) {
                Picker(L("voice_share.resolution"), selection: $height) {
                    ForEach([720, 1080, 1440] as [UInt32], id: \.self) { Text("\($0)p").tag($0) }
                }.frame(width: 200)
                Picker(L("voice_share.fps"), selection: $fps) {
                    ForEach([15, 30, 60] as [UInt32], id: \.self) { Text("\($0)").tag($0) }
                }.frame(width: 200)
                Spacer()
                Button(L("actions.cancel")) { dismiss() }
                Button(L("voice_share.start")) {
                    let (source, lines, rate) = (chosen, height, fps)
                    dismiss()
                    Task { await voice.share(source: source, height: lines, fps: rate) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(sources == nil)
            }
        }
        .padding(20)
        .frame(width: 760, height: 560)
        .task {
            height = voice.listening.shareHeight
            fps = voice.listening.shareFps
            let found = await voice.sources() ?? []
            sources = found
            chosen = found.first { !$0.window }?.id
        }
    }

    func sourceCard(_ source: VoiceSource, index: Int) -> some View {
        VStack(spacing: 6) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Vibe.night)
                Image(systemName: source.window ? "macwindow" : "display").font(.system(size: 28)).foregroundStyle(Vibe.faint)
                VoiceVideo(native: voice.native, identity: source.id, thumbnail: true)
            }
            .frame(height: 117)
            Text(source.window ? source.title : L("voice_share.screen_n", ["n": "\(index + 1)"]))
                .font(.vibe(12.5, .bold)).lineLimit(1).help(source.title)
        }
        .padding(6)
        .background(chosen == source.id ? Vibe.pink.opacity(0.25) : .clear, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(chosen == source.id ? Vibe.pink : .clear, lineWidth: 2))
        .contentShape(Rectangle())
        .onTapGesture { chosen = source.id }
    }
}

/// A RocketVibe call row: Join while it goes on, Call back once over (rings in a direct room).
struct VoiceCallCard: View {
    @Environment(AppModel.self) var app
    let rid: String
    let kind: String
    let param: String

    var body: some View {
        let ongoing = kind == "rv-call-ringing" || (kind == "rv-call-answered" && param.isEmpty)
        HStack(spacing: 10) {
            Text(systemMessage(kind: kind, param: param))
                .font(.vibe(13.5, .bold))
                .foregroundStyle(kind == "rv-call-missed" ? Vibe.pink : Vibe.text)
            if kind != "rv-call", app.voice != nil, app.voice?.state.room != rid {
                Button(L(ongoing ? "message.join" : "voice_call.back")) {
                    app.joinVoice(rid, ring: !ongoing && app.rooms.first { $0.rid == rid }?.kind == "d")
                }
                .buttonStyle(VibeButtonStyle())
            }
        }
        .padding(10)
        .vibeCard()
    }
}

/// The voice sounds (assets/sounds, as AAC in the bundle's Resources/sounds,
/// made by scripts/package.sh): cues once, the ringtone and the ringback looped.
@MainActor
final class VoiceSounds {
    static let shared = VoiceSounds()
    private var players: [AVAudioPlayerBox] = []
    private var tone: AVAudioPlayerBox?

    func cue(_ cue: VoiceCue) {
        let name: String
        switch cue {
        case .join: name = "cue-join"
        case .leave: name = "cue-leave"
        case .mute: name = "cue-mute"
        case .unmute: name = "cue-unmute"
        case .missed: name = "cue-missed"
        }
        guard let player = AVAudioPlayerBox(name) else { return }
        players.removeAll { !$0.playing }
        players.append(player)
        player.play(loop: false)
    }

    func tone(_ tone: VoiceTone?) {
        self.tone?.stop()
        self.tone = nil
        guard let tone, let player = AVAudioPlayerBox(tone == .ringtone ? "ringtone" : "ringback") else { return }
        self.tone = player
        player.play(loop: true)
    }
}

/// A sound of the bundle's Resources/sounds, played once or looped.
@MainActor
final class AVAudioPlayerBox {
    private let player: AVAudioPlayer

    init?(_ name: String) {
        guard let url = Bundle.main.url(forResource: name, withExtension: "m4a", subdirectory: "sounds"),
              let player = try? AVAudioPlayer(contentsOf: url) else { return nil }
        self.player = player
    }

    var playing: Bool { player.isPlaying }

    func play(loop: Bool) {
        player.numberOfLoops = loop ? -1 : 0
        player.play()
    }

    func stop() { player.stop() }
}

/// The header's call button in a native room: a direct room nobody else is in
/// rings its other member, any other room joins its session.
struct VoiceCallButton: View {
    @Environment(AppModel.self) var app
    let room: Room

    var body: some View {
        if let voice = app.voice {
            let direct = room.kind == "d"
            Button {
                let me = app.account?.userId
                let alone = voice.members(room.rid).allSatisfy { $0.id == me }
                app.joinVoice(room.rid, ring: direct && alone)
            } label: { Image(systemName: "phone") }
                .help(L(direct ? "voice_session.start_call" : "voice_session.join"))
        }
    }
}

/// An incoming call: an alert with Accept and Decline while it rings.
struct IncomingCall: ViewModifier {
    @Environment(AppModel.self) var app

    func body(content: Content) -> some View {
        let call = app.voice?.incoming
        content.alert(
            L("voice_session.incoming"),
            isPresented: Binding(get: { call != nil }, set: { _ in }),
            presenting: call
        ) { call in
            Button(L("voice_session.accept")) { app.answer(call) }
            Button(L("voice_session.decline"), role: .cancel) {
                if let voice = app.voice { Task { await voice.decline(call) } }
            }
        } message: { call in
            Text(L("voice_session.incoming_from", ["name": call.callerName]))
        }
    }
}
