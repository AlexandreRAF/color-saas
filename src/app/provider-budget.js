// Conservative admission before every paid HTTP attempt. No refund is assumed
// for failed requests, missing usage, or retries. Model prices are supplied by
// the researcher's reviewed price table; update that table only in its own work.
export function budgetedFetch(request, { capMicroUsd, prices, searchMicroUsd = 1000 }) {
  let allocated = 0;
  const reserve = amount => {
    if (!Number.isFinite(amount) || amount < 0 || allocated + amount > capMicroUsd)
      throw Object.assign(new Error('Provider spending cap reached'), { code: 'AI_BUDGET_LIMIT' });
    allocated += amount;
  };
  return async (url, init = {}) => {
    const destination = new URL(url);
    let body = init.body;
    if (['api.openai.com', 'openrouter.ai'].includes(destination.hostname)) {
      const payload = JSON.parse(body);
      const provider = destination.hostname === 'api.openai.com' ? 'openai' : 'openrouter';
      const tier = payload.service_tier === 'priority' ? 'fast' : payload.service_tier || 'default';
      const price = prices[`${provider}:${payload.model}:${tier}`];
      if (!price) throw Object.assign(new Error('Unpriced model'), { code: 'AI_BUDGET_LIMIT' });
      const chat = destination.pathname.includes('chat/completions');
      const field = chat ? 'max_tokens' : 'max_output_tokens';
      payload[field] = Math.min(8192, payload[field] || 4096);
      body = JSON.stringify(payload);
      const tokens = Buffer.byteLength(body) + 1024;
      reserve(Math.ceil(tokens * Math.max(price.input, price.cacheWrite || 0) + payload[field] * price.output));
    } else if (destination.hostname === 'google.serper.dev') reserve(searchMicroUsd);
    else if (init.headers?.Authorization || init.headers?.authorization || init.headers?.['x-goog-api-key'])
      throw Object.assign(new Error('Provider destination not allowed'), { code: 'PROVIDER_BLOCKED' });
    return request(url, { ...init, body, redirect: 'error' });
  };
}
