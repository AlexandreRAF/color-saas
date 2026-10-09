'use strict';

const { object } = require('./candidate_inventory');
const { matchesSchema, normalizeBatchMember } = require('./model_router');
const { structuredRequest, requestWorkload } = require('./request_envelope');
const { hueFamilies } = require('./hue_review');

const EXCLUSIONS = ['unrelated_vehicle', 'unrelated_hue', 'not_paint_name',
  'interior_or_component', 'repaint_only', 'authoritative_exclusion'];

// Coordinate transport slots before assembling batches. Otherwise independent
// triage/full queues either leave slots idle or burst past primary capacity.
class ReviewSlots {
  constructor(concurrency) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid review transport concurrency');
    this.concurrency = concurrency;
    this.active = 0;
    this.waiting = new Set();
  }

  take(batcher) {
    if (this.active >= this.concurrency) {
      this.waiting.add(batcher);
      return false;
    }
    this.waiting.delete(batcher);
    this.active++;
    return true;
  }

  release() {
    this.active--;
    for (const batcher of this.waiting) {
      if (this.active >= this.concurrency) break;
      this.waiting.delete(batcher);
      batcher.flush();
    }
  }
}

function transportSchema(item, catalogRefs = [], evidenceRefs = []) {
  const fields = item.schema.properties;
  if (!fields?.action) return item.schema;
  // Identity selection needs representatives, not every formula edition and
  // model spelling. All original rows still reach the independent matcher.
  const rowGroups = new Set((item.input.candidates?.[0]?.catalog_check?.rows || []).map(row =>
    JSON.stringify([row.manufacturer, row.universal_code, [...(row.paintFinish || [])].sort()])));
  return object({
    decision: { type: 'string', enum: ['include'],
      description: 'Inclusions use this object. Supported exclusions use the category string instead.' },
    source_ids: fields.source_ids,
    catalog_refs: { type: 'array', items: { type: 'string', ...(catalogRefs.length && { enum: catalogRefs }) },
      maxItems: catalogRefs.length,
      description: `Prefer at most ${rowGroups.size} representatives, one per supported manufacturer/code/finish combination. Avoid redundant formula editions.` },
    name: fields.name, confidence: fields.confidence, reason: fields.reason,
    name_status: fields.name_status,
    ...(item.input.vehicle.paintFinish && {
      finish_status: fields.finish_status, finish_evidence_ids: { ...fields.finish_evidence_ids,
        items: { type: 'string', ...(evidenceRefs.length && { enum: evidenceRefs }) },
        ...(!evidenceRefs.length && { maxItems: 0 }) },
    }),
    detail: { anyOf: [{ type: 'null' }, object({ question: fields.detail_question, page_ids: fields.detail_page_ids })] },
  });
}

function expandDecision(value, item, catalogRows, evidenceIds = {}) {
  if (!item.schema.properties?.action || !value || typeof value !== 'object') return value;
  const { detail, decision: verdict, catalog_refs = [], ...decision } = value;
  if (EXCLUSIONS.includes(verdict)) {
    return { action: 'exclude', exclusion: verdict, reason: decision.reason || verdict,
      catalog_ids: [], detail_question: '' };
  }
  return { action: 'include', name: null, name_status: 'complete', exclusion: 'none',
    finish_status: 'unknown', finish_evidence_ids: [], ...decision,
    catalog_ids: catalog_refs.map(id => catalogRows[id]?.candidate_id),
    ...(decision.finish_evidence_ids && {
      finish_evidence_ids: decision.finish_evidence_ids.map(id => evidenceIds[id]),
    }),
    detail_question: detail?.question || '', detail_page_ids: detail?.page_ids || [] };
}

