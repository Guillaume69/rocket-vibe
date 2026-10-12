import { accountCodeLogin } from "../account-code";
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import type { App } from "../app";
import type { AuthenticationStep, Discovery, Session } from "../protocol";
import { t, language, setLanguage } from "../i18n";
import { operation, secret } from "../api";
import { read, write } from "../store";
import { nt } from "../native-i18n";
import { toast } from "../dom";
import { STARS } from "../design.generated";
import { ActionButton, Brand, Symbol } from "./controls";

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
  if (app.loginChallenge) return <FactorScreen app={app} />;
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
        const step = await accountCodeLogin(
          app.api,
          info,
          username,
          password,
          token.trim(),
          mode === "recovery",
        );
        if (!active.current) return;
        setPassword("");
        setToken("");
        if (step.kind === "challenge") app.challenge(step.challenge, info);
        else await app.accept(step.session, info);
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
          label={mode === "login" ? t("username") : t("handle")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
          autoFocus
          disabled={pending}
        />
        <Field
          label={mode === "recovery" ? nt("login.new_password") : t("password")}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          disabled={pending}
        />
        <div className="login-modes">
          <label>
            <input
              type="checkbox"
              checked={mode === "signup"}
              disabled={pending}
              onChange={(event) => {
                setMode(event.target.checked ? "signup" : "login");
                setToken("");
                setError("");
              }}
            />
            {t("signup")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={mode === "recovery"}
              disabled={pending}
              onChange={(event) => {
                setMode(event.target.checked ? "recovery" : "login");
                setToken("");
                setError("");
              }}
            />
            {t("recovery")}
          </label>
        </div>
        {mode !== "login" && (
          <div className="login-account-code">
            {
              <>
                <Field
                  label={
                    mode === "signup" ? t("invitation") : t("recoveryCode")
                  }
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  type="password"
                  disabled={pending}
                />
                <p className="login-help">
                  {nt(
                    mode === "signup"
                      ? "login.invitation_help"
                      : "login.recovery_help",
                  )}
                </p>
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
            }
          </div>
        )}
        <div className="login-error" role="alert" hidden={!error}>
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

/** GTK's verification step stays in the login column, with no detached modal. */
function FactorScreen({ app }: { app: App }) {
  const state = useRef(app.loginChallenge!).current;
  const [method, setMethod] = useState(state.challenge.methods[0]);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const running = useRef(false);
  const current = () => app.loginChallenge === state;
  const submit = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError("");
    try {
      const key = "factor:" + state.challenge.challenge_id;
      let intent = await read<{ operation_id: string; next_token: string }>(
        "operations",
        key,
      );
      if (!current()) return;
      if (!intent) {
        intent = { operation_id: operation(), next_token: secret() };
        await write("operations", key, intent);
      }
      if (!current()) return;
      const session = await app.api.request<Session>(
        "/api/v1/auth/factors/verify",
        "POST",
        { ...intent, challenge_id: state.challenge.challenge_id, method, code },
        true,
      );
      if (!current()) return;
      setCode("");
      await app.accept(session, state.info);
      await write("operations", key);
    } catch (reason) {
      if (current())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      running.current = false;
      if (current()) setPending(false);
    }
  };
  return (
    <div className="login-page">
      <Sky />
      <form
        className="login-form factor-step"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ActionButton
          className="flat back-link"
          disabled={pending}
          action={() => app.login()}
        >
          <span className="chevron">‹</span>
          {t("login")}
        </ActionButton>
        <Symbol name="security" className="shield" />
        <div className="step-title">{nt("login.magic")}</div>
        <p className="step-intro">{nt("login.intro_" + method)}</p>
        {state.challenge.methods.length > 1 && (
          <select
            className="pill-entry"
            aria-label={nt("security.method")}
            value={method}
            disabled={pending}
            onChange={(event) => {
              setMethod(event.target.value as typeof method);
              setCode("");
              setError("");
            }}
          >
            {state.challenge.methods.map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </select>
        )}
        {method === "email" && (
          <ActionButton
            disabled={pending}
            action={async () => {
              await app.api.request(
                "/api/v1/auth/factors/email/start",
                "POST",
                {
                  challenge_id: state.challenge.challenge_id,
                  operation_id: operation(),
                  delivery_id: secret(),
                },
                true,
              );
              if (current()) setSent(true);
            }}
          >
            {nt(sent ? "email.resend_code" : "email.send_code")}
          </ActionButton>
        )}
        <Field
          label={nt("login.code_" + method)}
          type={method === "recovery_code" ? "password" : "text"}
          placeholder={method === "recovery_code" ? "" : "123456"}
          inputMode={method === "recovery_code" ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
          value={code}
          disabled={pending}
          onChange={(event) => setCode(event.target.value)}
          required
        />
        <div className="login-error" role="alert" hidden={!error}>
          {error}
        </div>
        <button className="cta" type="submit" disabled={pending}>
          {t("verify")}
        </button>
      </form>
    </div>
  );
}
