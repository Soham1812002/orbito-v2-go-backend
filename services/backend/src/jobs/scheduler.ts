export function startJobs(deps: {
  dispatch: () => Promise<void>;
  retain: () => Promise<void>;
  error: (err: unknown) => void;
  intervalMs?: number;
  retentionIntervalMs?: number;
}) {
  let stopped = false;
  const running = new Set<Promise<void>>();

  function schedule(work: () => Promise<void>, interval: number) {
    let active = false;

    return setInterval(() => {
      if (stopped || active) {
        return;
      }

      active = true;
      const task = Promise.resolve()
        .then(work)
        .catch(deps.error)
        .finally(() => {
          active = false;
          running.delete(task);
        });

      running.add(task);
    }, interval);
  }

  const dispatch = schedule(deps.dispatch, deps.intervalMs ?? 1000);
  const retention = schedule(deps.retain, deps.retentionIntervalMs ?? 60000);

  return async () => {
    stopped = true;
    clearInterval(dispatch);
    clearInterval(retention);
    await Promise.all(running);
  };
}
