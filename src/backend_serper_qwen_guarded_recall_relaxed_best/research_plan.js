const { initialColorQuery, vehicleModelName } = require('./agentic_loop_helpers');
const { searchLocale } = require('./browse');
const { sourceUrl } = require('./source_index');
const { hueFamilies } = require('./hue_review');
const { finishSearchTerms } = require('./paint_finish');
const { destinationUrl } = require('./search_urls');
const { candidateSourceCodes } = require('./paint_evidence');
const { sourceYearRelevance } = require('./source_year');
const { vehicleProfile } = require('./vehicle_profiles');
const { modelNameMatches } = require('./model_name_match');
const knownManufacturers = require('./data/known_manufacturers.json');

const normalizedWords = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const listedMakes = knownManufacturers.map(normalizedWords).filter(Boolean);
const firstWords = new Map();
for (const make of listedMakes) {
  const first = make.split(' ')[0];
  firstWords.set(first, (firstWords.get(first) || 0) + 1);
}
// Some catalog makers are listed only as regional divisions (for example,
// Ford Europe and Ford Australia). Their shared parent is still a different
// manufacturer when it precedes the requested model in a result title.
const otherMakes = [...new Set([...listedMakes,
  ...[...firstWords].filter(([, count]) => count >= 2).map(([first]) => first)])];

// A model word can also be another maker's model. Such pages do not establish
// the requested maker merely because its name appears in the result title.
function conflictingMakeModel(source, vehicle) {
  const brand = normalizedWords(vehicle.brand);
  const firstModelWord = normalizedWords(vehicle.model).split(' ')[0];
  if (!brand || !firstModelWord) return false;
  const url = new URL(source.url);
  const text = ` ${normalizedWords(`${source.title || ''} ${url.pathname}`)} `;
  return otherMakes.some(make => make !== brand && (text.includes(` ${make} ${firstModelWord} `)
    || text.includes(` ${make} europe ${firstModelWord} `)
    || text.includes(` ${make} europa ${firstModelWord} `)));
}

function seedQueries(vehicle) {
  const model = vehicleModelName(vehicle);
  const name = [model, vehicle.manufacturingYear].filter(Boolean).join(' ');
  const hues = [...hueFamilies(vehicle.predominantColor)];
  const hue = hues.length ? vehicle.predominantColor : '';
  const internationalHue = hues.flatMap(family => family.split('-')).join(' ');
  const local = searchLocale(vehicle.country).hl;
  const profile = vehicleProfile(vehicle.automobileType);
  const typeTerm = profile.kind === 'car' ? '' : vehicle.automobileType || '';
  const terms = {
    pt: [profile.localPalette, profile.localParts],
    es: ['catálogo colores pintura original', 'piezas pintadas nombre color'],
  }[local] || [profile.internationalPalette, profile.internationalParts];

  // Broad palette searches also find names that do not contain the requested hue.
  // Search providers sometimes return no results for filetype:pdf even when
  // the period brochure is indexed. The PDF term still surfaces those charts.
  const periodBrochure = [model, vehicle.manufacturingYear,
    local === 'pt' ? 'catálogo PDF cores' : 'brochure PDF paint colors'].filter(Boolean).join(' ');

  const equipmentColors = local === 'pt' && vehicle.manufacturingYear
    ? [`${name} ${profile.kind === 'car' ? 'lista de equipamentos' : 'versões'} cores PDF`] : [];
  // A localized finish-specific palette query reaches period brochures whose
  // titles omit individual paint names. It runs alongside the broad searches,
  // so marketing names that do not state the visual hue remain discoverable.
  const localFinishPalette = local === 'pt' && vehicle.manufacturingYear && hue && vehicle.paintFinish
    ? [`${name} ${hue} ${finishSearchTerms(vehicle.paintFinish, local)} catálogo cores`]
    : [];

  if (['agricultural', 'construction'].includes(profile.kind)) {
    // Equipment catalogs often use one maker-wide paint across several models.
    // Keep both model-specific and maker paint searches so the main reviewer
    // can cross their applicability without assuming a shared paint.
    return [[initialColorQuery(vehicle), hue].filter(Boolean).join(' '),
      [name, typeTerm, 'paint code', internationalHue].filter(Boolean).join(' '),
      [model, 'código tinta original', hue].filter(Boolean).join(' '),
      [vehicle.brand, 'standard factory paint all', typeTerm, 'equipment'].filter(Boolean).join(' '),
      [name, profile.localPalette].filter(Boolean).join(' '),
      [model, profile.localParts].filter(Boolean).join(' '), ...localFinishPalette];
  }

  return [[initialColorQuery(vehicle), hue].filter(Boolean).join(' '),
    [name, typeTerm, terms[0], vehicle.country].filter(Boolean).join(' '),
    [model, profile.internationalPalette, internationalHue].filter(Boolean).join(' '),
    [model, typeTerm, terms[1], finishSearchTerms(vehicle.paintFinish, local)].filter(Boolean).join(' '),
    periodBrochure, ...equipmentColors, ...localFinishPalette];
}

