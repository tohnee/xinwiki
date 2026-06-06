# llm-wiki Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a canonical llm-wiki runtime so upload parsing, knowledge compilation, query, chat, and export all operate on the same persistent knowledge base.

**Architecture:** Introduce a parser adapter boundary, a runtime persistence layer for entries/edges/provenance, an incremental compiler, a shared runtime query service, and an export projection layer. Keep the raw-source store immutable and migrate existing chat/query/export paths onto runtime-backed services incrementally under TDD.

**Tech Stack:** Node.js, Express, SQLite (`better-sqlite3`), Vitest, Supertest

---

## File Structure

**Create**
- `server/services/parser-adapter.js` - parser adapter interface and default local parser implementation
- `server/services/llm-wiki-runtime.js` - runtime domain helpers, entry/edge normalization, projection helpers
- `server/services/llm-wiki-compiler.js` - incremental compiler from `DocumentParseResult` and curated knowledge into runtime entries and edges
- `server/services/llm-wiki-query.js` - shared runtime query service for `/api/llm-wiki/query` and `/api/chat/message`
- `tests/parser-adapter.test.js` - parser adapter contract tests
- `tests/llm-wiki-runtime.test.js` - runtime persistence and relation normalization tests
- `tests/llm-wiki-compiler.test.js` - compiler upsert, provenance, and idempotency tests

**Modify**
- `server/services/document-parser.js` - refactor into low-level local parser implementation consumed by adapter
- `server/db.js` - add runtime persistence tables and access methods
- `server/app.js` - switch upload, query, chat, and export flows to runtime services in phases
- `server/services/llm-wiki-exporter.js` - export from runtime projections instead of legacy wiki/ontology tables
- `tests/source-pipeline.test.js` - assert runtime-backed ingest behavior
- `tests/chat-api.test.js` - assert shared runtime query path and grounded evidence behavior
- `tests/bootstrap-and-export.test.js` - assert runtime-backed query and export projection
- `tests/llm-wiki-exporter.test.js` - assert index/log and projection fidelity

---

### Task 1: Parser Adapter Boundary

**Files:**
- Create: `server/services/parser-adapter.js`
- Modify: `server/services/document-parser.js`
- Test: `tests/parser-adapter.test.js`

- [ ] **Step 1: Write the failing test**

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultParserAdapter } from "../server/services/parser-adapter.js";

const tempDirs = [];

