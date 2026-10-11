# CGBC Info Map 2.1 Validation Rules

Status: Final 2.1 validation contract adopted for the Step 3 normalization package. Machine-readable JSON Schema and semantic validation are complementary. The schema checks structure and controlled vocabularies; these rules cover cross-reference integrity, provenance, source-grounded meaning, and preservation requirements that JSON Schema alone cannot prove.

## A. Version and identity
- **V2.1-001** `schemaVersion` must be `2.1` for records emitted under this contract.
- **V2.1-002** `recordVersion` must be `2.1` after a record has completed the 2.1 normalization pass.
- **V2.1-003** Stable sermon IDs, existing node IDs, reviewed quote IDs/statuses, timestamps, source evidence, Discover references, and editorial decisions must be preserved during backfill unless a documented correction is required.

## A2. Normalization completion manifest
- **V2.1-004** Every final 2.1 record must include a `normalization` completion manifest identifying profile/version, Concept Registry version, and the required weekly semantic passes.
- **V2.1-005** A pass flag may be `true` only after that category was actually reviewed against sermon evidence. The flag distinguishes “reviewed and none found” from “not analyzed.”
- **V2.1-006** Required completion passes: concepts, Scripture commentary, teaching stance, applications, named resources, definitions/word studies, illustrations, and sermon callbacks.

## B. Referential integrity
- **V2.1-010** Node IDs must be unique within the sermon.
- **V2.1-011** Source IDs must be unique within the sermon.
- **V2.1-012** Every node `sourceRefs` value must resolve to a source record.
- **V2.1-013** Every node connection target must resolve to an existing node.
- **V2.1-014** Every Discover `nodeRefs` value must resolve to an existing node.
- **V2.1-015** Every word-study `nodeRef`, named-resource `nodeRefs`, selected-quote `nodeRef`, and resolved callback target must resolve where the target belongs to the current canonical data set.

## C. Concepts
- **V2.1-020** A permanent `conceptId` may be used only when it exists in the authoritative CGBC Concept Registry.
- **V2.1-021** Meaningful concepts without a registered ID must be stored as `conceptCandidates`, not silently minted as permanent IDs.
- **V2.1-022** Concept significance is only `primary`, `supporting`, or `incidental`, based on the role the concept actually plays in that node.
- **V2.1-023** Do not convert every literal transcript word into a semantic concept. Literal occurrence belongs in generated transcript indexes.

## D. Pastoral Scripture Commentary
- **V2.1-030** `scriptureCommentary` is created only for substantive observation, explanation, interpretation, context, word study, doctrinal support, or application. A bare reading/mention is not commentary.
- **V2.1-031** Use the narrowest defensible normalized Scripture reference.
- **V2.1-032** `primary-text` means the node is directly expounding the passage; `cross-reference` means the passage is brought in to explain, support, contrast, illustrate, or apply another text.
- **V2.1-033** Commentary functions use only the controlled 2.1 vocabulary and may contain multiple values only when evidence supports them.
- **V2.1-034** External commentary/resource material stays externally attributed. Pastor Jacob's own synthesis may be indexed as his teaching only while the external-source relationship remains explicit.

## E. Teaching stance / certainty
- **V2.1-040** Use `teachingStance` where a node carries a substantive position whose adoption, rejection, comparison, or uncertainty matters for later retrieval.
- **V2.1-041** Allowed values: `affirmed`, `tentative`, `reported-other-view`, `contrasted`, `rejected`, `unresolved`.
- **V2.1-042** Do not manufacture certainty. Preserve qualifying language and timestamps/segments.
- **V2.1-043** A node must not collapse multiple competing positions into one stance. Split positions or make them independently addressable.
- **V2.1-044** Search/index generation must not rank reported, contrasted, rejected, or unresolved views as though they were affirmed teaching.

## F. Applications
- **V2.1-050** Every 2.1 `application` node must carry normalized `applicationAudience` and `applicationFunction`.
- **V2.1-051** Do not infer a narrow audience because an application could be useful to that group. Use `all-listeners` when the application is broadly directed.
- **V2.1-052** `specific-group` requires the pastor's explicit group label in `applicationSpecificGroupLabels`.

