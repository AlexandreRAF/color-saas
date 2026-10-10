// Count each started logical search once, regardless of retries or subscribers.
async function trackSearch(engine, operation, { signal, onEngineRequest, onEngineComplete, searchBudget, searchPhase }) {
  signal?.throwIfAborted();
  const lease = searchBudget?.reserve(searchPhase);
  onEngineRequest?.(engine);

  let completed = false;
  const complete = failed => {
    if (completed) return;

    completed = true;
    signal?.removeEventListener('abort', abort);
    onEngineComplete?.(engine, { failed });
  };

  // Record cancellation immediately, before a shared search releases its callers.
  const abort = () => complete(true);

  signal?.addEventListener('abort', abort, { once: true });

  try {
    signal?.throwIfAborted();

    const result = await operation(lease);

    // Partial URL-resolution warnings still produced usable search results.
    complete(Boolean(result.error && !result.results?.length));

    return result;
  } catch (error) {
    complete(true);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { trackSearch };
