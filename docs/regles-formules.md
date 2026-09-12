# Formules de règles COF2 (référence pour le moteur de calcul)

Ces formules sont universelles (indépendantes du profil/peuple, sauf mention contraire) — à implémenter en code applicatif, pas en données DB. Les valeurs qui varient par famille/profil/peuple sont déjà en base (`rules_familles`, `rules_profils`, `rules_peuples`).

Source : COF2-RèglesBasiques.pdf, p.22-32 (création) et p.38-43 (progression).

## Création de personnage (niveau 1)

- **PV** = `(2 × rules_familles.pv_base) + CON` — stocké comme amorce du grand livre `pv_body_total` (voir "Profils hybrides" plus bas), la formule fermée ne s'applique qu'au niveau 1
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
- **Nouvelle voie** : possible dès le niveau 2, parmi les 5 voies du profil principal (accessible à tout niveau) ou hors profil (profil hybride, voir plus bas — l'app ne demande pas de justification narrative, c'est au MJ de la faire respecter à la table).
- **Dés évolutifs (d4°)** — table universelle :

  | Niveau | 1-5 | 6-8 | 9-11 | 12-14 | 15+ |
  |--------|-----|-----|------|-------|-----|
  | Dé     | d4  | d6  | d8   | d10   | d12 |

- **Voies de prestige** — accessible à partir du niveau 5 (une seule dans toute la carrière). Niveau requis par rang (table universelle, sauf exception explicite sur une voie comme "Voie du chevalier dragon" qui ouvre plus tard) :

  | Rang   | 4 | 5 | 6 | 7  | 8  |
  |--------|---|---|---|----|----|
  | Niveau | 5 | 7 | 9 | 11 | 13 |

  `rules_voies.niveau_prestige_requis` stocke le niveau du rang 4 (le point d'ouverture) ; les rangs suivants suivent la table ci-dessus (+2 niveaux par rang) sauf indication contraire dans la description.

  **Implémentation** : `type='prestige'` (52 voies extraites, `profil_id`/`peuple_id` NULL — accessibles à n'importe quel profil). L'acquisition initiale octroie directement le **rang 4** (coût 2 points, comme un rang 3+) plutôt que le rang 1 ; les rangs suivants passent par le même endpoint générique de montée de rang que les voies normales (la table de niveaux requis est identique). Verrouillé côté backend : `character.level >= niveau_prestige_requis`, et une seule voie de prestige possédée à la fois par personnage.

- **Changement d'orientation** : à chaque niveau, oublier 1 capacité (2 si INT ≥ +2) et la remplacer en suivant les règles normales de progression. Impossible d'oublier : la capacité de voie de peuple (auto/gratuite), les 2 capacités de rang 1 du profil principal acquises au niveau 1, ou un rang intermédiaire sans avoir d'abord oublié les rangs au-dessus (pas de "trous" dans une voie).

## Profils hybrides (chapitre 9, p.176-179)

- **Condition** : un personnage ne peut choisir une voie hors de son profil principal que tant qu'il reste au moins une des 5 voies de ce profil dans laquelle il n'a **encore rien investi**. Dès que les 5 sont entamées (ne serait-ce qu'au rang 1), plus aucun nouveau profil hybride n'est possible — implémenté via `character_voies` : compte des voies dont `voie.profil_id = character.profil_id`, doit être < 5.
- **PV** : ne suit plus la formule fermée `pv_base*(niveau+1)+CON*niveau` dès qu'un personnage devient hybride, car `pv_base` dépend de la famille — remplacé par un **grand livre** (`characters.pv_body_total`), incrémenté à chaque fois que tous les points de capacité d'un niveau ont été dépensés :
  - Amorcé à la création à `2 × pv_base` de la famille du profil principal (le niveau 1 n'est jamais hybride).
  - À chaque niveau, la famille de chaque voie de type `profil` achetée est enregistrée (`characters.level_up_families`) ; une fois les points du niveau épuisés, le gain de PV de ce niveau = `pv_base` de la famille si une seule famille a été touchée, sinon la **moyenne** des familles distinctes touchées (arrondie au demi-point inférieur la première fois, supérieur la fois suivante, en alternance — `characters.pv_pending_half`).
  - Une voie de peuple, de mage ou personnalisée (`profil_id` NULL) ne compte pour aucune famille ; si un niveau entier ne touche que ce type de voie, on retombe sur la famille du profil principal par défaut (cas non couvert explicitement par le livre).
  - `pv_max = pv_body_total + CON × niveau` — le CON reste appliqué rétroactivement à chaque niveau comme avant.
- **DR et PC** viennent toujours uniquement du profil principal, jamais moyennés (p.176 : "Il permet de déterminer le DR et certains avantages ... PC, DR ou capacité de rang 2").
- **Hors scope volontairement** : restrictions croisées d'armes/armures et surcoût en PM pour lancer un sort en armure non autorisée (p.177-178) — nécessiteraient un référentiel armes/armures qui n'existe pas dans l'app ; laissé à la gestion manuelle du MJ.

## Changement d'orientation (p.42-43)

- À chaque montée de niveau : +1 jeton "oubli" (`characters.forgets_available`), +2 si INT ≥ +2.
- Oublier une capacité = retirer le rang le plus haut actuellement possédé d'une voie (jamais un rang arbitraire, ce qui empêche naturellement les "trous" dans une voie) et récupérer son coût en points de capacité (1 pour rang ≤ 2, 2 pour rang ≥ 3 — même barème que l'acquisition) pour le dépenser ailleurs.
- Protégé : toute voie acquise gratuitement à la création (`obtained_at_level = 1`) ne peut pas descendre sous le rang 1 — "impossible d'oublier sa jeunesse" (les 2 capacités de rang 1 du profil principal + la voie de peuple).
- **Simplification acceptée** : la capacité de rang 2 offerte au mage à la création (bonus mage) est aussi `obtained_at_level = 1` mais démarre à rang 2 sans qu'aucun point n'ait été payé — le garde-fou ci-dessus ne bloque qu'à partir du rang 1, donc l'oublier rembourse un point qui n'a jamais été dépensé. Cas rare et sans enjeu réel (application MJ, pas de compétitif) ; pas de colonne dédiée ajoutée pour le couvrir.
- Ne recalcule pas rétroactivement le ledger de PV (`pv_body_total`) : les PV déjà gagnés à un niveau passé restent acquis même si la capacité qui a motivé leur famille est ensuite oubliée.

## PM et sorts appris par une autre voie ("poupées russes")

Un sort obtenu via une capacité d'appel (ex: "choisissez une capacité de rang 1 d'une autre voie") rapporte quand même 1 PM et utilise le coût du rang habituel du sort. La caractéristique de magie utilisée est celle du profil d'origine du sort. Pas d'appel en cascade (une capacité d'appel ne peut pas elle-même être un appel).
