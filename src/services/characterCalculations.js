// COF2 base formulas — see docs/regles-formules.md for the rulebook references.

export function computePvMax(pvBase, con) {
  return 2 * pvBase + con;
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

export function computeDefenseBase(agi) {
  return 10 + agi;
}

export function computeValeursAttaque(level, caracteristiques) {
  return {
    contact: level + caracteristiques.FOR,
    distance: level + caracteristiques.AGI,
    magique: level + caracteristiques.VOL,
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
    pv_max: computePvMax(familleRow.pv_base, caracteristiques.CON),
    de_recuperation: `${computeDrCount(caracteristiques.CON, familleRow.dr_bonus)}${familleRow.dr_die}`,
    points_chance: computePc(caracteristiques.CHA, familleRow.pc_bonus),
    pm_max: computePmMax(sortsCount, caracteristiques.VOL),
    initiative: computeInitiative(caracteristiques.PER),
    defense: computeDefenseBase(caracteristiques.AGI),
    valeurs_attaque: computeValeursAttaque(level, caracteristiques),
  };
}
