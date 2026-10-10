'use strict';

const { structuredRequest, requestWorkload } = require('./request_envelope');
const { matchesSchema } = require('./model_router');

function subset(schema, input, rows) {
  if (input.colors) {
    const ids = new Set(rows.map(row => row.id));
    const pages = new Set(rows.flatMap(row => row.source_ids));
    return { schema: { ...schema, properties: Object.fromEntries(Object.entries(schema.properties)
      .filter(([id]) => ids.has(id))), required: [...ids] },
    input: { ...input, colors: rows, pages: input.pages.filter(page => pages.has(page.id)) } };
  }
  const evidence = new Set(rows.flatMap(row => row.sources.flatMap(source => source.evidence_ids)));
  const pages = new Set(rows.flatMap(row => row.sources.map(source => source.page_id)));
  const child = structuredClone(schema);
  child.properties.reconsiderations.items.properties.candidate_id.enum = rows.map(row => row.id);
  return { schema: child, input: { ...input, candidates: rows,
    evidence: Object.fromEntries(Object.entries(input.evidence).filter(([id]) => evidence.has(id))),
    pages: input.pages.filter(page => pages.has(page.id)) } };
}

// Size before sending; after a timeout split once, continuing at the next route.
// Successful siblings remain available even if another child exhausts its routes.
async function verificationRequest(execute, stage, schema, input, instructions, recovery = {}) {
  const rows = input.colors || input.candidates;
  const combine = parts => input.colors ? Object.assign({}, ...parts)
    : { reconsiderations: parts.flatMap(part => part.reconsiderations || []) };
  const split = async (pending, next, partial = {}) => {
    const middle = Math.ceil(pending.length / 2);
    const groups = [pending.slice(0, middle), pending.slice(middle)].filter(group => group.length);
    const results = await Promise.allSettled(groups.map((group, index) => {
      const child = subset(schema, input, group);
      return verificationRequest(execute, `${stage}_part${index + 1}`, child.schema, child.input, instructions, next);
    }));
    const values = results.map(result => result.status === 'fulfilled' ? result.value : result.reason.partialOutput || {});
    const merged = combine([partial, ...values]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) {
      const error = new Error(failed.reason.message, { cause: failed.reason });
      error.code = failed.reason.code;
      error.partialOutput = merged;
      error.completedIds = results.flatMap((result, index) => result.status === 'fulfilled'
        ? groups[index].map(row => row.id) : result.reason.completedIds || []);
      throw error;
    }
    return merged;
  };

  if (rows.length > 1 && requestWorkload(structuredRequest(stage, schema, input, instructions)).totalChars > 60000) {
    return split(rows, recovery);
  }
  try {
    return await execute(stage, schema, input, instructions,
      { ...recovery, managed: true, splitOnTimeout: rows.length > 1 && !recovery.startAfter });
  } catch (error) {
    // A large batch may exceed the remaining stage reservation even when its
    // smaller children fit. Split only that batch; the budget still admits each
    // child independently and never borrows from another mandatory stage.
    const budgetSplit = error.code === 'AI_BUDGET_LIMIT';
    const noFunds = budgetSplit && Number.isFinite(error.details?.spentUsd)
      && Number.isFinite(error.details?.stageLimitUsd)
      && error.details.spentUsd >= error.details.stageLimitUsd;
    if ((!budgetSplit && error.code !== 'MODEL_ROUTE_TIMEOUT') || rows.length < 2
      || recovery.startAfter || noFunds) throw error;
    const partial = input.colors ? Object.fromEntries(Object.entries(error.partialOutput || {})
      .filter(([id, value]) => schema.properties[id] && matchesSchema(value, schema.properties[id]))) : {};
    const pending = input.colors ? rows.filter(row => !Object.hasOwn(partial, row.id)) : rows;
    if (!pending.length) return partial;
    return split(pending, budgetSplit ? recovery : { ...recovery, startAfter: error.routeId }, partial);
  }
}

module.exports = { verificationRequest, subset };