function compactReviewInput(items) {
  const passages = {}, passageIds = new Map(), pages = {}, pageIds = new Map();
  const sharedCatalogRows = {}, catalogIds = new Map();
  const evidenceIdentities = [];
  const requests = items.map((item, index) => {
    const originalEvidence = {}, transportEvidence = {};
    const evidence = Object.fromEntries(Object.entries(item.input.evidence).map(([id, text]) => {
      if (!passageIds.has(text)) {
        const key = `E${passageIds.size + 1}`;
        passageIds.set(text, key);
        passages[key] = text;
      }
      const passageId = passageIds.get(text);
      // One ID names both the owned evidence and its verbatim shared passage.
      // Separate T/E aliases caused valid text to be cited with an invalid ID.
      const transportId = passageId;
      originalEvidence[transportId] = id;
      transportEvidence[id] = transportId;
      return [transportId, { passage_id: passageId }];
    }));
    evidenceIdentities.push(originalEvidence);
    const references = (item.input.pages || []).map(page => {
      const key = JSON.stringify(page);
      if (!pageIds.has(key)) {
        const id = `G${pageIds.size + 1}`;
        pageIds.set(key, id);
        pages[id] = page;
      }
      return { id: page.id, page_reference: pageIds.get(key) };
    });
    const candidates = item.input.candidates?.map(candidate => {
      candidate = { ...candidate, ...(candidate.sources && { sources: candidate.sources.map(source => ({
        ...source, ...(source.evidence_ids && { evidence_ids: source.evidence_ids.map(id => transportEvidence[id]) }),
      })) }) };
      if (!candidate.catalog_check?.rows) return candidate;
      const { rows, ...check } = candidate.catalog_check;
      const row_refs = rows.map(row => {
        const key = JSON.stringify(row);
        if (!catalogIds.has(key)) {
          const id = `K${catalogIds.size + 1}`;
          catalogIds.set(key, id);
          sharedCatalogRows[id] = row;
        }
        return catalogIds.get(key);
      });
      return { ...candidate, catalog_check: { ...check, row_refs } };
    });
    return { id: `R${index + 1}`, ...item.input, ...(candidates && { candidates }), evidence, pages: references };
  });
  // Send column names once. Numeric database IDs stay in the application;
  // the model selects only candidate-scoped K references.
  const catalogColumns = [...new Set(Object.values(sharedCatalogRows).flatMap(Object.keys))]
    .filter(key => key !== 'candidate_id');
  const catalogTable = Object.fromEntries(Object.entries(sharedCatalogRows)
    .map(([id, row]) => [id, catalogColumns.map(key => row[key] ?? null)]));

  // Local model pages repeat the same catalog field names for every record.
  // Share those columns without shortening any record or source qualification.
  const records = {}, recordIds = new Map();
  const compactPages = Object.fromEntries(Object.entries(pages).map(([id, page]) => {
    const { catalog_record: record, opening, ...rest } = page;
    const compact = { ...rest };
    if (opening !== undefined) {
      const passageId = passageIds.get(opening);
      if (passageId) compact.opening_passage_id = passageId;
      else compact.opening = opening;
    }
    if (record) {
      const key = JSON.stringify(record);
      if (!recordIds.has(key)) {
        const ref = `D${recordIds.size + 1}`;
        recordIds.set(key, ref);
        records[ref] = record;
      }
      compact.catalog_record_ref = recordIds.get(key);
    }
    return [id, compact];
  }));
  const recordColumns = [...new Set(Object.values(records).flatMap(Object.keys))];
  const recordTable = Object.fromEntries(Object.entries(records)
    .map(([id, record]) => [id, recordColumns.map(key => record[key] ?? null)]));

  return { input: { requests, passages, sharedPages: compactPages,
    ...(recordColumns.length && { recordColumns, sharedCatalogRecords: recordTable }),
    catalogColumns, sharedCatalogRows: catalogTable }, catalogIdentities: sharedCatalogRows, evidenceIdentities };
}

// Transport batching only: each item keeps its own schema, citations and result.
// Identical passages are sent once, without merging their source associations.
class ReviewBatcher {
  constructor(execute, { size = 6, maxChars = 50000, concurrency = 8,
    stagePrefix = 'research_review_batch', triage = false, repairBatcher, repairInvalid = true, splitTimeouts = true, slots } = {}) {
    if (![size, maxChars, concurrency].every(value => Number.isInteger(value) && value > 0)) {
      throw new Error('Review batch limits must be positive integers');
    }
    Object.assign(this, { execute, size, maxChars, concurrency, stagePrefix, triage, repairBatcher, repairInvalid, splitTimeouts, slots });
    this.active = 0;
    this.pending = [];
    this.sequence = 0;
  }

