# XinWiki Missing Features Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the gap between the existing `front.html` experience and the current backend by implementing the missing APIs, persistence, and real data flows for sources, ontology, chat, and report generation.

**Architecture:** Keep the existing `Node.js + Express + SQLite + single-file front-end` architecture, but move all remaining demo-only actions behind real backend APIs. Add small service modules for document parsing, grounding, and report generation so the route layer stays thin and testable. Reuse `/api/bootstrap` for initial page state, then introduce narrower APIs for actions and detail queries to reduce over-refreshing.

**Tech Stack:** Node.js, Express, SQLite (`better-sqlite3`), Multer, Zod, Vitest, Supertest, single-file HTML front-end

---

## Clarify Need

This plan covers the feature gaps discovered during the audit of:

- `front.html`
- `server/app.js`
- `server/db.js`
- `server/services/llm-wiki-exporter.js`
- `tests/*.test.js`

The current repo already supports:

- auth and workspace bootstrap
- source upload
- manual Wiki build from a source
- Wiki promote to ontology node
- expert injections
- memory persistence
- QA record persistence
- Dify proxy chat
- `llm-wiki` export

The current repo still does not fully support:

- real document parsing and automatic Wiki generation
- ontology edge promotion from Wiki relations
- chat history loading and grounded gating consistency
- persistent focus configuration
- real report generation and export flows
- several front-end actions that still only call `toast(...)`

## Gap Matrix

| Area | Front-end behavior today | Backend reality today | Target outcome |
|---|---|---|---|
| Sources | Upload appears successful; parsing pipeline is implied | Upload only stores metadata summary; no real parse pipeline | Uploaded files produce parsed sections, facts, and optional auto-built Wiki |
| Sources | Reparse / Export Markdown buttons exist | No API | Buttons call real APIs |
| Wiki | Relation rows offer "加入本体" | No API to create ontology edges from Wiki relations | Relation promotion writes edges and persists them |
| Ontology | Focus list is interactive | Front-end-only state, not persisted | Focus config persists per workspace |
| Ontology | Export JSON / Re-layout / Save draft buttons exist | No API | Actions work and persist where appropriate |
| Ask | Messages send successfully | Messages are stored, but history is not returned to UI; Dify bypasses strict grounding contract | Chat history loads, and grounded gating is enforced consistently |
| Reports | Full report page renders | Pure front-end mock content | Report/PPT/Markdown content comes from backend APIs |
| Platform | Uploads are accepted | No strong file constraints; no parser abstraction | Safer uploads and service boundaries |

## Missing API Contracts

### 1. Source Pipeline

#### `POST /api/sources/upload-and-build`

Purpose: upload files, parse them, create source records, optionally build Wiki pages, and return created artifacts.

Request:

```http
Content-Type: multipart/form-data
files=<file>[] (1..N)
autoBuild=true|false
```

Response `201`:

```json
{
  "sources": [
    {
      "id": "source_xxx",
      "name": "sample.pdf",
      "title": "上传文档 · sample.pdf",
      "parsed": true,
      "wikiBuilt": true,
      "progress": 100,
      "abstract": "真实解析摘要",
      "facts": ["fact 1", "fact 2"],
      "sections": [["章节 A", "内容摘要"]]
    }
  ],
  "wikiPages": [
    {
      "id": "wiki_source_xxx",
      "title": "Wiki · sample.pdf",
      "source": "sample.pdf"
    }
  ],
  "jobIds": ["job_xxx"]
}
```

Failure cases:

- `400` no files
- `413` file too large
- `415` unsupported file type

#### `POST /api/sources/:sourceId/reparse`

Purpose: rerun parser for one source.

Request:

```json
{
  "rebuildWiki": true
}
```

Response `200`:

```json
{
  "source": {
    "id": "source_xxx",
    "parsed": true,
    "wikiBuilt": true,
    "abstract": "更新后的摘要"
  },
  "wikiPage": {
    "id": "wiki_source_xxx",
    "title": "Wiki · sample.pdf"
  }
}
```

#### `GET /api/sources/:sourceId/markdown`

Purpose: return the structured markdown extracted from the source.

Response `200`:

```json
{
  "sourceId": "source_xxx",
  "markdown": "# 标题\n\n## 小节\n\n内容"
}
```

#### `GET /api/jobs/:jobId`

Purpose: return the parse/build progress for long-running operations.

