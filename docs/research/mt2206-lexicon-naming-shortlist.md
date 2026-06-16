# mt#2206 — Full Lexicon naming pass: ranked, screened shortlist (Minsky rename candidate search)

**Date:** 2026-05-31 · **Status:** research artifact (provenance) · **Feeds:** mt#2046 umbrella (keep/rename/defer verdict) · **Method:** four multi-agent workflows via the `name-product` skill (mt#2045) / Lexicon framework

This is the rigorous-invent deliverable mt#2046 sub-investigation #1 requires. It does **not** make the naming decision (principal-reserved) and does **not** execute a rename. The concise version lives on the mt#2206 spec `## Outcome`; this file is the full provenance.

---

## Headline

A four-pass search (two generation methodologies, two live screens) took the problem from a saturated dead-end to a genuine answer:

- The **trademark/domain screen — not generation quality — is the binding constraint.** 427+ candidates were generated; the AI/software namespace (IC-009/042 + `.com`/`.ai`/`.dev`) is brutally saturated.
- The decisive move was **raising the dimensionality of generation**: replacing one blended brief + physical-domain disguises with **nine orthogonal conceptual-pillar bases**, adding a **distinctiveness (ownability) axis**, and reading a **multi-profile Pareto front** instead of one ranking.
- That escaped the fit-vs-clean tradeoff: the final pass produced **5 of 15 candidates that are simultaneously high-myth, trademark-clean, AND domain-acquirable** — the point the earlier passes proved did not exist in their basins.

**Strategic consequence for mt#2046:** the trademark-driven argument _against_ renaming is materially **weakened** — a clean, on-theme, ownable successor name is reachable. The remaining counterweights (4 years of `Minsky` brand equity, full migration cost, first-hearing accessibility, taste) are unchanged and are the principal's to weigh.

---

## Method & provenance

Four background workflows (~7.5M subagent tokens total):

| Run               | Purpose                                               | Outcome                                  |
| ----------------- | ----------------------------------------------------- | ---------------------------------------- |
| `wf_92e7e1a7-f9a` | Generate v1 (5 physical-domain disguised briefs)      | **Rejected**                             |
| `wf_44bfa9bf-fa8` | Generate v2 (corrected rubric)                        | superseded                               |
| `wf_23d039ca-a97` | Screen v2 survivors (Markbase + whois)                | 3/33 clean-and-acquirable                |
| `wf_f00c0152-ccb` | Generate v3 (9 orthogonal pillar bases, Pareto sweep) | **the winning basis**                    |
| `wf_4a06cfe5-ce5` | Screen v3 robust-top (Markbase + whois)               | **5/15 clean-and-acquirable, high-myth** |

