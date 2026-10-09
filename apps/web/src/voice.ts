import type { App } from "./app";
import type { VoiceGrant, VoiceRing, LiveState } from "./protocol";
import { Api, segment } from "./api";
import { el, button, dialog, tile, toast, initials } from "./dom";
import { icon, iconButton } from "./icons";
import { nt } from "./native-i18n";
import { tileLayout } from "./voice-grid";
import { MicrophoneGain, volumeValue } from "./voice-audio";
import { read, write } from "./store";
import { preferencesGroup, actionRow } from "./sidebar";
import { sound } from "./sounds";
import { t, language } from "./i18n";
export class Voice {
  current?: string;
  room?: import("livekit-client").Room;
  audioContext?: AudioContext;
  busy = false;
  lifecycle = 0;
  leaving: Promise<void> = Promise.resolve();
  voiceRequests: Promise<unknown> = Promise.resolve();
  microphoneWork: Promise<void> = Promise.resolve();
  cancelled = false;
  ringDialogs = new Map<string, HTMLDialogElement>();
  bar = el("div", "voice-bar");
  stage = el("div", "voice-stage");
  muted = false;
  camera = false;
  sharing = false;
  deafened = false;
  cards = new Map<string, HTMLElement>();
  speaking = new Set<string>();
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
    { identity: string; track: import("livekit-client").RemoteAudioTrack }
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
    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.stage.addEventListener("dblclick", (event) => {
      const video = (event.target as HTMLElement).closest("video");
      if (video) void video.requestFullscreen().catch(toast);
    });
  }
  async join(id = this.app.room): Promise<void> {
    if (
      !id ||
      !this.app.account ||
      !this.app.info ||
      this.app.model.rooms.get(id)?.encrypted ||
      this.busy
    )
      return;
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
      this.current = id;
      this.status.textContent = nt("voice_session.connecting");
      this.status.classList.remove("connected");
      this.controls.replaceChildren();
      this.show();
      const grant = await this.app.api.request<VoiceGrant>(
        "/api/v1/rooms/" + segment(id) + "/voice/join",
        "POST",
        {
          data_epoch: this.app.account.epoch,
          membership_version: member,
          e2ee: false,
          ring: room?.kind === "direct",
        },
      );
      if (account !== this.app.account?.key || lifecycle !== this.lifecycle)
        return;
      if (grant.e2ee) throw new Error(t("encryptedHint"));
      this.current = id;
      this.bar.replaceChildren(
        el("span", "", room?.name || ""),
        el("span", "dim", language === "fr" ? "Appel…" : "Calling…"),
        iconButton("close", t("close"), () => this.leave()),
      );
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
        await this.connect(grant, lifecycle, account);
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
  ): Promise<void> {
    if (
      !this.app.account ||
      lifecycle !== this.lifecycle ||
      account !== this.app.account.key ||
      this.cancelled
    )
      return;
    if (grant.e2ee) throw new Error(t("encryptedHint"));
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
    const { Room, RoomEvent, Track } = await import("livekit-client");
    const saved = await read<
      Record<string, { volume: number; muted: boolean }>
    >("operations", account + ":voice-listening");
    if (
      lifecycle !== this.lifecycle ||
      account !== this.app.account?.key ||
      this.cancelled
    )
      return;
    this.listening = new Map(
      Object.entries(saved || {}).map(([id, value]) => [
        id,
        { volume: volumeValue(value.volume), muted: value.muted === true },
      ]),
    );
    this.listeningAccount = account || "";
    const audioContext = new AudioContext();
    this.audioContext = audioContext;
    this.gain = new MicrophoneGain(
      volumeValue(Number(localStorage.getItem("rv-voice-input-volume") ?? 1)),
    );
    const room = new Room({
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
    this.current = grant.room_id;
    const alive = () =>
      this.room === room &&
      account === this.app.account?.key &&
      lifecycle === this.lifecycle &&
      !this.cancelled;
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
        if (audio.identity === participant.identity)
          this.audioTracks.delete(sid);
      if (
        this.app.model.rooms.get(this.current || "")?.kind === "direct" &&
        room.remoteParticipants.size === 0
      )
        this.peerLeaveTimer = setTimeout(() => {
          if (alive() && room.remoteParticipants.size === 0)
            void this.leave().catch(toast);
        }, 2000);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (participants) => {
      if (!alive()) return;
      const active = new Set(
        participants.map((participant) => participant.identity),
      );
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
      if (alive()) this.syncCards();
    });
    room.on(RoomEvent.TrackUnmuted, () => {
      if (alive()) this.syncCards();
    });
    room.on(RoomEvent.ParticipantAttributesChanged, () => {
      if (alive()) this.syncCards();
    });
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (!alive()) return;
      const media = track.attach();
      media.setAttribute("autoplay", "");
      if (track.kind === Track.Kind.Audio) {
        this.audioTracks.set(track.sid!, {
          identity: participant.identity,
          track: track as import("livekit-client").RemoteAudioTrack,
        });
        this.mix();
        media.classList.add("voice-audio");
      }
      if (media instanceof HTMLVideoElement) {
        media.playsInline = true;
        media.classList.add("voice-camera");
      }
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
      }
      this.syncCards();
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
      media.classList.add("voice-camera");
      if (media instanceof HTMLVideoElement) media.playsInline = true;
      this.card(
        room.localParticipant.identity,
        this.app.account?.session.user.display_name || "",
      ).append(media);
      if (track.sid) this.tracks.set(track.sid, media);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (!alive()) return;
      if (publication.trackSid) {
        this.tracks.get(publication.trackSid)?.remove();
        this.tracks.delete(publication.trackSid);
      }
      if (publication.source === Track.Source.ScreenShare && this.sharing) {
        this.sharing = false;
        this.syncControls();
        this.syncCards();
        void this.screenRequest("DELETE").catch(() => {});
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!alive()) return;
      void this.leave().catch(toast);
    });
    await room.connect(grant.url, grant.token);
    if (
      account !== this.app.account?.key ||
      this.cancelled ||
      lifecycle !== this.lifecycle
    ) {
      await room.disconnect();
      return;
    }
    this.card(
      room.localParticipant.identity,
      this.app.account?.session.user.display_name || "",
    );
    for (const participant of room.remoteParticipants.values())
      this.card(participant.identity, participant.name || participant.identity);
    this.muted = !grant.can_publish;
    if (grant.can_publish) {
      try {
        await this.setMicrophone(room, true);
      } catch (error) {
        if (!alive()) return;
        await room.localParticipant.setMicrophoneEnabled(false);
        this.muted = true;
        toast(error);
      }
    }
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
    sound("join");
    this.status.textContent = nt("voice_session.connected");
    this.status.classList.add("connected");
    const controls = (sidebar = false) => {
      const mic = iconButton(
        "mic",
        "Microphone",
        async () => {
          if (!alive()) return;
          await this.setMicrophone(room, this.muted);
          if (!alive()) return;
          sound(this.muted ? "mute" : "unmute");
          this.syncControls();
          this.syncCards();
        },
        sidebar ? "flat" : "voice-control",
      );
      mic.disabled = !grant.can_publish;
      const menu = iconButton(
        "audio-menu",
        nt("voice_menu.open"),
        () => (alive() ? this.audioMenu(menu) : undefined),
        "flat voice-menu-button",
      );
      const deaf = iconButton(
        "headphones",
        language === "fr" ? "Écoute" : "Listen",
        async () => {
          if (!alive()) return;
          this.deafened = !this.deafened;
          this.mix();
          this.syncControls();
          this.syncCards();
          await room.localParticipant.setAttributes({
            "rv.deafened": String(this.deafened),
          });
        },
        sidebar ? "flat" : "voice-control",
      );
      const leave = iconButton(
        "leave-call",
        sidebar ? t("close") : nt("voice_session.leave"),
        () => this.leave(),
        sidebar ? "flat voice-leave" : "voice-control voice-leave",
      );
      leave.title = nt("voice_session.leave");
      const nodes = [mic, menu, deaf];
      const camera = iconButton(
        "camera",
        language === "fr" ? "Caméra" : "Camera",
        async () => {
          if (!alive()) return;
          const next = !this.camera;
          await room.localParticipant.setCameraEnabled(next);
          if (!alive()) return;
          this.camera = next;
          this.syncControls();
          this.syncCards();
        },
        "voice-control",
      );
      camera.disabled = !grant.can_publish;
      const screen = iconButton(
        "screen",
        nt("voice_session.share_screen"),
        async () => {
          if (!alive()) return;
          if (!this.sharing) {
            await this.screenRequest("POST");
            if (!alive()) return;
            try {
              await room.localParticipant.setScreenShareEnabled(true);
              if (!alive()) return;
              this.sharing = true;
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
        },
        "voice-control",
      );
      screen.disabled = !grant.can_publish;
      if (!sidebar) nodes.push(camera, screen);
      nodes.push(leave);
      const sync = () => {
        mic.replaceChildren(icon(this.muted ? "mic-muted" : "mic"));
        mic.classList.toggle("voice-off", this.muted);
        mic.title = nt(
          !grant.can_publish
            ? "voice_session.listening"
            : this.muted
              ? "voice_session.unmute"
              : "voice_session.mute",
        );
        mic.setAttribute("aria-pressed", String(this.muted));
        deaf.replaceChildren(
          icon(this.deafened ? "volume-muted" : "headphones"),
        );
        deaf.classList.toggle("voice-off", this.deafened);
        deaf.title = nt(
          this.deafened ? "voice_session.undeafen" : "voice_session.deafen",
        );
        deaf.setAttribute("aria-pressed", String(this.deafened));
        camera.classList.toggle("voice-on", this.camera);
        camera.title = nt(
          this.camera ? "voice_session.camera_off" : "voice_session.camera_on",
        );
        camera.setAttribute("aria-pressed", String(this.camera));
        screen.classList.toggle("voice-on", this.sharing);
        screen.title = nt(
          this.sharing
            ? "voice_session.stop_screen"
            : "voice_session.share_screen",
        );
        screen.setAttribute("aria-pressed", String(this.sharing));
      };
      return { nodes, sync };
    };
    const main = controls(),
      sidebar = controls(true);
    this.syncControls = () => {
      main.sync();
      sidebar.sync();
    };
    this.syncControls();
    this.controls.replaceChildren(...main.nodes);
    const resume = button(
      language === "fr" ? "Activer le son" : "Enable audio",
      () => room.startAudio(),
    );
    const syncPlayback = () => {
      if (alive()) resume.hidden = room.canPlaybackAudio;
    };
    room.on(RoomEvent.AudioPlaybackStatusChanged, syncPlayback);
    syncPlayback();
    this.controls.append(resume);
    const connection = button("", () => this.show(), "flat voice-bar-info");
    connection.append(
      el("span", "voice-bar-status connected", nt("voice_session.connected")),
      el(
        "span",
        "voice-bar-room",
        this.app.model.rooms.get(grant.room_id)?.name || t("voice"),
      ),
    );
    this.bar.replaceChildren(connection, ...sidebar.nodes);
    this.app.sidebar.insertBefore(this.bar, this.app.sidebar.lastElementChild);
    this.syncCards();
    this.show();
  }
  layout(): void {
    const cards = [...this.cards.values()],
      bounds = this.stage.getBoundingClientRect();
    const rectangles = tileLayout(cards.length, bounds.width, bounds.height);
    cards.forEach((card, index) => {
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
          label.textContent =
            profile.user.display_name || profile.user.username;
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
      if (!participant.isMicrophoneEnabled) {
        const mic = icon("mic-muted");
        mic.classList.add("voice-state");
        media.append(mic);
      }
      if (
        local ? this.deafened : participant.attributes["rv.deafened"] === "true"
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
  }
  setMicrophone(
    room: import("livekit-client").Room,
    enabled: boolean,
  ): Promise<void> {
    const work = this.microphoneWork
      .catch(() => {})
      .then(() => this.applyMicrophone(room, enabled));
    this.microphoneWork = work;
    return work;
  }
  async applyMicrophone(
    room: import("livekit-client").Room,
    enabled: boolean,
  ): Promise<void> {
    if (this.room !== room) return;
    const gain = this.gain,
      context = this.audioContext;
    let created: import("livekit-client").LocalAudioTrack | undefined;
    try {
      const existing = [
        ...room.localParticipant.audioTrackPublications.values(),
      ].find((publication) => publication.source === "microphone");
      if (enabled && !existing) {
        const { createLocalAudioTrack, Track } = await import("livekit-client");
        created = await createLocalAudioTrack({
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: localStorage.getItem("rv-voice-noise") !== "false",
          deviceId: localStorage.getItem("rv-audioinput") || undefined,
        });
        if (this.room !== room) {
          created.stop();
          return;
        }
        created.setAudioContext(context);
        await created.setProcessor(gain);
        if (this.room !== room) {
          created.stop();
          return;
        }
        await room.localParticipant.publishTrack(created, {
          source: Track.Source.Microphone,
        });
      } else {
        await room.localParticipant.setMicrophoneEnabled(enabled);
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
  mix(): void {
    for (const { identity, track } of this.audioTracks.values()) {
      const person = this.listening.get(identity);
      track.setVolume(
        this.deafened || person?.muted
          ? 0
          : this.outputVolume * (person?.volume ?? 1),
      );
    }
  }
  popover(x: number, y: number, above = false): HTMLElement {
    this.closeMenu();
    const menu = el("div", "voice-menu" + (above ? " above" : "")),
      abort = new AbortController();
    menu.setAttribute("role", "dialog");
    document.body.append(menu);
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
      const level = this.muted ? 0 : this.gain.level();
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
        "rv.deafened": String(value),
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
    const noiseRow = actionRow(nt("voice_settings.noise"));
    const noise = el("input");
    noise.type = "checkbox";
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
    page.append(group);
  }
  show(): void {
    if (!this.current) return;
    this.heading.textContent =
      this.app.model.rooms.get(this.current)?.name || t("voice");
    this.app.roomPane.append(this.page);
    this.app.roomPane.classList.add("voice-open");
    this.app.threadPane.hidden = true;
  }
  hide(): void {
    this.app.roomPane.classList.remove("voice-open");
  }
  async leave(notify = true): Promise<void> {
    this.lifecycle++;
    this.closeMenu();
    this.audioTracks.clear();
    this.listening.clear();
    this.listeningAccount = "";
    clearTimeout(this.peerLeaveTimer);
    this.peerLeaveTimer = undefined;
    this.syncControls = () => {};
    this.microphoneWork = Promise.resolve();
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
    this.audioContext = undefined;
    const api = new Api();
    api.token = this.app.api.token;
    const previous = this.leaving;
    const voiceRequests = this.voiceRequests;
    this.room = undefined;
    this.current = undefined;
    this.bar.remove();
    this.stage.replaceChildren();
    this.controls.replaceChildren();
    this.tracks.clear();
    this.muted = false;
    this.camera = false;
    this.sharing = false;
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
      if (this.app.model.rooms.get(ring.room_id)?.encrypted) continue;
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
            const grant = await this.app.api.request<VoiceGrant>(
              "/api/v1/voice/rings/" + segment(ring.id) + "/accept",
              "POST",
              {
                data_epoch: this.app.account.epoch,
                membership_version: member,
                e2ee: false,
              },
            );
            node.close();
            if (
              lifecycle !== this.lifecycle ||
              account !== this.app.account?.key
            )
              return;
            this.cancelled = false;
            await this.connect(grant, lifecycle, account);
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
