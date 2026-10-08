import type { App } from "./app";
import type { VoiceGrant, VoiceRing, LiveState } from "./protocol";
import { Api, segment } from "./api";
import { el, button, dialog, tile, toast } from "./dom";
import { iconButton } from "./icons";
import { preferencesGroup, actionRow } from "./sidebar";
import { sound } from "./sounds";
import { t, language } from "./i18n";
export class Voice {
  current?: string;
  room?: import("livekit-client").Room;
  busy = false;
  lifecycle = 0;
  leaving: Promise<void> = Promise.resolve();
  cancelled = false;
  ringDialogs = new Map<string, HTMLDialogElement>();
  bar = el("div", "voice-bar");
  stage = el("div", "voice-stage");
  muted = false;
  camera = false;
  sharing = false;
  deafened = false;
  cards = new Map<string, HTMLElement>();
  loop?: HTMLAudioElement;
  tracks = new Map<string, HTMLElement>();
  page = el("section", "voice-page");
  controls = el("div", "voice-controls");
  heading = el("h2", "voice-title");
  constructor(public app: App) {
    this.page.append(this.heading, this.stage, this.controls);
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
      this.controls.replaceChildren(el("span", "dim", t("loading")));
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
    if (
      lifecycle !== this.lifecycle ||
      account !== this.app.account?.key ||
      this.cancelled
    )
      return;
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
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
    room.on(RoomEvent.ParticipantConnected, (participant) =>
      this.card(participant.identity, participant.name || participant.identity),
    );
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.cards.get(participant.identity)?.remove();
      this.cards.delete(participant.identity);
      if (
        this.app.model.rooms.get(this.current || "")?.kind === "direct" &&
        room.remoteParticipants.size === 0
      )
        void this.leave().catch(toast);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (participants) => {
      const active = new Set(
        participants.map((participant) => participant.identity),
      );
      for (const [identity, card] of this.cards)
        card.classList.toggle("voice-speaking", active.has(identity));
    });
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      const media = track.attach();
      media.setAttribute("autoplay", "");
      if (media instanceof HTMLAudioElement) {
        media.muted = this.deafened;
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
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const media of track.detach()) media.remove();
      if (track.sid) {
        this.tracks.get(track.sid)?.remove();
        this.tracks.delete(track.sid);
      }
    });
    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      const track = publication.track;
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
      if (publication.trackSid) {
        this.tracks.get(publication.trackSid)?.remove();
        this.tracks.delete(publication.trackSid);
      }
      if (publication.source === Track.Source.ScreenShare && this.sharing) {
        this.sharing = false;
        void this.app.api
          .request("/api/v1/voice/screen", "DELETE")
          .catch(() => {});
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.room = undefined;
      this.current = undefined;
      this.bar.remove();
      this.hide();
      this.page.remove();
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
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (error) {
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
    const mic = iconButton(
      "mic",
      language === "fr" ? "Microphone" : "Microphone",
      async () => {
        const next = !this.muted;
        await room.localParticipant.setMicrophoneEnabled(!next);
        this.muted = next;
        sound(this.muted ? "mute" : "unmute");
        mic.classList.toggle("muted", this.muted);
      },
    );
    mic.disabled = !grant.can_publish;
    mic.classList.toggle("muted", this.muted);
    const camera = iconButton(
      "video",
      language === "fr" ? "Caméra" : "Camera",
      async () => {
        this.camera = !this.camera;
        await room.localParticipant.setCameraEnabled(this.camera);
      },
    );
    camera.disabled = !grant.can_publish;
    const screen = iconButton(
      "screen",
      language === "fr" ? "Partager l’écran" : "Share screen",
      async () => {
        if (!this.sharing) {
          await this.app.api.request("/api/v1/voice/screen", "POST", null);
          try {
            await room.localParticipant.setScreenShareEnabled(true);
            this.sharing = true;
          } catch (error) {
            await this.app.api.request("/api/v1/voice/screen", "DELETE");
            throw error;
          }
        } else {
          await room.localParticipant.setScreenShareEnabled(false);
          await this.app.api.request("/api/v1/voice/screen", "DELETE");
          this.sharing = false;
        }
      },
    );
    screen.disabled = !grant.can_publish;
    const deaf = iconButton(
      "headphones",
      language === "fr" ? "Écoute" : "Listen",
      async () => {
        this.deafened = !this.deafened;
        for (const media of this.stage.querySelectorAll("audio"))
          media.muted = this.deafened;
        await room.localParticipant.setAttributes({
          "rv.deafened": String(this.deafened),
        });
        deaf.classList.toggle("muted", this.deafened);
      },
    );
    this.controls.replaceChildren(
      mic,
      deaf,
      camera,
      screen,
      iconButton(
        "leave-call",
        language === "fr" ? "Quitter l’appel" : "Leave call",
        () => this.leave(),
        "destructive",
      ),
    );
    const resume = button(
      language === "fr" ? "Activer le son" : "Enable audio",
      () => room.startAudio(),
    );
    const syncPlayback = () => {
      resume.hidden = room.canPlaybackAudio;
    };
    room.on(RoomEvent.AudioPlaybackStatusChanged, syncPlayback);
    syncPlayback();
    this.controls.append(
      resume,
      button(language === "fr" ? "Messages" : "Messages", () => this.hide()),
    );
    this.bar.replaceChildren(
      button(this.app.model.rooms.get(grant.room_id)?.name || t("voice"), () =>
        this.show(),
      ),
      iconButton("close", t("close"), () => this.leave()),
    );
    this.app.sidebar.insertBefore(this.bar, this.app.sidebar.lastElementChild);
    this.show();
  }
  card(identity: string, name: string): HTMLElement {
    let card = this.cards.get(identity);
    if (!card) {
      card = el("div", "voice-card");
      card.dataset.participant = identity;
      const portrait = tile(name, "profile");
      portrait.classList.add("voice-avatar");
      card.append(portrait, el("span", "voice-card-name", name));
      this.cards.set(identity, card);
      this.stage.append(card);
    }
    return card;
  }
  async settings(page: HTMLElement): Promise<void> {
    const [group, rows] = preferencesGroup(
      language === "fr" ? "Voix" : "Voice",
    );
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [kind, label] of [
      ["audioinput", language === "fr" ? "Microphone" : "Microphone"],
      ["audiooutput", language === "fr" ? "Sortie audio" : "Audio output"],
    ] as const) {
      const row = actionRow(label),
        select = el("select", "row-select");
      select.setAttribute("aria-label", label);
      const defaultOption = el(
        "option",
        "",
        language === "fr" ? "Valeur par défaut du système" : "System default",
      );
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
      language === "fr" ? "Réduction du bruit" : "Noise suppression",
    );
    const noise = el("input");
    noise.type = "checkbox";
    noise.setAttribute(
      "aria-label",
      language === "fr" ? "Réduction du bruit" : "Noise suppression",
    );
    noise.checked = localStorage.getItem("rv-voice-noise") !== "false";
    noise.addEventListener("change", () => {
      localStorage.setItem("rv-voice-noise", String(noise.checked));
      void this.room?.localParticipant
        .setMicrophoneEnabled(!this.muted, { noiseSuppression: noise.checked })
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
    this.cancelled = true;
    this.loop?.pause();
    this.loop = undefined;
    this.cards.clear();
    this.hide();
    this.page.remove();
    const active = this.current || this.room;
    const room = this.room;
    const api = new Api();
    api.token = this.app.api.token;
    const previous = this.leaving;
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
          t("join"),
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
          t("cancel"),
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
