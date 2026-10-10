import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import type { App } from "../app";
import type { AuthenticationStep, Discovery, Session } from "../protocol";
import { t, language, setLanguage } from "../i18n";
import { operation } from "../api";
import { toast } from "../dom";
import { STARS } from "../design.generated";
import { ActionButton, Brand } from "./controls";

export function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="field">
      <span className="pill-caption">{label}</span>
      <input {...props} className="pill-entry" />
    </label>
  );
}

export function Sky() {
  return (
    <div className="stars" aria-hidden="true">
      {STARS.map(([x, y, r, red, green, blue, alpha], index) => (
        <svg
          key={index}
          className="sparkle"
          viewBox="-1 -1 2 2"
          style={{
            left: x * 100 + "%",
            top: y * 100 + "%",
            width: 2 * r * 1.4,
            height: 2 * r * 1.4,
          }}
        >
          <path
            d="M0 -1 C.18 -.18 .18 -.18 1 0 C.18 .18 .18 .18 0 1 C-.18 .18 -.18 .18 -1 0 C-.18 -.18 -.18 -.18 0 -1 Z"
            fill={
              "rgba(" +
              [red * 255, green * 255, blue * 255, alpha].join(",") +
              ")"
            }
          />
        </svg>
      ))}
    </div>
  );
}

export function LoginScreen({ app }: { app: App }) {
  const [mode, setMode] = useState<"login" | "signup" | "recovery">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  const submitting = useRef(false);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const discover = () =>
    app.api.request<Discovery>(
      "/.well-known/rocketvibe",
      "GET",
      undefined,
      true,
    );
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const info = await discover();
      if (!active.current) return;
      if (!info.protocol_versions.includes(1))
        throw new Error("Unsupported protocol");
      if (mode === "login") {
        const step = await app.api.request<AuthenticationStep>(
          "/api/v1/auth/start",
          "POST",
          { username, password },
          true,
        );
        if (!active.current) return;
        setPassword("");
        if (step.kind === "challenge") app.challenge(step.challenge, info);
        else await app.accept(step.session, info);
      } else {
        const session = await app.api.request<Session>(
          mode === "signup"
            ? "/api/v1/auth/invitations/accept"
            : "/api/v1/auth/recovery",
          "POST",
          mode === "signup"
            ? { username, password, token }
            : { username, token, new_password: password },
          true,
        );
        if (!active.current) return;
        setPassword("");
        await app.accept(session, info);
      }
    } catch (reason) {
      if (active.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      if (active.current) setPending(false);
    }
  };
  return (
    <div className="login-page">
      <Sky />
      <form
        className="login-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="hero">
          <div className="unicorn-hero">🦄</div>
          <div className="rainbow">
            {["pink", "yellow", "cyan", "violet"].map((color) => (
              <i key={color} className={"rainbow-bar rainbow-" + color} />
            ))}
          </div>
          <Brand size="hero" />
          <div className="slogan">{t("slogan")}</div>
          <div className="login-origin">{location.host}</div>
        </div>
        <Field
          label={t("username")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
          autoFocus
          disabled={pending}
        />
        <Field
          label={t("password")}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          disabled={pending}
        />
        <div>
          {mode !== "login" && (
            <>
              <Field
                label={mode === "signup" ? t("invitation") : t("recoveryCode")}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={pending}
              />
              <ActionButton disabled={pending} action={() => setMode("login")}>
                {t("login")}
              </ActionButton>
              {mode === "recovery" && (
                <ActionButton
                  disabled={pending}
                  action={async () => {
                    const info = await discover();
                    if (!active.current || !info.capabilities.email_recovery)
                      return;
                    await app.api.request(
                      "/api/v1/auth/recovery/email/start",
                      "POST",
                      {
                        operation_id: operation(),
                        username,
                        instance_id: info.instance_id,
                        data_epoch: info.data_epoch,
                      },
                      true,
                    );
                    if (active.current)
                      toast(
                        language === "fr"
                          ? "Si une adresse vérifiée est disponible, le code vous sera envoyé."
                          : "If a verified address is available, a recovery code will be sent.",
                      );
                  }}
                >
                  {language === "fr"
                    ? "Recevoir un code par email"
                    : "Email me a recovery code"}
                </ActionButton>
              )}
            </>
          )}
        </div>
        <div className="login-error" role="alert">
          {error}
        </div>
        <button className="cta" type="submit" disabled={pending}>
          {t(
            mode === "signup"
              ? "signup"
              : mode === "recovery"
                ? "recovery"
                : "login",
          )}
        </button>
        <div className="login-links">
          <ActionButton disabled={pending} action={() => setMode("signup")}>
            {t("signup")}
          </ActionButton>
          <ActionButton disabled={pending} action={() => setMode("recovery")}>
            {t("recovery")}
          </ActionButton>
        </div>
        <ActionButton
          disabled={pending}
          action={() => {
            setLanguage(language === "fr" ? "en" : "fr");
            app.login();
          }}
        >
          {language === "fr" ? "English" : "Français"}
        </ActionButton>
        {app.account && (
          <ActionButton action={() => app.build()}>{t("cancel")}</ActionButton>
        )}
      </form>
    </div>
  );
}
