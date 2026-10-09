'use strict';

const { sourceCodes } = require('./paint_evidence');
const { MatcherBatcher } = require('./matcher_batcher');
const { runMatcherAgent } = require('./database_code_agent');

// Match reviewed colors, reusing catalog evidence and recording each batch.
async function matchCandidateColors(run, colors, vehicle, signal, batch) {
  if (!colors.length) return [];

  const started = performance.now();
  const palette = { make: vehicle.brand || 'unknown', model: vehicle.model,
    year: vehicle.manufacturingYear, market: vehicle.country || 'unknown', version: 'unknown', colors,
    ...(vehicle.paintFinish && { paintFinish: vehicle.paintFinish }) };

  let coded = { ...palette, colors: colors.map(color => ({ ...color, universal_code: '', code_candidates: [] })) };
  let requests = 0;
  let incomplete = [];
  let incompleteIndices = [];

  try {
    run.matcherBatcher ||= new MatcherBatcher(runMatcherAgent);
    coded = await run.databaseCodeAgent(palette, {
      brand: vehicle.brand, model: vehicle.model, year: vehicle.manufacturingYear, paintFinish: vehicle.paintFinish,
      databasePath: run.options.databasePath, signal,
      loadCandidatesFn: run.catalogs ? async colors => Promise.all(colors.map(async (color, index) => {
        signal?.throwIfAborted();
        const cached = await run.catalogs.cachedFor?.(color);
        const found = cached || await run.catalogs.lookup({ name: color.name, brand: vehicle.brand, model: vehicle.model,
          year: vehicle.manufacturingYear, source_codes: (color.source_evidence || []).flatMap(source =>
            sourceCodes(source.source_name || color.name, source.passages || [])) }, signal);

        signal?.throwIfAborted();
        const reviewedIds = await run.catalogs.selectedFor(color);

        return { index, candidates: found.candidates.map(row => ({ ...row,
          catalog_identity_confirmed: reviewedIds.has(row.candidate_id) })) };
      })) : undefined,
      scheduler: run.scheduler, timing: run.timing, request: run.options.request, apiKey: run.options.apiKey,
      modelRouting: run.routing,
      matcherBatcher: run.matcherBatcher,
      onWait: ({ event, ...detail }) => run.log(event, { batch, ...detail }),
      onProgress: (event, details) => {
        if (event === 'finish_exclusions') {
          run.matchingExclusions ||= [];
          run.matchingExclusions.push(...details.colors);
        }
        if (event === 'database_matcher_request_start') requests++;

        if (event === 'database_matcher_usage') {
          run.cost.record('databaseMatcher', details);
          run.usage('databaseMatcher', details.usage);
        }

        run.log(event, { batch, ...details });
      },
      onDebug: (name, data) => run.dump(`${name}-batch-${batch}`, data),
    });

    for (const warning of coded._databaseCodeAgentWarnings || []) run.warn('code_matching', warning);
    incomplete = coded._databaseCodeAgentIncompleteNames || [];
    incompleteIndices = coded._databaseCodeAgentIncompleteIndices || [];
  } catch (error) {
    incomplete = colors.map(color => color.name);
    incompleteIndices = colors.map((_, index) => index);
    run.warn('code_matching', error);
  }

  run.modelCalls.databaseMatcher += Math.max(1, requests);
  run.stageTimes.databaseCodeAgent = (run.stageTimes.databaseCodeAgent || 0) + performance.now() - started;

  // Pipeline metadata is not a public color field and is never serialized.
  Object.defineProperty(coded.colors, 'incompleteNames', { value: incomplete });
  Object.defineProperty(coded.colors, 'incompleteIndices', { value: incompleteIndices });
  return coded.colors;
}

module.exports = { matchCandidateColors };
