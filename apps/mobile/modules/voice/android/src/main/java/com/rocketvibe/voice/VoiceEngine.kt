package com.rocketvibe.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.os.SystemClock
import android.util.Log
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import livekit.org.webrtc.AudioTrackSink
import livekit.org.webrtc.ScreenCapturerAndroid
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.audio.ScreenAudioCapturer
import io.livekit.android.audio.AudioBufferCallback
import android.os.Build
import androidx.core.content.ContextCompat
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import io.livekit.android.renderer.TextureViewRenderer
import java.util.concurrent.CopyOnWriteArraySet
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The process's one voice connection (an account has one, docs/protocol/VOICE.md).
 * It outlives the React instance: JS reloads and backgrounding keep the call,
 * the foreground service keeps the process. Main thread only.
 */
object VoiceEngine {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val listeners = CopyOnWriteArraySet<() -> Unit>()
  /** The microphone's level for a meter, about ten times a second while connected. */
  private val levelListeners = CopyOnWriteArraySet<(Double) -> Unit>()
  private lateinit var app: Context
  private var room: Room? = null
  private var job: Job? = null
  /** How long someone still speaks after their last loud enough sound. */
  private const val HANGOVER_MS = 350L

  var state = "idle"; private set
  var roomId: String? = null; private set
  var title = ""; private set
  var link: String? = null; private set
  /** What the user asked for; deafened silences it without forgetting it. */
  var microphone = true; private set
  var deafened = false; private set
  /** The camera is off until asked for; the screen is shared after the server's claim. */
  var camera = false; private set
  var sharing = false; private set
  /**
   * An encrypted room's frame key (docs/protocol/VOICE.md): LiveKit's shared
   * key, index 0, with its default PBKDF2 derivation, as on desktop.
   */
  private var keys: BaseKeyProvider? = null
  private var reason: String? = null

  /**
   * How this side hears the call, kept for the process (JS restores it at
   * start): each person's volume and a mute for this side only, the speakers'
   * volume. The microphone's volume and the noise remover are read by the
   * audio thread.
   */
  private val people = HashMap<String, Pair<Double, Boolean>>()
  private var outputVolume = 1.0
  @Volatile private var inputVolume = 1.0f
  @Volatile private var noiseSuppression = true
  /** A share's lines (the screen's shorter side) and frames a second. */
  private var shareHeight = 1080
  private var shareFps = 15

  /** Who speaks, from the sound itself (a whisper included): when each was last heard. */
  @Volatile private var localHeard = 0L
  private val remoteHeard = ConcurrentHashMap<String, Long>()
  private val sinks = HashMap<RemoteAudioTrack, AudioTrackSink>()
  @Volatile private var inputLevel = 0f
  private var shownLevel = -1.0
  private var lastSpeaking: Set<String> = emptySet()

  fun attach(context: Context) {
    if (!::app.isInitialized) app = context.applicationContext
  }
  fun listen(listener: () -> Unit) { listeners.add(listener) }
  fun unlisten(listener: () -> Unit) { listeners.remove(listener) }
  fun listenLevel(listener: (Double) -> Unit) { levelListeners.add(listener) }
  fun unlistenLevel(listener: (Double) -> Unit) { levelListeners.remove(listener) }
  /** Computed on the main thread; any thread may read it. */
  @Volatile var last: Map<String, Any?> = mapOf("state" to "idle", "participants" to emptyList<Any>()); private set
  private fun changed() {
    last = snapshot()
    listeners.forEach { it() }
    if (roomId != null) VoiceService.refresh(app)
  }