Response `200`:

```json
{
  "id": "job_xxx",
  "status": "running",
  "stage": "extract_entities",
  "progress": 72,
  "stages": [
    "upload",
    "parse_content",
    "structure_markdown",
    "extract_entities",
    "build_wiki"
  ]
}
```

### 2. Wiki / Ontology Bridge

#### `POST /api/wiki/:wikiId/relations/promote`

Purpose: persist selected Wiki relations into ontology edges.

Request:

```json
{
  "relations": [
    ["台积电", "usesNode", "N2"],
    ["台积电", "usesTechnology", "CoWoS"]
  ]
}
```

Response `201`:

```json
{
  "createdEdges": [
    ["台积电", "N2", "usesNode"],
    ["台积电", "CoWoS", "usesTechnology"]
  ],
  "skippedEdges": []
}
```

#### `GET /api/ontology/export`

Purpose: export ontology nodes, edges, expert metadata, and focus config.

Response `200`:

```json
{
  "nodes": [],
  "edges": [],
  "expertInjections": [],
  "focuses": {}
}
```

#### `POST /api/ontology/layout`

Purpose: recompute and persist layout coordinates.

Request:

```json
{
  "strategy": "radial"
}
```

Response `200`:

```json
{
  "nodes": [
    { "id": "台积电", "x": 220, "y": 180 }
  ]
}
```

### 3. Focus Config

#### `GET /api/focuses`

Response `200`:

```json
{
  "公司": [["TSMC", true], ["ASML", false]],
  "技术": [["CoWoS", true], ["GAA", true]]
}
```

#### `PUT /api/focuses`

Request:

```json
{
  "公司": [["TSMC", true], ["ASML", true]],
  "技术": [["CoWoS", true], ["GAA", false]]
}
```

Response `200`:

```json
{
  "focuses": {
    "公司": [["TSMC", true], ["ASML", true]],
    "技术": [["CoWoS", true], ["GAA", false]]
  }
}
```

### 4. Chat History + Grounding

#### `GET /api/chat/thread`

Purpose: return the current active thread metadata.

Response `200`:

```json
{
  "thread": {
    "id": "thread_xxx",
    "title": "XinWiki Chat",
    "difyConversationId": "conv_xxx"
  }
}
```

#### `GET /api/chat/messages`

Purpose: return current thread messages for UI hydration.

Response `200`:

```json
{
  "messages": [
    {
      "id": "msg_xxx",
      "role": "user",
      "content": "CoWoS 的供应链瓶颈是什么？",
      "citations": [],
      "createdAt": "2026-06-05T00:00:00.000Z"
    }
  ]
}
```

#### `POST /api/chat/retrieve`

Purpose: expose retrieval hits and grounding evidence before answer generation.

Request:

```json
{
  "question": "台积电26年营收预测"
}
```

Response `200`:

```json
{
  "intents": ["revenue_forecast"],
  "evidence": [],
  "canAnswer": false,
  "reason": "缺少财务预测或指引类证据"
}
```

#### Update existing `POST /api/chat/message`

Target behavior:

- always run retrieval and intent gating first
- refuse before calling Dify when strict intent has no evidence
- include `messages`, `evidence`, and `reason` in response

Response `201`:

```json
{
  "answer": "回答正文",
  "citations": ["wiki:台积电 / TSMC"],
  "messages": [],
  "evidence": [],
  "grounded": true,
  "refused": false,
  "reason": null
}
```

### 5. Report Generation

#### `POST /api/reports/generate`

Request:

```json
{
  "scope": "wiki",
  "reportType": "company",
  "chartType": "roadmap",
  "model": "deepseek v4 pro"
}
```

Response `201`:

```json
{
  "report": {
    "id": "report_xxx",
    "title": "XinWiki · 公司分析报告",
    "summary": "自动摘要",
    "metrics": [
      { "label": "源文档", "value": 4 }
    ],
    "sections": [
      {
        "title": "核心结论",
        "body": "..."
      }
    ],
    "charts": [
      {
        "type": "roadmap",
        "title": "台积电先进制程路线图",
        "payload": {}
      }
    ],
    "sources": ["wiki:台积电 / TSMC", "source:TSMC_Q4_Earnings_2025.pdf"]
  }
}
```

#### `POST /api/reports/ppt-outline`

Response `201`:

