import { reactVoice } from "../social";
import type { Voice } from "../voice";
import { nt } from "../native-i18n";
import { t, language } from "../i18n";
import { ActionButton, IconButton } from "./controls";
import { renderView } from "./portals";
export interface VoiceBindings {
  canPublish: boolean;
  mic(): Promise<void>;
  deafen(): Promise<void>;
  camera(): Promise<void>;
  screen(): Promise<void>;
  menu(anchor: HTMLElement): void | Promise<void>;
  enableAudio(): Promise<void>;
}
function Controls({
  voice,
  bindings,
  sidebar = false,
}: {
  voice: Voice;
  bindings: VoiceBindings;
  sidebar?: boolean;
}) {
  const base = sidebar ? "flat" : "voice-control";
  const muted = voice.muted || !bindings.canPublish;
  return (
    <>
      <IconButton
        name={muted ? "mic-muted" : "mic"}
        label="Microphone"
        title={nt(
          !bindings.canPublish
            ? "voice_session.listening"
            : voice.muted
              ? "voice_session.unmute"
              : "voice_session.mute",
        )}
        className={base + (muted ? " voice-off" : "")}
        disabled={!bindings.canPublish}
        aria-pressed={muted}
        action={bindings.mic}
      />
      <IconButton
        name="audio-menu"
        label={nt("voice_menu.open")}
        className="flat voice-menu-button"
        action={bindings.menu}
      />
      <IconButton
        name={voice.deafened ? "volume-muted" : "headphones"}
        label={language === "fr" ? "Écoute" : "Listen"}
        title={nt(
          voice.deafened ? "voice_session.undeafen" : "voice_session.deafen",
        )}
        className={base + (voice.deafened ? " voice-off" : "")}
        aria-pressed={voice.deafened}
        action={bindings.deafen}
      />
      {!sidebar && (
        <>
          <IconButton
            name="camera"
            label={language === "fr" ? "Caméra" : "Camera"}
            title={nt(
              voice.camera
                ? "voice_session.camera_off"
                : "voice_session.camera_on",
            )}
            className={base + (voice.camera ? " voice-on" : "")}
            aria-pressed={voice.camera}
            disabled={!bindings.canPublish}
            action={bindings.camera}
          />
          <IconButton
            name="screen"
            label={nt("voice_session.share_screen")}
            title={nt(
              voice.sharing
                ? "voice_session.stop_screen"
                : "voice_session.share_screen",
            )}
            className={base + (voice.sharing ? " voice-on" : "")}
            aria-pressed={voice.sharing}
            disabled={!bindings.canPublish || voice.sharingBusy}
            action={bindings.screen}
          />
        </>
      )}
      {voice.app.info?.capabilities.voice_reactions &&
        !voice.app.model.rooms.get(voice.current ?? "")?.encrypted && (
          <IconButton
            name="smile"
            label={language === "fr" ? "Réagir" : "React"}
            className={base}
            action={(node) => reactVoice(voice.app, node)}
          />
        )}
      <IconButton
        name="leave-call"
        label={sidebar ? t("close") : nt("voice_session.leave")}
        title={nt("voice_session.leave")}
        className={base + " voice-leave"}
        action={() => voice.leave(true, true)}
      />
      {!sidebar && (
        <ActionButton
          hidden={voice.room?.canPlaybackAudio}
          action={bindings.enableAudio}
        >
          {language === "fr" ? "Activer le son" : "Enable audio"}
        </ActionButton>
      )}
    </>
  );
}
export function paintVoiceControls(
  voice: Voice,
  bindings: VoiceBindings,
): void {
  renderView(voice.controls, <Controls voice={voice} bindings={bindings} />);
  renderView(
    voice.bar,
    <>
      <ActionButton className="flat voice-bar-info" action={() => voice.show()}>
        <span
          className={
            "voice-bar-status " +
            (voice.connectionStatus === "voice_session.connected"
              ? "connected"
              : "pending")
          }
        >
          {nt(voice.connectionStatus)}
        </span>
        <span className="voice-bar-room">
          {voice.app.model.rooms.get(voice.current || "")?.name || t("voice")}
        </span>
      </ActionButton>
      <div className="voice-bar-controls">
        <Controls voice={voice} bindings={bindings} sidebar />
      </div>
    </>,
  );
}
export function ringingBar(voice: Voice, name: string): void {
  renderView(
    voice.bar,
    <>
      <ActionButton className="flat voice-bar-info" action={() => voice.show()}>
        <span className="voice-bar-status pending">
          {nt("voice_session.ringing")}
        </span>
        <span className="voice-bar-room">{name}</span>
      </ActionButton>
      <IconButton
        name="leave-call"
        label={t("close")}
        title={nt("voice_session.leave")}
        className="flat voice-leave"
        action={() => voice.leave(true, true)}
      />
    </>,
  );
}
