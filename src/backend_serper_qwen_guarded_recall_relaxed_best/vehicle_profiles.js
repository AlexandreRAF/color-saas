'use strict';

// Vehicle type changes search vocabulary and source priority, never paint
// eligibility. Unknown types use the general profile and remain searchable.
const PROFILES = {
  car: {
    aliases: ['car', 'cars', 'automobile', 'automovel', 'auto', 'suv', 'pickup', 'picape', 'van'],
    localPalette: 'catálogo cores pintura',
    localParts: 'peças pintadas cor',
    localCodes: 'código tinta original',
    internationalPalette: 'paint color chart',
    internationalParts: 'painted body panels',
    sourceTerms: /brochure|cat[aá]logo|paint|colou?r|cores|pintura|tinta|touch.?up/i,
  },
  motorcycle: {
    aliases: ['motorcycle', 'motorbike', 'moto', 'motocicleta', 'scooter', 'quadriciclo', 'atv'],
    localPalette: 'cores versões pintura original',
    localParts: 'carenagem tanque peças pintadas cor',
    localCodes: 'código cor tinta moto',
    internationalPalette: 'motorcycle paint colour codes',
    internationalParts: 'fairing fuel tank paint code',
    sourceTerms: /moto|motorcycle|fairing|carenagem|tanque|paint|colou?r|cores|pintura|tinta/i,
  },
  truck: {
    aliases: ['truck', 'trucks', 'caminhao', 'caminhão', 'semi', 'tractor unit', 'cavalo mecanico', 'cavalo mecânico'],
    localPalette: 'cores cabine pintura original',
    localParts: 'cabine peças pintadas cor',
    localCodes: 'código tinta cabine',
    internationalPalette: 'truck cab paint colour codes',
    internationalParts: 'cab body panels paint code',
    sourceTerms: /truck|caminh[aã]o|cabine|cab|paint|colou?r|cores|pintura|tinta/i,
  },
  bus: {
    aliases: ['bus', 'buses', 'onibus', 'ônibus', 'coach', 'microonibus', 'micro-ônibus'],
    localPalette: 'cores carroceria pintura original',
    localParts: 'carroceria painéis pintados cor',
    localCodes: 'código tinta carroceria',
    internationalPalette: 'bus coach body paint colours',
    internationalParts: 'coach body panel paint code',
    sourceTerms: /bus|[oô]nibus|coach|carroceria|body|paint|colou?r|cores|pintura/i,
  },
  agricultural: {
    aliases: ['tractor', 'trator', 'agricultural machine', 'agricultural machinery', 'agricultural',
      'colheitadeira', 'harvester', 'plantadeira', 'sprayer', 'pulverizador'],
    localPalette: 'cores pintura original equipamento agrícola',
    localParts: 'capô cabine painéis pintados cor',
    localCodes: 'código tinta trator máquina agrícola',
    internationalPalette: 'agricultural equipment factory paint colours',
    internationalParts: 'tractor hood cab paint code',
    sourceTerms: /tractor|trator|agr[ií]col|harvester|colheitadeira|cabine|paint|colou?r|cores|pintura/i,
  },
  construction: {
    aliases: ['construction machine', 'construction equipment', 'building machine', 'heavy equipment',
      'escavadeira', 'excavator', 'backhoe', 'retroescavadeira', 'loader', 'pa carregadeira',
      'pá carregadeira', 'bulldozer', 'motoniveladora', 'crane', 'guindaste'],
    localPalette: 'cores pintura original máquina construção',
    localParts: 'cabine capô peças pintadas cor',
    localCodes: 'código tinta equipamento construção',
    internationalPalette: 'construction equipment factory paint colours',
    internationalParts: 'equipment cab hood paint code',
    sourceTerms: /excavat|escavad|construction|constru[cç][aã]o|cabine|paint|colou?r|cores|pintura/i,
  },
  general: {
    aliases: [],
    localPalette: 'cores pintura original',
    localParts: 'peças pintadas cor',
    localCodes: 'código tinta original',
    internationalPalette: 'factory paint colour chart',
    internationalParts: 'painted panels paint code',
    sourceTerms: /paint|colou?r|cores|pintura|tinta|cat[aá]logo/i,
  },
};

function vehicleProfile(type) {
  const key = String(type || 'car').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const match = Object.entries(PROFILES).find(([, profile]) => profile.aliases.some(alias => {
    const word = alias.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    return (` ${key} `).includes(` ${word} `);
  }));
  return { kind: match?.[0] || (key ? 'general' : 'car'), ...(match?.[1] || (key ? PROFILES.general : PROFILES.car)) };
}

module.exports = { vehicleProfile };
