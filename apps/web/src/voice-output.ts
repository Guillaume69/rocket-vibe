type SinkContext = Pick<AudioContext, "state"> & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

// LiveKit's Web Audio device switch does not await setSinkId. Observe that
// native promise on this call's context while preserving it for other callers.
export function observeAudioOutput(
  context: SinkContext,
  valid: () => boolean,
  failed: (error: unknown) => void,
): void {
  const setSinkId = context.setSinkId;
  if (!setSinkId) return;
  context.setSinkId = (deviceId) => {
    if (!valid() || context.state === "closed") return Promise.resolve();
    const pending = setSinkId.call(context, deviceId);
    void pending.catch((error: unknown) => {
      if (valid() && context.state !== "closed") failed(error);
    });
    return pending;
  };
}
