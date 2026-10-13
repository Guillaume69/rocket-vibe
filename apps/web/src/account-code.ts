import type { AuthenticationStep, Discovery, User } from "./protocol.ts";
type Transport = {
  request<T>(
    path: string,
    method?: string,
    input?: unknown,
    anonymous?: boolean,
  ): Promise<T>;
};
export async function accountCodeLogin(
  api: Transport,
  info: Discovery,
  username: string,
  password: string,
  token: string,
  recovery = false,
): Promise<AuthenticationStep> {
  if (
    !(recovery
      ? info.capabilities.account_recovery
      : info.capabilities.account_invitations)
  )
    throw Error("unsupported_feature");
  const user = await api.request<User>(
    recovery ? "/api/v1/auth/recovery" : "/api/v1/auth/invitations/accept",
    "POST",
    recovery
      ? { username, token, new_password: password }
      : { username, password, token },
    true,
  );
  const check = async () => {
    const fresh = await api.request<Discovery>(
      "/.well-known/vibez",
      "GET",
      undefined,
      true,
    );
    if (
      fresh.instance_id !== info.instance_id ||
      fresh.data_epoch !== info.data_epoch
    )
      throw Error("server_identity_changed");
  };
  await check();
  const step = await api.request<AuthenticationStep>(
    "/api/v1/auth/start",
    "POST",
    { username, password },
    true,
  );
  await check();
  if (step.kind === "session" && step.session.user.id !== user.id)
    throw Error("server_identity_changed");
  return step;
}
