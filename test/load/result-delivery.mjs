// Keep a generator alive until the parent accepts its full histogram report.
// process.send() queues an IPC write; worker exit alone is not delivery proof.
export function deliverResult(channel, report, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      channel.off('message', received);
      channel.off('disconnect', disconnected);
      error ? reject(error) : resolve();
    };
    const failure = () => Object.assign(new Error('Capacity report was not acknowledged.'), { code: 'TIMEOUT' });
    const received = message => { if (message?.action === 'result-received') finish(); };
    const disconnected = () => finish(failure());
    const timer = setTimeout(disconnected, timeoutMs);
    channel.on('message', received);
    channel.once('disconnect', disconnected);
    try {
      if (!channel.connected) return disconnected();
      channel.send(report, error => { if (error) finish(failure()); });
    } catch { disconnected(); }
  });
}
