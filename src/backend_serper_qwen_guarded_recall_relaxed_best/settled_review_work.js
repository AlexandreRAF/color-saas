'use strict';

const { reviewedColors } = require('./candidate_inventory');
const { auditOmissions } = require('./omission_review');

// This queue starts only after discovery seals the inventory. It consumes final
// candidate decisions, not speculative sightings, and joins before final output.
class SettledReviewWork {
  constructor(run, vehicle) {
    Object.assign(this, { run, vehicle, audits: [], matches: [], jobs: [], seen: new Set(), matchSeen: new Set() });
    this.activeAudits = 0;
    this.sequence = 0;
  }

  add(candidates, decisions, unresolvedNames = []) {
    const withheld = new Set(unresolvedNames.map(candidate => candidate.name));
    const colors = reviewedColors(candidates, decisions, { onUnresolved: candidate => withheld.add(candidate.name) });
    this.run.verificationResearch?.offer(colors);
    for (const color of colors) {
      const key = JSON.stringify(color);
      if (this.matchSeen.has(key)) continue;
      this.matchSeen.add(key);
      this.matches.push(color);
    }
    for (const candidate of candidates) {
      const decision = decisions[candidate.id];
      const omitted = decision && (typeof decision === 'string' || decision.exclude_reason
        || decision.action === 'exclude' || decision.name_status === 'unresolved' || withheld.has(candidate.name));
      if (!omitted || this.seen.has(candidate.id) || this.run.options.verification === false) continue;
      this.seen.add(candidate.id);
      this.audits.push({ candidate, decision, withheld: withheld.has(candidate.name) });
    }
    if (this.audits.length >= 24 || this.matches.length >= 6) this.flush();
    else if (this.matches.length && !this.timer) this.timer = setTimeout(() => this.flush(), 100);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.matches.length) {
      try { this.run.codeMatches.start(this.matches.splice(0)); }
      catch (error) { this.run.warn('code_matching', error); }
    }
    // Assemble only after admission. Freezing tiny batches while both slots
    // are busy creates many serial calls instead of filling the next batch.
    while ((this.audits.length >= 24 || this.finishing && this.audits.length) && this.activeAudits < 2) {
      const batch = this.audits.splice(0, 24);
      const sequence = ++this.sequence;
      this.activeAudits++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.activeAudits--;
        this.flush();
      };
      // Limit audit calls, not their downstream main-agent repairs. Otherwise
      // two slow repairs occupy both audit slots and starve untouched candidates.
      const job = (async () => {
        const decisions = Object.fromEntries(batch.map(item => [item.candidate.id, item.decision]));
        try {
          const summary = await auditOmissions(this.run, this.vehicle, batch.map(item => item.candidate), decisions,
            batch.filter(item => item.withheld).map(item => item.candidate), {
              releaseBudget: false, stagePrefix: `final_verification_omissions_ready_${sequence}`,
              auditLimit: async execute => { try { return await execute(); } finally { release(); } },
            });
          return { summary, decisions };
        } catch (error) {
          this.run.warn('omission_review', error);
          return { summary: { total: batch.length, checked: 0, flagged: 0, recovered: 0,
            incomplete: batch.length, repairFailures: 0 }, decisions: {} };
        } finally { release(); }
      })();
      // finish/drain observes failures even if the caller aborts meanwhile.
      job.catch(() => {});
      this.jobs.push(job);
    }
  }

  async finish(candidates, decisions, unresolvedNames) {
    this.finishing = true;
    this.add(candidates, decisions, unresolvedNames);
    this.flush();
    const summary = { total: 0, checked: 0, flagged: 0, recovered: 0, incomplete: 0, repairFailures: 0 };
    try {
      const completed = await this.settle();
      for (const result of completed) {
        Object.assign(decisions, result.decisions);
        for (const [key, count] of Object.entries(result.summary)) {
          if (typeof count === 'number') summary[key] = (summary[key] || 0) + count;
        }
      }
      if (this.run.options.verification === false) summary.status = 'disabled';
      this.run.dump('omission-review', summary);
      return summary;
    } finally { this.run.routing?.budget?.finishOmissionAudit?.(); }
  }

  async drain() {
    this.finishing = true;
    await this.settle();
  }

  async settle() {
    const results = [];
    let joined = 0;
    // Releasing a transport slot can append new jobs while we await repairs.
    // Join those too before reporting coverage or releasing reserved funds.
    do {
      this.flush();
      const jobs = this.jobs.slice(joined);
      joined += jobs.length;
      results.push(...await Promise.all(jobs));
    } while (joined < this.jobs.length || this.audits.length);
    return results;
  }
}

module.exports = { SettledReviewWork };