function indexResults(searches, index) {
  for (const search of searches) {
    const results = (search.results || []).flatMap(result => {
      const destination = destinationUrl(result.url || '');
      if (!destination) return [result];
      const url = new URL(destination);
      // Search engines can return page 2/3 without the first palette page.
      // Retain pagination and explicitly admit its root; never infer a paint.
      if (/^\d+$/.test(url.searchParams.get('page') || '') && Number(url.searchParams.get('page')) > 1) {
        url.searchParams.delete('page');
        return [{ ...result, url: url.href, rank: Math.max(0, (result.rank || 0) - 1) }, result];
      }
      return [result];
    });
    for (const [rank, result] of results.entries()) {
      const destination = destinationUrl(result.url || '');

      if (!destination) continue;

      const url = sourceUrl(destination);
      const previous = index.get(url);
      const position = result.rank ?? rank;

      index.set(url, { ...result, url, rank: Math.min(previous?.rank ?? position, position),
        ...((previous?.engines || result.engines) && { engines: [...new Set([...(previous?.engines || []), ...(result.engines || [])])] }),
        queries: [...new Set([...(previous?.queries || []), search.query])] });
    }
  }
}

function selectSources(index, attempted, vehicle, count, preferred = [],
  { allowBrandCatalogs = false } = {}) {
  const preferredSet = new Set(preferred.map(sourceUrl));
  const profile = vehicleProfile(vehicle.automobileType);
  const equipment = ['agricultural', 'construction', 'truck', 'bus'].includes(profile.kind);
  const compact = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const modelKey = compact(vehicle.model);
  const paintTerms = /paint|colou?r|cores|pintura|tinta|farb|couleur|brochure|cat[aá]logo|prata|silver|metallic|perol|pearl/i;
  const namedHue = /\b(?:branc[oa]|white|pret[oa]|black|cinza|gr[ae]y|gris|vermelh[oa]|red|azul|blue|verde|green|amarel[oa]|yellow|bege|beige|marrom|brown|prata|silver)\b/iu;
  const entries = [...index.values()].filter((entry) => {
    if (attempted.has(entry.url)) return false;
    if (conflictingMakeModel(entry, vehicle)) return false;
    const host = new URL(entry.url).hostname;
    if (equipment && /(?:youtube|facebook|instagram|tiktok)\.com$/i.test(host)
      && !/\b(?:paint|colou?r)\s+codes?\b|c[oó]digos?\s+(?:d[ae]\s+)?(?:cor|tinta)/iu
        .test(`${entry.title || ''} ${entry.snippet || ''}`)) return false;
    if (preferredSet.has(entry.url) || entry.plannedSource) return true;

    const text = `${entry.url} ${entry.title} ${entry.snippet || ''}`;
    const ambiguousModel = /^\d+$/.test(modelKey) || modelKey.length <= 3;
    const brandPresent = !ambiguousModel || !vehicle.brand || compact(text).includes(compact(vehicle.brand));
    const words = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    const modelPresent = /^[\p{L}]{1,3}$/u.test(modelKey)
      ? words.includes(` ${modelKey} `) : modelNameMatches(text, vehicle.model);
    const brandCatalog = allowBrandCatalogs && vehicle.brand
      && compact(text).includes(compact(vehicle.brand))
      && /cores|colou?rs?|paint|pintura|tintas?|farb/i.test(`${entry.title} ${entry.snippet || ''}`);
    const titlePath = `${entry.title || ''} ${new URL(entry.url).pathname}`;
    const specificPage = modelNameMatches(titlePath, vehicle.model)
      || /paint|colou?r|cores|pintura|tintas?|farb|couleur|vernici|lack|touch.?up/i.test(titlePath)
      || /(?:paint|colou?r)\s+(?:codes?|charts?|palette)|cores originais|c[oó]digos? de cores|pintura original/i.test(entry.snippet || '');

    // Incidental model/color mentions in broad archives are not a paint source.
    // Vehicle pages and paint catalogs remain eligible, including donor makes.
    // A model-specific specialist listing can expose a body color even when
    // its title says only "branco" or "white" rather than "paint". It remains
    // a lead for extraction/review, not proof of a named factory paint.
    const colorLead = equipment && modelNameMatches(titlePath, vehicle.model)
      && namedHue.test(`${entry.title || ''} ${entry.snippet || ''}`);
    return (brandPresent && modelPresent || brandCatalog)
      && (paintTerms.test(text) || colorLead) && specificPage;
  });

  const domains = new Map();
  const selected = [];
  const modelInTitleOrPath = entry => {
    const url = new URL(entry.url);
    return modelNameMatches(`${entry.title || ''} ${url.pathname}`, vehicle.model);
  };

  const modelDomains = new Set(entries.filter(modelInTitleOrPath)
    .map(entry => new URL(entry.url).hostname.replace(/^www\./, '')));
  const score = (entry) => {
    const text = `${entry.url} ${entry.title} ${entry.snippet}`.toLowerCase();
    const domain = new URL(entry.url).hostname.replace(/^www\./, '');
    const period = sourceYearRelevance(entry, vehicle);
    const manufacturer = compact(vehicle.brand || '');
    const manufacturerSite = manufacturer.length >= 4 && compact(domain).includes(manufacturer);
    const brochure = /brochure|brochura|cat[aá]logo|catalog|\.pdf/i.test(`${entry.title || ''} ${entry.url}`);
    const ownersManual = /manual.{0,40}(?:propriet|owner|usu[aá]ri)|owner.?s?\s+manual|user\s+manual/i
      .test(`${entry.title || ''} ${entry.url}`);
    const social = /youtube|facebook|instagram|tiktok/i.test(domain);
    const listing = /mercadolivre|mfrural|olx|classificados|marketplace/i.test(domain)
      || /\b(?:an[uú]ncio|venda|comprar|usad[oa]|aluguel|seminov[oa])\b/iu.test(entry.title || '');

    return (preferredSet.has(entry.url) || entry.plannedSource ? 20 : 0)
      + (modelNameMatches(text, vehicle.model) ? 8 : 0)
      + (/paint|colou?r|cores|pintura|tinta|farb|couleur/i.test(text) ? 6 : 0)
      + (/brochure|catalog|chart|\.pdf|manual/i.test(text) ? 4 : 0)
      + (profile.kind !== 'car' && profile.sourceTerms.test(`${entry.title || ''} ${entry.snippet || ''}`) ? 4 : 0)
      + (equipment && /\b(?:paint|colou?r)\s+codes?\b|c[oó]digos?\s+(?:d[ae]\s+)?(?:cor|tinta)|factory paint/i
        .test(`${entry.title || ''} ${entry.snippet || ''}`) ? 8 : 0)
      + period * 14
      + (manufacturerSite && brochure ? 12 : 0)
      - (ownersManual ? 30 : 0)
      // Prefer the model's own palette over a same-site all-model index.
      // Broad references remain eligible when room remains or no specific page exists.
      - (modelDomains.has(domain) && !modelInTitleOrPath(entry) ? 30 : 0)
      - (/atos of|di[aá]rio oficial|preg[aã]o|licita[cç][aã]o|edital|official gazette/i.test(entry.title || '') ? 35 : 0)
      - (social ? (equipment ? 42 : 18) : 0)
      - (equipment && listing ? 18 : 0)
      // Reader-gated document hosts remain eligible, but direct paint pages
      // should get the first fetch slot when both are indexed.
      - (/(?:^|\.)(?:scribd|issuu)\.com$|(?:^|\.)academia\.edu$/i.test(domain) ? 24 : 0)
      - entry.rank - (domains.get(domain) || 0) * 5;
  };

  while (entries.length && selected.length < count) {
    entries.sort((a, b) => score(b) - score(a));

    const entry = entries.shift();

    selected.push(entry);

    const domain = new URL(entry.url).hostname.replace(/^www\./, '');

    domains.set(domain, (domains.get(domain) || 0) + 1);
  }

  return selected;
}

