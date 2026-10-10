'use strict';

const { vehicleProfile } = require('./vehicle_profiles');
const { mentions } = require('./search_groups');

const customLivery = /\b(?:livery|identidade visual|pintura alusiva|pintura personalizada|plotagem|envelopamento|adesivagem|operadora|frotista|via[cç][aã]o)\b/iu;
const chassisOnly = /\b(?:chassi|chassis|cabine|cab)\b/iu;
const bodyOrFactory = /\b(?:carroceria|bodywork|exterior|f[aá]brica|factory|original|cat[aá]logo|catalog|c[oó]digo(?: de)? (?:cor|tinta)|paint code)\b/iu;

// An operator's livery and the chassis maker's paint are not proof that a
// coachbuilder offered the named paint on every bus of this body model.
function busBodyPaintPossible(page, color, vehicle) {
  if (vehicleProfile(vehicle?.automobileType).kind !== 'bus') return true;
  const passages = [
    ...(page?.candidates || []).filter(candidate => candidate.name === color.name)
      .flatMap(candidate => candidate.evidence || []),
    ...String(page?.text || '').split(/(?<=[.!?])\s+|\r?\n/),
  ].filter(passage => mentions(passage, color.name));
  if (!passages.length) return false;
  return passages.some(passage => !customLivery.test(passage)
    && (!chassisOnly.test(passage) || bodyOrFactory.test(passage)));
}

module.exports = { busBodyPaintPossible };
