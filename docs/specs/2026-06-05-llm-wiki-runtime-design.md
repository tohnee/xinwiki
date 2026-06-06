# llm-wiki Runtime Design

> Status: Draft for review
> Date: 2026-06-05
> Scope: V1

## Background

The current project has three partially overlapping knowledge paths:

- Uploaded sources are parsed and stored as `sources`
- Wiki and ontology are stored as separate runtime objects
- QA and memory are persisted, but enter chat through side paths

This creates a split-brain architecture:

- `POST /api/llm-wiki/export` projects `wikiPages + ontologyNodes + ontologyEdges`
- `GET /api/llm-wiki/query` performs lightweight search over in-memory wiki and ontology data
- `POST /api/chat/message` builds grounded context from wiki, source, ontology, QA, and memory independently

As a result, `llm-wiki` is currently a compatibility/export layer instead of the canonical knowledge runtime.

This design changes that.

## Goal

Upgrade `llm-wiki` into the canonical, persistent knowledge runtime for the application so that:

- query, chat, and export all operate on the same compiled knowledge base
- wiki, ontology, QA, and memory become part of one runtime model
- uploads first go through a parser adapter and then through a compiler into the runtime
- future document parsers such as MinerU can be integrated without rewriting query, chat, or export

## Non-Goals

V1 does not include:

- vector search or embedding infrastructure
- full LLM-based contradiction resolution for every ingest
- full visual lint UI
- direct file-system-native runtime where markdown files are the only persistence layer
- immediate migration of every existing screen to new UI concepts

## Canonical Definition

The canonical `llm-wiki` is the runtime itself.

This means:

- the runtime is the source of truth for compiled knowledge
- exported markdown and graph files are projections of the runtime
- query and chat must retrieve evidence from the runtime first
- raw uploaded files remain immutable sources and are not themselves part of the runtime
- parser output is an intermediate artifact and is not itself the runtime

## Core Invariants

1. Raw sources remain immutable and are the ultimate source of truth.
2. The canonical `llm-wiki` is the runtime, not the export directory.
3. Query and chat must share the same runtime query service.
4. Wiki, ontology, QA, and memory must be represented inside the runtime and may not remain side stores for answering.
5. Every runtime entry and relation must retain provenance back to raw sources or human-authored facts.
6. Export is a projection from runtime state and must not invent or omit core knowledge semantics.
7. Workspace isolation applies to all runtime entries, edges, provenance, logs, and projections.
8. Valuable answers may be compiled back into the runtime as `qa-note` entries.
9. Parser adapters may change, but the compiler and query contract must remain stable.
10. Dify consumes grounded evidence produced by the runtime query path only.

## Architecture

The V1 architecture is:

```text
Upload File
-> Parser Adapter
-> DocumentParseResult
-> llm-wiki Compiler
-> Canonical Runtime
-> Query Service
-> grounded QA / Dify
-> Export Projection
```

### Layer Responsibilities

- `Raw Sources`
  - immutable uploaded files
  - source of truth for evidence recovery
- `Parser Adapter`
  - transforms raw sources into a normalized parse result
  - pluggable implementation boundary for local parsing, MinerU, or future model-backed services
- `DocumentParseResult`
  - stable intermediate contract consumed by the compiler
- `llm-wiki Compiler`
  - incrementally compiles parse results and curated knowledge into runtime entries and edges
- `Canonical Runtime`
  - persistent llm-wiki knowledge base
  - the only source used by query, chat, and export
- `Query Service`
  - unified retrieval path for `/api/llm-wiki/query` and `/api/chat/message`
- `grounded QA / Dify`
  - answer generation layer consuming runtime evidence
- `Export Projection`
  - runtime projection to `wiki/*.md`, `_schema/graph.json`, `index.md`, and `log.md`

## Runtime Schema

V1 runtime uses four layers: `entry`, `edge`, `provenance`, and `maintenance metadata`.

### Entry

An entry is the smallest canonical runtime unit.

V1 entry kinds:

