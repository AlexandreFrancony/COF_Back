// COF2 base formulas — see docs/regles-formules.md for the rulebook references.

// Rang → niveau requis (table p.39, commune aux voies normales et de prestige).
export const NIVEAU_REQUIS_PAR_RANG = { 1: 1, 2: 2, 3: 3, 4: 5, 5: 7, 6: 9, 7: 11, 8: 13 };

// PV are tracked as a ledger (character.pv_body_total) rather than a closed formula, so a
// profil hybride (p.176-177) can mix families across levels: pv_max = pv_body_total + CON*level
// still applies CON retroactively (CON is recomputed live, not stored in the ledger).
// Level 1 always seeds pv_body_total = 2*pvBase of the principal profil's family — a hybrid
// pick can only ever happen on a later level-up, never at creation.
export function seedPvBodyTotal(pvBase) {
  return 2 * pvBase;
}

// One level's PV gain, from the distinct famille pv_base values touched that level (p.176):
// same family all along -> that family's pv_base; mixed families -> their average, with a
// half-point carried and resolved on the alternating floor/ceil rule the book describes.
export function computePvBodyGain(pvBases, pendingHalf) {
  const avg = pvBases.reduce((a, b) => a + b, 0) / pvBases.length;
  if (Number.isInteger(avg)) return { gain: avg, pendingHalf };
  return pendingHalf
    ? { gain: Math.ceil(avg), pendingHalf: false }
    : { gain: Math.floor(avg), pendingHalf: true };
}

export function computeDrCount(con, drBonus) {
  return Math.max(0, 2 + con + drBonus);
}

export function computePc(cha, pcBonus) {
  return 2 + cha + pcBonus;
}

export function computePmMax(sortsCount, vol) {
  return sortsCount > 0 ? sortsCount + vol : 0;
}

export function computeInitiative(per) {
  return 10 + per;
}

export function computeDefenseBase(agi, armureBonus = 0, bouclierBonus = 0) {
  return 10 + agi + armureBonus + bouclierBonus;
}

export function computeValeursAttaque(level, caracteristiques) {
  const cappedLevel = Math.min(level, 10); // attack values stop increasing past level 10
  return {
    contact: cappedLevel + caracteristiques.FOR,
    distance: cappedLevel + caracteristiques.AGI,
    magique: cappedLevel + caracteristiques.VOL,
  };
}

// A handful of capacités let a character use a "better" caractéristique in place of the usual
// one for a specific formula (e.g. the forgesort's Grosse tête, p.176: INT instead of CON for
// PV, "s'il le souhaite" — modeled here as an automatic max() rather than a stored per-player
// choice, since the book only ever offers this as a strict upside). Data-driven off
// rules_capacites.effect so a future capacité with the same shape needs no code change, only a
// row: { type: 'stat_substitute_max', in: 'pv_max', replace: 'CON', with: 'INT' }.
// capaciteEffects is every effect JSONB a character currently owns (any rang/voie), already
// rang-gated by the caller's join — this only reads entries whose `in` matches the formula
// being computed, everything else is silently ignored (forward-compatible with effect types
// this function doesn't know about yet).
function applyStatSubstitutions(caracteristiques, capaciteEffects, formulaName) {
  let result = caracteristiques;
  for (const effect of capaciteEffects) {
    if (effect?.type === 'stat_substitute_max' && effect.in === formulaName) {
      const better = Math.max(result[effect.replace], result[effect.with]);
      if (better !== result[effect.replace]) result = { ...result, [effect.replace]: better };
    }
  }
  return result;
}

/**
 * Recomputes every derived stat for a character.
 * @param {object} familleRow - row from rules_familles for the character's PRINCIPAL profil
 *   (pv_base, dr_die, dr_bonus, pc_bonus) — DR and PC always come from the principal profil,
 *   never averaged across a profil hybride's families (p.176: "Il permet de déterminer le DR
 *   et certains avantages ... PC, DR ou capacité de rang 2").
 * @param {object} character - the characters row (caracteristiques, level, pv_body_total,
 *   pc_bonus_orphan, dr_bonus_orphan, pm_bonus_orphan)
 * @param {number} sortsCount - number of spell-type capacités known
 * @param {boolean} hasHumanOrigin - owns the Voie de l'Humain's rang-1 "Diversité" capacité,
 *   which grants +1 PC on top of the usual formula (p.46) — the +3 to two narrative skill
 *   domains from the same capacité isn't tracked here, the app has no skill-check system.
 * @param {number} armureBonus - flat DEF bonus from the character's equipped armor (rules_armures
 *   type='armure', 0 if none) — stacks with bouclierBonus (p.188: armor + shield both apply).
 *   No AGI cap or PM spellcasting surcharge, same deliberate scope cut as profils hybrides'
 *   armor/weapon cross-restrictions (p.177-178), left to the GM at the table.
 * @param {number} bouclierBonus - flat DEF bonus from the character's equipped shield
 *   (rules_armures type='bouclier', 0 if none).
 * @param {object[]} capaciteEffects - every non-null rules_capacites.effect the character
 *   currently owns (rang-gated), e.g. for the pv_max CON/INT substitution above.
 */
export function computeDerivedStats(
  familleRow, character, sortsCount, hasHumanOrigin = false, armureBonus = 0, bouclierBonus = 0,
  capaciteEffects = []
) {
  const { caracteristiques: c, level } = character;
  const cForPv = applyStatSubstitutions(c, capaciteEffects, 'pv_max');
  return {
    pv_max: character.pv_body_total + cForPv.CON * level,
    dr_max: computeDrCount(c.CON, familleRow.dr_bonus + character.dr_bonus_orphan),
    dr_die: familleRow.dr_die,
    points_chance: computePc(c.CHA, familleRow.pc_bonus + character.pc_bonus_orphan + (hasHumanOrigin ? 1 : 0)),
    pm_max: computePmMax(sortsCount, c.VOL) + character.pm_bonus_orphan,
    initiative: computeInitiative(c.PER),
    defense: computeDefenseBase(c.AGI, armureBonus, bouclierBonus),
    valeurs_attaque: computeValeursAttaque(level, c),
  };
}
