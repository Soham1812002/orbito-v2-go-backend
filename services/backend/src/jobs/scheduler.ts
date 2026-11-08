export function startJobs(deps: {
  dispatch: () => Promise<void>;
  retain: () => Promise<void>;
  error: (err: unknown) => void;
  intervalMs?: number;
}) {
  let stopped = false;
  let running: Promise<void> | undefined;
  let ticks = 0;
  const timer = setInterval(() => {
    if (running || stopped) {
      return;
    }

    running = (async () => {
      await deps.dispatch();
      if (++ticks % 60 === 0) {
        await deps.retain();
      }
    })()
      .catch((err) => deps.error(err))
      .finally(() => {
        running = undefined;
      });
  }, deps.intervalMs ?? 1000);

  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
