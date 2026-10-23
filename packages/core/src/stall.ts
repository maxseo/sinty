/** Arms a two-step timer. The first silence calls `onNotice` and keeps waiting. The second calls `onEscalate`. `pulse` restarts from stage 0. */
export function watchStall(seconds: number, onNotice: () => void, onEscalate: () => void): { stop: () => void; pulse: () => void } {
  if (!Number.isFinite(seconds) || seconds <= 0) return { stop: () => undefined, pulse: () => undefined };
  const ms = Math.round(seconds * 1000);
  let stage = 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    timer = setTimeout(() => {
      stage++;
      if (stage === 1) {
        onNotice();
        arm();
        return;
      }
      onEscalate();
    }, ms);
    timer.unref?.();
  };
  arm();
  return {
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    pulse() {
      if (timer) clearTimeout(timer);
      stage = 0;
      arm();
    },
  };
}
