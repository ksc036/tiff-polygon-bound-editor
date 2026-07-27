export function runSharpWithSignal(pipeline, operation, signal) {
  if (!signal) return Promise.resolve().then(operation);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      pipeline.destroy();
      settle(reject, renderAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending;
    try {
      pending = operation();
    } catch (error) {
      settle(reject, error);
      return;
    }

    Promise.resolve(pending).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

function renderAbortError() {
  const error = new Error("Image rendering aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}