```json
{
  "deck": {
    "title": "先进制程与先进封装产业分析",
    "slides": [
      {
        "no": "01",
        "title": "执行摘要",
        "bullets": ["N2 是先进制程主线", "CoWoS 是先进封装主线"]
      }
    ]
  }
}
```

#### `POST /api/reports/markdown`

Response `201`:

```json
{
  "title": "XinWiki · Markdown 报告",
  "markdown": "# 报告标题\n\n## 核心结论\n\n..."
}
```

#### `POST /api/reports/export`

Request:

```json
{
  "format": "pdf",
  "reportId": "report_xxx"
}
```

Response `201`:

```json
{
  "downloadUrl": "/exports/report_xxx.pdf",
  "format": "pdf"
}
```

## Database Changes

Implement these changes inside `server/db.js` without introducing a separate migration system yet.

| Table | Change | Why |
|---|---|---|
| `sources` | enrich stored payload with `sections`, `markdown`, `parser_meta`, `content_hash` | support real parse output and reparse |
| `wiki_pages` | enrich payload with `sourceId`, `sourceType`, `generatedAt` | traceability |
| `ontology_edges` | add id stability or dedupe key in payload | avoid repeated relation promotion |
| `chat_threads` | keep `title`, `dify_conversation_id`, maybe `active` flag in payload or schema | future multi-thread support |
| `chat_messages` | no schema change required initially | already sufficient for history hydration |
| `focus_configs` | new table: workspace-scoped JSON payload | persist `focusList` |
| `jobs` | new table: id, workspace_id, payload_json, created_at, updated_at | source parse/build progress |
| `reports` | new table: generated report payloads for export and reuse | decouple generation from download |
| `expert_drafts` | optional table if draft save is implemented now | enable saved draft UX |

Suggested DDL additions:

```sql
CREATE TABLE IF NOT EXISTS focus_configs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);
```

## Test Strategy

Add the following integration-focused test files:

- Create: `tests/source-pipeline.test.js`
- Create: `tests/ontology-api.test.js`
- Create: `tests/chat-api.test.js`
- Create: `tests/report-api.test.js`

Coverage targets:

| Test File | Coverage |
|---|---|
| `tests/source-pipeline.test.js` | upload-and-build, reparse, markdown export, job status |
| `tests/ontology-api.test.js` | relation promotion, focus persistence, ontology export |
| `tests/chat-api.test.js` | chat history load, strict grounding refusal, Dify bypass prevention |
| `tests/report-api.test.js` | report generation, ppt outline, markdown generation, export metadata |

## Task Breakdown

### Task 1: Extract Source Parsing Into A Real Service

**Files:**
- Create: `server/services/document-parser.js`
- Modify: `server/app.js`
- Modify: `server/db.js`
- Test: `tests/source-pipeline.test.js`

**Step 1: Write the failing test**

Add an integration test in `tests/source-pipeline.test.js` that uploads a small `.md` or `.txt` file and expects:

- `abstract` to include file content keywords
- `facts` to contain at least one extracted line
- `sections` to exist in the stored source payload

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/source-pipeline.test.js
```

Expected: FAIL because no parser service exists and stored payload does not contain parsed sections/markdown.

**Step 3: Write minimal implementation**

- Create `server/services/document-parser.js`
- Support `txt`, `md`, and `html` first
- Return:
  - `abstract`
  - `facts`
  - `sections`
  - `markdown`
  - `parserMeta`

**Step 4: Wire upload path**

- Update `server/app.js` upload handling to call the parser service
- Store enriched source payload

**Step 5: Run test to verify it passes**

Run:

```bash
npm test -- tests/source-pipeline.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/services/document-parser.js server/app.js server/db.js tests/source-pipeline.test.js
git commit -m "feat: add real source parsing service"
```

### Task 2: Implement Upload-And-Build And Reparse APIs

**Files:**
- Modify: `server/app.js`
- Modify: `server/db.js`
- Test: `tests/source-pipeline.test.js`

**Step 1: Write the failing test**

Extend `tests/source-pipeline.test.js` with:

- `POST /api/sources/upload-and-build`
- `POST /api/sources/:sourceId/reparse`
- `GET /api/sources/:sourceId/markdown`

Assert that:

- source is stored
- wiki page is created
- markdown can be fetched

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/source-pipeline.test.js
```

Expected: FAIL with missing route errors.

**Step 3: Write minimal implementation**

