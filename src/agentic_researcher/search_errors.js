// Safe, stable public errors. Do not expose arbitrary provider response bodies.
function searchFailure(cause, details = cause?.details, provider = 'serper') {
  if (['serper', 'brave', 'openserp'].includes(details?.provider)) {
    return Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { details,
      blocksSearch: ['SEARCH_CREDITS_EXHAUSTED', 'SEARCH_AUTH_FAILED', 'SEARCH_CONFIG_INVALID', 'SEARCH_BLOCKED'].includes(details.code) });
  }

  const name = provider === 'openserp' ? 'OpenSERP' : provider === 'brave' ? 'Brave' : 'Serper';
  const key = provider === 'brave' ? 'BRAVE_API_KEY' : 'SERPER_API_KEY';
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = cause?.status || Number(message.match(/HTTP (\d{3})\b/)?.[1]) || undefined;
  let code = 'SEARCH_FAILED', description = `${name} search failed.`,
    action = 'Check the search configuration and provider availability.', retryable = false, blocksSearch = false;

  if (provider === 'openserp' && cause?.code === 'SEARCH_UNRESOLVED_URLS') {
    code = 'SEARCH_UNRESOLVED_URLS';
    description = 'Some OpenSERP results have no usable destination URL.';
    action = 'Unresolved links were skipped. Check Google redirect access from the backend and the OpenSERP server logs.';
    retryable = true;
  } else if (provider === 'openserp' && /OPENSERP_HOST/.test(message)) {
    code = 'SEARCH_CONFIG_INVALID';
    description = 'OpenSERP host configuration is missing or invalid.';
    action = 'Set OPENSERP_HOST to host:port or an HTTP(S) base URL.';
    blocksSearch = true;
  } else if (provider === 'openserp' && ([401, 403].includes(status) || /captcha/i.test(message))) {
    code = 'SEARCH_BLOCKED';
    description = 'An OpenSERP search engine was blocked.';
    action = 'Check the OpenSERP server logs and the affected engine access/proxy configuration.';
    blocksSearch = true;
  } else if (status === 402 || /not enough credits|insufficient[_ ]credits|credits? (?:exhausted|depleted)|payment required|insufficient_quota|QUOTA_LIMITED|USAGE_LIMIT_EXCEEDED|billing|hard.limit/i.test(`${cause?.providerCode || ''} ${message}`)) {
    code = 'SEARCH_CREDITS_EXHAUSTED';
    description = `${name} search credits are exhausted.`;
    action = `Refill ${name} credits or configure a funded ${key}.`;
    blocksSearch = true;
  } else if ([401, 403].includes(status) || /(?:SERPER|BRAVE)_API_KEY|invalid api.?key|unauthorized|SUBSCRIPTION_TOKEN/i.test(`${cause?.providerCode || ''} ${message}`)) {
    code = 'SEARCH_AUTH_FAILED';
    description = `${name} search authentication failed.`;
    action = `Check ${key} and its access permissions.`;
    blocksSearch = true;
  } else if (status === 429) {
    code = 'SEARCH_RATE_LIMITED';
    description = `${name} search is temporarily rate limited.`;
    action = 'Retry after the provider cooldown; reduce concurrent search requests if it persists.';
    retryable = true;
  } else if (status === 408 || cause?.name === 'TimeoutError' || /timed? ?out|ETIMEDOUT|deadline exceeded|deadline reached/i.test(message)) {
    code = 'SEARCH_TIMEOUT';
    description = `${name} search timed out.`;
    action = 'Retry the request when the search service is available.';
    retryable = true;
  } else if (status >= 500 || status === 425 || cause?.name === 'TypeError'
    || /ECONNRESET|EAI_AGAIN|ENETUNREACH|ENOTFOUND|ECONNREFUSED/.test(cause?.cause?.code || cause?.code || '')) {
    code = 'SEARCH_UNAVAILABLE';
    description = `${name} search failed because the service or network is unavailable.`;
    action = 'Retry shortly; check network connectivity if the problem persists.';
    retryable = true;
  } else if (cause instanceof SyntaxError) {
    code = 'SEARCH_INVALID_RESPONSE';
    description = `${name} returned an invalid search response.`;
    action = 'Retry the search; check provider availability if it persists.';
    retryable = true;
  }

  const error = new Error(`${description} ${action}`);

  error.blocksSearch = blocksSearch;
  error.details = { code, provider, stage: 'search', retryable, action,
    ...(status && { httpStatus: status }),
    ...(Number.isFinite(cause?.attempts) && { attempts: cause.attempts }),
    ...(Number.isFinite(cause?.retryAfterMs) && cause.retryAfterMs > 0 && { retryAfterMs: cause.retryAfterMs }),
  };

  return error;
}

module.exports = { searchFailure };