function sparseResearchQueries(vehicle, candidates, pages = []) {
  const linked = candidates.some(candidate => candidate.sources?.some(source => {
    const page = pages.find(page => page.id === source.page_id);
    return modelNameMatches(`${source.url} ${source.evidence?.join(' ')} ${page?.title || ''} ${page?.text?.slice(0, 1000) || ''}`,
      vehicle.model);
  }));

  if (linked || !vehicle.brand) return [];

  const model = vehicle.model.toLowerCase().startsWith(vehicle.brand.toLowerCase())
    ? vehicle.model : `${vehicle.brand} ${vehicle.model}`;
  const profile = vehicleProfile(vehicle.automobileType);

  return [`${vehicle.brand} "cores originais" pintura catálogo`,
    `"${model}" ${profile.localPalette}`];
}

// Planning selects searches, not paint identities. Repeating every catalog
// quotation here spends the review budget before reviewers see those records.
function planningCandidates(candidates) {
  return candidates.map(candidate => ({
    id: candidate.id,
    name: candidate.name,
    aliases: candidate.aliases || [],
    source_ids: [...new Set(candidate.sources.map(source => source.page_id))],
    source_codes: [...new Set(candidate.sources.flatMap(source =>
      candidateSourceCodes(candidate, source)))],
    has_model_catalog_evidence: candidate.sources.some(source => source.url?.startsWith('catalog:basf_models:')),
    has_web_evidence: candidate.sources.some(source => /^https?:/.test(source.url || '')),
  }));
}

module.exports = { seedQueries, indexResults, selectSources, sourceYearRelevance,
  sparseResearchQueries, planningCandidates, conflictingMakeModel };
