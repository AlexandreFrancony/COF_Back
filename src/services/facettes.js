// Augustin Moëdec's homebrew facettes — hardcoded to these exact voie_ids, gated on
// custom_data.threshold_percent (only set for him). Mirrors COF_Front's utils/facettes.js.
export const FACETTE_VOIE_IDS = { calme: [78, 80], mage: [82, 83] };
const OTHER_FACETTE = { calme: 'mage', mage: 'calme' };

export function facetteOf(character, voieId) {
  if (character.custom_data?.threshold_percent == null) return null;
  const id = Number(voieId);
  return Object.keys(FACETTE_VOIE_IDS).find((f) => FACETTE_VOIE_IDS[f].includes(id)) ?? null;
}

/**
 * Splits a rang's cost between the facette's free points and regular capacity points. Every
 * regular point spent in one facette grants a free point in the other (his GM's rule); free
 * points never grant more. Unused free points stay in custom_data.facette_bonus for later levels.
 * Returns { regular, customData } — customData is null when nothing facette-related changes.
 */
export function facettePayment(character, voieId, cost) {
  const facette = facetteOf(character, voieId);
  if (!facette) return { regular: cost, customData: null };
  const bonus = { calme: 0, mage: 0, ...character.custom_data.facette_bonus };
  const free = Math.min(bonus[facette], cost);
  const regular = cost - free;
  bonus[facette] -= free;
  bonus[OTHER_FACETTE[facette]] += regular;
  return { regular, customData: { ...character.custom_data, facette_bonus: bonus } };
}
