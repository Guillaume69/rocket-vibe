import Foundation
import Observation
import RocketVibeCore

/// rv-core's code for a failed native call (`voice_encrypted_room`, `offline`, ...):
/// rv-ffi hands it as a server error's `error`, or as a local error's message.
func nativeCode(_ error: Error) -> String {
    switch error as? RvError {
    case let .Server(_, _, code, _, _, _)?: return code ?? ""
    case let .Local(message)?: return message
    case nil: return ""
    }
}

/// A short sound of the voice session.
public enum VoiceCue: Equatable { case join, leave, mute, unmute, missed }
/// A looped sound: an incoming call rings, an outgoing one rings back.
public enum VoiceTone: Equatable { case ringtone, ringback }

/// Voice on a RocketVibe server (docs/protocol/VOICE.md), over rv-ffi's voice
/// API and the `rv-voice` sidecar the GTK app uses: the session this account is
/// in, who is in each room's session, rings, the listening choices, the cues.
/// The supervisor in Rust hangs up a declined call and a direct call the
/// other person left; this model only follows and says.
@MainActor @Observable
public final class VoiceModel {
    public let native: NativeChat
    public private(set) var state: VoiceState
    public private(set) var calls: [VoiceCall] = []
    public private(set) var listening: VoiceListening
    /// Bumped at each refresh: views reading members redraw.
    public private(set) var revision = 0
    /// The room whose voice page shows, its chat open behind it.
    public var shown: String?
    /// The room being joined, until the sidecar took it.
    public private(set) var joining: String?
    /// A direct call this side declined or answered, until the server resolves it.
    var answered: String?
    @ObservationIgnored var seen: [String: String] = [:]
    @ObservationIgnored let me: String

    /// A short message for the window's toast.
    public var onNotice: ((String) -> Void)?
    public var onCue: ((VoiceCue) -> Void)?
    /// The looped sound to play now, or none.
    public var onTone: ((VoiceTone?) -> Void)?
    /// Whether a room is a direct one: a direct call over gives the chat back.
    public var isDirect: ((String) -> Bool)?
    @ObservationIgnored var tone: VoiceTone?

    public init(native: NativeChat) {
        self.native = native
        me = native.account().userId
        state = native.voiceState()
        listening = native.voiceListening()
    }

    /// The server offers voice and the app carries the sidecar.
    public var supported: Bool { native.voiceSupported() }

    /// Someone of a room's session; the session's own view for the room this account is in.
    public func members(_ room: String) -> [VoiceMember] { native.voiceMembers(room: room) }

    /// An incoming ring this side has not answered, not for the call it is in.
    public var incoming: VoiceCall? {
        calls.first { $0.calleeId == me && $0.state == "ringing" && $0.id != answered && $0.room != state.room }
    }

    /// Reads everything again after an event, then says what changed.
    public func refresh() {
        let previous = state
        state = native.voiceState()
        calls = native.voiceCalls()
        listening = native.voiceListening()
        revision &+= 1
        cues(previous)
        rings()
        // A direct call over: its chat again.
        if let room = previous.room, state.room == nil, shown == room, isDirect?(room) == true { shown = nil }
    }

    func cues(_ before: VoiceState) {
        let connected = { (s: VoiceState) in s.phase == .connected }
        if connected(state) && (!connected(before) || before.room != state.room) {
            onCue?(.join)
        } else if connected(state) && connected(before) && !state.deafened {
            let others = { (s: VoiceState) in Set(s.members.filter { !$0.local }.map(\.id)) }
            let (was, now) = (others(before), others(state))
            if !now.subtracting(was).isEmpty { onCue?(.join) } else if !was.subtracting(now).isEmpty { onCue?(.leave) }
        }
        if state.room != nil && before.room == state.room {
            if before.microphone != state.microphone { onCue?(state.microphone ? .unmute : .mute) }
            else if before.deafened != state.deafened { onCue?(state.deafened ? .mute : .unmute) }
        }
        if state.error != before.error, let error = state.error {
            switch error {
            case "camera_unavailable": onNotice?(L("voice_session.camera_unavailable"))
            case "screen_unavailable": onNotice?(L("voice_session.screen_unavailable"))
            default: break
            }
        }
        if state.ended != before.ended, before.room != nil, let ended = state.ended {
            switch ended {
            case "left": onCue?(.leave)
            case "moved": onNotice?(L("voice_session.moved"))
            case "removed": onCue?(.leave); onNotice?(L("voice_session.removed"))
            default: onNotice?(L("voice_session.lost"))
            }
        }
    }

