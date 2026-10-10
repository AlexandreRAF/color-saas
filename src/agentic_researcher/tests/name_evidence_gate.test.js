const test = require('node:test');
const assert = require('node:assert/strict');

const { hasNameLeadEvidence } = require('../paint_evidence');
const { analyzePage } = require('../page_analysis');

test('name clarification retains fragments, accents, code-linked aliases and uncertain initials', () => {
  assert.equal(hasNameLeadEvidence('A general repair manual.', 'Hyper', ['P2S']), false);
  assert.equal(hasNameLeadEvidence('General metallic paint preparation.', 'Hyper Metallic', []), false);
  assert.equal(hasNameLeadEvidence('Hyper White Tricoat', 'Hyper', []), true);
  assert.equal(hasNameLeadEvidence('Rally Red', 'Rall', []), true);
  assert.equal(hasNameLeadEvidence('Cinza Titanio', 'Titânio', []), true);
  assert.equal(hasNameLeadEvidence('N2 | Pure Pearl White', 'Powder-P.-White-P.', ['N2']), true);
  assert.equal(hasNameLeadEvidence('Slate Gray P2S', 'Hyper', ['P2S']), true);
  assert.equal(hasNameLeadEvidence('Pearl White', 'P.-W.', []), true);
  assert.equal(hasNameLeadEvidence('Any complete vehicle palette.', undefined), true);
});

test('name clarification analyzes matching segments without processing unrelated manual sections', async () => {
  let calls = 0;
  const result = await analyzePage({ url: 'https://example.com/manual.pdf',
    text: 'Preparation and general repair instructions.\n'.repeat(500)
      + '\nHyper Silver P2S\n' + 'Tools and surface preparation.\n'.repeat(500) }, {
    model: 'Example', paintNameLead: 'Hyper Metallic', paintCodeLeads: ['P2S'],
  }, { apiKey: 'test-key', provider: 'openai', deferAudits: true, segmentChars: 2000,
    modelRouting: { openrouterApiKey: '', geminiApiKey: '' },
    request: async () => {
      calls++;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({
        status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"candidates":[]}' }] }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      }) };
    } });
  assert.ok(calls >= 1 && calls < result.segments);
  assert.equal(result.skippedSegments, result.segments - calls);
  assert.equal(result.failures.length, 0);
});

test('an unrelated large clarification page sends no extraction requests', async () => {
  const result = await analyzePage({ url: 'https://example.com/repair.pdf',
    text: 'General repair procedures and preparation instructions.\n'.repeat(1000) }, {
    model: 'Example', paintNameLead: 'Hyper', paintCodeLeads: ['P2S'],
  }, { apiKey: 'test-key', provider: 'openai',
    request: async () => assert.fail('No evidence can support this name clarification') });
  assert.equal(result.requests, 0);
  assert.equal(result.segments, 0);
  assert.equal(result.skippedReason, 'name_lead_absent');
});
