package com.rocketvibe.voice

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * A Jitsi Meet conference's signalling (crates/rv-voice-mobile's call module,
 * rv-call as the desktop sidecar speaks it) over JNI. Absent library: [available]
 * is false and calls keep the meeting's page.
 */
internal object JitsiCall {
  val available: Boolean = try {
    System.loadLibrary("rv_voice_mobile")
    true
  } catch (error: UnsatisfiedLinkError) {
    false
  }

  @JvmStatic external fun start(meeting: String, configJs: String, displayName: String, token: String?): Long
  @JvmStatic external fun startChime(signalingUrl: String, audioHost: String, attendeeId: String, joinToken: String, origin: String): Long
  @JvmStatic external fun offer(handle: Long, sdp: String)
  @JvmStatic external fun next(handle: Long, timeoutMs: Long): String?
  @JvmStatic external fun answer(handle: Long, sdp: String)
  @JvmStatic external fun candidate(handle: Long, mid: String, line: String)
  @JvmStatic external fun muted(handle: Long, muted: Boolean)
  @JvmStatic external fun leave(handle: Long)
  @JvmStatic external fun free(handle: Long)
}

/** An Amazon Chime attendee's credentials (a Slack huddle). */
internal data class ChimeCredentials(
  val signalingUrl: String,
  val audioHost: String,
  val attendeeId: String,
  val joinToken: String,
  val origin: String,
)

/**
 * One native call, audio only: libwebrtc (the copy LiveKit ships) answers a Jitsi
 * bridge's offer or offers to Chime, the signalling runs in Rust. [onChange] and
 * [onEnd] are called on the main thread.
 */
