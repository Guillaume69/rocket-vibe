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
  return (
    <>
      <IconButton
        name={voice.muted ? "mic-muted" : "mic"}
        label="Microphone"
        title={nt(
          !bindings.canPublish
            ? "voice_session.listening"
            : voice.muted
              ? "voice_session.unmute"
              : "voice_session.mute",
        )}
        className={base + (voice.muted ? " voice-off" : "")}
        disabled={!bindings.canPublish}
        aria-pressed={voice.muted}
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
      <IconButton
        name="leave-call"
        label={sidebar ? t("close") : nt("voice_session.leave")}
        title={nt("voice_session.leave")}
        className={base + " voice-leave"}
        action={() => voice.leave()}
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
        <span className="voice-bar-status connected">
          {nt("voice_session.connected")}
        </span>
        <span className="voice-bar-room">
          {voice.app.model.rooms.get(voice.current || "")?.name || t("voice")}
        </span>
      </ActionButton>
      <Controls voice={voice} bindings={bindings} sidebar />
    </>,
  );
}
export function ringingBar(voice: Voice, name: string): void {
  renderView(
    voice.bar,
    <>
      <span>{name}</span>
      <span className="dim">{language === "fr" ? "Appel…" : "Calling…"}</span>
      <IconButton
        name="close"
        label={t("close")}
        action={() => voice.leave()}
      />
    </>,
  );
}