All generation used the topology-agnostic recursion-aware brief (no "single principal" framing; per mt#1953 / mt#2194). Screens used Markbase (free USPTO mirror, query form `GET https://api.markbase.co/search?q=<name>`) for IC-009/042 + `whois <name>.{com,ai,dev}` (primary) / RDAP (secondary) for domains. **Trademark status is mutable — reconfirm via USPTO TSDR before relying; full clearance is parked at mt#2189.** These are pre-filing risk screens, not legal opinions.

### Pass v1 — rejected (the rubric phoneme-density trap)

5 disguised briefs → 230 raw → 208 unique. Over-instructed coinage (186/208 abstract) + a sound-symbolism-weighted rubric collapsed into a **phoneme-density sort**: the top-30 was **30/30 V/Z/X coinages** (Zaxon, Zyntex, Vexor, Vectron…) — the Lexicon principle-#4 _anti-pattern_ (abstract Greek/Latin sophistication). The literal myth (Exocortex, myth-fit 5) ranked 30th. Recorded as memory `39a00aca`.

### Pass v2 — corrected rubric, on-register but screen-starved

Rebalanced generation (tangible compounds + operational nouns; `-vex/-zyn/-tron` banned), 6-axis rubric (added **tangibility**; sound-symbolism demoted to a balance modifier penalizing V/Z/X stacking; myth decoupled from genre-sound), deterministic composite + crowding penalty. 230→208 unique scored; top-30 V/Z/X dropped to 7/30. Register was right (Patchbay, Marshal, Setpoint, Flightdeck, Thalamus, Cortex…) but the **screen killed most of it**: only **3/33 clean-and-acquirable**, all mid-fit:

| Tier-1 v2              | Composite | Trademark              | Domains             |
| ---------------------- | --------- | ---------------------- | ------------------- |
| Prifly                 | 4.30      | clean                  | `.ai`+`.dev` open   |
| Chainfall              | 4.25      | clean                  | `.ai`+`.dev` open   |
| Exocortex _(carry-in)_ | 3.15      | clean (all marks dead) | `.dev` open + owned |

The strongest Lexicon picks were all blocked — **Patchbay (4.8)** domains-tight, **Marshal (4.7)/Setpoint (4.6)** trademark-flagged. Disqualified: Waypoint (HashiCorp), Cortex (Cortex.io), Axon, Manifest, Brainframe.

### Pass v3 — orthogonal pillar basis (the escape)

9 orthogonal conceptual-pillar generative briefs, each register-anchored, weighted toward the richer veins:

- **Magickal/systems (high quota):** exocortex-uplink/borrowed-intelligence; egregore/servitor/hermetic
- **Semiotic-cultural (high quota):** GitS/Section-9; Evangelion; Accelerando/Macx-exoself; Dennō-Coil overlay
- **Academic/theoretic (baseline):** cybernetics/VSM; Society-of-Mind; extended-mind/distributed-cognition

7-axis scoring added **distinctiveness** (oblique/uncommon = trademark-clean proxy). Scores projected through **4 weighting profiles** (myth-max / ownability-max / compound-max / balanced) → Pareto front + cross-profile-robust names. 273→270 scored. The pillar basis opened a register (guiding-spirit / neural-tether / externalized-memory-device) the physical-domain briefs never reached. Technique recorded as memory `6ca7c014`.

---

## Final shortlist — high-myth ∩ trademark-clean ∩ acquirable (v3 screen)

**5 of 15 robust-top candidates cleared both screens — all high-myth.** Live screens ran 2026-06-01 (v3 screen `wf_4a06cfe5-ce5` completed ~01:24Z; v2 screen `wf_23d039ca-a97` ~2026-05-31 23:44Z).

**Full per-candidate Lexicon-axis breakdown** (each axis 0–5). Legend: **T** tangibility · **So** sound-balance · **C** compound-multiplier · **F** processing-fluency · **P** polarization · **M** myth-fit · **D** distinctiveness (ownability proxy). **Mean** = mean of the candidate's score across the four weighting profiles (myth-max / ownability-max / compound-max / balanced).

| Name          | T   | So  | C   | F   | P   | M   | D   | Mean | Screen verdict / domains                               |
| ------------- | --- | --- | --- | --- | --- | --- | --- | ---- | ------------------------------------------------------ |
| **Nervecord** | 5   | 4   | 4   | 4   | 4   | 5   | 5   | 4.58 | clean · `.ai`+`.dev` open (.com held 12/2025)          |
| **Orrery**    | 5   | 5   | 4   | 3   | 4   | 5   | 5   | 4.53 | clean · `.dev` open                                    |
| **Cordmeld**  | 4   | 4   | 4   | 4   | 4   | 5   | 5   | 4.43 | clean · **all 3 open**                                 |
| **Pleromesh** | 3   | 4   | 5   | 3   | 4   | 5   | 5   | 4.41 | clean · **all 3 open**                                 |
| **Nerveclad** | 5   | 4   | 4   | 4   | 4   | 4   | 5   | 4.33 | clean · **all 3 open**                                 |
| **Daimon**    | 4   | 4   | 5   | 5   | 5   | 5   | 4   | 4.63 | **FLAG** (live same-class, diff. goods) · domains gone |
| **Quipu**     | 5   | 4   | 4   | 3   | 5   | 5   | 5   | 4.54 | **FLAG** (live same-class, diff. goods) · domains gone |

**Tagline pairing per candidate** (the foreground line each name composes with):

- **Nervecord** — "The cyberbrain for software organizations." (Eva umbilical + signal-bearing spine; Pareto-optimal)
- **Orrery** — "The external model you consult to reason about systems too large to hold in head." (clockwork model of coordinated motion — most accessible REAL word)
- **Cordmeld** — "The substrate mediates the meld. Keeps it controlled." (neural-tether fusion)
- **Pleromesh** — "The complete field of emanations, coordinated." (_pleroma_ = gnostic divine-fullness + mesh — richest myth, lowest fluency)
- **Nerveclad** — "The cyberbrain for software organizations." (protected neural infrastructure)
- **Daimon** — "The guiding intelligence between mortal intent and realized work." (daemon/POSIX × daímōn/Greek guiding-spirit dual read)
- **Quipu** — "Knotted memory. Distributed record. Extended mind." (Inca knotted-cord externalized-memory device)

**Pareto front = {Daimon, Nervecord}** (non-dominated across all four profiles). The two highest-fit names overall (**Daimon** 4.63, **Quipu** 4.54) both carry a counsel **flag** — a live same-class mark with differentiated goods — not a clean bill, and their `.com`/`.ai`/`.dev` are all taken; a cheap counsel relatedness read is the gate before either could advance.

**Struck:** Graft / Golem / Reticle (live related-goods marks → disqualify); Syncwell (flag); Scrim / Glassware / Ganglia / Netdive (trademark-clean but domains gone).

### Per-pillar note

The clean-and-acquirable winners cluster in **Evangelion (Nervecord, Cordmeld)**, **extended-mind/anatomy (Nerveclad)**, **Dennō-Coil/cybernetics overlay (Orrery)**, and **egregore/gnostic (Pleromesh)** — i.e., precisely the orthogonal pillars the physical-domain v1/v2 briefs could not reach. This is the empirical case for the higher-dimensional generation method.

---

## Carry-in verdicts (spec-required explicit evaluation)

- **Exo** — composite 3.40 (v2) / flag; abstract prefix (tang 2), diluted exclusivity. `exo.computer` owned; `.ai`/`.com` gone.
- **Exocortex** — clean-and-acquirable via `.dev` (owned); literal myth (5) but abstract (tang 2). Counsel caveat: Nahlia Inc. IC-042 AI-as-service application abandoned only 2026-04-21 (fresh; abandonment removes block).
- **Memetic** — TM-clean, off cyberbrain-core register; `memetic.systems` owned.

---

## Handoff to mt#2046

This shortlist is the rigorous-Lexicon-walk input for the umbrella's keep/rename/defer verdict. The verdict, the cost-of-rename quantification, and the tagline pairing remain mt#2046's (principal-reserved). If the principal leans rename, the natural finalists are **Orrery** (accessible real word, `.dev`) and **Nervecord** (Pareto-optimal, `.ai`/`.dev`), with **Cordmeld / Pleromesh / Nerveclad** as the fully-acquirable coined options and **Daimon / Quipu** as the highest-fit names pending a cheap counsel relatedness read.

Full per-candidate scores and rationales live in the workflow run outputs: `wf_44bfa9bf-fa8` (v2 scores), `wf_23d039ca-a97` (v2 screen), `wf_f00c0152-ccb` (v3 scores), `wf_4a06cfe5-ce5` (v3 screen). Methodology memories: `39a00aca` (v1 rubric trap), `6ca7c014` (orthogonal-pillar-basis escape technique).