internal class JitsiSession(
  private val app: Context,
  private val onChange: () -> Unit,
  private val onEnd: (String) -> Unit,
) {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var handle = 0L
  @Volatile private var closed = false
  private var factory: PeerConnectionFactory? = null
  private var audio: JavaAudioDeviceModule? = null
  private var pc: PeerConnection? = null
  private var microphone: AudioTrack? = null
  private var iceServers: List<PeerConnection.IceServer> = emptyList()
  private var localId = ""
  private var deafened = false
  /** Everyone else: endpoint id to display name and whether they are muted. */
  private val roster = LinkedHashMap<String, Pair<String, Boolean>>()
  /** Remote tracks by endpoint, and when each was last heard. */
  private val tracks = ConcurrentHashMap<String, AudioTrack>()
  private val heard = ConcurrentHashMap<String, Long>()
  private val levels = ConcurrentHashMap<String, Double>()
  @Volatile var connected = false; private set
  /** Lost on the way and joining again. */
  @Volatile var reconnecting = false; private set
  /** Why the current session was lost (a media failure), read by the reader thread. */
  @Volatile private var lost: String? = null
  private var everConnected = false

  /** The offer waiting for ICE gathering, sent once at most. */
  private var offering = false
  private var relayOnly = false

  /** Joins on a thread of its own; false at once when the library is missing. */
  fun start(meeting: String, displayName: String, token: String?): Boolean {
    if (!JitsiCall.available) return false
    Thread({
      val configJs = fetchConfig(meeting)
      hold { if (configJs == null) 0L else JitsiCall.start(meeting, configJs, displayName, token) }
    }, "jitsi-call").start()
    return true
  }

  /** Joins a Chime meeting on a thread of its own; false at once when the library is missing. */
  fun startChime(c: ChimeCredentials): Boolean {
    if (!JitsiCall.available) return false
    Thread({
      hold { JitsiCall.startChime(c.signalingUrl, c.audioHost, c.attendeeId, c.joinToken, c.origin) }
    }, "chime-call").start()
    return true
  }

  /**
   * Joins, then joins again whenever the session is lost on the way (the socket
   * dropped, the media failed, the focus ended or replaced the session), keeping
   * the microphone and deafen choices, until it holds or every retry failed.
   * A first join that fails ends at once, so the meeting's page takes over.
   */
  private fun hold(join: () -> Long) {
    var tries = 0
    var reason = "connect_failed"
    var over = false
    while (!closed) {
      val h = join()
      if (h == 0L && !everConnected) break
      if (h != 0L) {
        handle = h
        lost = null
        while (!closed && lost == null) {
          val line = JitsiCall.next(h, 500) ?: continue
          val event = runCatching { JSONObject(line) }.getOrNull() ?: continue
          val type = event.optString("type")
          if (type in setOf("ended", "gone", "over")) {
            over = type == "over"
            lost = event.optString("reason", "terminated")
            break
          }
          main.post { if (!closed) handle(event) }
        }
        // Only this thread enters the library once joined: leaving and freeing never race a read.
        handle = 0L
        JitsiCall.leave(h)
        JitsiCall.free(h)
        if (closed) return
        reason = lost ?: "terminated"
        if (connected) tries = 0
      }
      if (over || tries >= REJOIN_DELAYS_S.size) break
      Log.i("RocketVibeVoice", "jitsi: lost ($reason), joining again")
      reconnecting = true
      connected = false
      main.post { if (!closed) { dropMedia(); onChange() } }
      Thread.sleep(REJOIN_DELAYS_S[tries++] * 1000)
    }
    if (!closed) main.post { if (!closed) onEnd(reason) }
  }

  private fun fetchConfig(meeting: String): String? = runCatching {
    val url = URL(meeting)
    if (url.protocol != "https") return null
    val connection = URL("https://${url.host}/config.js").openConnection() as HttpURLConnection
    connection.connectTimeout = 5000; connection.readTimeout = 5000
    try { connection.inputStream.bufferedReader().readText() } finally { connection.disconnect() }
  }.getOrNull()

  private fun handle(event: JSONObject) {
    when (event.optString("type")) {
      "local" -> localId = event.optString("id")
      "ice" -> {
        val servers = event.optJSONArray("servers")
        iceServers = (0 until (servers?.length() ?: 0)).map { i ->
          val s = servers!!.getJSONObject(i)
          val urls = s.getJSONArray("urls").let { a -> (0 until a.length()).map { a.getString(it) } }
          PeerConnection.IceServer.builder(urls).setUsername(s.optString("username")).setPassword(s.optString("credential")).createIceServer()
        }
      }
      "offer" -> offer(event.getString("sdp"))
      "offerWanted" -> {
        relayOnly = event.optBoolean("relayOnly")
        localOffer()
      }
      "answer" -> pc?.setRemoteDescription(Sdp(), SessionDescription(SessionDescription.Type.ANSWER, event.getString("sdp")))
      "levels" -> {
        val list = event.getJSONArray("levels")
        val now = SystemClock.elapsedRealtime()
        for (i in 0 until list.length()) {
          val item = list.getJSONObject(i)
          val id = item.getString("id")
          val level = item.optDouble("level")
          levels[id] = level
          if (level > REPORTED_SPEAKING) heard[id] = now
        }
      }
      "candidate" -> pc?.addIceCandidate(IceCandidate(event.getString("mid"), 0, event.getString("line")))
      "roster" -> {
        roster.clear()
        val members = event.getJSONArray("members")
        for (i in 0 until members.length()) {
          val m = members.getJSONObject(i)
          roster[m.getString("id")] = m.optString("name") to m.optBoolean("muted")
        }
        onChange()
      }
    }
  }

  private fun peer(): PeerConnection? {
    pc?.let { return it }
    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
    val adm = JavaAudioDeviceModule.builder(app)
      .setUseHardwareAcousticEchoCanceler(true)
      .setUseHardwareNoiseSuppressor(true)
      .createAudioDeviceModule()
    val f = PeerConnectionFactory.builder().setAudioDeviceModule(adm).createPeerConnectionFactory()
    audio = adm; factory = f
    val config = PeerConnection.RTCConfiguration(iceServers).apply {
      sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
      bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
      rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
      if (relayOnly) iceTransportsType = PeerConnection.IceTransportsType.RELAY
    }
    val created = f.createPeerConnection(config, observer) ?: return null
    val track = f.createAudioTrack("${localId}-a0", f.createAudioSource(MediaConstraints()))
    track.setEnabled(VoiceEngine.microphone && !VoiceEngine.deafened)
    created.addTrack(track, listOf(localId))
    microphone = track
    pc = created
    return created
  }

  private fun offer(sdp: String) {
    val p = peer() ?: return onEnd("connect_failed")
    p.setRemoteDescription(object : Sdp() {
      override fun onSetSuccess() {
        p.createAnswer(object : Sdp() {
          override fun onCreateSuccess(answer: SessionDescription) {
            p.setLocalDescription(object : Sdp() {
              override fun onSetSuccess() { if (handle != 0L) JitsiCall.answer(handle, answer.description) }
            }, answer)
          }
        }, MediaConstraints())
      }
    }, SessionDescription(SessionDescription.Type.OFFER, sdp))
  }

  /** The local offer made and set; it goes out once gathering completed, or after a moment. */
  private fun localOffer() {
    val p = peer() ?: return onEnd("connect_failed")
    p.createOffer(object : Sdp() {
      override fun onCreateSuccess(offer: SessionDescription) {
        p.setLocalDescription(object : Sdp() {
          override fun onSetSuccess() {
            main.post {
              offering = true
              main.postDelayed({ sendOffer() }, GATHERING_MS)
              if (p.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) sendOffer()
            }
          }
        }, offer)
      }
    }, MediaConstraints().apply {
      mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
    })
  }

  /** Sends the local description, its gathered candidates in it. */
  private fun sendOffer() {
    if (closed || !offering) return
    val sdp = pc?.localDescription?.description ?: return
    offering = false
    if (handle != 0L) JitsiCall.offer(handle, sdp)
  }

  private val observer = object : PeerConnection.Observer {
    override fun onIceCandidate(c: IceCandidate) {
      if (handle != 0L) JitsiCall.candidate(handle, c.sdpMid ?: "", c.sdp)
      // One relay candidate is all a relayed call needs: gathering may take long to say it is done.
      if (relayOnly) main.postDelayed({ sendOffer() }, FIRST_CANDIDATE_MS)
    }
    override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
      main.post {
        if (closed) return@post
        when (state) {
          PeerConnection.PeerConnectionState.CONNECTED -> {
            connected = true; everConnected = true; reconnecting = false; onChange()
          }
          PeerConnection.PeerConnectionState.FAILED -> lost = "connection_failed"
          else -> {}
        }
      }
    }
    override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
      val track = receiver.track() as? AudioTrack ?: return
      val endpoint = streams.firstOrNull()?.id ?: return
      track.setEnabled(!deafened)
      tracks[endpoint] = track
    }
    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
      if (state == PeerConnection.IceGatheringState.COMPLETE) main.post { sendOffer() }
    }
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
    override fun onAddStream(stream: MediaStream) {}
    override fun onRemoveStream(stream: MediaStream) {}
    override fun onDataChannel(channel: DataChannel) {}
    override fun onRenegotiationNeeded() {}
  }

  /** Reads who is heard, about three times a second, from the receivers' audio levels. */
  fun poll() {
    val p = pc ?: return
    p.getStats { report ->
      val byTrack = tracks.entries.associate { it.value.id() to it.key }
      report.statsMap.values.filter { it.type == "inbound-rtp" && it.members["kind"] == "audio" }.forEach { s ->
        val endpoint = byTrack[s.members["trackIdentifier"] as? String] ?: return@forEach
        val level = (s.members["audioLevel"] as? Number)?.toDouble() ?: 0.0
        levels[endpoint] = level
        if (level > SPEAKING) heard[endpoint] = SystemClock.elapsedRealtime()
      }
    }
  }

  fun members(): List<Map<String, Any?>> {
    val now = SystemClock.elapsedRealtime()
    val local = mapOf(
      "identity" to localId, "speaking" to false, "muted" to (!VoiceEngine.microphone || VoiceEngine.deafened),
      "deafened" to VoiceEngine.deafened, "level" to 0.0, "local" to true, "camera" to false, "screen" to false,
    )
    return listOf(local) + roster.map { (id, value) ->
      mapOf(
        "identity" to id, "name" to value.first, "muted" to value.second, "deafened" to false,
        "speaking" to (!value.second && (heard[id]?.let { now - it < HANGOVER_MS } ?: false)),
        "level" to (levels[id] ?: 0.0), "local" to false, "camera" to false, "screen" to false,
      )
    }
  }

  fun setMicrophone(on: Boolean) {
    microphone?.setEnabled(on)
    if (handle != 0L) JitsiCall.muted(handle, !on)
  }

  fun setDeafened(on: Boolean) {
    deafened = on
    tracks.values.forEach { it.setEnabled(!on) }
  }

  /** Hangs up; the reader thread leaves the conference within half a second. */
  fun close() {
    if (closed) return
    closed = true
    dropMedia()
  }

  /** One session's media: the peer connection, its tracks, who was heard. */
  private fun dropMedia() {
    pc?.close(); pc?.dispose(); pc = null
    microphone = null
    factory?.dispose(); factory = null
    audio?.release(); audio = null
    tracks.clear(); heard.clear(); levels.clear(); roster.clear()
    offering = false
  }

  private open class Sdp : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) { Log.w("RocketVibeVoice", "jitsi sdp: $error") }
    override fun onSetFailure(error: String?) { Log.w("RocketVibeVoice", "jitsi sdp: $error") }
  }

  private companion object {
    const val SPEAKING = 0.02
    /** The loudness, as the provider reports it, above which a member speaks. */
    const val REPORTED_SPEAKING = 0.15
    const val GATHERING_MS = 5000L
    const val FIRST_CANDIDATE_MS = 500L
    const val HANGOVER_MS = 350L
    /** The pause before each rejoin; as many tries. */
    val REJOIN_DELAYS_S = longArrayOf(1, 2, 4, 8, 15)
  }
}