## G. Named resources
- **V2.1-060** Named commentaries, books, lexicons, podcasts, songs, sermons/messages, articles, websites, and other external sources used substantively must be normalized in top-level `namedResources`.
- **V2.1-061** Resolved identities receive stable `resourceId` values; uncertain identities remain explicitly uncertain and must not be assigned a false stable identity.
- **V2.1-062** External wording, interpretation, or stories must not be silently absorbed into Pastor Jacob's original teaching.
- **V2.1-063** Named-resource node/source references must resolve and provenance must remain visible.

## H. Definitions and word studies
- **V2.1-070** Every `definition` node must include `definedTerm`.
- **V2.1-071** Word studies retain their source term and may add `normalizedTerm`; distinct lexical/theological senses must not be merged merely because surface wording matches.
- **V2.1-072** Named lexical resources should be represented in `namedResources` and linked to the relevant word-study nodes/source evidence.

## I. Illustrations
- **V2.1-080** Every `illustration` node must include `illustrationOrigin`; `illustrationForm` is added when supported.
- **V2.1-081** `personal` is used only when Pastor Jacob identifies the experience as his own or the evidence clearly establishes that.
- **V2.1-082** `external-source` illustrations retain named-resource/source provenance.

## J. Sermon callbacks
- **V2.1-090** Explicit callbacks such as “last week,” recaps, continuations, and previews should be normalized when present.
- **V2.1-091** Resolve `targetSermonId` only when repository metadata makes the target confident; otherwise retain an unresolved target description.
- **V2.1-092** AI-inferred sermon similarity is not an explicit pastoral callback and belongs in later corpus/relationship generation.

## K. Doctrine, provenance, and absence
- **V2.1-100** Doctrine taxonomy is classification vocabulary, not sermon evidence.
- **V2.1-101** Provenance boundaries must remain intact among spoken, prepared, visual, Scripture, external-resource, CGBC-official, and analysis material.
- **V2.1-102** Absence of a normalized tag must never be treated as proof that the concept/audience/resource/relationship does not exist.

## L. Paths, quotes, and package preservation
- **V2.1-110** Canonical path must remain `knowledge/YYYY/YYYY-MM-DD_sermon-slug.json`; source archive path must remain `Sermon Source Archive/YYYY/YY_MM_DD/`.
- **V2.1-111** Approved/Featured quote decisions must be preserved exactly unless Joel explicitly changes them.
- **V2.1-112** Quote representation may reference a semantic node or use a dedicated quote node; curation status remains authoritative in the top-level quote record. Do not require every selected quote to be a `quote`-type node.
- **V2.1-113** Path-only or normalization amendments must not trigger unnecessary sermon re-analysis or unrelated editorial rewrites.

## M. Sanctioned node vocabulary
Schema 2.1 sanctions: `argument`, `question`, `answer`, `illustration`, `application`, `definition`, `scriptureTrail`, `scripture`, `doctrine`, `wordStudy`, `quote`, `transition`, `observation`, `connection`, `outlinePoint`, `clarification`.

`scripture` is retained as a discrete passage-focused teaching node. `scriptureTrail` remains appropriate for a multi-passage trail/relationship. `clarification` is retained for an explicit qualification/boundary that materially constrains another teaching node. `transition` remains sanctioned from the earlier architecture even though none of the four audited sermons currently uses it.

## N. Concept Registry integrity
- **V2.1-120** The authoritative CGBC Concept Registry is the source of permanent `conceptId` values used by canonical sermon records.
- **V2.1-121** Concept Registry IDs must be unique, labels must be nonempty, and every `relatedConceptIds` reference must resolve to another registered concept.
- **V2.1-122** Concept aliases are normalization/retrieval aids only after node meaning has been established from sermon evidence; alias matches alone are not proof that a sermon teaches a concept.
- **V2.1-123** Registry changes are deliberate corpus-infrastructure changes. Routine weekly sermon work must use `conceptCandidates` for meaningful unregistered concepts rather than silently minting permanent IDs.

## O. Stance-safe backfill
- **V2.1-130** When an older synthesis node contains multiple positions whose stance differs materially, preserve that node and add separately addressable, source-grounded nodes for the distinct positions rather than rewriting history or assigning one misleading stance to the mixed node.
- **V2.1-131** New backfill nodes must receive new stable node IDs, resolvable source references, timestamps/segment indexes when spoken evidence exists, and an explicit connection to the older node they clarify.