function fakeUpload(filePath, originalname) {
  return {
    path: filePath,
    originalname,
    mimetype: "text/markdown",
    size: 32,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("parser adapter", () => {
  it("returns the canonical DocumentParseResult shape", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-parser-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "aurora.md");
    await fs.writeFile(filePath, "# Project Aurora\n\n客户 A 的采购代号。", "utf8");

    const adapter = createDefaultParserAdapter();
    const result = await adapter.parse({
      sourceId: "source_demo",
      file: fakeUpload(filePath, "aurora.md"),
    });

    expect(result.document).toEqual(
      expect.objectContaining({
        sourceId: "source_demo",
        fileName: "aurora.md",
        parserName: "local-basic",
      }),
    );
    expect(result.content).toEqual(
      expect.objectContaining({
        markdown: expect.stringContaining("# Project Aurora"),
        plainText: expect.any(String),
        sections: expect.any(Array),
        contentBlocks: expect.any(Array),
      }),
    );
    expect(result.artifacts).toEqual(
      expect.objectContaining({
        tables: expect.any(Array),
        figures: expect.any(Array),
        citations: expect.any(Array),
      }),
    );
    expect(result.quality).toEqual(
      expect.objectContaining({
        mode: expect.any(String),
        warnings: expect.any(Array),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/parser-adapter.test.js --reporter=verbose`

Expected: FAIL because `server/services/parser-adapter.js` does not exist and no canonical `DocumentParseResult` contract exists yet.

- [ ] **Step 3: Write minimal implementation**

```js
// server/services/parser-adapter.js
import { parseDocumentFile } from "./document-parser.js";

function toPlainText(markdown) {
  return String(markdown || "").replace(/^#{1,6}\s+/gm, "").trim();
}

function toBlocks(sections) {
  return (sections || []).map(([heading, content], index) => ({
    kind: "section",
    index,
    heading,
    text: content,
  }));
}

export function createDefaultParserAdapter() {
  return {
    name: "local-basic",
    async parse({ sourceId, file }) {
      const parsed = await parseDocumentFile(file);
      return {
        document: {
          sourceId,
          fileName: file.originalname,
          mimeType: file.mimetype || "application/octet-stream",
          parserName: "local-basic",
          parserVersion: "v1",
        },
        content: {
          markdown: parsed.markdown,
          plainText: toPlainText(parsed.markdown),
          sections: parsed.sections,
          contentBlocks: toBlocks(parsed.sections),
        },
        artifacts: {
          tables: [],
          figures: [],
          citations: [],
        },
        quality: {
          warnings: [],
          confidence: 0.6,
          mode: parsed.parserMeta?.mode || "text",
        },
        rawPointers: [],
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/parser-adapter.test.js --reporter=verbose`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/parser-adapter.js server/services/document-parser.js tests/parser-adapter.test.js
git commit -m "feat: add llm-wiki parser adapter contract"
```

### Task 2: Runtime Persistence Schema

**Files:**
- Create: `server/services/llm-wiki-runtime.js`
- Modify: `server/db.js`
- Test: `tests/llm-wiki-runtime.test.js`

- [ ] **Step 1: Write the failing test**

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../server/db.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("llm-wiki runtime persistence", () => {
  it("persists workspace-scoped entries, edges, and provenance with normalized relation ordering", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });

    db.saveRuntimeEntry("workspace_a", {
      id: "entry_page_aurora",
      kind: "page",
      title: "Project Aurora",
      summary: "客户 A 采购计划。",
      bodyMarkdown: "# Project Aurora",
      aliases: ["Aurora"],
      tags: ["customer"],
      status: "active",
      sourceRefs: [{ sourceId: "source_1", sourceType: "upload" }],
      compiledFrom: ["source_1"],
      updatedAt: "2026-06-05T00:00:00.000Z",
      version: 1,
    });

    db.saveRuntimeEdge("workspace_a", {
      fromEntryId: "entry_page_aurora",
      toEntryId: "entry_entity_customer_a",
      type: "mentions",
      evidenceRefs: [{ sourceId: "source_1", excerpt: "客户 A" }],
      confidence: 0.9,
    });

    const snapshot = db.getRuntimeSnapshot("workspace_a");
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.entries[0].workspaceId).toBe("workspace_a");
    expect(snapshot.edges[0]).toEqual(
      expect.objectContaining({
        fromEntryId: "entry_page_aurora",
        toEntryId: "entry_entity_customer_a",
        type: "mentions",
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm-wiki-runtime.test.js --reporter=verbose`

Expected: FAIL because runtime persistence tables and methods do not exist.

- [ ] **Step 3: Write minimal implementation**

```js
// server/db.js
db.exec(`
  CREATE TABLE IF NOT EXISTS llm_wiki_entries (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id)
  );
  CREATE TABLE IF NOT EXISTS llm_wiki_edges (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id)
  );
`);

function withWorkspace(workspaceId, payload) {
  return { ...payload, workspaceId };
}

saveRuntimeEntry(workspaceId, entry) {
  this.statements.saveRuntimeEntry.run(workspaceId, entry.id, JSON.stringify(withWorkspace(workspaceId, entry)));
}

saveRuntimeEdge(workspaceId, edge) {
  const id = `${edge.fromEntryId}::${edge.type}::${edge.toEntryId}`;
  this.statements.saveRuntimeEdge.run(workspaceId, id, JSON.stringify(withWorkspace(workspaceId, { id, ...edge })));
}

getRuntimeSnapshot(workspaceId) {
  return {
    entries: this.statements.listRuntimeEntries.all(workspaceId).map((row) => JSON.parse(row.payload_json)),
    edges: this.statements.listRuntimeEdges.all(workspaceId).map((row) => JSON.parse(row.payload_json)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm-wiki-runtime.test.js --reporter=verbose`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/services/llm-wiki-runtime.js tests/llm-wiki-runtime.test.js
git commit -m "feat: add llm-wiki runtime persistence"
```

### Task 3: Incremental Compiler

**Files:**
- Create: `server/services/llm-wiki-compiler.js`
- Modify: `server/app.js`
- Test: `tests/llm-wiki-compiler.test.js`
- Test: `tests/source-pipeline.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from "vitest";

import { compileDocumentIntoRuntime } from "../server/services/llm-wiki-compiler.js";

describe("llm-wiki compiler", () => {
  it("compiles a parse result into page and entity runtime entries with provenance", () => {
    const result = compileDocumentIntoRuntime({
      workspaceId: "workspace_demo",
      parseResult: {
        document: {
          sourceId: "source_aurora",
          fileName: "aurora.md",
          mimeType: "text/markdown",
          parserName: "local-basic",
          parserVersion: "v1",
        },
        content: {
          markdown: "# Project Aurora\n\n客户 A 采购计划。",
          plainText: "Project Aurora 客户 A 采购计划。",
          sections: [["Project Aurora", "客户 A 采购计划。"]],
          contentBlocks: [{ kind: "section", index: 0, heading: "Project Aurora", text: "客户 A 采购计划。" }],
        },
        artifacts: { tables: [], figures: [], citations: [] },
        quality: { warnings: [], confidence: 0.6, mode: "text" },
        rawPointers: [],
      },
    });

    expect(result.upsertedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "page", title: "Project Aurora" }),
      ]),
    );
    expect(result.upsertedEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mentions" }),
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm-wiki-compiler.test.js --reporter=verbose`

Expected: FAIL because no compiler service exists.

- [ ] **Step 3: Write minimal implementation**

```js
// server/services/llm-wiki-compiler.js
function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function compileDocumentIntoRuntime({ workspaceId, parseResult }) {
  const title = parseResult.content.sections?.[0]?.[0] || parseResult.document.fileName;
  const pageId = `page_${slug(title)}`;
  const entityId = `entity_${slug(title)}`;
  const sourceRef = {
    sourceId: parseResult.document.sourceId,
    sourceType: "upload",
    locator: { sectionHeading: title, blockIndex: 0 },
    excerpt: parseResult.content.plainText.slice(0, 120),
    confidence: parseResult.quality.confidence,
  };

  return {
    upsertedEntries: [
      {
        id: pageId,
        workspaceId,
        kind: "page",
        title,
        summary: parseResult.content.plainText.slice(0, 120),
        bodyMarkdown: parseResult.content.markdown,
        aliases: [],
        tags: ["compiled"],
        status: "active",
        sourceRefs: [sourceRef],
        compiledFrom: [parseResult.document.sourceId],
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      {
        id: entityId,
        workspaceId,
        kind: "entity",
        title,
        summary: `Entity derived from ${title}`,
        bodyMarkdown: `# ${title}`,
        aliases: [],
        tags: ["entity"],
        status: "active",
        sourceRefs: [sourceRef],
        compiledFrom: [parseResult.document.sourceId],
        updatedAt: new Date().toISOString(),
        version: 1,
      },
    ],
    upsertedEdges: [
      {
        fromEntryId: pageId,
        toEntryId: entityId,
        type: "mentions",
        evidenceRefs: [sourceRef],
        confidence: 0.8,
      },
    ],
    supersededEntries: [],
    logEvents: [{ kind: "ingest", sourceId: parseResult.document.sourceId }],
    lintHints: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm-wiki-compiler.test.js tests/source-pipeline.test.js --reporter=verbose`

Expected: PASS for the new compiler test, and no regressions in the existing source pipeline after upload flow is adapted to call the compiler.

- [ ] **Step 5: Commit**

```bash
git add server/services/llm-wiki-compiler.js server/app.js tests/llm-wiki-compiler.test.js tests/source-pipeline.test.js
git commit -m "feat: compile parsed uploads into llm-wiki runtime"
```

### Task 4: Shared Runtime Query For Query And Chat

**Files:**
- Create: `server/services/llm-wiki-query.js`
- Modify: `server/app.js`
- Test: `tests/chat-api.test.js`
- Test: `tests/bootstrap-and-export.test.js`

- [ ] **Step 1: Write the failing test**

```js
it("serves query and chat from the same runtime retrieval path", async () => {
  const { app } = await makeApp();

  const registerResponse = await request(app).post("/api/auth/register").send({
    email: "runtime-query@example.com",
    password: "Passw0rd!",
    displayName: "Runtime Query",
  });

  const cookie = registerResponse.headers["set-cookie"];

  await request(app)
    .post("/api/memories")
    .set("Cookie", cookie)
    .send({ text: "Project Aurora 是客户 A 采购代号。", period: "长期记忆" })
    .expect(201);

  const queryResponse = await request(app)
    .get("/api/llm-wiki/query")
    .query({ q: "客户 A 采购代号" })
    .set("Cookie", cookie);

  const chatResponse = await request(app)
    .post("/api/chat/message")
    .set("Cookie", cookie)
    .send({ question: "客户 A 采购代号是什么？" });

  expect(queryResponse.status).toBe(200);
  expect(queryResponse.body.entries.join(" ")).toMatch(/Project Aurora/);
  expect(chatResponse.status).toBe(201);
  expect(chatResponse.body.answer).toMatch(/Project Aurora/);
  expect(chatResponse.body.citations.join(" ")).toMatch(/memory-note|qa-note|page/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chat-api.test.js tests/bootstrap-and-export.test.js --reporter=verbose`

Expected: FAIL because `query` and `chat` still use different retrieval logic and current query payload does not expose runtime-shaped results.

- [ ] **Step 3: Write minimal implementation**

```js
// server/services/llm-wiki-query.js
export function queryRuntimeSnapshot(snapshot, question) {
  const lowered = String(question || "").toLowerCase();
  const entries = snapshot.entries
    .map((entry) => ({
      ...entry,
      score: `${entry.title} ${entry.summary} ${entry.bodyMarkdown}`.toLowerCase().includes(lowered) ? 5 : 0,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    entries,
    relations: snapshot.edges.filter((edge) => entries.some((entry) => entry.id === edge.fromEntryId || entry.id === edge.toEntryId)),
    evidence: entries.flatMap((entry) => entry.sourceRefs || []),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/chat-api.test.js tests/bootstrap-and-export.test.js --reporter=verbose`

Expected: PASS after both `/api/llm-wiki/query` and `/api/chat/message` call the same runtime query service and chat builds grounded packages from runtime evidence only.

- [ ] **Step 5: Commit**

```bash
git add server/services/llm-wiki-query.js server/app.js tests/chat-api.test.js tests/bootstrap-and-export.test.js
git commit -m "feat: unify llm-wiki query and chat retrieval"
```

### Task 5: Export Runtime Projection

**Files:**
- Modify: `server/services/llm-wiki-exporter.js`
- Modify: `server/app.js`
- Test: `tests/llm-wiki-exporter.test.js`
- Test: `tests/bootstrap-and-export.test.js`

- [ ] **Step 1: Write the failing test**

```js
it("projects runtime state into wiki pages, graph, index, and log", async () => {
  const exportResult = await exportRuntimeToLlmWiki({
    outputDir,
    workspace: { id: "workspace_demo", name: "Demo Workspace" },
    runtime: {
      entries: [
        {
          id: "page_project_aurora",
          kind: "page",
          title: "Project Aurora",
          summary: "客户 A 采购代号。",
          bodyMarkdown: "# Project Aurora\n\n客户 A 采购代号。",
          aliases: ["Aurora"],
          tags: ["customer"],
          sourceRefs: [{ sourceId: "source_1", sourceType: "upload" }],
        },
      ],
      edges: [],
      logs: [{ kind: "ingest", sourceId: "source_1" }],
    },
  });

  expect(exportResult.pageCount).toBe(1);
  expect(await fs.readFile(path.join(outputDir, "index.md"), "utf8")).toContain("Project Aurora");
  expect(await fs.readFile(path.join(outputDir, "log.md"), "utf8")).toContain("ingest");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm-wiki-exporter.test.js tests/bootstrap-and-export.test.js --reporter=verbose`

Expected: FAIL because exporter still serializes legacy wiki/ontology structures only and does not emit `index.md` or `log.md`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/services/llm-wiki-exporter.js
function buildIndex(runtime) {
  return [
    "# Index",
    "",
    ...runtime.entries.map((entry) => `- [[${entry.title}]] - ${entry.summary}`),
    "",
  ].join("\n");
}

function buildLog(runtime) {
  return [
    "# Log",
    "",
    ...runtime.logs.map((event, index) => `## [${index + 1}] ${event.kind} | ${event.sourceId || "runtime"}`),
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm-wiki-exporter.test.js tests/bootstrap-and-export.test.js --reporter=verbose`

Expected: PASS with runtime-backed export projection and new `index.md` / `log.md` files.

- [ ] **Step 5: Commit**

```bash
git add server/services/llm-wiki-exporter.js server/app.js tests/llm-wiki-exporter.test.js tests/bootstrap-and-export.test.js
git commit -m "feat: project llm-wiki runtime to export files"
```

### Task 6: Full Regression And Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/2026-06-05-llm-wiki-runtime-design.md`
- Test: `tests/auth-api.test.js`
- Test: `tests/source-pipeline.test.js`
- Test: `tests/chat-api.test.js`
- Test: `tests/bootstrap-and-export.test.js`
- Test: `tests/llm-wiki-exporter.test.js`

- [ ] **Step 1: Write the failing test**

```js
it("exports runtime-backed llm-wiki without leaking absolute paths", async () => {
  const { app } = await makeApp();
  const registerResponse = await request(app).post("/api/auth/register").send({
    email: "runtime-export@example.com",
    password: "Passw0rd!",
    displayName: "Runtime Export",
  });
  const cookie = registerResponse.headers["set-cookie"];

  const response = await request(app)
    .post("/api/llm-wiki/export")
    .set("Cookie", cookie);

  expect(response.status).toBe(201);
  expect(response.body.outputDir).toBeUndefined();
  expect(response.body.workspaceId).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`

Expected: FAIL if any remaining endpoint still depends on legacy wiki/ontology-only behavior or if docs are out of sync with runtime-backed behavior.

- [ ] **Step 3: Write minimal implementation**

```md
## README updates

- describe llm-wiki runtime as the canonical knowledge base
- explain parser adapter and future MinerU integration point
- explain that query and chat both use runtime-backed retrieval
- explain export as runtime projection
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`

Expected: PASS with all existing and new tests green.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/specs/2026-06-05-llm-wiki-runtime-design.md tests
git commit -m "docs: sync llm-wiki runtime architecture and coverage"
```

---

## Self-Review Checklist

- Spec coverage:
  - Parser adapter is covered by Task 1
  - Runtime schema is covered by Task 2
  - Compiler contract is covered by Task 3
  - Shared query/chat flow is covered by Task 4
  - Export projection is covered by Task 5
  - Risk controls and regression coverage are covered by Task 6

- Placeholder scan:
  - No `TBD`
  - No `TODO`
  - No unresolved "implement later" language

- Type consistency:
  - `DocumentParseResult` is introduced in Task 1 and reused in Task 3
  - `entry`, `edge`, and `sourceRefs` vocabulary is consistent across tasks
  - runtime query terminology stays aligned between Task 4 and Task 5

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-05-llm-wiki-runtime-implementation-plan.md`.

Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints
