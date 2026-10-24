# CGBC Info Map 3.0 Validation Rules

**Status:** Prepared for owner adoption on 2026-10-24. This contract is intended to replace the Schema 2.1 backfill model for fresh canonical sermon construction. Until REV5/v1.7 and the SPP2 operating standard are updated to reference 3.0, any wording conflict must be reported rather than silently resolved.

**Current implementation baseline used to prepare this contract:** GitHub `main` `d394702d0d96c4284631b151e851032246689fc6`.

Machine-readable JSON Schema and these semantic rules are complementary. The schema checks structure and controlled vocabularies. These rules govern provenance, source authority, fresh-run boundaries, cross-reference integrity, evidence sufficiency, rights, mapping precision, quote curation separation, and completion.

## A. Version, scope, and fresh-build modes
- **V3.0-001** `schemaVersion` and `recordVersion` must both be `3.0`.
- **V3.0-002** One sermon has one canonical Info Map at `knowledge/YYYY/YYYY-MM-DD_slug.json`. `passageResearch` is embedded research inside that record, not a competing sermon record.
- **V3.0-003** `buildProvenance.buildMode` is either `FRESH_REBASELINE` or `WEEKLY_NEW_SERMON` under this contract.
- **V3.0-004** For `FRESH_REBASELINE`, the previous sermon knowledge JSON is not required research input and is not a node-ID preservation target. Prior AI/SPP/pilot research must be excluded until the new independent result is frozen.
- **V3.0-005** Existing production sermon identity (`sermon.stableId`) remains the media/episode identity when already established. Freshly generated node, passage, factual and related-study IDs become stable when the 3.0 record is adopted; they do not have to reproduce Schema 2.1 node IDs.
- **V3.0-006** A future maintenance contract may define targeted edits to an adopted 3.0 record. That is outside the fresh-build modes defined here and must not be simulated by silently merging legacy research.

## B. Source authority and transcript layers
- **V3.0-010** Archived sermon sources are the primary sermon evidence: original SRT/audio for spoken evidence, sermon notes for prepared material, and presentation/PPTX for visual material.
- **V3.0-011** `data/transcripts/en/*.json` with `faithful_clean` semantics is a verified derived transcript layer useful for segment/timestamp/reference integrity after its derivation is checked against the authoritative source.
- **V3.0-012** `*.display.json` and display SRT files are presentation derivatives. They must have `authorityRole: DISPLAY_DERIVED`, `evidenceEligible: false`, and must not establish `PASTOR - SPOKEN EXACT` wording.
- **V3.0-013** Source records identify derivation and authority explicitly. Same-name files in different repository paths are never assumed interchangeable.
- **V3.0-014** Hashes identify file versions; a checksum is not a substitute for examining the source or establishing what it supports.

## C. Fresh-run firewall
- **V3.0-020** `buildProvenance.freshEvidenceAttestation` and `passageResearch.freshEvidenceAttestation` must both attest: prior generated research excluded, independent interpretation recorded before commentary, and QA comparison only after freeze.
- **V3.0-021** For rebaseline work, old canonical knowledge may be consulted only after freeze for QA, migration diagnosis, or owner-decision recovery that is independently authorized. It is not evidence for Scripture interpretation, historical claims, entities, maps, or commentary conclusions.
- **V3.0-022** Owner-controlled data that lives outside the sermon knowledge record remains external authority. The principal current example is quote curation.

## D. IDs and referential integrity
- **V3.0-030** Sermon stable ID is unique and must match the production media identity when one exists.
- **V3.0-031** Node IDs are unique within the sermon and sermon-scoped. Once a 3.0 record is adopted, later updates must preserve them unless a documented correction/merge is required.
- **V3.0-032** Every node `sourceRefs` resolves to `sources[]`; every node `evidenceRefs`, passage `sourceEvidenceRefs`, commentary `sourceEvidenceRef`, factual `evidenceRefs`, and geometry `geometryEvidenceRefs` resolves to an evidence record or other explicitly permitted pinned evidence source.
- **V3.0-033** Node connections and Discover `nodeRefs` resolve to existing nodes. Passage `nodeRefs` resolve to existing nodes.
- **V3.0-034** Related Study destinations resolve by their declared type, or remain an explicit external URL/reference with fallback text.
- **V3.0-035** Stable reusable factual IDs use the SPP2 typed `cgbc:` namespaces and are resolved-before-created. Do not mint a new ID because a label is convenient.

## E. Provenance lanes
- **V3.0-040** Preserve these distinct lanes: `PASTOR - SPOKEN EXACT`, `PASTOR - PREPARED`, `PASTOR - VISUAL`, `JAKE - EXISTING TEACHING SYNTHESIS`, `INDEPENDENT BIBLICAL ANALYSIS`, `PASTOR RESOURCE / EXTERNAL SUPPORT`, `AUTHOR RESEARCH BRIEF`, `JAKE DRAFT SYNTHESIS`, and `JAKE APPROVED / PUBLISHED`.
- **V3.0-041** Prepared notes or slides never become spoken evidence merely because the ideas overlap.
- **V3.0-042** Independent analysis, commentary, historical material, and commissioned research must never be retroactively represented as Jake's sermon teaching.
- **V3.0-043** A Jake synthesis must be anchored to actual Jake evidence. Exact quotation requires exact transcript evidence.

## F. Sermon nodes and pastoral Scripture commentary
- **V3.0-050** Nodes remain the source-grounded sermon-meaning layer: argument, question, answer, illustration, application, definition, scriptureTrail, scripture, doctrine, wordStudy, quote, transition, observation, connection, outlinePoint, or clarification.
- **V3.0-051** `nodes[].scriptureCommentary` classifies Jake's own substantive spoken/prepared exposition. It is not the independent research commentary layer.
- **V3.0-052** Applications, teaching stance, definitions, illustrations, callbacks and named resources retain the Schema 2.1 semantic rules where those rules do not conflict with fresh rebaseline.
- **V3.0-053** Doctrine taxonomy and concept registries classify meaning; neither is independent evidence that Jake taught a claim.

## G. Passage research and SPP2 compatibility profile
- **V3.0-060** `passageResearch` implements the substantive SPP2 v1.1.2 research record requirements inside the canonical record: Jake evidence, independent literary/original-language study, commentary witnesses, entities/context/maps, evidence refs, Related Study, Author Research lane/status, review gates, and display policy.
- **V3.0-061** The 3.0 embedded profile intentionally removes the v1.1.2 `baselineInfoMapBlob` dependency because a fresh rebaseline does not treat the legacy knowledge JSON as its construction scaffold.
- **V3.0-062** Materially interpreted/explained/applied passages receive full research. Passing citations may receive lighter treatment. Never fabricate a controlling Jake interpretation where the sermon supplies none.
- **V3.0-063** Jake-facing interpretation leads. Independent disputes/qualifications may be deeper but must not obscure what Jake explicitly taught.

## H. Concept Registry v2
- **V3.0-070** Permanent concept IDs used by 3.0 records come only from `knowledge/CGBC_CONCEPT_REGISTRY_v2.json` when that registry is `ACTIVE`.
- **V3.0-071** While Registry v2 is `BOOTSTRAP_EMPTY`, fresh sermons use `conceptCandidates`; they do not import permanent IDs from Registry v1.
- **V3.0-072** Corpus normalization after fresh sermon research may promote candidates into Registry v2 without re-running Scripture research. Promotion requires fresh canonical evidence and a resolvable registry `evidenceBasis`.
- **V3.0-073** Legacy Registry v1 is reference-only during rebaseline. A matching old label/alias is a QA hint at most, not adoption evidence.
- **V3.0-074** Alias matching is retrieval assistance after meaning is established; it is never proof that a sermon teaches the concept.

## I. Reusable facts, entities, chronology, and Sources & Evidence
- **V3.0-080** Reusable people, places, groups, events, chronology, context claims, map features, source editions, evidence and linguistic-source records follow the SPP2 v1.1.2 factual-record shape.
- **V3.0-081** Ordinary factual records require nonempty `evidenceRefs`; evidence records require source ID, locator, what-it-supports, support type and confidence. Source-edition records do not self-reference merely to satisfy evidence linkage.
- **V3.0-082** `LOCAL_STAGED` is valid when no approved shared snapshot exists. It must carry enough evidence to reconcile later without redoing Scripture research and must never be described as globally approved.
- **V3.0-083** Sources & Evidence is required underneath substantive external historical, geographic, archaeological, linguistic, cartographic or commentary claims surfaced to a listener.
- **V3.0-084** Evidence records preserve source identity/edition/version, exact locator, what the source supports, support type, confidence/qualification, verification, rights/attribution and relevant Scripture/entity/node connections where applicable.

## J. Original language
- **V3.0-090** Study literary/book context and actual surface form, lemma, morphology, syntax and contextual use before commentary conclusions.
- **V3.0-091** STEPBible entries are `VERIFIED` only after exact source-lock/verse/row verification required by SPP2. Strong's identifiers are navigation aids, not interpretive verdicts.
- **V3.0-092** Glosses, roots, morphology or lexical tools alone must not be used to settle doctrine. Record material textual variants and competing readings.

## K. Commentary and rights
- **V3.0-100** Consult actual commentary witnesses after provisional independent interpretation. JFB then Matthew Henry remain the normal starting stack, with other approved sources used selectively.
- **V3.0-101** Commentary records identify author, work, exact edition/item, locator, relation to Jake, evidence record and reuse class.
- **V3.0-102** Rights apply to the exact digital edition/item. Research permission is not direct-display permission. Unclear editions default to synthesis/link treatment rather than copied display text.
- **V3.0-103** No numerical commentary consensus substitutes for evidence-based interpretation.

## L. Historical context, entities, chronology, geography and maps
- **V3.0-110** Historical/context research must answer a real passage question, not merely share a century. Preserve ranges, uncertainty, alternative chronologies and relevance.
- **V3.0-111** Use the roughly +/-20-year first-century proximity screen only as a relevance aid, never as causality proof.
- **V3.0-112** Entity identity preserves aliases, authority IDs, Scripture relevance, roles and confidence. Resolve before creating; disputed identity stays qualified/disputed rather than silently merged.
- **V3.0-113** Map Features are evidence-backed reusable geometry. Map Views are renderer-neutral projections over feature refs. Leaflet, tile providers and future static-book styling are not canonical truth.
- **V3.0-114** Geometry records carry source evidence, temporal/spatial precision and location status. Do not fabricate a point for an unnamed place. An unnamed Matthew 28 Galilee mountain receives no invented mountain pin.

## M. Related Study
- **V3.0-120** Related Study requires a useful question, typed destination and fallback summary. Valid destinations follow the SPP2 passage research contract.
- **V3.0-121** A destination may exist before a dedicated UI screen. The canonical typed reference and fallback are sufficient; UI implementation is not a research blocker.

## N. Author Corpus and commissioned research
- **V3.0-130** Public sermon JSON contains no confidential commissioned brief content. `authorCorpus.privateContentIncluded` must be false.
- **V3.0-131** Author Research Brief, Jake Draft Synthesis and Jake Approved/Published remain distinct adoption states. Independent research becomes Jake-authored material only through a later adoption act.
- **V3.0-132** Public-safe references may point to private corpus material without exposing private bytes.

## O. Quote curation authority
- **V3.0-140** `config/quote-curation.json` is the owner-curation source of truth for reviewed/Featured/Approved/Rejected status.
- **V3.0-141** Schema 3.0 does not copy reviewed status into sermon knowledge. This removes the duplicate quote authority that existed in Schema 2.1.
- **V3.0-142** `passageResearch.quoteCandidates[]` are `UNREVIEWED` only and require exact transcript evidence. Once Joel reviews a quote, durable status lives in quote curation and can be overlaid by consumers.
- **V3.0-143** Rebuilding sermon knowledge must not rewrite quote-curation decisions.

## P. Discover, Search, and projections
- **V3.0-150** Discover, Deep Dive, Search, maps and Author Corpus are projections from the same canonical sermon meaning/evidence. They must not create a competing knowledge store.
- **V3.0-151** Discover answers resolve to source-grounded nodes/passage evidence. Generated questions remain labeled analysis.
- **V3.0-152** Literal transcript occurrence stays in transcript/search indexes. Do not inflate the semantic graph by turning every spoken word into a concept.

## Q. Editorial, visual and implementation metadata
- **V3.0-160** Study/series/collection hierarchy remains canonical editorial structure and is sourced from authoritative CGBC metadata rather than inferred from semantic similarity.
- **V3.0-161** Slide mapping and visual identity are rebuilt from authoritative weekly source/presentation material. A fresh rebaseline does not require preserving obsolete sandbox slide/visual enrichment merely because it existed in an old knowledge JSON.
- **V3.0-162** Canonical/source paths remain repository-relative and resolvable when declared. No UI/renderer/runtime-specific implementation choice becomes canonical meaning.

## R. Completion and PASS COMPLETE
- **V3.0-170** JSON Schema validity is necessary but not sufficient for completion.
- **V3.0-171** `SPP2 PASS COMPLETE` requires actual source retrieval, passage/context study, independent original-language research where material, Jake evidence, commentary comparison, Sources & Evidence, rights/provenance, entity/time/geo/map precision where applicable, cross-reference resolution, quote-candidate integrity, final schema validation and package integrity checks.
- **V3.0-172** A missing required authoritative source is a hard execution blocker only after retrieval is genuinely attempted and the missing item is specifically identified. Tool-boundary inconvenience is not a reason to reconstruct protected evidence from excerpts.
- **V3.0-173** Durable internal checkpoints may preserve one fresh run across interruptions; they are recovery state, not intermediate review gates and not a second research pass.

## S. Transition from Schema 2.1
- **V3.0-180** Schema 2.1 remains historical/legacy compatibility material. Its backfill rule requiring preservation of old node IDs and embedded quote status does not govern a 3.0 fresh rebaseline once 3.0 is formally adopted.
- **V3.0-181** Existing sermon stable IDs and external production identities remain valid anchors. Other old knowledge IDs may be mapped for QA or redirects after fresh freeze but are not research inputs.
- **V3.0-182** Before production consumers are changed to require 3.0, inspect current readers/workflows and perform the normal production restore-point procedure. Uploading these contract files manually for review does not itself authorize parser/UI/deployment changes.