    func rings() {
        for call in calls {
            let before = seen.updateValue(call.state, forKey: call.id)
            let missed = call.state == "missed" || (call.state == "declined" && call.callerId == me)
            if before == "ringing" && missed { onCue?(.missed) }
        }
        seen = seen.filter { id, _ in calls.contains { $0.id == id } }
        let outgoing = calls.contains { $0.callerId == me && $0.state == "ringing" && $0.room == state.room }
        let wanted: VoiceTone? = incoming != nil ? .ringtone : outgoing ? .ringback : nil
        if wanted != tone { tone = wanted; onTone?(wanted) }
    }

    func refusal(_ error: Error) -> String {
        switch nativeCode(error) {
        case "voice_encrypted_room": return L("voice_session.encrypted")
        case "voice_key_unavailable": return L("voice_session.key_unavailable")
        case "voice_unavailable", "unsupported_feature": return L("voice_session.unavailable")
        case "screen_taken": return L("voice_session.screen_taken")
        case "screen_unavailable", "voice_not_connected": return L("voice_session.screen_unavailable")
        default: return L("voice_session.join_failed")
        }
    }

    /// Shows a room's voice page and joins its session; already in it, the page only,
    /// unless calling again a direct room nobody else is in (`ring`).
    public func join(_ room: String, ring: Bool = false) async {
        shown = room
        let alone = !state.members.contains { !$0.local }
        if state.room == room && !(ring && alone) || joining != nil { return }
        joining = room
        defer { joining = nil; refresh() }
        do { try await native.joinVoice(room: room, ring: ring) } catch { onNotice?(refusal(error)) }
    }

    public func answer(_ call: VoiceCall) async {
        answered = call.id
        shown = call.room
        joining = call.room
        defer { joining = nil; refresh() }
        do { try await native.answerCall(id: call.id, room: call.room) } catch { onNotice?(refusal(error)) }
    }

    public func decline(_ call: VoiceCall) async {
        answered = call.id
        refresh()
        try? await native.declineCall(id: call.id)
    }

    public func leave() async { await native.leaveVoiceSession(); refresh() }
    public func toggleMicrophone() async { await native.setVoiceMicrophone(enabled: !state.microphone); refresh() }
    public func toggleDeafen() async { await native.setVoiceDeafened(deafened: !state.deafened); refresh() }
    public func setDeafened(_ on: Bool) async { await native.setVoiceDeafened(deafened: on); refresh() }
    public func toggleCamera() async { await native.setVoiceCamera(enabled: !state.camera); refresh() }

    public func share(source: String?, height: UInt32, fps: UInt32) async {
        do { try await native.shareScreen(source: source, height: height, fps: fps) } catch { onNotice?(refusal(error)) }
        refresh()
    }
    public func stopSharing() async { await native.stopScreenShare(); refresh() }
    /// Screens then windows; empty where the system picks.
    public func sources() async -> [VoiceSource]? { try? await native.voiceSources() }

    public func devices() async -> VoiceDevices? { try? await native.voiceDevices() }
    public func select(input: Bool, id: String) async { await native.selectVoiceDevice(input: input, id: id) }
    public func setInputVolume(_ volume: Float) async { await native.setVoiceInputVolume(volume: volume); refresh() }
    public func setOutputVolume(_ volume: Float) async { await native.setVoiceOutputVolume(volume: volume); refresh() }
    public func setNoiseSuppression(_ on: Bool) async { await native.setVoiceNoiseSuppression(enabled: on); refresh() }
    public func setShareCall(_ on: Bool) { native.setVoiceShareCall(on: on); refresh() }
    public func volume(of uid: String) -> Float { native.personVolume(uid: uid) }
    public func setPerson(_ uid: String, volume: Float, muted: Bool) async {
        await native.setPersonVolume(uid: uid, volume: volume, muted: muted)
        refresh()
    }
    /// The microphone's level, 0 to 1.
    public var inputLevel: Float { native.voiceInputLevel() }
}