- Add new routes
- Reuse parser service from Task 1
- Reuse existing `buildWikiFromSource` as a starting point, but enrich it with parsed sections

**Step 4: Add job status support**

- Add `jobs` table support in `server/db.js`
- Save a simple completed job first; do not overbuild async workers yet

**Step 5: Run tests**

```bash
npm test -- tests/source-pipeline.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/app.js server/db.js tests/source-pipeline.test.js
git commit -m "feat: add source pipeline APIs"
```

### Task 3: Implement Relation Promotion And Ontology Support APIs

**Files:**
- Modify: `server/app.js`
- Modify: `server/db.js`
- Test: `tests/ontology-api.test.js`

**Step 1: Write the failing test**

Create `tests/ontology-api.test.js` covering:

- `POST /api/wiki/:wikiId/relations/promote`
- `GET /api/ontology/export`

Assert that:

- promoted relations appear in ontology edges
- duplicate promotions are skipped

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/ontology-api.test.js
```

Expected: FAIL with route missing.

**Step 3: Write minimal implementation**

- Add route for relation promotion
- Add dedupe strategy for edges in `server/db.js`
- Add ontology export route

**Step 4: Run tests**

```bash
npm test -- tests/ontology-api.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/app.js server/db.js tests/ontology-api.test.js
git commit -m "feat: add ontology relation promotion APIs"
```

### Task 4: Persist Focus Configuration And Optional Ontology Layout

**Files:**
- Modify: `server/app.js`
- Modify: `server/db.js`
- Modify: `front.html`
- Test: `tests/ontology-api.test.js`

**Step 1: Write the failing test**

Add focus persistence tests:

- `GET /api/focuses`
- `PUT /api/focuses`

Assert that:

- saved payload survives a bootstrap reload

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/ontology-api.test.js
```

Expected: FAIL due to missing table and routes.

**Step 3: Write minimal implementation**

- Add `focus_configs` table support
- Add get/update routes
- Update `front.html` to hydrate and persist `focusList` through the API

**Step 4: Optionally add layout endpoint**

- If time permits in this task, implement `POST /api/ontology/layout`
- Otherwise leave it for a follow-up task and keep the button hidden

**Step 5: Run tests**

```bash
npm test -- tests/ontology-api.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/app.js server/db.js front.html tests/ontology-api.test.js
git commit -m "feat: persist ontology focus config"
```

### Task 5: Expose Chat History And Enforce Grounding Before Dify

**Files:**
- Create: `server/services/grounding.js`
- Modify: `server/app.js`
- Modify: `server/db.js`
- Modify: `front.html`
- Test: `tests/chat-api.test.js`

**Step 1: Write the failing test**

Create `tests/chat-api.test.js` covering:

- `GET /api/chat/thread`
- `GET /api/chat/messages`
- `POST /api/chat/retrieve`
- `POST /api/chat/message` strict refusal behavior

Use a question like `台积电26年营收预测` and assert:

- `canAnswer` is `false`
- Dify is not called when strict evidence is missing
- refusal is returned and stored consistently

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/chat-api.test.js
```

Expected: FAIL because these routes do not exist and grounding logic is not centralized.

**Step 3: Write minimal implementation**

- Move retrieval/gating logic into `server/services/grounding.js`
- Use it in both `/api/chat/retrieve` and `/api/chat/message`
- Add thread/messages routes
- Update `front.html` ask view to load messages on render

**Step 4: Run tests**

```bash
npm test -- tests/chat-api.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/services/grounding.js server/app.js server/db.js front.html tests/chat-api.test.js
git commit -m "feat: add grounded chat history APIs"
```

### Task 6: Implement Real Report Generation APIs

**Files:**
- Create: `server/services/report-generator.js`
- Modify: `server/app.js`
- Modify: `server/db.js`
- Modify: `front.html`
- Test: `tests/report-api.test.js`

**Step 1: Write the failing test**

Create `tests/report-api.test.js` covering:

- `POST /api/reports/generate`
- `POST /api/reports/ppt-outline`
- `POST /api/reports/markdown`

Assert that:

- output reflects selected `scope`, `reportType`, `chartType`, and current workspace data
- response is not a fixed hard-coded deck

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/report-api.test.js
```

Expected: FAIL because routes do not exist.

**Step 3: Write minimal implementation**

