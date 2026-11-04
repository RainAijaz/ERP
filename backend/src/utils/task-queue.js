// Limit background/read-only work without changing task results or swallowing
// failures. Queue task factories, not already-started promises.
const createTaskQueue = (concurrency) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Task queue concurrency must be a positive integer");
  }
  let active = 0;
  const waiting = [];
  const drain = () => {
    while (active < concurrency && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    drain();
  });
};

module.exports = { createTaskQueue };
