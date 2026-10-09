'use strict';

function sourceYearRelevance(source, vehicle) {
  const target = Number(vehicle.manufacturingYear);
  if (!Number.isInteger(target)) return 0;

  const path = new URL(source.url).pathname;
  const text = `${source.title || ''} ${path}`.toLowerCase();
  const years = [...text.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)|(?:^|[^a-z])my\s*[-_]?\s*(\d{2})(?!\d)/g)]
    .map(match => match[1] ? 2000 + Number(match[1]) : Number(match[0]));
  const ranges = [...text.matchAll(/(?<!\d)((?:19|20)\d{2})\s*(?:-|–|a|to|ate|até|through)\s*((?:19|20)\d{2})(?!\d)/g)];

  return years.includes(target) || ranges.some(([, start, end]) => target >= Number(start) && target <= Number(end))
    ? 1 : years.length ? -1 : 0;
}

function sourceYearDistance(source, vehicle) {
  const target = Number(vehicle.manufacturingYear);
  if (!Number.isInteger(target)) return Infinity;

  const yearsIn = text => [...text.toLowerCase()
    .matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)|(?:^|[^a-z])my\s*[-_]?\s*(\d{2})(?!\d)/g)]
    .map(match => match[1] ? 2000 + Number(match[1]) : Number(match[0]));
  const years = yearsIn(String(source.title || ''));
  if (!years.length) years.push(...yearsIn(new URL(source.url).pathname));

  return years.length ? Math.min(...years.map(year => Math.abs(year - target))) : Infinity;
}

module.exports = { sourceYearRelevance, sourceYearDistance };
