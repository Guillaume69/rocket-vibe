import { paintVoiceControls, ringingBar, type VoiceBindings } from "./ui/voice";
import { clearView } from "./ui/portals";
import type { App } from "./app";
import type { VoiceGrant, VoiceRing, LiveState } from "./protocol";
import { Api, segment } from "./api";
import { el, button, dialog, tile, toast, initials } from "./dom";
import { icon, iconButton } from "./icons";
import { nt } from "./native-i18n";
import { tileLayout } from "./voice-grid";
import { MicrophoneGain, volumeValue } from "./voice-audio";
import { observeAudioOutput } from "./voice-output";
import { chooseShareQuality } from "./voice-share";
import { ShareAudioMixer, excludesOwnAudio } from "./voice-share-audio";
import {
  VoiceActivity,
  LOCAL_SPEECH_DB,
  REMOTE_SPEECH_DB,
} from "./voice-activity";
import { read, write } from "./store";
import { preferencesGroup, actionRow } from "./sidebar";
import { sound } from "./sounds";
import { t, language } from "./i18n";
import { encryptedVoice, type EncryptedVoice } from "./crypto/voice";
export class Voice {
  private readonly lifetime = new AbortController();
  private readonly resize = new ResizeObserver(() => this.layout());
  visible = false;
  current?: string;
  membership?: string | null;
  room?: import("livekit-client").Room;
  audioContext?: AudioContext;
  busy = false;
  lifecycle = 0;
  leaving: Promise<void> = Promise.resolve();
  voiceRequests: Promise<unknown> = Promise.resolve();
  microphoneWork: Promise<void> = Promise.resolve();
  cameraWork: Promise<void> = Promise.resolve();
  pendingCameras = new Set<import("livekit-client").LocalVideoTrack>();
  cancelled = false;
  private encryption?: EncryptedVoice;
  private encryptionTimer?: ReturnType<typeof setInterval>;
  ringDialogs = new Map<string, HTMLDialogElement>();
  bar = el("div", "voice-bar");
  stage = el("div", "voice-stage");
  screenStage = el("div", "voice-screen-stage");
  minis = el("div", "voice-mini-strip");
  screenLabel = el("span", "voice-stage-label");
  screens = new Map<string, { identity: string; video: HTMLVideoElement }>();
  shareAbort?: AbortController;
  fullscreenEndTimer?: ReturnType<typeof setTimeout>;
  fullscreen = iconButton(
    "fullscreen",
    nt("voice_session.fullscreen"),
    () => this.toggleFullscreen(),
    "flat voice-stage-full",
  );
  muted = false;
  camera = false;
  sharing = false;
  sharingBusy = false;
  includeCall = localStorage.getItem("rv-share-call") === "true";
  sharedSound?: {
    room: import("livekit-client").Room;
    track: import("livekit-client").LocalAudioTrack;
    mixer: ShareAudioMixer;
    captured: boolean;
  };
  shareAudioWork: Promise<void> = Promise.resolve();
  deafened = false;
  cards = new Map<string, HTMLElement>();
  speaking = new Set<string>();
  inputActivity = new VoiceActivity();
  activityTimer?: ReturnType<typeof setInterval>;
  meters = new Map<
    string,
    {
      identity: string;
      track: import("livekit-client").RemoteAudioTrack;
      source: MediaStreamAudioSourceNode;
      analyser: AnalyserNode;
      samples: Float32Array<ArrayBuffer>;
      activity: VoiceActivity;
    }
  >();
  peerLeaveTimer?: ReturnType<typeof setTimeout>;
  listeningAccount = "";
  loop?: HTMLAudioElement;
  tracks = new Map<string, HTMLElement>();
  page = el("section", "voice-page");
  controls = el("div", "voice-controls");
  heading = el("h2", "voice-title");
  status = el("div", "voice-status");
  header = el("header", "headerbar voice-header");
  gain = new MicrophoneGain(
    volumeValue(Number(localStorage.getItem("rv-voice-input-volume") ?? 1)),
  );
  outputVolume = volumeValue(
    Number(localStorage.getItem("rv-voice-output-volume") ?? 1),
  );
  listening = new Map<string, { volume: number; muted: boolean }>();
  audioTracks = new Map<
    string,
    {
      identity: string;
      track: import("livekit-client").RemoteAudioTrack;
      source: string;
    }
  >();
  syncControls: () => void = () => {};
  closeMenu: () => void = () => {};
  processors = new WeakMap<
    import("livekit-client").LocalAudioTrack,
    Promise<void>
  >();
  constructor(public app: App) {
    const title = el("div", "voice-heading");
    title.append(icon("volume"), this.heading);
    this.header.append(
      title,
      button(nt("voice_session.open_chat"), () => this.hide()),
    );
    this.page.append(this.header, this.status, this.stage, this.controls);
    this.resize.observe(this.stage);
    this.screenStage.append(this.screenLabel, this.fullscreen);
    this.stage.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest(".voice-screen-stage video"))
        void this.toggleFullscreen().catch(toast);
    });
    document.addEventListener(
      "fullscreenchange",
      () => {
        const active = document.fullscreenElement === this.screenStage;
        this.fullscreen.replaceChildren(
          icon(active ? "restore" : "fullscreen"),
        );
        this.fullscreen.title = nt(
          active ? "voice_session.exit_fullscreen" : "voice_session.fullscreen",
        );
        this.fullscreen.setAttribute("aria-label", this.fullscreen.title);
        this.layout();
      },
      { signal: this.lifetime.signal },
    );
  }
  dispose(): void {
    this.lifetime.abort();
    this.resize.disconnect();
  }
  hasAccess(
    id: string,
    account: string | undefined,
    membership: string | null | undefined,
  ): boolean {
    const room = this.app.model.rooms.get(id);
    return Boolean(
      account &&
      this.app.account?.key === account &&
      membership &&
      room &&
      room.read_state?.membership_version === membership,
    );
  }
  async join(id = this.app.room): Promise<void> {
    if (!id || !this.app.account || !this.app.info || this.busy) return;
    if (this.current === id) {
      this.show();
      return;
    }
    this.busy = true;
    const account = this.app.account.key;
    let lifecycle = this.lifecycle;
    try {
      const leaving = this.leave();
      lifecycle = this.lifecycle;
      await leaving;
      if (account !== this.app.account?.key || lifecycle !== this.lifecycle)
        return;
      this.cancelled = false;
      let room = this.app.model.rooms.get(id);
      let member = room?.read_state?.membership_version;
      if (!member) {
        const details = await this.app.api.request<
          import("./protocol").RoomDetails
        >("/api/v1/rooms/" + segment(id));
        if (account !== this.app.account?.key || lifecycle !== this.lifecycle)
          return;
        this.app.model.rooms.set(id, details.room);
        room = details.room;
        member = room.read_state?.membership_version;
      }
      if (!member) throw new Error("Conversation membership not ready");
      if (!this.hasAccess(id, account, member))
        throw new Error(nt("voice_session.join_failed"));
      this.current = id;
      this.membership = member;
      this.status.textContent = nt("voice_session.connecting");
      this.status.classList.remove("connected");
      clearView(this.controls);
      this.show();
      if (room?.encrypted)
        this.encryption = await encryptedVoice(
          this.app,
          id,
          () =>
            lifecycle === this.lifecycle &&
            !this.cancelled &&
            this.hasAccess(id, account, member),
        );
      const grant = await this.app.api.request<VoiceGrant>(
        "/api/v1/rooms/" + segment(id) + "/voice/join",
        "POST",
        {
          data_epoch: this.app.account.epoch,
          membership_version: member,
          e2ee: !!room?.encrypted,
          ring: room?.kind === "direct",
        },
      );
      if (account !== this.app.account?.key || lifecycle !== this.lifecycle)
        return;
      if (!this.hasAccess(id, account, member))
        throw new Error(nt("voice_session.join_failed"));
      if (!!grant.e2ee !== !!room?.encrypted)
        throw Error(nt("voice_session.key_unavailable"));
      this.current = id;
      ringingBar(this, room?.name || "");
      this.app.sidebar.insertBefore(
        this.bar,
        this.app.sidebar.lastElementChild,
      );
      if (grant.ring) {
        this.loop = sound("ringback", true);
        while (
          grant.ring.state === "ringing" &&
          !this.cancelled &&
          lifecycle === this.lifecycle
        ) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          grant.ring = await this.app.api.request<VoiceRing>(
            "/api/v1/voice/rings/" + segment(grant.ring.id),
          );
        }
        if (lifecycle !== this.lifecycle) return;
        if (grant.ring.state !== "answered" || this.cancelled) {
          await this.leave();
          return;
        }
      }
      if (account === this.app.account?.key && !this.cancelled)
        await this.connect(grant, lifecycle, account, member);
    } catch (error) {
      if (lifecycle !== this.lifecycle) return;
      await this.leave();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async connect(
    grant: VoiceGrant,
    lifecycle = this.lifecycle,
    account = this.app.account?.key,
    membership = this.app.model.rooms.get(grant.room_id)?.read_state
      ?.membership_version,
  ): Promise<void> {
    if (
      !this.app.account ||
      lifecycle !== this.lifecycle ||
      account !== this.app.account.key ||
      this.cancelled
    )
      return;
    if (!this.hasAccess(grant.room_id, account, membership))
      throw new Error(nt("voice_session.join_failed"));
    if (
      !!grant.e2ee !== !!this.app.model.rooms.get(grant.room_id)?.encrypted ||
      (grant.e2ee && !this.encryption)
    )
      throw Error(nt("voice_session.key_unavailable"));
    if (grant.e2ee) await this.encryption!.check();
    this.loop?.pause();
    this.loop = undefined;
    const url = new URL(grant.url);
    if (
      !["wss:", "https:"].includes(url.protocol) &&
      !(
        ["ws:", "http:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )
    )
      throw new Error("Invalid voice service origin");
    const { Room, RoomEvent, Track, DisconnectReason } =
      await import("livekit-client");
    const saved = await read<
      Record<string, { volume: number; muted: boolean }>
    >("operations", account + ":voice-listening");
    if (
      lifecycle !== this.lifecycle ||
      account !== this.app.account?.key ||
      this.cancelled
    )
      return;
    if (!this.hasAccess(grant.room_id, account, membership))
      throw new Error(nt("voice_session.join_failed"));
    this.listening = new Map(
      Object.entries(saved || {}).map(([id, value]) => [
        id,
        { volume: volumeValue(value.volume), muted: value.muted === true },
      ]),
    );
    this.listeningAccount = account || "";
    const audioContext = new AudioContext();
    this.audioContext = audioContext;
    observeAudioOutput(
      audioContext,
      () =>
        this.audioContext === audioContext &&
        lifecycle === this.lifecycle &&
        account === this.app.account?.key &&
        !this.cancelled,
      toast,
    );
    this.gain = new MicrophoneGain(
      volumeValue(Number(localStorage.getItem("rv-voice-input-volume") ?? 1)),
    );
    const room = new Room({
      e2ee: grant.e2ee ? this.encryption!.options : undefined,
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: { audioContext },
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: localStorage.getItem("rv-voice-noise") !== "false",
        autoGainControl: true,
        deviceId: localStorage.getItem("rv-audioinput") || undefined,
      },
      videoCaptureDefaults: {
        deviceId: localStorage.getItem("rv-videoinput") || undefined,
      },
    });
    this.room = room;
    if (grant.e2ee) {
      await room.setE2EEEnabled(true);
      if (lifecycle !== this.lifecycle || this.cancelled) {
        await room.disconnect();
        return;
      }
      const encryption = this.encryption!;
      let checking = false;
      this.encryptionTimer = setInterval(() => {
        if (checking || this.encryption !== encryption) return;
        checking = true;
        void encryption
          .check()
          .catch((error) => {
            if (this.encryption === encryption) {
              toast(error);
              void this.leave();
            }
          })
          .finally(() => {
            checking = false;
          });
      }, 5000);
      room.on(RoomEvent.EncryptionError, (error) => {
        if (this.room === room) {
          toast(error);
          void this.leave();
        }
      });
    }
    this.current = grant.room_id;
    this.membership = membership;
    const ownsCall = () =>
      this.room === room &&
      account === this.app.account?.key &&
      lifecycle === this.lifecycle &&
      !this.cancelled;
    const alive = () =>
      ownsCall() && this.hasAccess(grant.room_id, account, membership);
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (alive()) {
        clearTimeout(this.peerLeaveTimer);
        this.peerLeaveTimer = undefined;
        this.card(
          participant.identity,
          participant.name || participant.identity,
        );
      }
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (!alive()) return;
      this.cards.get(participant.identity)?.remove();
      this.cards.delete(participant.identity);
      this.layout();
      for (const [sid, audio] of this.audioTracks)
        if (audio.identity === participant.identity) {
          this.audioTracks.delete(sid);
          this.removeMeter(sid);
        }
      this.mix();
      if (
        this.app.model.rooms.get(this.current || "")?.kind === "direct" &&
        room.remoteParticipants.size === 0
      )
        this.peerLeaveTimer = setTimeout(() => {
          if (alive() && room.remoteParticipants.size === 0)
            void this.leave().catch(toast);
        }, 2000);
    });
    room.on(RoomEvent.Reconnecting, () => {
      if (alive()) {
        this.status.textContent = nt("voice_session.reconnecting");
        this.status.classList.remove("connected");
      }
    });
    room.on(RoomEvent.Reconnected, () => {
      if (alive()) {
        this.status.textContent = nt("voice_session.connected");
        this.status.classList.add("connected");
      }
    });
    room.on(RoomEvent.TrackMuted, () => {
      if (alive()) {
        this.syncCards();
        this.mix();
      }
    });
    room.on(RoomEvent.TrackUnmuted, () => {
      if (alive()) {
        this.syncCards();
        this.mix();
      }
    });
    room.on(RoomEvent.ParticipantAttributesChanged, () => {
      if (alive()) this.syncCards();
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (!alive()) return;
      const media = track.attach();
      media.setAttribute("autoplay", "");
      media.dataset.voiceSource = publication.source;
      if (track.kind === Track.Kind.Audio) {
        this.audioTracks.set(track.sid!, {
          identity: participant.identity,
          track: track as import("livekit-client").RemoteAudioTrack,
          source: publication.source,
        });
        this.mix();
        media.classList.add("voice-audio");
        if (
          publication.source === Track.Source.Microphone &&
          track.sid &&
          this.audioContext
        ) {
          const source = this.audioContext.createMediaStreamSource(
            new MediaStream([track.mediaStreamTrack]),
          );
          const analyser = this.audioContext.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          this.meters.set(track.sid, {
            identity: participant.identity,
            track: track as import("livekit-client").RemoteAudioTrack,
            source,
            analyser,
            samples: new Float32Array(512),
            activity: new VoiceActivity(),
          });
        }
      }
      if (media instanceof HTMLVideoElement) {
        media.playsInline = true;
        media.classList.add("voice-camera");
      }
      if (
        media instanceof HTMLVideoElement &&
        publication.source === Track.Source.ScreenShare
      )
        this.addScreen(
          track.sid || publication.trackSid,
          participant.identity,
          media,
        );
      else
        this.card(
          participant.identity,
          participant.name || participant.identity,
        ).append(media);
      if (track.sid) this.tracks.set(track.sid, media);
      this.syncCards();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (!alive()) return;
      for (const media of track.detach()) media.remove();
      if (track.sid) {
        this.tracks.get(track.sid)?.remove();
        this.tracks.delete(track.sid);
        this.audioTracks.delete(track.sid);
        this.removeMeter(track.sid);
        this.screens.delete(track.sid);
      }
      this.layout();
      this.syncCards();
      this.mix();
    });
    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (!alive()) return;
      const track = publication.track;
      if (track?.kind === Track.Kind.Audio) {
        void this.processMicrophone(room).catch(toast);
        return;
      }
      if (!track || track.kind !== Track.Kind.Video) return;
      const media = track.attach();
      media.muted = true;
      media.dataset.voiceSource = publication.source;
      media.classList.add("voice-camera");
      if (media instanceof HTMLVideoElement) media.playsInline = true;
      if (
        media instanceof HTMLVideoElement &&
        publication.source === Track.Source.ScreenShare
      )
        this.addScreen(
          publication.trackSid,
          room.localParticipant.identity,
          media,
        );
      else
        this.card(
          room.localParticipant.identity,
          this.app.account?.session.user.display_name || "",
        ).append(media);
      if (track.sid) this.tracks.set(track.sid, media);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (!alive()) return;
      if (publication.track === this.sharedSound?.track)
        this.sharedSound = undefined;
      if (publication.trackSid) {
        this.tracks.get(publication.trackSid)?.remove();
        this.tracks.delete(publication.trackSid);
        this.screens.delete(publication.trackSid);
        this.layout();
      }
      if (publication.source === Track.Source.ScreenShare) {
        this.sharing = false;
        const audio = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        )?.track;
        if (audio)
          void room.localParticipant.unpublishTrack(audio).catch(toast);
        this.syncControls();
        this.syncCards();
        void this.screenRequest("DELETE").catch(() => {});
      }
    });
    let connected = false;
    room.on(RoomEvent.Disconnected, (reason) => {
      // A failed initial connection also emits Disconnected. Let join's catch
      // report that error before teardown advances the lifecycle.
      if (!ownsCall() || !connected) return;
      const notify =
        reason !== DisconnectReason.DUPLICATE_IDENTITY &&
        reason !== DisconnectReason.PARTICIPANT_REMOVED &&
        reason !== DisconnectReason.ROOM_DELETED &&
        reason !== DisconnectReason.ROOM_CLOSED;
      void this.leave(notify).catch(toast);
      if (reason === DisconnectReason.DUPLICATE_IDENTITY)
        toast(nt("voice_session.moved"));
    });
    try {
      await room.connect(grant.url, grant.token);
    } catch (error) {
      throw new Error(nt("voice_session.join_failed"), { cause: error });
    }
    connected = true;
    if (
      account !== this.app.account?.key ||
      this.cancelled ||
      lifecycle !== this.lifecycle
    ) {
      await room.disconnect();
      return;
    }
    if (!this.hasAccess(grant.room_id, account, membership))
      throw new Error(nt("voice_session.join_failed"));
    this.card(
      room.localParticipant.identity,
      this.app.account?.session.user.display_name || "",
    );
    for (const participant of room.remoteParticipants.values())
      this.card(participant.identity, participant.name || participant.identity);
    this.muted = !grant.can_publish;
    if (grant.can_publish) {
      try {
        await this.setMicrophone(room, true, alive);
      } catch (error) {
        if (!ownsCall()) return;
        if (!this.hasAccess(grant.room_id, account, membership)) throw error;
        await room.localParticipant.setMicrophoneEnabled(false);
        this.muted = true;
        toast(error);
      }
    }
    if (!alive()) return;
    await room
      .switchActiveDevice(
        "audiooutput",
        localStorage.getItem("rv-audiooutput") || "default",
      )
      .catch(() => {});
    if (
      account !== this.app.account?.key ||
      lifecycle !== this.lifecycle ||
      this.room !== room
    ) {
      await room.disconnect();
      return;
    }
    if (!this.hasAccess(grant.room_id, account, membership))
      throw new Error(nt("voice_session.join_failed"));
    sound("join");
    this.activityTimer = setInterval(() => {
      if (!alive() || this.audioContext?.state !== "running") return;
      const now = performance.now(),
        active = new Set<string>();
      if (this.muted) this.inputActivity.quiet();
      else this.inputActivity.update(this.gain.rms(), LOCAL_SPEECH_DB, now);
      if (this.inputActivity.speaking(now))
        active.add(room.localParticipant.identity);
      for (const meter of this.meters.values()) {
        if (meter.track.isMuted) meter.activity.quiet();
        else {
          meter.analyser.getFloatTimeDomainData(meter.samples);
          const rms = Math.sqrt(
            meter.samples.reduce((sum, value) => sum + value * value, 0) /
              meter.samples.length,
          );
          meter.activity.update(rms, REMOTE_SPEECH_DB, now);
        }
        if (meter.activity.speaking(now)) active.add(meter.identity);
      }
      this.light(active);
    }, 50);
    this.status.textContent = nt("voice_session.connected");
    this.status.classList.add("connected");
    const bindings: VoiceBindings = {
      canPublish: grant.can_publish,
      mic: async () => {
        if (!alive()) return;
        await this.setMicrophone(room, this.muted, alive);
        if (!alive()) return;
        sound(this.muted ? "mute" : "unmute");
        this.syncControls();
        this.syncCards();
      },
      deafen: async () => {
        if (!alive()) return;
        this.deafened = !this.deafened;
        this.mix();
        this.syncControls();
        this.syncCards();
        await room.localParticipant.setAttributes({
          "rv.deafened": this.deafened ? "1" : "0",
        });
      },
      camera: async () => {
        if (!alive()) return;
        const next = !this.camera;
        await this.setCamera(room, next, alive);
        if (!alive()) return;
        this.camera = next;
        this.syncControls();
        this.syncCards();
      },
      screen: async () => {
        if (!alive() || this.sharingBusy) return;
        this.sharingBusy = true;
        this.syncControls();
        try {
          if (!this.sharing) {
            this.shareAbort?.abort();
            const abort = new AbortController();
            this.shareAbort = abort;
            const quality = await chooseShareQuality(abort.signal);
            if (!quality || !alive()) return;
            await this.screenRequest("POST");
            if (!alive()) return;
            try {
              await this.startSharing(room, quality, abort.signal, alive);
              if (!alive()) return;
              this.sharing = room.localParticipant.isScreenShareEnabled;
            } catch (error) {
              if (alive()) await this.screenRequest("DELETE");
              throw error;
            }
          } else {
            await room.localParticipant.setScreenShareEnabled(false);
            if (alive()) await this.screenRequest("DELETE");
            if (!alive()) return;
            this.sharing = false;
          }
          this.syncControls();
          this.syncCards();
        } finally {
          if (alive()) {
            this.sharingBusy = false;
            this.syncControls();
          }
        }
      },
      menu: (anchor) => (alive() ? this.audioMenu(anchor) : undefined),
      enableAudio: async () => {
        if (alive()) await room.startAudio();
      },
    };
    this.syncControls = () => {
      if (alive()) paintVoiceControls(this, bindings);
    };
    room.on(RoomEvent.AudioPlaybackStatusChanged, this.syncControls);
    this.syncControls();
    this.app.sidebar.insertBefore(this.bar, this.app.sidebar.lastElementChild);
    this.syncCards();
    this.show();
  }
  removeMeter(sid: string): void {
    const meter = this.meters.get(sid);
    meter?.source.disconnect();
    meter?.analyser.disconnect();
    this.meters.delete(sid);
  }
  light(active: Set<string>): void {
    this.speaking = active;
    for (const roster of this.app.rooms.querySelectorAll<HTMLElement>(
      "[data-voice-room]",
    ))
      if (roster.dataset.voiceRoom === this.current)
        for (const person of roster.querySelectorAll<HTMLElement>(
          "[data-voice-user]",
        ))
          person
            .querySelector(".voice-avatar")
            ?.classList.toggle(
              "speaking",
              active.has(person.dataset.voiceUser || ""),
            );
    for (const [identity, card] of this.cards) {
      card.classList.toggle("speaking", active.has(identity));
      card
        .querySelector(".voice-avatar")
        ?.classList.toggle("speaking", active.has(identity));
    }
  }
  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement === this.screenStage)
      await document.exitFullscreen();
    else if (this.screens.size) await this.screenStage.requestFullscreen();
  }
  addScreen(sid: string, identity: string, video: HTMLVideoElement): void {
    video.classList.add("voice-screen-video");
    this.screens.set(sid, { identity, video });
    this.screenStage.prepend(video);
    this.layout();
  }
  layout(): void {
    if (!this.stage.contains(this.screenStage))
      this.stage.append(this.screenStage, this.minis);
    const cards = [...this.cards.values()],
      bounds = this.stage.getBoundingClientRect(),
      screen = [...this.screens.values()].at(-1);
    const fullscreen = document.fullscreenElement === this.screenStage;
    // The SFU removes the previous track before the replacement subscribes.
    // Keep the same fullscreen surface across that gap; an actual stop closes
    // it after one server roster interval instead of stranding a hidden exit.
    this.screenStage.hidden = !screen && !fullscreen;
    if (!screen && fullscreen) {
      if (!this.fullscreenEndTimer) {
        const lifecycle = this.lifecycle;
        this.fullscreenEndTimer = setTimeout(() => {
          this.fullscreenEndTimer = undefined;
          if (
            lifecycle === this.lifecycle &&
            !this.screens.size &&
            document.fullscreenElement === this.screenStage
          )
            void document.exitFullscreen().catch(() => {});
        }, 2000);
      }
    } else {
      clearTimeout(this.fullscreenEndTimer);
      this.fullscreenEndTimer = undefined;
    }
    this.minis.hidden = !screen;
    for (const value of this.screens.values())
      value.video.hidden = value !== screen;
    if (screen) {
      const person = this.app.live?.rooms
        .find((item) => item.room_id === this.current)
        ?.voice?.find((item) => item.user.id === screen.identity)?.user;
      const name =
        person?.display_name ||
        person?.username ||
        this.room?.remoteParticipants.get(screen.identity)?.name ||
        this.app.account?.session.user.display_name ||
        screen.identity;
      this.screenLabel.textContent = nt("voice_session.screen_of", { name });
      const width = Math.min(
        cards.some((card) => card.querySelector("video:not([hidden])"))
          ? 180
          : 130,
        Math.max(100, bounds.width * 0.22),
      );
      Object.assign(this.screenStage.style, {
        left: "0px",
        top: "0px",
        width: Math.max(0, bounds.width - width - 14) + "px",
        height: bounds.height + "px",
      });
      this.minis.style.width = width + "px";
      let top = 0;
      cards.forEach((card) => {
        const camera = Boolean(card.querySelector("video:not([hidden])")),
          height = camera ? Math.floor(((width - 20) * 9) / 16) + 40 : 92;
        this.minis.append(card);
        card.classList.add("mini");
        card.classList.toggle("has-camera", camera);
        card.querySelector(".voice-card-name")!.textContent =
          card.dataset.personName || "";
        Object.assign(card.style, {
          left: "0px",
          top: top + "px",
          width: width + "px",
          height: height + "px",
        });
        top += height + 10;
      });
    } else {
      const rectangles = tileLayout(cards.length, bounds.width, bounds.height);
      cards.forEach((card, index) => {
        this.stage.append(card);
        card.classList.remove("mini");
        card.querySelector(".voice-card-name")!.textContent =
          card.dataset.tileName || "";
        const rectangle = rectangles[index];
        if (!rectangle) return;
        Object.assign(card.style, {
          left: rectangle.left + "px",
          top: rectangle.top + "px",
          width: rectangle.width + "px",
          height: rectangle.height + "px",
        });
      });
    }
  }
  card(identity: string, name: string): HTMLElement {
    let card = this.cards.get(identity);
    if (card) return card;
    card = el("div", "voice-card tile");
    card.dataset.participant = identity;
    const local = identity === this.app.account?.session.user.id;
    const person = local
      ? this.app.account?.session.user
      : this.app.live?.rooms
          .find((item) => item.room_id === this.current)
          ?.voice?.find((item) => item.user.id === identity)?.user;
    const avatar = el("div", "voice-avatar large"),
      portrait = tile(
        identity,
        "profile",
        initials(person?.display_name || person?.username || name),
      );
    avatar.append(portrait);
    const tag = el("div", "voice-tile-tag"),
      label = el(
        "span",
        "voice-card-name",
        local
          ? nt("voice_session.you", { name: person?.display_name || name })
          : person?.display_name || name,
      ),
      media = el("span", "voice-media");
    tag.append(label, media);
    card.dataset.personName = person?.display_name || name;
    card.dataset.tileName = label.textContent || name;
    card.append(avatar, tag);
    this.cards.set(identity, card);
    this.stage.append(card);
    this.layout();
    if (person) this.app.avatar(person, portrait);
    const generation = this.lifecycle;
    if (!person) {
      const request =
        this.app.profiles.get(identity) ||
        this.app.api.request<import("./protocol").UserProfile>(
          "/api/v1/users/" + segment(identity),
        );
      this.app.profiles.set(identity, request);
      void request
        .then((profile) => {
          if (generation !== this.lifecycle || !card?.isConnected) return;
          const updated = tile(
            identity,
            "profile",
            initials(profile.user.display_name || profile.user.username),
          );
          portrait.className = updated.className;
          portrait.textContent = updated.textContent;
          card.dataset.personName =
            profile.user.display_name || profile.user.username;
          card.dataset.tileName = local
            ? nt("voice_session.you", { name: card.dataset.personName })
            : card.dataset.personName;
          label.textContent = card.classList.contains("mini")
            ? card.dataset.personName
            : card.dataset.tileName;
          this.app.avatar(profile.user, portrait);
        })
        .catch(() => {});
    }
    if (!local)
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        void this.personMenu(
          identity,
          label.textContent || name,
          event.clientX,
          event.clientY,
        ).catch(toast);
      });
    this.syncCards();
    return card;
  }
  syncCards(): void {
    for (const [identity, card] of this.cards) {
      const participant =
        this.room?.localParticipant.identity === identity
          ? this.room.localParticipant
          : this.room?.remoteParticipants.get(identity);
      const media = card.querySelector(".voice-media");
      if (!media || !participant) continue;
      media.replaceChildren();
      const local = identity === this.room?.localParticipant.identity;
      for (const video of card.querySelectorAll<HTMLVideoElement>(
        'video[data-voice-source="camera"]',
      ))
        video.hidden = !participant.isCameraEnabled;
      if (!participant.isMicrophoneEnabled) {
        const mic = icon("mic-muted");
        mic.classList.add("voice-state");
        media.append(mic);
      }
      if (
        local ? this.deafened : participant.attributes["rv.deafened"] === "1"
      ) {
        const deaf = icon("volume-muted");
        deaf.classList.add("voice-deafened", "voice-state");
        media.append(deaf);
      }
      if (participant.isCameraEnabled) media.append(icon("camera"));
      if (participant.isScreenShareEnabled) media.append(icon("screen"));
      if (this.listening.get(identity)?.muted) {
        const muted = icon("volume-low");
        muted.classList.add("voice-muted-here");
        muted.setAttribute("title", nt("voice_person.muted_here"));
        media.append(muted);
      }
    }
    this.layout();
  }
  setMicrophone(
    room: import("livekit-client").Room,
    enabled: boolean,
    valid: () => boolean,
  ): Promise<void> {
    const work = this.microphoneWork
      .catch(() => {})
      .then(() => this.applyMicrophone(room, enabled, valid));
    this.microphoneWork = work;
    return work;
  }
  async applyMicrophone(
    room: import("livekit-client").Room,
    enabled: boolean,
    valid: () => boolean,
  ): Promise<void> {
    const alive = () => this.room === room && valid();
    if (!alive()) return;
    const gain = this.gain,
      context = this.audioContext;
    let created: import("livekit-client").LocalAudioTrack | undefined;
    try {
      const existing = [
        ...room.localParticipant.audioTrackPublications.values(),
      ].find((publication) => publication.source === "microphone");
      if (enabled && !existing) {
        const { createLocalAudioTrack, Track } = await import("livekit-client");
        if (!alive()) return;
        created = await createLocalAudioTrack({
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: localStorage.getItem("rv-voice-noise") !== "false",
          deviceId: localStorage.getItem("rv-audioinput") || undefined,
        });
        if (!alive()) {
          created.stop();
          return;
        }
        created.setAudioContext(context);
        await created.setProcessor(gain);
        if (!alive()) {
          created.stop();
          return;
        }
        await room.localParticipant.publishTrack(created, {
          source: Track.Source.Microphone,
        });
        if (!alive()) {
          created.stop();
          await room.localParticipant.unpublishTrack(created).catch(() => {});
          return;
        }
      } else {
        await room.localParticipant.setMicrophoneEnabled(enabled);
        if (!alive()) {
          existing?.track?.stop();
          if (existing?.track)
            await room.localParticipant
              .unpublishTrack(existing.track)
              .catch(() => {});
          return;
        }
        if (enabled) await this.processMicrophone(room);
      }
    } catch (error) {
      if (created) {
        created.stop();
        await gain.destroy();
      }
      await room.localParticipant.setMicrophoneEnabled(false);
      throw error;
    } finally {
      if (this.room === room) {
        this.muted = !room.localParticipant.isMicrophoneEnabled;
        this.syncControls();
        this.syncCards();
      }
    }
  }
  setCamera(
    room: import("livekit-client").Room,
    enabled: boolean,
    valid: () => boolean,
  ): Promise<void> {
    const work = this.cameraWork
      .catch(() => {})
      .then(async () => {
        const alive = () => this.room === room && valid();
        if (!alive()) return;
        const { createLocalVideoTrack, Track } = await import("livekit-client");
        if (!alive()) return;
        const existing = room.localParticipant.getTrackPublication(
          Track.Source.Camera,
        )?.track;
        if (existing) {
          if (enabled && !existing.isMuted) return;
          await room.localParticipant.unpublishTrack(existing);
        }
        if (!enabled || !alive()) return;
        const track = await createLocalVideoTrack({
          deviceId: localStorage.getItem("rv-videoinput") || undefined,
        });
        if (!alive()) {
          track.stop();
          return;
        }
        this.pendingCameras.add(track);
        try {
          await room.localParticipant.publishTrack(track, {
            source: Track.Source.Camera,
          });
          if (!alive()) {
            track.stop();
            await room.localParticipant.unpublishTrack(track).catch(() => {});
          }
        } catch (error) {
          track.stop();
          throw error;
        } finally {
          this.pendingCameras.delete(track);
        }
      });
    this.cameraWork = work;
    return work;
  }
  async processMicrophone(room: import("livekit-client").Room): Promise<void> {
    const track = [
      ...room.localParticipant.audioTrackPublications.values(),
    ].find((publication) => publication.source === "microphone")?.audioTrack;
    if (!track) return;
    const pending = this.processors.get(track);
    if (pending) {
      await pending;
      return;
    }
    if (track.getProcessor() === this.gain) return;
    const processing = track.setProcessor(this.gain);
    this.processors.set(track, processing);
    try {
      await processing;
    } finally {
      this.processors.delete(track);
    }
  }
  screenRequest(method: "POST" | "DELETE"): Promise<unknown> {
    const api = new Api();
    api.token = this.app.api.token;
    const request = this.voiceRequests
      .catch(() => {})
      .then(() => api.request("/api/v1/voice/screen", method, null));
    this.voiceRequests = request;
    return request;
  }
  async startSharing(
    room: import("livekit-client").Room,
    quality: import("./voice-share").ShareQuality,
    signal: AbortSignal,
    valid: () => boolean,
  ): Promise<void> {
    const { Track } = await import("livekit-client");
    const alive = () => this.room === room && !signal.aborted && valid();
    if (!alive()) return;
    const audio: import("livekit-client").AudioCaptureOptions & {
      restrictOwnAudio: boolean;
    } = {
      restrictOwnAudio: true,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    const tracks = await room.localParticipant.createScreenTracks({
      resolution: {
        width: Math.round((quality.height * 16) / 9),
        height: quality.height,
        frameRate: quality.fps,
      },
      contentHint: "detail",
      audio,
      selfBrowserSurface: "exclude",
      systemAudio: "include",
    });
    try {
      if (!alive()) return;
      const video = tracks.find(
        (track) => track.source === Track.Source.ScreenShare,
      )!;
      const captured = tracks.find(
        (track) => track.source === Track.Source.ScreenShareAudio,
      ) as import("livekit-client").LocalAudioTrack | undefined;
      // Requesting exclusion does not prove the browser applied it. Never send
      // unrestricted loopback, which includes the call by default on some UAs.
      const safe =
        captured && excludesOwnAudio(captured.mediaStreamTrack)
          ? captured
          : undefined;
      if (captured && !safe) captured.stop();
      await room.localParticipant.publishTrack(video, {
        source: Track.Source.ScreenShare,
        screenShareEncoding: {
          maxFramerate: quality.fps,
          maxBitrate: Math.round(
            2_000_000 * (quality.height / 720) ** 2 * (quality.fps / 30),
          ),
        },
      });
      if (!alive()) return;
      await this.publishSharedSound(room, safe);
    } catch (error) {
      for (const track of tracks) {
        await room.localParticipant.unpublishTrack(track).catch(() => {});
        track.stop();
      }
      throw error;
    } finally {
      if (!alive()) for (const track of tracks) track.stop();
    }
  }
  async publishSharedSound(
    room: import("livekit-client").Room,
    captured?: import("livekit-client").LocalAudioTrack,
  ): Promise<void> {
    const context = this.audioContext;
    const { LocalAudioTrack, Track } = await import("livekit-client");
    const screenSid = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
    )?.trackSid;
    const alive = () =>
      this.room === room &&
      Boolean(screenSid) &&
      room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
        ?.trackSid === screenSid;
    if (!alive() || !context || (!captured && !this.includeCall)) {
      captured?.stop();
      return;
    }
    const track =
      captured ||
      new LocalAudioTrack(
        context.createMediaStreamDestination().stream.getAudioTracks()[0],
        undefined,
        false,
        context,
      );
    track.source = Track.Source.ScreenShareAudio;
    track.setAudioContext(context);
    const mixer = new ShareAudioMixer();
    try {
      mixer.sync(this.sharedVoices());
      await track.setProcessor(mixer);
      if (!alive()) {
        track.stop();
        return;
      }
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.ScreenShareAudio,
      });
      if (!alive()) {
        track.stop();
        await room.localParticipant.unpublishTrack(track).catch(() => {});
        return;
      }
      this.sharedSound = { room, track, mixer, captured: Boolean(captured) };
      this.mix();
    } catch (error) {
      track.stop();
      await mixer.destroy();
      throw error;
    }
  }
  sharedVoices(): import("./voice-share-audio").SharedVoice[] {
    if (!this.includeCall) return [];
    return [...this.audioTracks]
      .filter(([, audio]) => audio.source === "microphone")
      .map(([sid, { identity, track }]) => ({
        sid,
        track: track.mediaStreamTrack,
        volume: track.isMuted ? 0 : this.listenVolume(identity),
      }));
  }
  listenVolume(identity: string): number {
    const person = this.listening.get(identity);
    return this.deafened || person?.muted
      ? 0
      : this.outputVolume * (person?.volume ?? 1);
  }
  updateSharedSound(): Promise<void> {
    const room = this.room;
    const work = this.shareAudioWork
      .catch(() => {})
      .then(async () => {
        if (!room || this.room !== room || !this.sharing) return;
        const sound = this.sharedSound;
        if (sound) {
          if (!sound.captured && !this.includeCall)
            await room.localParticipant.unpublishTrack(sound.track);
          else sound.mixer.sync(this.sharedVoices());
        } else if (this.includeCall) await this.publishSharedSound(room);
      });
    this.shareAudioWork = work;
    return work;
  }
  mix(): void {
    for (const { identity, track } of this.audioTracks.values()) {
      track.setVolume(this.listenVolume(identity));
    }
    this.sharedSound?.mixer.sync(this.sharedVoices());
  }
  popover(x: number, y: number, above = false): HTMLElement {
    this.closeMenu();
    const menu = el("div", "voice-menu" + (above ? " above" : "")),
      abort = new AbortController();
    menu.setAttribute("role", "dialog");
    (document.fullscreenElement || document.body).append(menu);
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 334)) + "px";
    menu.style.top = Math.max(8, y) + "px";
    const resize = new ResizeObserver(() => {
      const rect = menu.getBoundingClientRect();
      menu.style.top =
        Math.max(
          8,
          Math.min(
            above ? y - rect.height - 8 : y,
            window.innerHeight - rect.height - 8,
          ),
        ) + "px";
    });
    resize.observe(menu);
    this.closeMenu = () => {
      resize.disconnect();
      abort.abort();
      menu.remove();
      this.closeMenu = () => {};
    };
    const signal = abort.signal;
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!menu.contains(event.target as Node)) this.closeMenu();
      },
      { signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          this.closeMenu();
        }
      },
      { signal, capture: true },
    );
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      menu.style.top =
        Math.max(
          8,
          Math.min(
            above ? y - rect.height - 8 : y,
            window.innerHeight - rect.height - 8,
          ),
        ) + "px";
    });
    return menu;
  }
  volumeControl(
    menu: HTMLElement,
    key: string,
    value: number,
    change: (value: number) => void,
  ): void {
    const row = el("label", "voice-volume"),
      title = el("span", "voice-menu-heading", nt(key)),
      amount = el("output", "", Math.round(value * 100) + " %"),
      input = el("input");
    input.type = "range";
    input.min = "0";
    input.max = "200";
    input.step = "1";
    input.value = String(Math.round(value * 100));
    input.style.setProperty("--voice-volume-fill", String(value * 50) + "%");
    input.setAttribute("aria-label", nt(key));
    input.addEventListener("input", () => {
      amount.textContent = input.value + " %";
      input.style.setProperty(
        "--voice-volume-fill",
        String(Number(input.value) / 2) + "%",
      );
      change(Number(input.value) / 100);
    });
    const rail = el("div", "voice-volume-rail");
    rail.append(input);
    row.append(title, amount, rail);
    menu.append(row);
  }
  async personMenu(
    identity: string,
    name: string,
    x: number,
    y: number,
  ): Promise<void> {
    const openingAccount = this.app.account?.key,
      openingLifecycle = this.lifecycle;
    if (!openingAccount) return;
    if (this.listeningAccount !== openingAccount) {
      const stored = await read<
        Record<string, { volume: number; muted: boolean }>
      >("operations", openingAccount + ":voice-listening");
      if (
        openingAccount !== this.app.account?.key ||
        openingLifecycle !== this.lifecycle
      )
        return;
      this.listening = new Map(
        Object.entries(stored || {}).map(([id, value]) => [
          id,
          { volume: volumeValue(value.volume), muted: value.muted === true },
        ]),
      );
      this.listeningAccount = openingAccount;
    }
    const menu = this.popover(x, y);
    menu.setAttribute("aria-label", name);
    menu.append(el("div", "voice-menu-title", name));
    const person = this.listening.get(identity) || { volume: 1, muted: false };
    this.listening.set(identity, person);
    const account = this.app.account?.key,
      lifecycle = this.lifecycle;
    const save = () => {
      if (account !== this.app.account?.key || lifecycle !== this.lifecycle)
        return;
      this.mix();
      this.syncCards();
      void write(
        "operations",
        account + ":voice-listening",
        Object.fromEntries(this.listening),
      ).catch(toast);
    };
    this.volumeControl(menu, "voice_person.volume", person.volume, (value) => {
      person.volume = value;
      save();
    });
    const row = el("label", "voice-menu-check"),
      mute = el("input");
    mute.type = "checkbox";
    mute.checked = person.muted;
    mute.addEventListener("change", () => {
      person.muted = mute.checked;
      save();
    });
    row.append(mute, el("span", "", nt("voice_person.mute")));
    menu.append(row);
  }
  async audioMenu(anchor: HTMLElement): Promise<void> {
    const room = this.room;
    if (!room) return;
    const bounds = anchor.getBoundingClientRect(),
      menu = this.popover(
        bounds.left + bounds.width / 2 - 159,
        bounds.top,
        true,
      ),
      lifecycle = this.lifecycle;
    menu.setAttribute("aria-label", nt("voice_menu.open"));
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!menu.isConnected || this.room !== room || lifecycle !== this.lifecycle)
      return;
    for (const kind of ["audioinput", "audiooutput"] as const) {
      const row = el("label", "voice-device"),
        key =
          kind === "audioinput"
            ? "voice_menu.input_device"
            : "voice_menu.output_device",
        select = el("select", "row-select");
      select.setAttribute("aria-label", nt(key));
      const defaultOption = el("option", "", nt("voice_settings.default"));
      defaultOption.value = "default";
      select.append(defaultOption);
      for (const device of devices.filter(
        (item) => item.kind === kind && item.deviceId !== "default",
      )) {
        const option = el("option", "", device.label || nt(key));
        option.value = device.deviceId;
        select.append(option);
      }
      select.value = localStorage.getItem("rv-" + kind) || "default";
      select.addEventListener("change", () => {
        void room
          .switchActiveDevice(kind, select.value)
          .then(() => localStorage.setItem("rv-" + kind, select.value))
          .catch(toast);
      });
      row.append(el("span", "voice-menu-heading", nt(key)), select);
      menu.append(row);
    }
    menu.append(el("hr"));
    this.volumeControl(
      menu,
      "voice_menu.input_volume",
      this.gain.volume,
      (value) => {
        this.gain.setVolume(value);
        localStorage.setItem("rv-voice-input-volume", String(value));
      },
    );
    menu.append(el("div", "voice-menu-heading", nt("voice_menu.input_level")));
    const meter = el("div", "voice-meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", nt("voice_menu.input_level"));
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    for (let i = 0; i < 24; i++) meter.append(el("span"));
    menu.append(meter);
    const tick = () => {
      if (!menu.isConnected) return;
      const level = this.muted ? 0 : this.inputActivity.level;
      meter.setAttribute("aria-valuenow", String(Math.round(level * 100)));
      [...meter.children].forEach((block, index) =>
        block.classList.toggle("filled", index < Math.round(level * 24)),
      );
      requestAnimationFrame(tick);
    };
    tick();
    this.volumeControl(
      menu,
      "voice_menu.output_volume",
      this.outputVolume,
      (value) => {
        this.outputVolume = value;
        this.mix();
        localStorage.setItem("rv-voice-output-volume", String(value));
      },
    );
    menu.append(el("hr"));
    const check = (
      key: string,
      value: boolean,
      change: (value: boolean) => Promise<void>,
    ) => {
      const row = el("label", "voice-menu-check"),
        input = el("input");
      input.type = "checkbox";
      input.checked = value;
      input.addEventListener("change", () => {
        input.disabled = true;
        void change(input.checked)
          .catch((error) => {
            input.checked = !input.checked;
            toast(error);
          })
          .finally(() => (input.disabled = false));
      });
      row.append(input, el("span", "", nt(key)));
      menu.append(row);
    };
    check(
      "voice_settings.noise",
      localStorage.getItem("rv-voice-noise") !== "false",
      async (value) => {
        const track = [
          ...room.localParticipant.audioTrackPublications.values(),
        ].find((item) => item.source === "microphone")?.audioTrack;
        await track?.applyConstraints({ noiseSuppression: value });
        localStorage.setItem("rv-voice-noise", String(value));
      },
    );
    check("voice_menu.deafen", this.deafened, async (value) => {
      this.deafened = value;
      this.mix();
      this.syncControls();
      this.syncCards();
      await room.localParticipant.setAttributes({
        "rv.deafened": value ? "1" : "0",
      });
    });
    menu.append(
      button(nt("voice_menu.settings"), async () => {
        this.closeMenu();
        const { settings } = await import("./panels");
        await settings(this.app, "voice");
      }),
    );
  }
  async settings(page: HTMLElement): Promise<void> {
    const [group, rows] = preferencesGroup(nt("voice_settings.title"));
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [kind, label] of [
      ["audioinput", nt("voice_settings.input")],
      ["audiooutput", nt("voice_settings.output")],
    ] as const) {
      const row = actionRow(label),
        select = el("select", "row-select");
      select.setAttribute("aria-label", label);
      const defaultOption = el("option", "", nt("voice_settings.default"));
      defaultOption.value = "default";
      select.append(defaultOption);
      for (const device of devices.filter(
        (device) => device.kind === kind && device.deviceId !== "default",
      )) {
        const option = el("option", "", device.label || label);
        option.value = device.deviceId;
        select.append(option);
      }
      select.value = localStorage.getItem("rv-" + kind) || "default";
      select.addEventListener("change", () => {
        localStorage.setItem("rv-" + kind, select.value);
        void this.room?.switchActiveDevice(kind, select.value).catch(toast);
      });
      row.append(select);
      rows.append(row);
    }
    const noiseRow = actionRow(
      nt("voice_settings.noise"),
      nt("voice_settings.noise_hint").replace(" (RNNoise)", ""),
    );
    const noise = el("input");
    noise.type = "checkbox";
    noise.classList.add("row-switch");
    noise.setAttribute("role", "switch");
    noise.setAttribute("aria-label", nt("voice_settings.noise"));
    noise.checked = localStorage.getItem("rv-voice-noise") !== "false";
    noise.addEventListener("change", () => {
      localStorage.setItem("rv-voice-noise", String(noise.checked));
      const track = [
        ...(this.room?.localParticipant.audioTrackPublications.values() || []),
      ].find((item) => item.source === "microphone")?.audioTrack;
      void track
        ?.applyConstraints({ noiseSuppression: noise.checked })
        .catch(toast);
    });
    noiseRow.append(noise);
    rows.append(noiseRow);
    const shareRow = actionRow(
      nt("voice_settings.share_call"),
      nt("voice_settings.share_call_hint"),
    );
    const include = el("input");
    include.type = "checkbox";
    include.classList.add("row-switch");
    include.setAttribute("role", "switch");
    include.setAttribute("aria-label", nt("voice_settings.share_call"));
    include.checked = this.includeCall;
    include.addEventListener("change", () => {
      this.includeCall = include.checked;
      localStorage.setItem("rv-share-call", String(include.checked));
      void this.updateSharedSound().catch(toast);
    });
    shareRow.append(include);
    rows.append(shareRow);
    page.append(group);
  }
  show(): void {
    if (!this.current) return;
    if (this.app.room !== this.current) {
      const id = this.current,
        lifecycle = this.lifecycle;
      void this.app
        .openRoom(id)
        .then(() => {
          if (
            this.current === id &&
            this.lifecycle === lifecycle &&
            this.app.room === id
          )
            this.show();
        })
        .catch(toast);
      return;
    }
    this.heading.textContent =
      this.app.model.rooms.get(this.current)?.name || t("voice");
    this.app.roomPane.append(this.page);
    this.visible = true;
    this.app.roomPane.classList.add("voice-open");
    this.app.view.changed();
    this.app.threadPane.hidden = true;
  }
  hide(): void {
    this.visible = false;
    this.app.roomPane.classList.remove("voice-open");
    this.app.view.changed();
    this.app.scheduleRead();
  }
  async leave(notify = true): Promise<void> {
    this.lifecycle++;
    clearInterval(this.encryptionTimer);
    this.encryptionTimer = undefined;
    this.encryption?.close();
    this.encryption = undefined;
    clearTimeout(this.fullscreenEndTimer);
    this.fullscreenEndTimer = undefined;
    this.shareAbort?.abort();
    this.shareAbort = undefined;
    if (document.fullscreenElement === this.screenStage)
      void document.exitFullscreen().catch(() => {});
    this.closeMenu();
    clearInterval(this.activityTimer);
    this.activityTimer = undefined;
    this.inputActivity.quiet();
    for (const sid of this.meters.keys()) this.removeMeter(sid);
    this.audioTracks.clear();
    this.listening.clear();
    this.listeningAccount = "";
    clearTimeout(this.peerLeaveTimer);
    this.peerLeaveTimer = undefined;
    this.syncControls = () => {};
    this.microphoneWork = Promise.resolve();
    this.cameraWork = Promise.resolve();
    for (const track of this.pendingCameras) track.stop();
    this.pendingCameras.clear();
    this.cancelled = true;
    this.loop?.pause();
    this.loop = undefined;
    this.cards.clear();
    this.speaking.clear();
    this.hide();
    this.page.remove();
    const active = this.current || this.room;
    const room = this.room;
    const audioContext = this.audioContext;
    this.sharedSound = undefined;
    this.shareAudioWork = Promise.resolve();
    this.audioContext = undefined;
    const api = new Api();
    api.token = this.app.api.token;
    const previous = this.leaving;
    const voiceRequests = this.voiceRequests;
    this.room = undefined;
    this.current = undefined;
    this.membership = undefined;
    clearView(this.bar);
    this.bar.remove();
    for (const screen of this.screens.values()) screen.video.remove();
    this.screens.clear();
    this.minis.replaceChildren();
    this.stage.replaceChildren();
    clearView(this.controls);
    this.tracks.clear();
    this.muted = false;
    this.camera = false;
    this.sharing = false;
    this.sharingBusy = false;
    this.deafened = false;
    const leaving = (async () => {
      await previous.catch(() => {});
      if (room) {
        await room.disconnect(true);
        sound("leave");
      }
      await audioContext?.close().catch(() => {});
      await voiceRequests.catch(() => {});
      if (active && notify)
        try {
          await api.request("/api/v1/voice/leave", "POST", null);
        } catch {}
    })();
    this.leaving = leaving;
    await leaving;
  }
  observe(state: LiveState): void {
    if (
      this.current &&
      !this.hasAccess(this.current, this.app.account?.key, this.membership)
    )
      void this.leave(false).catch(toast);
    if (this.current) this.layout();
    for (const [id, node] of this.ringDialogs)
      if (
        !state.rings?.some((ring) => ring.id === id && ring.state === "ringing")
      ) {
        node.close();
        this.ringDialogs.delete(id);
      }
    for (const ring of state.rings || []) {
      if (
        ring.state !== "ringing" ||
        ring.callee.id !== this.app.account?.session.user.id ||
        this.ringDialogs.has(ring.id)
      )
        continue;
      const [node, body] = dialog(
        language === "fr" ? "Appel entrant" : "Incoming call",
      );
      const ringtone = sound("ringtone", true);
      node.addEventListener("close", () => ringtone.pause());
      this.ringDialogs.set(ring.id, node);
      body.append(
        tile(ring.caller.username, "profile"),
        el(
          "h2",
          "details-name",
          ring.caller.display_name || ring.caller.username,
        ),
        button(
          nt("voice_session.accept"),
          async () => {
            const member = this.app.model.rooms.get(ring.room_id)?.read_state
              ?.membership_version;
            if (!member || !this.app.account) return;
            const account = this.app.account.key;
            const leaving = this.leave();
            const lifecycle = this.lifecycle;
            await leaving;
            if (
              account !== this.app.account?.key ||
              lifecycle !== this.lifecycle
            )
              return;
            if (!this.hasAccess(ring.room_id, account, member)) return;
            this.current = ring.room_id;
            this.membership = member;
            this.cancelled = false;
            try {
              const encrypted = !!this.app.model.rooms.get(ring.room_id)
                ?.encrypted;
              if (encrypted)
                this.encryption = await encryptedVoice(
                  this.app,
                  ring.room_id,
                  () =>
                    lifecycle === this.lifecycle &&
                    !this.cancelled &&
                    this.hasAccess(ring.room_id, account, member),
                );
              const grant = await this.app.api.request<VoiceGrant>(
                "/api/v1/voice/rings/" + segment(ring.id) + "/accept",
                "POST",
                {
                  data_epoch: this.app.account.epoch,
                  membership_version: member,
                  e2ee: encrypted,
                },
              );
              node.close();
              if (
                lifecycle !== this.lifecycle ||
                account !== this.app.account?.key
              )
                return;
              this.cancelled = false;
              await this.connect(grant, lifecycle, account, member);
            } catch (error) {
              if (lifecycle !== this.lifecycle) return;
              await this.leave();
              throw error;
            }
          },
          "cta",
        ),
        button(
          nt("voice_session.decline"),
          async () => {
            await this.app.api.request(
              "/api/v1/voice/rings/" + segment(ring.id) + "/decline",
              "POST",
              null,
            );
            node.close();
          },
          "destructive",
        ),
      );
    }
  }
}
