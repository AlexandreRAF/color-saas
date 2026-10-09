'use strict';

const { hasPortugueseName, webPortugueseName } = require('./portuguese_names');
const { normalized, quoted } = require('./search_groups');
const { hueFamilies } = require('./hue_review');
const { printedNameKey } = require('./paint_evidence');

const MAX_EXTRA_MS = 4500;

function unresolvedForeignNames(colors, pages, vehicle) {
  return colors.filter(color => color.name && !hasPortugueseName(color.name)
    && !color._catalogName && !webPortugueseName(color, pages, vehicle))
    .sort((left, right) => Number((right.code_candidates?.length || 0) !== 1)
      - Number((left.code_candidates?.length || 0) !== 1)
      || Number(printedNameKey(right.name).split(' ').length === 1)
      - Number(printedNameKey(left.name).split(' ').length === 1)
      || (right.sources?.length || 0) - (left.sources?.length || 0));
}

function localizationQueries(color, vehicle) {
  const identity = [vehicle.brand, quoted(color.name)].filter(Boolean).join(' ');
  const hue = String(vehicle.predominantColor || '').trim();

  return [
    `${identity} ${hue} (nome OR cor OR tinta) Brasil código`,
    `${vehicle.brand} ${vehicle.model} ${vehicle.manufacturingYear} ${quoted(color.name)} paint color code`,
  ];
}

function relevantResult(source, color, vehicle) {
  const summary = normalized(`${source.title || ''} ${source.snippet || ''} ${source.url || ''}`);
  return summary.includes(normalized(color.name)) && summary.includes(normalized(vehicle.brand))
    && /\b(?:paint|colour|color|tinta|cor|pintura|lack|farb)\b/u.test(summary);
}

// Run only when the normal pipeline has produced a foreign display name with
// no verified Portuguese equivalent. Fetch two short sources without another
// model call; snippets merely choose URLs and never establish an alias.
async function researchPortugueseNames(run, colors, vehicle) {
  const remaining = run.searchBudget.remaining('research');
  const room = run.maxPages - run.pages.filter(page => !page.nameResearch).length;
  const timeLeft = (run.timing.targetTimeMs || 60000) - run.timing.processingMs();
  if (room <= 0 || timeLeft < MAX_EXTRA_MS || run.timing.signal.aborted) return;

  const color = unresolvedForeignNames(colors, run.pages, vehicle)[0];
  if (!color) return;

  const signal = AbortSignal.any([run.timing.signal, AbortSignal.timeout(MAX_EXTRA_MS)]);
  const wantedHues = hueFamilies(vehicle.predominantColor);
  const hueScore = source => [...hueFamilies(`${source.title || ''} ${source.snippet || ''}`)]
    .some(hue => wantedHues.has(hue));
  const aliasScore = source => {
    const summary = `${source.title || ''} ${source.snippet || ''}`;
    return Number(/\b(?:sold|known|listed|called|marketed|vendid[ao]|conhecid[ao]|chamad[ao])\s+(?:as|como)\b/iu
      .test(summary)) * 3 + Number(hasPortugueseName(summary)) * 2 + Number(hueScore(source));
  };
  let fetched = 0;

  const fetchSources = async (queries = []) => {
    const sources = [...run.index.values()].filter(source =>
      (!queries.length || source.queries?.some(query => queries.includes(query)))
      && relevantResult(source, color, vehicle)
      && !run.pages.some(page => page.url === source.url)
      && (queries.length || aliasScore(source) >= 2));
    sources.sort((left, right) => aliasScore(right) - aliasScore(left));

    for (const source of sources.slice(0, Math.max(0, Math.min(room - fetched, 2 - fetched)))) {
      if (signal.aborted) break;
      const [page] = await run.pagePool.fetchPages([source.url], {
        timeoutMs: 3500, totalTimeoutMs: 3500, signal,
      });
      fetched++;
      run.attempted.add(source.url);
      run.pages.push({ ...source, ...page, url: source.url,
        nameResearch: true, localizationOnly: true, candidates: [] });
      if (webPortugueseName(color, run.pages, vehicle)) return true;
    }
    return false;
  };

  try {
    let resolved = await fetchSources();
    for (const query of localizationQueries(color, vehicle).slice(0, Math.min(remaining, 2))) {
      if (resolved || signal.aborted || fetched >= Math.min(room, 2)) break;
      await run.search([query], vehicle, signal, { forLocalization: true });
      // Search publishes sources before its last engine finishes. Start the
      // fetch immediately; waiting for all search jobs spent the entire window.
      resolved = await fetchSources([query]);
    }

    run.log('portuguese_name_research', { name: color.name,
      queries: run.localizationQueries.size, pages: fetched, resolved });
  } catch (error) {
    run.log('portuguese_name_research', { name: color.name,
      queries: run.localizationQueries.size, pages: fetched, error: error?.message || String(error) });
  }
}

module.exports = { researchPortugueseNames };
