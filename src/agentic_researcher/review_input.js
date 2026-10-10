// Share exact passages within a review batch. Every source association and every
// character of evidence is retained; the full candidate inventory stays unchanged.
function reviewInput(vehicle, candidates, pages) {
  const evidence = {};
  const ids = new Map();
  const reference = (passage) => {
    if (!ids.has(passage)) {
      const id = `E${ids.size + 1}`;
      ids.set(passage, id);
      evidence[id] = passage;
    }

    return ids.get(passage);
  };

  const pageIds = new Set(candidates.flatMap((candidate) => candidate.sources.map((source) => source.page_id)));

  return { vehicle,
    candidates: candidates.map((candidate) => ({ ...candidate,
      sources: candidate.sources.map(({ page_id, evidence, claimScope }) => ({
        page_id, evidence_ids: evidence.map(reference),
        ...(claimScope && { claimScope }),
      })),
    })),
    evidence,
    pages: pages.filter((page) => pageIds.has(page.id)).map((page) => ({
      id: page.id, title: page.title, url: page.url, opening: page.text.slice(0, 1000),
      ...(page.catalog && { catalog: page.catalog, catalog_record: page.catalog_record }),
      ...(page.retrievalMethod === 'search_snippet' && { search_snippet: true }),
      ...(page.nearbyYearLead && { nearby_year_lead: true }),
      incomplete_extraction: !!page.failures?.length,
    })),
  };
}

module.exports = { reviewInput };
