package com.rocketvibe.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
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
import kotlinx.coroutines.launch

/**
 * The process's one voice connection (an account has one, docs/protocol/VOICE.md).
 * It outlives the React instance: JS reloads and backgrounding keep the call,
 * the foreground service keeps the process. Main thread only.
 */
object VoiceEngine {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val listeners = CopyOnWriteArraySet<() -> Unit>()
  private lateinit var app: Context
  private var room: Room? = null
  private var job: Job? = null

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
  private var reason: String? = null

  fun attach(context: Context) {
    if (!::app.isInitialized) app = context.applicationContext
  }
  fun listen(listener: () -> Unit) { listeners.add(listener) }
  fun unlisten(listener: () -> Unit) { listeners.remove(listener) }
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
    "camera" to camera, "sharing" to sharing,
    "reason" to reason, "route" to route(), "routes" to routes(), "participants" to members(),
  )

  private fun member(p: Participant, local: Boolean) = mapOf(
    "identity" to (p.identity?.value ?: ""),
    "speaking" to p.isSpeaking,
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

  fun connect(roomId: String, url: String, token: String, title: String, link: String?, microphone: Boolean) {
    teardown(null, cue = false)
    this.roomId = roomId; this.title = title; this.link = link
    this.microphone = microphone; this.deafened = false; camera = false; sharing = false; reason = null; state = "connecting"
    VoiceService.start(app)
    val r = LiveKit.create(app, RoomOptions(adaptiveStream = false, dynacast = false))
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
            is RoomEvent.TrackSubscribed -> applyDeafen(r)
            is RoomEvent.Disconnected -> {
              teardown(event.reason.name.lowercase(), cue = true)
              return@collect
            }
            else -> {}
          }
          changed()
        }
      }
      try {
        r.connect(url, token)
        if (room !== r) return@launch
        state = "connected"
        applyMicrophone(r)
        VoiceSounds.cue(app, R.raw.cue_join)
        changed()
      } catch (error: Exception) {
        if (room === r) teardown("connect_failed", cue = false)
      }
    }
    changed()
  }

  private suspend fun applyMicrophone(r: Room) {
    // Without the permission the room is still heard: listening only.
    r.localParticipant.setMicrophoneEnabled(microphone && !deafened && canRecord())
  }

  /** Remote audio stops at the SFU (bandwidth) and locally (any frame in flight). */
  private fun applyDeafen(r: Room) {
    r.remoteParticipants.values.forEach { p: RemoteParticipant ->
      p.audioTrackPublications.forEach { (publication, track) ->
        (publication as? RemoteTrackPublication)?.setEnabled(!deafened)
        (track as? RemoteAudioTrack)?.setVolume(if (deafened) 0.0 else 1.0)
      }
    }
  }

  fun setMicrophone(enabled: Boolean) {
    microphone = enabled
    // Speaking again lifts deafen, as in Discord.
    if (enabled && deafened) deafened = false
    val r = room ?: return changed()
    VoiceSounds.cue(app, if (enabled) R.raw.cue_unmute else R.raw.cue_mute)
    scope.launch {
      applyDeafen(r)
      r.localParticipant.updateAttributes(mapOf("rv.deafened" to if (deafened) "1" else ""))
      applyMicrophone(r)
      changed()
    }
  }

  fun setDeafened(on: Boolean) {
    deafened = on
    val r = room ?: return changed()
    VoiceSounds.cue(app, if (on) R.raw.cue_mute else R.raw.cue_unmute)
    scope.launch {
      applyDeafen(r)
      r.localParticipant.updateAttributes(mapOf("rv.deafened" to if (on) "1" else ""))
      applyMicrophone(r)
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
    scope.launch {
      val started = try {
        r.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(data, null, null) {
          scope.launch { if (room === r) { sharing = false; changed() } }
        })
      } catch (_: Exception) { false }
      if (!started) sharing = false
      changed()
    }
  }

  fun stopScreenShare() {
    val r = room ?: return
    sharing = false
    scope.launch {
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

  private fun teardown(why: String?, cue: Boolean) {
    val r = room ?: return
    room = null
    job?.cancel(); job = null
    r.disconnect()
    r.release()
    if (cue) VoiceSounds.cue(app, R.raw.cue_leave)
    state = if (why == null) "idle" else "disconnected"
    camera = false; sharing = false
    reason = why
    roomId = null
    VoiceService.stop(app)
    changed()
  }
}
