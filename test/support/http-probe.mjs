// A referenced deadline keeps Node alive while a pending HTTP probe has no other
// referenced handles. AbortSignal.timeout() alone does not provide that guarantee.
export async function httpReady(url, timeoutMs = 3000, request = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url + '/ready', { signal: controller.signal });
    await response.arrayBuffer();
    return response.status === 200;
  } finally {
    clearTimeout(timer);
  }
}