  private fun canFilm() = ContextCompat.checkSelfPermission(app, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
  private fun canRecord() = ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  private fun snapshot(): Map<String, Any?> = mapOf(
    "state" to state, "room" to roomId, "microphone" to microphone, "deafened" to deafened,
    "camera" to camera, "sharing" to sharing, "encrypted" to (keys != null),
    "reason" to reason, "route" to route(), "routes" to routes(), "participants" to members(),
  )

  private fun heard(at: Long?) = at != null && SystemClock.elapsedRealtime() - at < HANGOVER_MS
  private fun speaking(p: Participant, local: Boolean): Boolean {
    if (!p.isMicrophoneEnabled) return false
    return p.isSpeaking || heard(if (local) localHeard else remoteHeard[p.identity?.value ?: ""])
  }

  private fun member(p: Participant, local: Boolean) = mapOf(
    "identity" to (p.identity?.value ?: ""),
    "speaking" to speaking(p, local),
    "muted" to !p.isMicrophoneEnabled,
    "deafened" to if (local) deafened else p.attributes["rv.deafened"] == "1",
    "level" to p.audioLevel.toDouble(),
    "local" to local,
    "camera" to p.isCameraEnabled,
    "screen" to p.isScreenShareEnabled,
  )
  private fun members(): List<Map<String, Any?>> {
    val r = room ?: return emptyList()
    return listOf(member(r.localParticipant, true)) + r.remoteParticipants.values.map { member(it, false) }
  }

  private fun routeName(device: AudioDevice?) = when (device) {
    is AudioDevice.Speakerphone -> "speaker"
    is AudioDevice.Earpiece -> "earpiece"
    is AudioDevice.BluetoothHeadset -> "bluetooth"
    is AudioDevice.WiredHeadset -> "wired"
    else -> null
  }
  private fun route() = routeName(room?.audioSwitchHandler?.selectedAudioDevice)
  private fun routes() = room?.audioSwitchHandler?.availableAudioDevices?.mapNotNull { routeName(it) } ?: emptyList()

  fun connect(roomId: String, url: String, token: String, title: String, link: String?, microphone: Boolean, e2eeKey: String?) {
    teardown(null, cue = false)
    this.roomId = roomId; this.title = title; this.link = link
    this.microphone = microphone; this.deafened = false; camera = false; sharing = false; reason = null; state = "connecting"
    VoiceService.start(app)
    val r = LiveKit.create(app, RoomOptions(adaptiveStream = false, dynacast = false))
    // After the room: the key provider is native, and creating the room loads WebRTC.
    keys = e2eeKey?.let { key -> BaseKeyProvider().apply { setSharedKey(key, 0) } }
    keys?.let { r.e2eeOptions = E2EEOptions(it) }
    room = r
    job = scope.launch {
      launch {
        r.events.collect { event ->
          if (room !== r) return@collect
          when (event) {
            is RoomEvent.Reconnecting -> state = "reconnecting"
            is RoomEvent.Reconnected -> state = "connected"
            is RoomEvent.ParticipantConnected -> VoiceSounds.cue(app, R.raw.cue_join)
            is RoomEvent.ParticipantDisconnected -> VoiceSounds.cue(app, R.raw.cue_leave)
            is RoomEvent.TrackSubscribed -> {
              applyVolumes(r)
              val track = event.track as? RemoteAudioTrack
              if (track != null && event.publication.source == Track.Source.MICROPHONE) listenTo(track, event.participant.identity?.value ?: "")
            }
            is RoomEvent.TrackUnsubscribed -> (event.track as? RemoteAudioTrack)?.let { track -> sinks.remove(track)?.let { track.removeSink(it) } }
            // Someone else's share replaced this one: the SFU took the screen back.
            is RoomEvent.TrackUnpublished ->
              if (event.participant is LocalParticipant && event.publication.source == Track.Source.SCREEN_SHARE && sharing) stopScreenShare()
            is RoomEvent.ParticipantPermissionsChanged -> {
              val sources = event.newPermissions?.canPublishSources.orEmpty()
              if (event.participant is LocalParticipant && sharing && sources.isNotEmpty() && Track.Source.SCREEN_SHARE !in sources) stopScreenShare()
            }
            // Diagnostics only: a key mismatch silences someone without another trace.
            is RoomEvent.TrackE2EEStateEvent ->
              Log.i("RocketVibeVoice", "e2ee ${event.participant.identity?.value} ${event.state}")
            is RoomEvent.Disconnected -> {
              teardown(event.reason.name.lowercase(), cue = true)
              return@collect
            }
            else -> {}
          }
          changed()
        }
      }
      // Who speaks and the meter, from the sound: read ten times a second.
      launch {
        while (true) {
          delay(100)
          if (room !== r) return@launch
          tick(r)
        }
      }
      try {
        r.connect(url, token)
        if (room !== r) return@launch
        state = "connected"
        applyMicrophone(r)
        hookMicrophone(r)
        VoiceSounds.cue(app, R.raw.cue_join)
        changed()
      } catch (error: Exception) {
        if (room === r) teardown("connect_failed", cue = false)
      }
    }
    changed()
  }

  private suspend fun applyMicrophone(r: Room) {
    // Without the permission the room is still heard: listening only. While the
    // screen's sound rides on this track, it stays on and a mute silences the voice only.
    r.localParticipant.setMicrophoneEnabled((microphone && !deafened || screenAudio != null) && canRecord())
  }

  /**
   * The screen's sound (media, games: what Android lets apps capture), mixed into
   * the microphone track, the one recorded track Android publishes. Never the call:
   * Android does not capture voice-communication audio.
   */
  @Volatile private var screenAudio: ScreenAudioCapturer? = null
  private val frame = ShortArray(Denoiser.FRAME)
  /**
   * Every microphone buffer, on the audio thread: the noise remover, the
   * microphone's volume, its level and whether it speaks; then the screen's
   * sound mixed in. Muted (the track kept on for the screen's sound): silence.
   */
  private val voiceAndScreen = object : AudioBufferCallback {
    override fun onBuffer(buffer: ByteBuffer, audioFormat: Int, channelCount: Int, sampleRate: Int, bytesRead: Int, captureTimeNs: Long): Long {
      if (!microphone || deafened) {
        for (i in 0 until bytesRead) buffer.put(i, 0)
        inputLevel = 0f
      } else if (audioFormat == AudioFormat.ENCODING_PCM_16BIT) {
        voice(buffer.order(ByteOrder.nativeOrder()), channelCount, sampleRate, bytesRead / 2)
      }
      return screenAudio?.onBuffer(buffer, audioFormat, channelCount, sampleRate, bytesRead, captureTimeNs) ?: captureTimeNs
    }
  }

  private fun voice(buffer: ByteBuffer, channels: Int, rate: Int, count: Int) {
    var voice = -1f
    if (noiseSuppression && rate == 48_000 && channels == 1 && count % Denoiser.FRAME == 0 && Denoiser.available) {
      voice = 0f
      for (start in 0 until count step Denoiser.FRAME) {
        for (i in 0 until Denoiser.FRAME) frame[i] = buffer.getShort((start + i) * 2)
        voice = max(voice, Denoiser.process(frame))
        for (i in 0 until Denoiser.FRAME) buffer.putShort((start + i) * 2, frame[i])
      }
    }
    val gain = inputVolume
    var energy = 0.0
    for (i in 0 until count) {
      val value = (buffer.getShort(i * 2) * gain).coerceIn(-32768f, 32767f)
      buffer.putShort(i * 2, value.toInt().toShort())
      energy += value.toDouble() * value
    }
    val db = decibels(energy, count)
    val level = ((db + 60) / 60).toFloat().coerceIn(0f, 1f)
    inputLevel = if (level > inputLevel) level else inputLevel * 0.8f + level * 0.2f
    // RNNoise's voice probability above a floor; without it, the level alone.
    val speech = if (voice >= 0f) voice >= 0.5f && db > -62 else db > -50
    if (speech) localHeard = SystemClock.elapsedRealtime()
  }

  /** A remote microphone's sound, for who speaks (the SFU's own detection misses a whisper). */
  private fun listenTo(track: RemoteAudioTrack, identity: String) {
    if (sinks.containsKey(track)) return
    val sink = AudioTrackSink { data, bits, _, channels, frames, _ ->
      if (bits != 16) return@AudioTrackSink
      val samples = data.order(ByteOrder.nativeOrder())
      val count = min(frames * channels, samples.remaining() / 2)
      var energy = 0.0
      for (i in 0 until count) {
        val value = samples.getShort(samples.position() + i * 2).toDouble()
        energy += value * value
      }
      if (decibels(energy, count) > -52) remoteHeard[identity] = SystemClock.elapsedRealtime()
    }
    track.addSink(sink)
    sinks[track] = sink
  }

  private fun decibels(energy: Double, count: Int): Double =
    if (count == 0 || energy <= 0.0) -100.0 else 10 * log10(energy / count / (32768.0 * 32768.0))

  /** Ten times a second: who speaks changed, the meter moved. */
  private fun tick(r: Room) {
    val speaking = (listOf(r.localParticipant to true) + r.remoteParticipants.values.map { it to false })
      .filter { (p, local) -> speaking(p, local) }.mapNotNull { it.first.identity?.value }.toSet()
    if (speaking != lastSpeaking) {
      lastSpeaking = speaking
      changed()
    }
    val level = Math.round(inputLevel * 50) / 50.0
    if (level != shownLevel) {
      shownLevel = level
      levelListeners.forEach { it(level) }
    }
  }

  /** Every microphone buffer goes through [voiceAndScreen] once the track exists. */
  private fun hookMicrophone(r: Room) {
    (r.localParticipant.getTrackPublication(Track.Source.MICROPHONE)?.track as? LocalAudioTrack)?.setAudioBufferCallback(voiceAndScreen)
  }

  private suspend fun startScreenAudio(r: Room) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !canRecord() || screenAudio != null) return
    val video = r.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)?.track as? LocalVideoTrack ?: return
    val projection = (video.capturer as? ScreenCapturerAndroid)?.mediaProjection ?: return
    screenAudio = ScreenAudioCapturer(projection)
    applyMicrophone(r)
    if (r.localParticipant.getTrackPublication(Track.Source.MICROPHONE)?.track !is LocalAudioTrack) return stopScreenAudio(r)
    hookMicrophone(r)
  }

  private suspend fun stopScreenAudio(r: Room) {
    val capturer = screenAudio ?: return
    screenAudio = null
    capturer.releaseAudioResources()
    applyMicrophone(r)
  }

  /**
   * Each person at their volume here, times the speakers' volume; deafened,
   * remote audio stops at the SFU (bandwidth) and locally (any frame in flight).
   */
  private fun applyVolumes(r: Room) {
    r.remoteParticipants.values.forEach { p: RemoteParticipant ->
      val (volume, muted) = people[p.identity?.value ?: ""] ?: (1.0 to false)
      p.audioTrackPublications.forEach { (publication, track) ->
        (publication as? RemoteTrackPublication)?.setEnabled(!deafened)
        (track as? RemoteAudioTrack)?.setVolume(if (deafened || muted) 0.0 else volume * outputVolume)
      }
    }
  }

  fun setPersonVolume(identity: String, volume: Double, muted: Boolean) {
    people[identity] = volume.coerceIn(0.0, 2.0) to muted
    room?.let { applyVolumes(it) }
  }

  fun setOutputVolume(volume: Double) {
    outputVolume = volume.coerceIn(0.0, 2.0)
    room?.let { applyVolumes(it) }
  }

  fun setInputVolume(volume: Double) { inputVolume = volume.coerceIn(0.0, 2.0).toFloat() }
  fun setNoiseSuppression(on: Boolean) { noiseSuppression = on }
  fun setShareQuality(height: Int, fps: Int) {
    shareHeight = height.coerceIn(360, 2160)
    shareFps = fps.coerceIn(5, 60)
  }

  fun setMicrophone(enabled: Boolean) {
    microphone = enabled
    // Speaking again lifts deafen, as in Discord.
    if (enabled && deafened) deafened = false
    val r = room ?: return changed()
    VoiceSounds.cue(app, if (enabled) R.raw.cue_unmute else R.raw.cue_mute)
    scope.launch {
      applyVolumes(r)
      r.localParticipant.updateAttributes(mapOf("rv.deafened" to if (deafened) "1" else ""))
      applyMicrophone(r)
      hookMicrophone(r)
      changed()
    }
  }

  fun setDeafened(on: Boolean) {
    deafened = on
    val r = room ?: return changed()
    VoiceSounds.cue(app, if (on) R.raw.cue_mute else R.raw.cue_unmute)
    scope.launch {
      applyVolumes(r)
      r.localParticipant.updateAttributes(mapOf("rv.deafened" to if (on) "1" else ""))
      applyMicrophone(r)
      hookMicrophone(r)
      changed()
    }
  }

  fun setRoute(route: String) {
    val handler = room?.audioSwitchHandler ?: return
    handler.selectDevice(handler.availableAudioDevices.firstOrNull { routeName(it) == route })
    changed()
  }

  fun setCamera(enabled: Boolean) {
    camera = enabled && canFilm()
    val r = room ?: return changed()
    // The service restarts in the foreground with the camera type added.
    if (camera) VoiceService.start(app)
    scope.launch {
      r.localParticipant.setCameraEnabled(camera)
      changed()
    }
  }

  /** [data] is the user's MediaProjection consent; the server already granted the screen. */
  fun startScreenShare(data: Intent) {
    val r = room ?: return
    sharing = true
    // The chosen quality: the screen's shorter side at most `shareHeight` lines.
    val metrics = app.resources.displayMetrics
    val scale = min(1.0, shareHeight.toDouble() / min(metrics.widthPixels, metrics.heightPixels))
    val width = (metrics.widthPixels * scale).toInt() and 1.inv()
    val height = (metrics.heightPixels * scale).toInt() and 1.inv()
    val bitrate = (width.toLong() * height * shareFps * 8 / 100).coerceIn(1_500_000L, 12_000_000L).toInt()
    r.screenShareTrackCaptureDefaults = r.screenShareTrackCaptureDefaults.copy(
      captureParams = VideoCaptureParameter(width, height, shareFps))
    r.screenShareTrackPublishDefaults = r.screenShareTrackPublishDefaults.copy(
      videoEncoding = VideoEncoding(bitrate, shareFps), simulcast = false)
    scope.launch {
      val started = try {
        r.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(data, null, null) {
          scope.launch { if (room === r) { sharing = false; stopScreenAudio(r); changed() } }
        })
      } catch (_: Exception) { false }
      if (!started) sharing = false
      if (started) startScreenAudio(r)
      changed()
    }
  }

  fun stopScreenShare() {
    val r = room ?: return
    sharing = false
    scope.launch {
      stopScreenAudio(r)
      r.localParticipant.setScreenShareEnabled(false)
      changed()
    }
  }

  internal fun localIdentity(): String? = room?.localParticipant?.identity?.value

  internal fun initRenderer(renderer: TextureViewRenderer): Boolean {
    val r = room ?: return false
    r.initVideoRenderer(renderer)
    return true
  }

  /** The camera or screen track of a participant, local or remote, once subscribed. */
  internal fun videoTrack(identity: String, screen: Boolean): VideoTrack? {
    val r = room ?: return null
    val participant: Participant = if (r.localParticipant.identity?.value == identity) r.localParticipant
      else r.remoteParticipants.values.firstOrNull { it.identity?.value == identity } ?: return null
    val source = if (screen) Track.Source.SCREEN_SHARE else Track.Source.CAMERA
    val publication = participant.getTrackPublication(source) ?: return null
    if (publication.muted) return null
    return publication.track as? VideoTrack
  }

  fun leave() = teardown("client_initiated", cue = true)

  /** The group moved to a new epoch: every frame from now on is under its key. */
  fun setE2eeKey(key: String) {
    keys?.setSharedKey(key, 0)
  }

  private fun teardown(why: String?, cue: Boolean) {
    val r = room ?: return
    room = null
    job?.cancel(); job = null
    r.disconnect()
    r.release()
    if (cue) VoiceSounds.cue(app, R.raw.cue_leave)
    state = if (why == null) "idle" else "disconnected"
    camera = false; sharing = false; keys = null
    screenAudio?.releaseAudioResources()
    screenAudio = null
    sinks.clear()
    remoteHeard.clear()
    localHeard = 0L
    inputLevel = 0f
    lastSpeaking = emptySet()
    reason = why
    roomId = null
    VoiceService.stop(app)
    changed()
  }
}