- `page`
- `entity`
- `qa-note`
- `memory-note`

Required fields:

- `id`
- `workspaceId`
- `kind`
- `title`
- `summary`
- `bodyMarkdown`
- `aliases`
- `tags`
- `status`
- `sourceRefs`
- `compiledFrom`
- `updatedAt`
- `version`

Rules:

- `qa-note` and `memory-note` are first-class runtime entries
- `page` entries may represent source summaries, topic pages, concept pages, or comparison pages
- `entity` entries represent stable named entities that can be linked from pages and edges

### Edge

All relationships use one normalized schema.

Required fields:

- `fromEntryId`
- `toEntryId`
- `type`
- `evidenceRefs`
- `confidence`

Initial edge types:

- `mentions`
- `related_to`
- `part_of`
- `derived_from`
- `supports`
- `contradicts`
- `supersedes`

Rules:

- relation ordering is always `from -> to -> type`
- legacy relation arrays must be normalized into this shape before entering runtime

### Provenance

Each entry and edge must retain traceability to raw evidence.

Each provenance record should support:

- `sourceId`
- `sourceType`
- `locator`
- `excerpt`
- `confidence`

`locator` must already reserve room for richer parsers:

- `sectionHeading`
- `blockIndex`
- `pageRange`
- `bbox`
- `tableId`
- `figureId`

### Maintenance Metadata

V1 runtime must reserve explicit maintenance support for:

- `index view`
- `log events`
- `lint issues`
- `staleness markers`
- `superseded markers`

V1 does not need a full maintenance UI, but the data model must exist so later phases do not require a schema reset.

## Parser Adapter Contract

The current text parser must be refactored into an adapter boundary.

The stable output contract is `DocumentParseResult`.

### DocumentParseResult

Top-level sections:

- `document`
  - `sourceId`
  - `fileName`
  - `mimeType`
  - `parserName`
  - `parserVersion`
- `content`
  - `markdown`
  - `plainText`
  - `sections`
  - `contentBlocks`
- `artifacts`
  - `tables`
  - `figures`
  - `citations`
- `quality`
  - `warnings`
  - `confidence`
  - `mode`
- `rawPointers`
  - optional provider-specific pointers to original layout content

### Adapter Rules

- adapters only normalize raw source content
- adapters do not write runtime entries
- adapters do not perform QA retrieval
- adapters may be selected by file type, configuration, or workspace policy

### MinerU Reservation

The contract is explicitly shaped to allow future MinerU integration.

MinerU or similar parsers are expected to improve:

- layout fidelity
- table extraction
- figure references
- page coordinates
- citation precision

No runtime, compiler, or query contract should depend on the local parser implementation details.

## Compiler Contract

The compiler is the mechanism that maintains the llm-wiki runtime.

### Inputs

- `DocumentParseResult`
- `existingRuntimeSnapshot`
- `workspacePolicies`

### Outputs

- `upsertedEntries`
- `upsertedEdges`
- `supersededEntries`
- `logEvents`
- `lintHints`

### Compiler Responsibilities

- compile parsed documents into `page` entries
- extract or update `entity` entries
- create and update normalized `edge` records
- attach provenance to entries and edges
- compile accepted QA into `qa-note` entries
- compile accepted memory into `memory-note` entries
- incrementally revise existing entries instead of rebuilding the entire runtime

### Compiler Constraints

- must be incremental
- must be idempotent for repeated ingest of unchanged content
- must preserve provenance
- must keep exported projections reconstructable from runtime state

## Query And Chat Shared Flow

Query and chat must use the same retrieval chain.

The target flow is:

```text
User Question
-> Query Service
-> retrieve runtime entries + edges + provenance
-> grounded answer package
-> local answer or Dify generation
-> optional compile-back as qa-note
```

### Query Service

Responsibilities:

- retrieve relevant runtime entries
- retrieve supporting edges
- return evidence packages with provenance
- provide a stable interface for both `/api/llm-wiki/query` and `/api/chat/message`

### Chat Rules

