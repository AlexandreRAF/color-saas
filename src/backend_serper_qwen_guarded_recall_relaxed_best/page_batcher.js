'use strict';

const { requestModel, matchesSchema } = require('./model_router');
const { requestWorkload } = require('./request_envelope');
const { createLimiter } = require('./runtime');
const { DEFAULT_LIMITS } = require('./model_scheduler');
const { MODEL: QWEN_MODEL } = require('./qwen_page');

const qwenLimits = DEFAULT_LIMITS[`openrouter:${QWEN_MODEL}`];
const extractionConcurrency = Math.max(1, Math.min(qwenLimits.concurrency - (qwenLimits.reserveConcurrency || 0),
  Number(process.env.MODEL_CONCURRENCY || 16) - Number(process.env.MODEL_COMPLETION_SLOTS || 4)));

// Coalesce concurrent small extracts. Text and evidence IDs remain page-local;
// usage belongs to the first item so a shared HTTP request is counted once.
class PageBatcher {
  constructor({ size = 3, maxChars = 50000, concurrency = extractionConcurrency } = {}) {
    if (![size, maxChars, concurrency].every(value => Number.isInteger(value) && value > 0)) {
      throw new Error('Page batch limits must be positive integers');
    }
    Object.assign(this, { size, maxChars, concurrency });
    this.pending = [];
    this.limit = createLimiter(concurrency);
  }

  add(url, init, options) {
    return new Promise((resolve, reject) => {
      this.pending.push({ url, init, options, body: JSON.parse(init.body), resolve, reject });
      if (this.pending.length >= this.size) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), 20);
    });
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const items = [];
    let units = 0;
    while (this.pending.length && items.length < this.size) {
      const next = this.pending[0];
      const count = next.body.input.match(/^\d+\| /gm)?.length || 0;
      if (items.length && (requestWorkload(this.envelope([...items, next])).totalChars > this.maxChars
        || units + count > 140 || next.options.signal !== items[0].options.signal)) break;
      items.push(this.pending.shift());
      units += count;
    }
    if (items.length) this.limit(() => this.run(items)).catch(error => items.forEach(item => item.reject(error)));
    if (this.pending.length) this.timer = setTimeout(() => this.flush(), 0);
  }

  envelope(items) {
    const first = items[0];
    const properties = Object.fromEntries(items.map((item, index) => [`P${index + 1}`, item.body.text.format.schema]));
    return { ...first.body,
      instructions: first.body.instructions + '\nBATCH: Inspect every supplied page independently. Return one candidates object under EACH P key. Evidence IDs, names and vehicle context belong ONLY to that page. Never transfer a name or evidence ID between pages. An empty page result does not cancel the others.',
      input: JSON.stringify(items.map((item, index) => ({ id: `P${index + 1}`, page: item.body.input }))),
      text: { ...first.body.text, format: { ...first.body.text.format,
        schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } },
    };
  }

  async run(items, recovery = {}) {
    items = items.filter(item => {
      if (!item.options.signal?.aborted) return true;
      item.reject(item.options.signal.reason);
      return false;
    });
    if (!items.length) return;
    const first = items[0];
    if (items.length === 1) {
      first.resolve(await requestModel(first.url, first.init, { ...first.options, routing: { ...first.options.routing, ...recovery } }));
      return;
    }

    const body = this.envelope(items);
    let result;
    try {
      result = await requestModel(first.url, { ...first.init, body: JSON.stringify(body) }, {
        ...first.options, routing: { ...first.options.routing, ...recovery },
        splitOnTimeout: !recovery.startAfter, validateOutput: undefined,
      });
    } catch (error) {
      if (error.code !== 'MODEL_ROUTE_TIMEOUT' || recovery.startAfter) throw error;
      const pending = items.filter((item, index) => {
        const value = error.partialOutput?.[`P${index + 1}`];
        try {
          if (!matchesSchema(value, item.body.text.format.schema)) return true;
          item.options.validateOutput?.(value, error.route);
          item.resolve({ status: 'completed', _requestModel: error.route.model,
            _requestProvider: error.route.provider, _requestServiceTier: error.route.serviceTier,
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
          return false;
        } catch { return true; }
      });
      const middle = Math.ceil(pending.length / 2);
      await Promise.all([pending.slice(0, middle), pending.slice(middle)].filter(group => group.length)
        .map(group => this.run(group, { startAfter: error.routeId })
          .catch(failure => group.forEach(item => item.reject(failure)))));
      return;
    }
    const parsed = JSON.parse(result.output.findLast(item => item.type === 'message').content
      .find(item => item.type === 'output_text').text);

    await Promise.all(items.map(async (item, index) => {
      try {
        const value = parsed[`P${index + 1}`];
        try {
          item.options.validateOutput?.(value, { model: result._requestModel });
        } catch {
          // Repair only the affected page; correct siblings retain their result.
          item.resolve(await requestModel(item.url, item.init, item.options));
          return;
        }
        item.resolve({ status: 'completed', _requestModel: result._requestModel,
          _requestProvider: result._requestProvider, _requestServiceTier: result._requestServiceTier,
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
      } catch (error) { item.reject(error); }
    }));
  }
}

module.exports = { PageBatcher };
