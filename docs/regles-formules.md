# Formules de règles COF2 (référence pour le moteur de calcul)

Ces formules sont universelles (indépendantes du profil/peuple, sauf mention contraire) — à implémenter en code applicatif, pas en données DB. Les valeurs qui varient par famille/profil/peuple sont déjà en base (`rules_familles`, `rules_profils`, `rules_peuples`).

Source : COF2-RèglesBasiques.pdf, p.22-32 (création) et p.38-43 (progression).

## Création de personnage (niveau 1)

- **PV** = `(2 × rules_familles.pv_base) + CON`
- **DR (dé de récupération)** = `[2 + CON] + rules_familles.dr_bonus`, dé = `rules_familles.dr_die`. Cas particulier : CON = -2 → 0 DR (pas de récupération rapide possible, seulement complète, et le dé n'obtient jamais le résultat max).
- **PC (points de chance)** = `[2 + CHA] + rules_familles.pc_bonus`
- **PM (points de mana)** = `nombre de capacités de type sort (marquées *) connues + VOL` — 0 si aucun sort. Recalculé à chaque nouveau sort appris (jamais de gain automatique au niveau).
- **Initiative** = `10 + PER` (+ bonus de capacités)
- **Défense** = `10 + AGI` (+ bonus d'armure/bouclier/capacités)
- **Valeurs d'attaque** :
  - Contact = `niveau + FOR`
  - Distance = `niveau + AGI`
  - Magique = `niveau + VOL`
- **Dommages** : FOR ajoutée aux DM des armes de contact ; rien pour les armes à distance ; bonus magique seulement si précisé par la capacité.

## Ajustement de peuple (`rules_peuples.ajustements`)

Format `{"bonus": [...], "malus": [...]}` — le joueur choisit une caractéristique dans chaque liste (sauf humain : `"plus_faible"` = +1 à une des deux caractéristiques les plus faibles du personnage, pas de malus).

## Voies (création)

- 3 voies au niveau 1 : 2 voies du profil principal (rang 1 auto) + 1 voie de peuple (rang 1 auto).
- Mages : capacité de rang 2 supplémentaire dès le niveau 1 (dans une des 2 voies de profil, ou rang 2 de la Voie du Mage à la place de la voie de peuple).
- Max 6 voies + la voie de peuple sur toute la carrière.

## Montée de niveau

- **+2 points de capacité** par niveau, à dépenser immédiatement (jamais de réserve). Coût : 1 point pour le rang 2, 2 points pour les rangs 3+.
- **Point de capacité orphelin** (1 point non dépensable car il ne reste que des capacités à 2 points) : échangeable contre **1 PC**, **1 DR**, **2 PV**, ou **2 PM**.
- **Nouvelle voie** : possible dès le niveau 2, parmi les 5 voies du profil principal (accessible à tout niveau) ou hors profil (nécessite un événement de jeu validé par le MJ, sauf profil hybride).
- **Dés évolutifs (d4°)** — table universelle :

  | Niveau | 1-5 | 6-8 | 9-11 | 12-14 | 15+ |
  |--------|-----|-----|------|-------|-----|
  | Dé     | d4  | d6  | d8   | d10   | d12 |

- **Voies de prestige** — accessible à partir du niveau 5 (une seule dans toute la carrière). Niveau requis par rang (table universelle, sauf exception explicite sur une voie comme "Voie du chevalier dragon" qui ouvre plus tard) :

  | Rang   | 4 | 5 | 6 | 7  | 8  |
  |--------|---|---|---|----|----|
  | Niveau | 5 | 7 | 9 | 11 | 13 |

  `rules_voies.niveau_prestige_requis` stocke le niveau du rang 4 (le point d'ouverture) ; les rangs suivants suivent la table ci-dessus (+2 niveaux par rang) sauf indication contraire dans la description.

- **Changement d'orientation** : à chaque niveau, oublier 1 capacité (2 si INT ≥ +2) et la remplacer en suivant les règles normales de progression. Impossible d'oublier : la capacité de voie de peuple (auto/gratuite), les 2 capacités de rang 1 du profil principal acquises au niveau 1, ou un rang intermédiaire sans avoir d'abord oublié les rangs au-dessus (pas de "trous" dans une voie).

## PM et sorts appris par une autre voie ("poupées russes")

Un sort obtenu via une capacité d'appel (ex: "choisissez une capacité de rang 1 d'une autre voie") rapporte quand même 1 PM et utilise le coût du rang habituel du sort. La caractéristique de magie utilisée est celle du profil d'origine du sort. Pas d'appel en cascade (une capacité d'appel ne peut pas elle-même être un appel).
