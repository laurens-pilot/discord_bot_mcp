import { Worker } from "node:worker_threads";
import lockfile from "proper-lockfile";

export function startGateway(
  token,
  cache,
  {
    createWorker = () =>
      new Worker(new URL("./gateway-worker.mjs", import.meta.url), {
        workerData: { token },
      }),
    interval = 5000,
    retryDelay = 30000,
  } = {},
) {
  let stopped = false;
  let worker;
  let release;
  let retryAt = 0;
  let state = { status: "connecting" };
  let pending = Promise.resolve();
  const save = () => {
    if (release && !stopped) cache.setState(state);
  };
  const fail = () => {
    state = {
      status: "error",
      error:
        "The Gateway listener failed; retrying shortly. Capture may have gaps.",
    };
    try {
      save();
    } catch {
      return;
    }
  };
  const launch = () => {
    retryAt = Date.now() + retryDelay;
    state = { status: "connecting" };
    save();
    worker = createWorker();
    worker.on("message", (message) => {
      if (stopped || !release) return;
      try {
        if (message.event) cache.capture(message.event);
        else {
          state = {
            status: message.status,
            ...(message.error ? { error: message.error } : {}),
          };
          save();
        }
      } catch {
        fail();
        void worker.terminate();
      }
    });
    worker.on("error", fail);
    worker.on("exit", () => {
      worker = undefined;
      retryAt = Date.now() + retryDelay;
      if (!stopped) fail();
    });
  };
  const tick = async () => {
    if (stopped) return;
    if (release) {
      save();
      cache.prune();
      if (!worker && Date.now() >= retryAt) launch();
      return;
    }
    try {
      const unlock = await lockfile.lock(cache.file, {
        stale: 15000,
        update: 5000,
        retries: 0,
        onCompromised: () => {
          release = undefined;
          stopped = true;
          clearInterval(timer);
          void worker?.terminate();
        },
      });
      if (stopped) {
        await unlock();
        return;
      }
      release = unlock;
      launch();
    } catch (error) {
      if (error.code !== "ELOCKED") fail();
    }
  };
  const schedule = () => {
    pending = pending.then(tick).catch(fail);
  };
  const timer = setInterval(schedule, interval);
  schedule();
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      await pending;
      await worker?.terminate();
      if (release) {
        try {
          cache.setState({ status: "stopped" });
        } finally {
          await release().catch(() => {});
          release = undefined;
        }
      }
    },
  };
}
