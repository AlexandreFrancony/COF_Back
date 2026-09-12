// COF2 base formulas — see docs/regles-formules.md for the rulebook references.

// PV(level) = pvBase*(level+1) + CON*level — closed form of "2*pvBase+CON at
// level 1, then +pvBase+CON per level after", so a later CON change is applied
// retroactively to every level already gained just by recomputing from level.
export function computePvMax(pvBase, con, level = 1) {
  return pvBase * (level + 1) + con * level;
}

// Rang → niveau requis (table p.39, commune aux voies normales et de prestige).
export const NIVEAU_REQUIS_PAR_RANG = { 1: 1, 2: 2, 3: 3, 4: 5, 5: 7, 6: 9, 7: 11, 8: 13 };

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

export function computeDefenseBase(agi) {
  return 10 + agi;
}

export function computeValeursAttaque(level, caracteristiques) {
  const cappedLevel = Math.min(level, 10); // attack values stop increasing past level 10
  return {
    contact: cappedLevel + caracteristiques.FOR,
    distance: cappedLevel + caracteristiques.AGI,
    magique: cappedLevel + caracteristiques.VOL,
  };
}

/**
 * Recomputes every derived stat for a character.
 * @param {object} familleRow - row from rules_familles (pv_base, dr_die, dr_bonus, pc_bonus)
 * @param {object} caracteristiques - { AGI, CON, FOR, PER, CHA, INT, VOL }
 * @param {number} level
 * @param {number} sortsCount - number of spell-type capacités known
 */
export function computeDerivedStats(familleRow, caracteristiques, level, sortsCount) {
  return {
    pv_max: computePvMax(familleRow.pv_base, caracteristiques.CON, level),
    de_recuperation: `${computeDrCount(caracteristiques.CON, familleRow.dr_bonus)}${familleRow.dr_die}`,
    points_chance: computePc(caracteristiques.CHA, familleRow.pc_bonus),
    pm_max: computePmMax(sortsCount, caracteristiques.VOL),
    initiative: computeInitiative(caracteristiques.PER),
    defense: computeDefenseBase(caracteristiques.AGI),
    valeurs_attaque: computeValeursAttaque(level, caracteristiques),
  };
}