- chat may not build a separate side-path retrieval set from `sources`, `qaRecords`, `memories`, or ontology tables directly
- all evidence must come from runtime retrieval
- finance strict-evidence rules remain enforced after the query service returns evidence
- Dify receives grounded context generated from runtime evidence only

### Query API Shape

V1 does not need final payload naming locked down yet, but responses must clearly distinguish:

- matched entries
- matched relations
- evidence excerpts
- provenance references

Avoid ambiguous naming such as returning ontology nodes inside a field called `graph` if no actual graph structure is returned.

## Export Projection

Export becomes a projection of runtime state, not a bespoke serializer of legacy tables.

V1 projected files:

- `wiki/*.md`
- `_schema/graph.json`
- `index.md`
- `log.md`

### Projection Rules

- every projected page must be reproducible from runtime entries
- graph output must be reproducible from runtime entries and edges
- index output must summarize discoverable runtime content
- log output must summarize ingest, compile, query-filed, and maintenance events
- projection must not leak server file system paths

## Migration Strategy

The migration must be incremental and TDD-driven.

### Phase 1: Parser Adapter

- introduce `DocumentParseResult`
- wrap the current parser in a default adapter
- reserve MinerU-compatible fields
- keep existing upload and source tests green

### Phase 2: Runtime Schema

- introduce runtime persistence for entries, edges, and provenance
- normalize relation ordering
- preserve workspace isolation
- do not switch chat or query yet

### Phase 3: Compiler

- compile uploads into runtime entries and edges
- compile QA and memory into runtime entries
- keep ingestion incremental and idempotent

### Phase 4: Shared Query Service

- route `/api/llm-wiki/query` through runtime retrieval
- route `/api/chat/message` through the same runtime retrieval service
- ensure Dify consumes runtime-grounded evidence only

### Phase 5: Export Projection

- project runtime into markdown, graph, index, and log files
- add fidelity tests between runtime and exports

## Risk Controls

### Runtime / Export Drift

- runtime is the only source of truth
- export fidelity tests are required

### Chat Quality Regression

- preserve a chat regression suite during each migration phase
- compare evidence and answers before and after runtime cutover

### Schema Lock-In Too Early

- parser contract must reserve citation and layout fields now
- keep compiler/query interfaces independent from concrete parser details

### Noisy QA / Memory Page Explosion

- compile QA and memory into runtime immediately
- allow projection rules to decide whether they become standalone markdown pages in V1

### Multi-User Data Leakage

- all runtime tables and projections must remain workspace-scoped
- maintain dual-user isolation regression tests

### Over-Smart Compiler Risk

- V1 compiler should be deterministic and minimal
- advanced semantic upgrades can be added behind the same compiler contract later

## TDD Test Matrix

### Parser

- validates `DocumentParseResult` contract
- supports default local adapter
- supports future adapter substitution without changing consumer tests

### Runtime

- persists entries, edges, and provenance
- enforces workspace isolation
- normalizes relation schema consistently

### Compiler

- compiles source into `page` and `entity`
- compiles accepted QA into `qa-note`
- compiles accepted memory into `memory-note`
- remains idempotent for repeated ingest

### Query

- query returns runtime-derived matches and evidence
- query and chat use the same retrieval logic

### Chat

- grounded rules still hold
- Dify receives runtime-derived evidence only
- key regression questions preserve or improve answer quality

### Export

- exported markdown, graph, index, and log are faithful projections of runtime state
- export does not leak absolute paths

## Open Decisions

These are intentionally narrowed, not left vague:

- V1 should compile `qa-note` and `memory-note` into runtime immediately
- V1 may choose rule-based projection for those note kinds instead of exporting every note as a standalone markdown page
- V1 should prefer deterministic compiler behavior over speculative deep synthesis

## Implementation Readiness

This design is ready to be converted into an implementation plan.

The next step is to create a TDD-first plan that:

- introduces the parser adapter boundary
- adds runtime persistence
- migrates compiler behavior
- unifies query and chat retrieval
- upgrades export into runtime projection
