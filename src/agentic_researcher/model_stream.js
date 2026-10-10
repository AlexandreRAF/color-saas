'use strict';

function awaitWithSignal(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

// Only complete top-level members can survive an interrupted structured stream.
// Each member still has to pass its own schema and evidence validation.
function completeMembers(text) {
  const output = {};
  const retain = end => {
    try {
      const value = JSON.parse(text.slice(0, end) + '}');
      for (const [key, member] of Object.entries(value)) {
        if (/^[RPV]\d+$/.test(key)) output[key] = member;
      }
    } catch { /* Incomplete member. */ }
  };
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { quoted = false; if (depth === 1) retain(i + 1); }
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') depth++;
    if (char === '}' || char === ']') depth--;
    if ((depth === 1 && char === ',') || (depth === 0 && char === '}')) {
      retain(i);
    }
    if (depth === 1 && (char === '}' || char === ']')) retain(i + 1);
  }
  return output;
}

// Chat completions use choices[].delta; Responses uses semantic SSE events.
// Comments, role-only deltas and provider keepalives are not model progress.
async function readModelStream(response, { chat, signal, progress, state }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', finished = false, finishReason, refusal, terminal;
  state.text = '';
  const consume = frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { finished = true; return; }
    const event = JSON.parse(data);
    if (event.usage) state.usage = event.usage;
    if (event.response?.usage) state.usage = event.response.usage;
    if (event.error || event.type === 'error' || event.type === 'response.failed') {
      const error = event.error || event.response?.error || event;
      throw Object.assign(new Error(error.message || 'Model stream failed'), { status: Number(error.code) || 502 });
    }
    const choice = event.choices?.find(item => item.index === 0 || item.index === undefined);
    const text = chat ? choice?.delta?.content : event.type === 'response.output_text.delta' ? event.delta : '';
    if (typeof text === 'string' && text.length) {
      state.text += text;
      if (text.trim()) progress();
    }
    if (chat) {
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (choice?.delta?.refusal) refusal = choice.delta.refusal;
    } else if (['response.completed', 'response.incomplete'].includes(event.type)) {
      terminal = event.response;
      finished = true;
    }
  };

  try {
    while (!finished) {
      const { value, done } = await awaitWithSignal(() => reader.read(), signal);
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length + state.text.length > 2_000_000) throw new Error('Model stream exceeded response size limit');
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consume(frame);
        if (finished) break;
      }
      if (done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    if (chat) {
      if (!finished || !finishReason) throw new Error('Model stream ended without completion');
      return { choices: [{ finish_reason: finishReason, message: { content: state.text, refusal } }], usage: state.usage };
    }
    if (!terminal) throw new Error('Model stream ended without completion');
    return terminal;
  } finally {
    // Cancellation must not await a broken transport's pending read.
    Promise.resolve(reader.cancel()).catch(() => {});
  }
}

module.exports = { awaitWithSignal, completeMembers, readModelStream };
