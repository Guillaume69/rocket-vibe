import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import type { App } from "../app";
import type { Room, User } from "../protocol";
import { iconSource } from "../icons";
import { toast, initials } from "../dom";
import { segment } from "../api";

export function Symbol({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  const source = iconSource(name);
  return source.mask ? (
    <span
      className={"symbolic-icon " + className}
      style={{ maskImage: "url(" + JSON.stringify(source.mask) + ")" }}
      aria-hidden="true"
    />
  ) : (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={source.path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type ActionProps = Omit<ComponentPropsWithRef<"button">, "onClick"> & {
  action: (node: HTMLButtonElement) => void | Promise<void>;
};
export function ActionButton({
  action,
  disabled,
  className = "flat",
  children,
  ...props
}: ActionProps) {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  return (
    <button
      {...props}
      type={props.type || "button"}
      className={className}
      disabled={disabled || pending}
      onClick={(event) => {
        if (disabled || running.current) return;
        running.current = true;
        const node = event.currentTarget;
        setPending(true);
        void Promise.resolve()
          .then(() => action(node))
          .catch(toast)
          .finally(() => {
            running.current = false;
            setPending(false);
          });
      }}
    >
      {children}
    </button>
  );
}

export function IconButton({
  name,
  label,
  className = "flat",
  ...props
}: ActionProps & { name: string; label: string }) {
  return (
    <ActionButton
      {...props}
      className={className}
      aria-label={label}
      title={props.title ?? label}
    >
      <Symbol name={name} />
    </ActionButton>
  );
}

export function Brand({ size = "header" }: { size?: string }) {
  return <span className={"brand brand-" + size}>rocket-vibe</span>;
}

function gradient(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++)
    hash = (Math.imul(hash, 31) + name.charCodeAt(index)) | 0;
  return Math.abs(hash) % 7;
}

export function Avatar({
  app,
  name,
  user,
  room,
  size = "message",
  glyph,
  icon,
  children,
}: {
  app: App;
  name: string;
  user?: User | null;
  room?: Room | null;
  size?: string;
  glyph?: string;
  /** A symbolic icon in the glyph's place (a locked room), never an emoji. */
  icon?: string;
  children?: ReactNode;
}) {
  const [image, setImage] = useState<{ scope: string; url: string }>();
  const work = user ? app.profiles.get(user.id) : undefined;
  const generation = app.generation,
    account = app.account?.key,
    membership = room
      ? app.model.rooms.get(room.id)?.read_state?.membership_version
      : undefined,
    roomImage =
      room?.kind !== "direct" &&
      !!room &&
      !!app.info?.capabilities.room_avatars &&
      // GTK's list/header projection retains the lock; room information shows
      // its own profile-size image independently of encryption.
      (!room.encrypted || size === "profile"),
    scope = JSON.stringify([
      account,
      generation,
      user?.id,
      room?.id,
      room?.revision,
      membership,
      roomImage,
    ]);
  useEffect(() => {
    let active = true;
    setImage(undefined);
    const valid = () =>
      active &&
      generation === app.generation &&
      account === app.account?.key &&
      (!room ||
        (app.model.rooms.get(room.id)?.revision === room.revision &&
          app.model.rooms.get(room.id)?.read_state?.membership_version ===
            membership));
    if (roomImage && room) {
      void app
        .asset(
          "/api/v1/rooms/" +
            segment(room.id) +
            "/avatar?revision=" +
            segment(room.revision),
          undefined,
          room.id,
        )
        .then((url) => {
          if (valid()) setImage({ scope, url });
        })
        .catch(() => {});
      // App.asset owns this shared URL and revokes it on membership/account
      // withdrawal. Revoking it here would break the other room tiles.
      return () => {
        active = false;
      };
    }
    if (!user || (!work && app.connection !== "online")) return;
    const request =
      work ||
      app.api.request<import("../protocol").UserProfile>(
        "/api/v1/users/" + segment(user.id),
      );
    if (!work) {
      app.profiles.set(user.id, request);
      request.catch(() => {
        if (app.profiles.get(user.id) === request) app.profiles.delete(user.id);
      });
    }
    void request
      .then(async (profile) => {
        if (!profile.avatar_file_id) return;
        const url = await app.asset(
          "/api/v1/avatars/" + segment(profile.avatar_file_id),
        );
        if (valid()) setImage({ scope, url });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [
    app,
    user?.id,
    work,
    generation,
    account,
    app.connection,
    room?.id,
    room?.revision,
    membership,
    roomImage,
    scope,
  ]);
  const photo = image?.scope === scope ? image.url : undefined;
  return (
    <div
      className={
        "tile tile-" +
        size +
        // A locked room's tile is neutral, as on the desktop.
        (icon ? " tile-neutral" : " tile-g" + gradient(name))
      }
      data-avatar-user={user?.id}
      data-avatar-room={room?.id}
      data-react-avatar="true"
      title={user?.display_name || user?.username}
    >
      {photo ? (
        <img
          className="avatar-image"
          src={photo}
          alt={user?.display_name || user?.username || name}
        />
      ) : icon ? (
        <Symbol name={icon} className="tile-icon" />
      ) : (
        (glyph ?? initials(name))
      )}
      {children}
    </div>
  );
}
