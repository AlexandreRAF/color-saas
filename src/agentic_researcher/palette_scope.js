'use strict';

const { modelLinkedPage } = require('./verification_research');
const { sourceYearRelevance } = require('./source_year');

// Classify only after the final agent has reviewed every color. Keep all
// comparison leads in the established colors array, with their scope explicit.
function partitionPalette(colors, vehicle, pages = [], modelCatalogPages = []) {
  const byUrl = new Map(pages.filter(page => page?.url && page.status === 'ok')
    .map(page => [page.url, page]));
  const modelRecords = new Map(modelCatalogPages.filter(page => page.catalog === 'basf_models'
    && page.catalog_record?.model_match === 'exact')
    .map(page => [page.catalog_record.record_id, page]));
  let modelCandidates = 0;
  let manufacturerLeads = 0;

  const classified = colors.map(color => {
    let scope = null;
    if (color.identityType === 'vehicle_display_color') scope = 'model_display_label';
    else if (color.identityType === 'fleet_standard_paint') scope = 'fleet_standard';
    else if (color.catalogSources?.some(source => source.catalog === 'basf_models'
      && modelRecords.has(source.recordId))) scope = 'model_catalog';
    else if (color.sources?.some(url => {
      const page = byUrl.get(url);
      return page && !page.localizationOnly
        && (!color.nearbyYearLead || sourceYearRelevance(page, vehicle) >= 0)
        && modelLinkedPage(page, color, vehicle);
    })) scope = 'model_page';

    if (scope) modelCandidates++;
    else manufacturerLeads++;
    const { nearbyYearLead, ...publicColor } = color;
    return { ...publicColor, applicabilityScope: scope || (color.identityType === 'shared_paint_lead'
      ? 'shared_paint_possible' : nearbyYearLead ? 'adjacent_year_lead' : 'manufacturer_only') };
  });

  return { colors: classified, paletteScope: { modelCandidates, manufacturerLeads } };
}

module.exports = { partitionPalette };
