'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogPortugueseName } = require('../portuguese_names');
const { brandKey } = require('../database_code_agent');
const { outputColors } = require('../final_output');
const { catalogEvidence } = require('../final_verification_agent');

const color = { name: 'Platinum Gray', sources: ['https://example.test/paint'],
  code_candidates: [{ universal_code: 'LD7X', manufacturer: 'VW', description: 'PLATINUM GREY MET' }] };
const row = { candidate_id: 1, catalog: 'lazzumix', description: 'CINZA PLATINUM MET',
  manufacturer: 'VOLKSWAGEN', universal_code: 'LD7X,2R2R', year: '2015' };
const sameMaker = (a, b) => brandKey(a) === brandKey(b);

test('published Portuguese catalog aliases retain international names and provenance for verification', () => {
  const localized = { ...color, _catalogName: catalogPortugueseName(color, [row], sameMaker) };
  const [output] = outputColors([localized]);
  assert.equal(output.name, 'Cinza Platinum');
  assert.deepEqual(output.aliases, ['Platinum Gray']);
  assert.deepEqual(output.catalogSources, [{ catalog: 'lazzumix', recordId: 1 }]);
  assert.deepEqual(output.sources, color.sources);
  assert.ok(catalogEvidence(output, [localized]).some(page => page.text.includes('CINZA PLATINUM MET')));
});

test('shared codes cannot localize a different name, version, manufacturer or incompatible finish', () => {
  for (const change of [{ description: 'CINZA PLATINUM II MET' }, { description: 'CINZA OUTRO MET' },
    { manufacturer: 'FIAT' }, { universal_code: 'D7Y' }, { description: 'CINZA PLATINUM SOLID' }]) {
    assert.equal(catalogPortugueseName(color, [{ ...row, ...change }], sameMaker), null);
  }
  assert.equal(catalogPortugueseName({ ...color, code_candidates: [color.code_candidates[0],
    { ...color.code_candidates[0], universal_code: 'D7Y' }] }, [row], sameMaker), null);
});