- Create `server/services/report-generator.js`
- Start with template-driven generation based on bootstrap data
- Persist generated reports in a `reports` table
- Update `front.html` so `generateDoc(...)` renders API results instead of hard-coded mock output

**Step 4: Run tests**

```bash
npm test -- tests/report-api.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/services/report-generator.js server/app.js server/db.js front.html tests/report-api.test.js
git commit -m "feat: add report generation APIs"
```

### Task 7: Implement Report Export Metadata And Front-End Wiring Cleanup

**Files:**
- Modify: `server/app.js`
- Modify: `server/db.js`
- Modify: `front.html`
- Test: `tests/report-api.test.js`

**Step 1: Write the failing test**

Extend `tests/report-api.test.js` with `POST /api/reports/export` and assert:

- response contains a stable `downloadUrl`
- unknown `reportId` returns `404`

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/report-api.test.js
```

Expected: FAIL because export route does not exist.

**Step 3: Write minimal implementation**

- Add export metadata route
- It is acceptable in v1 to return a download placeholder path if the file generation is deterministic and documented
- Remove or replace report-page `toast(...)` placeholders with real actions

**Step 4: Run tests**

```bash
npm test -- tests/report-api.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/app.js server/db.js front.html tests/report-api.test.js
git commit -m "feat: wire report export actions"
```

### Task 8: Tighten Upload Safety, Docs, And Regression Coverage

Status update on 2026-06-05:

- Implemented upload extension whitelist and `5MB` size guard in `server/app.js`
- Added regression coverage for unsupported upload types, oversize uploads, and persisted source jobs in `/api/bootstrap`
- Upgraded report export templates so DOCX / PDF outputs include report meta, KPI blocks, sections, and citations
- Synced `README.md` with the real source pipeline, report export, and bootstrap hydration behavior
- Front-end source page now uses real jobs / reparse / markdown flows instead of placeholder success toasts

**Files:**
- Modify: `server/app.js`
- Modify: `README.md`
- Modify: `.env.example`
- Test: `tests/source-pipeline.test.js`
- Test: `tests/chat-api.test.js`
- Test: `tests/report-api.test.js`

**Step 1: Write the failing test**

Add tests for:

- unsupported file extension
- oversized upload rejection
- missing `JWT_SECRET` behavior in production-like mode if enforced

**Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL because upload constraints are not implemented.

**Step 3: Write minimal implementation**

- Restrict upload MIME/extensions and size
- Improve error messages
- Update docs and env guidance

**Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS across existing and new tests.

**Step 5: Commit**

```bash
git add server/app.js README.md .env.example tests/source-pipeline.test.js tests/chat-api.test.js tests/report-api.test.js
git commit -m "chore: harden missing feature rollout"
```

## Front-End Mapping Checklist

Update these exact front-end interaction points as each backend task lands:

- `handleFiles()` in `front.html`
- `renderProcList()` in `front.html`
- `buildUploadedWiki()` in `front.html`
- `buildWikiFromSource()` in `front.html`
- relation promotion button inside `renderWiki()` in `front.html`
- `toggleFocus()` in `front.html`
- `renderAsk()` and `ask()` in `front.html`
- `generateDoc()` in `front.html`

When an action is not implemented yet, prefer hiding the button over leaving a misleading success `toast(...)`.

## Verification Checklist

- Register two users and confirm workspace isolation still holds
- Upload a real `.md` file and see extracted sections/facts in the source detail page
- Upload with auto-build and confirm a new Wiki page appears
- Promote a Wiki relation and confirm a new ontology edge appears after reload
- Toggle focus items, refresh, and confirm the state persists
- Ask a strict financial forecast question without evidence and confirm refusal
- Ask a grounded question and confirm citations plus history reload
- Generate report / PPT / markdown and confirm output differs by scope and type

## Out Of Scope For This Plan

- true streaming chat transport
- OCR-heavy PDF reconstruction
- polished async job worker infrastructure
- full multi-thread chat UI
- binary `.docx` / `.pdf` final export rendering fidelity

These can be scheduled after the missing-feature parity milestone is complete.

## Recommended Execution Order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 6
7. Task 7
8. Task 8

Plan complete and saved to `docs/plans/2026-06-05-xinwiki-missing-features-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch a fresh subagent per task, review between tasks, and keep iterating here.

**2. Parallel Session (separate)** - Open a new session with `executing-plans`, then implement this plan task-by-task with checkpoints.

Which approach?
