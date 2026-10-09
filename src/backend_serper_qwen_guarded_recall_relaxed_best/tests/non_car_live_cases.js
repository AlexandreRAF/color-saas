'use strict';

// These are live regression inputs, not claims about a complete factory palette.
// Keep them separate from the offline suite because each run uses paid APIs.
const cases = Object.freeze({
  'honda-cg160': { automobileType: 'motorcycle', brand: 'Honda', model: 'CG 160',
    manufacturingYear: 2020, predominantColor: 'vermelho', country: 'Brazil' },
  'volvo-fh540': { automobileType: 'truck', brand: 'Volvo', model: 'FH 540',
    manufacturingYear: 2022, predominantColor: 'branco', country: 'Brazil' },
  'marcopolo-paradiso': { automobileType: 'bus', brand: 'Marcopolo', model: 'Paradiso 1200 G7',
    manufacturingYear: 2018, predominantColor: 'branco', country: 'Brazil' },
  'massey-275': { automobileType: 'tractor', brand: 'Massey Ferguson', model: '275',
    manufacturingYear: 1980, predominantColor: 'vermelho', country: 'Brazil' },
  'cat-320': { automobileType: 'excavator', brand: 'Caterpillar', model: '320',
    manufacturingYear: 2020, predominantColor: 'amarelo', country: 'Brazil' },
  'sprinter-415': { automobileType: 'bus', brand: 'Mercedes-Benz', model: 'Sprinter 415',
    manufacturingYear: 2018, predominantColor: 'branco', country: 'Brazil' },
});

module.exports = { cases };