  add(item) {
    return new Promise((resolve, reject) => {
      this.pending.push({ ...item, resolve, reject });
      if (this.pending.length >= this.size) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), 15);
    });
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    // Assemble a batch only when a transport slot is free. Catalog lookups
    // arrive progressively; freezing tiny queued batches multiplies API calls.
    if (!this.pending.length || this.active >= this.concurrency) return;
    if (this.slots && !this.slots.take(this)) return;
    const items = [];
    while (this.pending.length && items.length < this.size) {
      const next = this.pending[0];
      try {
        if (items.length && (next.instructions !== items[0].instructions
          || next.signal !== items[0].signal
          || next.recovery?.startAfter !== items[0].recovery?.startAfter
          || this.prepare([...items, next]).workload.totalChars > this.maxChars)) break;
      } catch (error) {
        // Reject malformed transport input without throwing from a timer or
        // leaking the shared slot. Remaining candidates can still proceed.
        this.pending.shift().reject(error);
        continue;
      }
      items.push(this.pending.shift());
    }
    this.active++;
    this.run(items).catch(error => items.forEach(item => item.reject(error))).finally(() => {
      this.active--;
      this.slots?.release();
      this.flush();
    });
    if (this.pending.length && this.active < this.concurrency) this.timer = setTimeout(() => this.flush(), 0);
  }

  prepare(items) {
    const { input, catalogIdentities, evidenceIdentities } = compactReviewInput(items);
    const { requests } = input;
    const noHue = !hueFamilies(items[0].input.vehicle?.predominantColor).size;
    const exclusions = noHue ? EXCLUSIONS.filter(reason => reason !== 'unrelated_hue') : EXCLUSIONS;
    const schema = object(Object.fromEntries(items.map((item, index) => [`R${index + 1}`,
      this.triage ? { type: 'string', enum: [...exclusions, 'review'] } : {
        anyOf: [{ type: 'string', enum: exclusions }, transportSchema(item,
          requests[index].candidates?.[0]?.catalog_check?.row_refs, Object.keys(evidenceIdentities[index]))],
      }])));
    const envelope = this.triage
      ? 'For EACH R key return ONLY a supported exclusion-category string, or review if any uncertainty remains. These candidates have potentially conflicting hue words or no recognized hue word. Neither the name nor the absence of a hue word justifies exclusion. Read each candidate\'s own evidence and catalog rows. Return review for an undertone, ambiguous marketing name, missing identity, or any finish issue. Do not generate objects, reasons, names or catalog IDs: review schedules the full independent review with the same evidence.'
      : 'Return one independent decision under EACH R key. A confidently excluded candidate MUST return ONLY the exclusion-category string: no object, sources, reason or catalog selections. Objects are ONLY for include decisions. A reason identifying an unrelated hue/model or a navigation label requires exclusion, never include. Commercial name words alone never prove an unrelated visual hue; uncertain appearance still requires inclusion. name=null preserves the input name, otherwise remove only a separately printed catalog identifier; use only fields in its supplied schema. Reason: at most 10 Portuguese words. detail=null normally, or {question,page_ids} for one targeted extractor question. Always return name_status: complete for a full name, unresolved for an incomplete name. Finish fields exist only when requested. Only AFTER paint identity, model and hue checks pass, keep uncertain/incompatible finish in an inclusion object so programmatic finish checks can assess it.';
    const instructions = items[0].instructions
      + (noHue ? '\nNo predominant color was specified. Review all exterior hue families; unrelated_hue is invalid.' : '')
      + '\nBATCH ENVELOPE overrides response shape: ' + envelope
      + ' Always return the outer JSON object keyed by R IDs, even for one request or exclusions: for example {"R1":"unrelated_hue"}. Never return a bare top-level verdict.'
      + ' Catalog selection: select a minimal set of representative K references covering every supported code and distinct finish; do not enumerate redundant editions or equivalent rows. All catalog rows remain available to the separate matcher, including conflicting evidence.'
      + ' Each request owns its source/evidence IDs and catalog rows. Resolve evidence through passages and page_reference through sharedPages. sharedCatalogRows is a table: catalogColumns gives the field name at each array position. Resolve catalog_check.row_refs through this table to read its catalog rows, including complete names, codes, years and finishes. For catalog identity output catalog_refs using ONLY this request\'s K references; the application restores numeric catalog_ids. Never borrow evidence or catalog rows between requests.';
    const pageInstructions = ' Page opening_passage_id refers to the unchanged text in passages. Page catalog_record_ref refers to sharedCatalogRecords; recordColumns names each array position. These D references describe source records, not selectable K catalog identities.';
    const data = { ...input, ...(this.triage && { triage: true }) };
    const prompt = instructions + pageInstructions;
    const workload = requestWorkload(structuredRequest(`${this.stagePrefix}_${this.sequence + 1}`, schema, data, prompt));
    return { input: data, schema, instructions: prompt, catalogIdentities, evidenceIdentities, workload };
  }

  decision(raw, item, catalogIdentities, evidenceIds) {
    const answer = EXCLUSIONS.includes(raw?.decision) ? raw.decision : raw;
    const candidate = item.input.candidates?.[0];
    const requested = hueFamilies(item.input.vehicle?.predominantColor);
    const named = hueFamilies(candidate?.name);
    const swatches = (candidate?.visual_swatches || []).map(swatch => swatch.approximate_family).filter(Boolean);
    const confirmedSwatchConflict = swatches.length > 0 && swatches.every(hue => !requested.has(hue));
    // A compact verdict carries no reason or citation. An uncolored commercial
    // name without consistently contrary swatches needs its full review.
    if (!requested.size && answer === 'unrelated_hue') throw Object.assign(
      new Error('No predominant color was requested; review the candidate without a hue filter'),
      { code: 'REVIEW_REQUIRED' });
    if (this.triage && (answer === 'review' || answer === 'unrelated_hue'
      && !named.size && !confirmedSwatchConflict)) throw Object.assign(
      new Error('Candidate needs its full independent review'), { code: 'REVIEW_REQUIRED' });
    return typeof answer === 'string' && EXCLUSIONS.includes(answer)
      ? { action: 'exclude', exclusion: answer, reason: raw?.reason || answer, catalog_ids: [], detail_question: '' }
      : expandDecision(answer, item, catalogIdentities, evidenceIds);
  }

  async run(items, recovery = {}) {
    items = items.filter(item => {
      if (!item.signal?.aborted) return true;
      item.reject(item.signal.reason);
      return false;
    });
    if (!items.length) return;
    const { input, schema, instructions, catalogIdentities, evidenceIdentities } = this.prepare(items);
    let result;
    try {
      result = await this.execute(`${this.stagePrefix}_${++this.sequence}`, schema,
        input, instructions, items[0].signal, undefined,
        { ...items[0].recovery, ...recovery,
          splitOnTimeout: this.splitTimeouts && items.length > 1 && !recovery.startAfter && !items[0].recovery?.startAfter });
    } catch (error) {
      if (!this.splitTimeouts && error.partialOutput) {
        // Completion owns repair. A cancelled batch can still contain valid
        // siblings; keep them instead of making the entire batch unresolved.
        for (const [index, item] of items.entries()) {
          try {
            const raw = normalizeBatchMember(error.partialOutput[`R${index + 1}`], schema.properties[`R${index + 1}`]);
            if (!matchesSchema(raw, schema.properties[`R${index + 1}`])) throw error;
            const value = this.decision(raw, item, catalogIdentities, evidenceIdentities[index]);
            item.validate?.(value);
            item.resolve(value);
          } catch { item.reject(error); }
        }
        return;
      }
      if (error.code !== 'MODEL_ROUTE_TIMEOUT' || items.length < 2 || recovery.startAfter || !this.splitTimeouts) throw error;
      const unfinished = items.filter((item, index) => {
        const raw = normalizeBatchMember(error.partialOutput?.[`R${index + 1}`], schema.properties[`R${index + 1}`]);
        try {
          if (!matchesSchema(raw, schema.properties[`R${index + 1}`])) return true;
          const value = this.decision(raw, item, catalogIdentities, evidenceIdentities[index]);
          item.validate?.(value);
          item.resolve(value);
          return false;
        } catch { return true; }
      });
      const midpoint = Math.ceil(unfinished.length / 2);
      await Promise.all([unfinished.slice(0, midpoint), unfinished.slice(midpoint)].filter(group => group.length)
        .map(group => this.run(group, { startAfter: error.routeId, splitOnTimeout: false })
          .catch(failure => group.forEach(item => item.reject(failure)))));
      return;
    }

    await Promise.all(items.map(async (item, index) => {
      try {
        item.signal?.throwIfAborted();
        const raw = normalizeBatchMember(result[`R${index + 1}`], schema.properties[`R${index + 1}`]);
        // An explicit exclusion object and its category string have identical
        // meaning. Inclusion-only metadata cannot turn that into a paid repair.
        const answer = EXCLUSIONS.includes(raw?.decision) ? raw.decision : raw;
        if (!matchesSchema(answer, schema.properties[`R${index + 1}`])) {
          throw new Error('Candidate decision does not match its response schema');
        }
        const value = this.decision(raw, item, catalogIdentities, evidenceIdentities[index]);
        item.validate?.(value);
        item.resolve(value);
      } catch (error) {
        if (error.code !== 'REVIEW_REQUIRED' && !error.routeId && result?._routeId) error.routeId = result._routeId;
        // Repair one malformed decision once, without redoing valid siblings.
        try {
          item.signal?.throwIfAborted();
          if (!this.repairInvalid) throw error;
          // Uncertain triage and malformed children share a bounded repair
          // batch. Keep the original instruction string so independent items
          // can share transport; the repair context belongs to that item only.
          const repaired = this.repairBatcher
            ? await this.repairBatcher.add({ ...item,
              input: { ...item.input, review_issue: error.message } })
            : await this.execute(`research_review_repair_${this.stagePrefix}_${++this.sequence}`, item.schema,
              item.input, item.instructions + '\nReturn the single flat object. Repair the previous invalid decision: '
                + error.message, item.signal, item.validate);
          item.validate?.(repaired);
          item.resolve(repaired);
        } catch (failure) { item.reject(failure); }
      }
    }));
  }
}

module.exports = { ReviewBatcher, ReviewSlots };
