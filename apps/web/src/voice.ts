import type { App } from "./app";
import type { VoiceGrant, VoiceRing, LiveState } from "./protocol";
import { segment } from "./api";
import { el, button, dialog, tile, toast } from "./dom";
import { iconButton } from "./icons";
import { sound } from "./sounds";
import { t, language } from "./i18n";
export class Voice {
  current?: string;
  room?: import("livekit-client").Room;
  busy = false;
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
  dialog?: HTMLDialogElement;
  constructor(public app: App) {
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
    if (this.current === id && this.room) {
      this.show();
      return;
    }
    await this.leave();
    this.busy = true;
    this.cancelled = false;
    const account = this.app.account.key;
    try {
      const room = this.app.model.rooms.get(id);
      const member = room?.read_state?.membership_version;
      if (!member) return;
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
      if (account !== this.app.account?.key) return;
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
        while (grant.ring.state === "ringing" && !this.cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          grant.ring = await this.app.api.request<VoiceRing>(
            "/api/v1/voice/rings/" + segment(grant.ring.id),
          );
        }
        if (grant.ring.state !== "answered" || this.cancelled) {
          await this.leave();
          return;
        }
      }
      if (account === this.app.account?.key && !this.cancelled)
        await this.connect(grant);
    } catch (error) {
      await this.leave();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async connect(grant: VoiceGrant): Promise<void> {
    if (!this.app.account) return;
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
    const account = this.app.account?.key;
    const { Room, RoomEvent, Track } = await import("livekit-client");
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
      this.stage.remove();
    });
    await room.connect(grant.url, grant.token);
    if (account !== this.app.account?.key || this.cancelled) {
      await room.disconnect();
      return;
    }
    this.card(
      room.localParticipant.identity,
      this.app.account?.session.user.display_name || "",
    );
    for (const participant of room.remoteParticipants.values())
      this.card(participant.identity, participant.name || participant.identity);
    if (grant.can_publish)
      await room.localParticipant.setMicrophoneEnabled(true);
    sound("join");
    const mic = iconButton(
      "mic",
      language === "fr" ? "Microphone" : "Microphone",
      async () => {
        this.muted = !this.muted;
        sound(this.muted ? "mute" : "unmute");
        await room.localParticipant.setMicrophoneEnabled(!this.muted);
        mic.classList.toggle("muted", this.muted);
      },
    );
    mic.disabled = !grant.can_publish;
    const camera = iconButton(
      "video",
      language === "fr" ? "Caméra" : "Camera",
      async () => {
        this.camera = !this.camera;
        await room.localParticipant.setCameraEnabled(this.camera);
      },
    );
    camera.disabled = !grant.can_publish;
    const screen = button(
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
    const deaf = button(language === "fr" ? "Écoute" : "Listen", async () => {
      this.deafened = !this.deafened;
      for (const media of this.stage.querySelectorAll("audio"))
        media.muted = this.deafened;
      await room.localParticipant.setAttributes({
        "rv.deafened": String(this.deafened),
      });
      deaf.classList.toggle("muted", this.deafened);
    });
    this.bar.replaceChildren(
      button(this.app.model.rooms.get(grant.room_id)?.name || t("voice"), () =>
        this.show(),
      ),
      mic,
      deaf,
      camera,
      iconButton("close", t("close"), () => this.leave()),
    );
    this.stage.prepend(el("div", "voice-controls"));
    this.stage.querySelector(".voice-controls")!.append(
      screen,
      button("Audio", () => room.startAudio()),
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
    const show = async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      for (const [kind, label] of [
        ["audioinput", language === "fr" ? "Microphone" : "Microphone"],
        ["audiooutput", language === "fr" ? "Sortie audio" : "Audio output"],
        ["videoinput", language === "fr" ? "Caméra" : "Camera"],
      ] as const) {
        const select = el("select", "pill-entry"),
          title = el("label", "field");
        title.append(el("span", "pill-caption", label), select);
        for (const device of devices.filter((device) => device.kind === kind)) {
          const option = el("option", "", device.label || label);
          option.value = device.deviceId;
          select.append(option);
        }
        select.value = localStorage.getItem("rv-" + kind) || "default";
        select.addEventListener("change", () => {
          localStorage.setItem("rv-" + kind, select.value);
          void this.room?.switchActiveDevice(kind, select.value).catch(toast);
        });
        page.append(title);
      }
      const label = el("label", "toggle"),
        noise = el("input");
      noise.type = "checkbox";
      noise.checked = localStorage.getItem("rv-voice-noise") !== "false";
      noise.addEventListener("change", () =>
        localStorage.setItem("rv-voice-noise", String(noise.checked)),
      );
      label.append(
        noise,
        el(
          "span",
          "",
          language === "fr"
            ? "Réduction du bruit au prochain appel"
            : "Noise suppression on the next call",
        ),
      );
      page.append(label);
    };
    page.append(
      button(
        language === "fr"
          ? "Autoriser le micro et la caméra"
          : "Allow microphone and camera",
        async () => {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true,
          });
          stream.getTracks().forEach((track) => track.stop());
          page.querySelectorAll("label").forEach((node) => node.remove());
          await show();
        },
      ),
    );
    await show();
  }
  show(): void {
    if (!this.current) return;
    this.dialog?.close();
    const [node, body] = dialog(
      this.app.model.rooms.get(this.current)?.name || t("voice"),
    );
    this.dialog = node;
    node.classList.add("voice-dialog");
    body.append(this.stage);
  }
  async leave(notify = true): Promise<void> {
    this.cancelled = true;
    this.loop?.pause();
    this.loop = undefined;
    this.cards.clear();
    this.dialog?.close();
    this.dialog = undefined;
    const active = this.current || this.room;
    const room = this.room;
    this.room = undefined;
    this.current = undefined;
    this.bar.remove();
    this.stage.remove();
    this.stage.replaceChildren();
    this.tracks.clear();
    this.muted = false;
    this.camera = false;
    this.sharing = false;
    this.deafened = false;
    if (room) {
      await room.disconnect(true);
      sound("leave");
    }
    if (active && notify)
      try {
        await this.app.api.request("/api/v1/voice/leave", "POST", null);
      } catch {}
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
            await this.leave();
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
            this.cancelled = false;
            await this.connect(grant);
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
