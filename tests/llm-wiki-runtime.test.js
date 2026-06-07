import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../server/db.js";
import { normalizeLegacyRelationArrays } from "../server/services/llm-wiki-runtime.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("llm-wiki runtime persistence", () => {
  it("persists workspace-scoped entries, edges, and provenance with normalized relation ordering", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "runtime-a@example.com",
      passwordHash: "hash",
      displayName: "Runtime A",
    });

    db.saveRuntimeEntry(workspace.id, {
      id: "entry_page_aurora",
      kind: "page",
      title: "Project Aurora",
      summary: "客户 A 采购计划。",
      bodyMarkdown: "# Project Aurora",
      aliases: ["Aurora"],
      tags: ["customer"],
      status: "active",
      sourceRefs: [
        {
          sourceId: "source_1",
          sourceType: "upload",
          locator: { sectionHeading: "Project Aurora", blockIndex: 0 },
          excerpt: "客户 A 采购计划。",
          confidence: 0.8,
        },
      ],
      compiledFrom: ["source_1"],
      updatedAt: "2026-06-05T00:00:00.000Z",
      version: 1,
    });

    db.saveRuntimeEdge(workspace.id, {
      fromEntryId: "entry_page_aurora",
      toEntryId: "entry_entity_customer_a",
      type: "mentions",
      evidenceRefs: [
        {
          sourceId: "source_1",
          sourceType: "upload",
          excerpt: "客户 A",
          confidence: 0.9,
        },
      ],
      confidence: 0.9,
    });

    db.addRuntimeLog(workspace.id, {
      kind: "ingest",
      sourceId: "source_1",
      detail: "compiled aurora runtime entry",
    });
    db.addRuntimeLintIssue(workspace.id, {
      code: "missing-alias",
      severity: "low",
      entryId: "entry_page_aurora",
      message: "Aurora page should expose more aliases.",
    });

    const snapshot = db.getRuntimeSnapshot(workspace.id);
    const customEntries = snapshot.entries.filter((entry) => entry.id === "entry_page_aurora");
    const customEdges = snapshot.edges.filter((edge) => edge.fromEntryId === "entry_page_aurora");
    expect(customEntries).toHaveLength(1);
    expect(customEdges).toHaveLength(1);
    expect(snapshot.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: workspace.id,
          ownerType: "entry",
          ownerId: "entry_page_aurora",
          refRole: "sourceRef",
          sourceId: "source_1",
        }),
        expect.objectContaining({
          workspaceId: workspace.id,
          ownerType: "edge",
          ownerId: "entry_page_aurora::mentions::entry_entity_customer_a",
          refRole: "evidenceRef",
          sourceId: "source_1",
          excerpt: "客户 A",
        }),
      ]),
    );
    expect(customEntries[0]).toEqual(
      expect.objectContaining({
        workspaceId: workspace.id,
        id: "entry_page_aurora",
        kind: "page",
      }),
    );
    expect(customEntries[0].sourceRefs).toEqual([
      expect.objectContaining({
        sourceId: "source_1",
        locator: expect.objectContaining({ sectionHeading: "Project Aurora", blockIndex: 0 }),
      }),
    ]);
    expect(customEdges[0]).toEqual(
      expect.objectContaining({
        id: "entry_page_aurora::mentions::entry_entity_customer_a",
        workspaceId: workspace.id,
        fromEntryId: "entry_page_aurora",
        toEntryId: "entry_entity_customer_a",
        type: "mentions",
      }),
    );
    expect(customEdges[0].evidenceRefs).toEqual([
      expect.objectContaining({
        sourceId: "source_1",
        excerpt: "客户 A",
      }),
    ]);
    expect(snapshot.logs).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        kind: "ingest",
        sourceId: "source_1",
      }),
    ]);
    expect(snapshot.lintIssues).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        code: "missing-alias",
        severity: "low",
        entryId: "entry_page_aurora",
      }),
    ]);
  });

  it("persists minimal maintenance metadata including index views, staleness markers, and superseded markers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "runtime-maintenance@example.com",
      passwordHash: "hash",
      displayName: "Runtime Maintenance",
    });

    db.addRuntimeIndexView(workspace.id, {
      key: "default",
      title: "Default Runtime Index",
      entryIds: ["entry_page_aurora", "entry_entity_customer_a"],
    });
    db.addRuntimeStalenessMarker(workspace.id, {
      targetType: "entry",
      targetId: "entry_page_aurora",
      reason: "source-updated",
      severity: "medium",
    });
    db.addRuntimeSupersededMarker(workspace.id, {
      targetType: "entry",
      targetId: "entry_page_aurora_v1",
      supersededById: "entry_page_aurora_v2",
      reason: "recompiled",
    });

    const snapshot = db.getRuntimeSnapshot(workspace.id);
    expect(snapshot.indexViews).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        key: "default",
        entryIds: ["entry_page_aurora", "entry_entity_customer_a"],
      }),
    ]);
    expect(snapshot.stalenessMarkers).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        targetType: "entry",
        targetId: "entry_page_aurora",
        reason: "source-updated",
      }),
    ]);
    expect(snapshot.supersededMarkers).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        targetType: "entry",
        targetId: "entry_page_aurora_v1",
        supersededById: "entry_page_aurora_v2",
      }),
    ]);
  });

  it("keeps runtime snapshots isolated per workspace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace: workspaceA } = db.createUser({
      email: "runtime-isolation-a@example.com",
      passwordHash: "hash",
      displayName: "Runtime Isolation A",
    });
    const { workspace: workspaceB } = db.createUser({
      email: "runtime-isolation-b@example.com",
      passwordHash: "hash",
      displayName: "Runtime Isolation B",
    });

    db.saveRuntimeEntry(workspaceA.id, {
      id: "entry_a",
      kind: "page",
      title: "Workspace A",
      summary: "A",
      bodyMarkdown: "# A",
      aliases: [],
      tags: [],
      status: "active",
      sourceRefs: [],
      compiledFrom: [],
      updatedAt: "2026-06-05T00:00:00.000Z",
      version: 1,
    });
    db.saveRuntimeEntry(workspaceB.id, {
      id: "entry_b",
      kind: "page",
      title: "Workspace B",
      summary: "B",
      bodyMarkdown: "# B",
      aliases: [],
      tags: [],
      status: "active",
      sourceRefs: [],
      compiledFrom: [],
      updatedAt: "2026-06-05T00:00:00.000Z",
      version: 1,
    });

    expect(db.getRuntimeSnapshot(workspaceA.id).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "entry_a", workspaceId: workspaceA.id })]),
    );
    expect(db.getRuntimeSnapshot(workspaceB.id).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "entry_b", workspaceId: workspaceB.id })]),
    );
    expect(db.getRuntimeSnapshot(workspaceA.id).entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "entry_b" })]),
    );
  });

  it("normalizes legacy relation arrays into runtime edge schema before persistence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "runtime-legacy@example.com",
      passwordHash: "hash",
      displayName: "Runtime Legacy",
    });

    const normalizedEdges = normalizeLegacyRelationArrays({
      workspaceId: workspace.id,
      fromEntryId: "entry_page_aurora",
      relations: [
        ["mentions", "entry_entity_customer_a"],
        ["entry_page_aurora", "related_to", "entry_entity_procurement_plan"],
        {
          relation: "supports",
          targetId: "entry_note_budget_signal",
          evidence: [
            {
              sourceId: "source_2",
              sourceType: "upload",
              excerpt: "预算信号",
              confidence: 0.7,
            },
          ],
          confidence: 0.7,
        },
      ],
    });

    for (const edge of normalizedEdges) {
      db.saveRuntimeEdge(workspace.id, edge);
    }

    const snapshot = db.getRuntimeSnapshot(workspace.id);
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "entry_page_aurora::mentions::entry_entity_customer_a",
          fromEntryId: "entry_page_aurora",
          toEntryId: "entry_entity_customer_a",
          type: "mentions",
        }),
        expect.objectContaining({
          id: "entry_page_aurora::supports::entry_note_budget_signal",
          fromEntryId: "entry_page_aurora",
          toEntryId: "entry_note_budget_signal",
          type: "supports",
          evidenceRefs: [
            expect.objectContaining({
              sourceId: "source_2",
              excerpt: "预算信号",
            }),
          ],
        }),
        expect.objectContaining({
          id: "entry_page_aurora::related_to::entry_entity_procurement_plan",
          fromEntryId: "entry_page_aurora",
          toEntryId: "entry_entity_procurement_plan",
          type: "related_to",
        }),
      ]),
    );
  });

  it("rejects invalid runtime entry, edge, and provenance payloads with explicit validation errors", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "runtime-validation@example.com",
      passwordHash: "hash",
      displayName: "Runtime Validation",
    });

    expect(() =>
      db.saveRuntimeEntry(workspace.id, {
        id: "",
        kind: "page",
        title: "Invalid",
        summary: "",
        bodyMarkdown: "# Invalid",
        aliases: [],
        tags: [],
        status: "active",
        sourceRefs: [],
        compiledFrom: [],
        updatedAt: "2026-06-05T00:00:00.000Z",
        version: 1,
      }),
    ).toThrow(/runtime entry/i);

    expect(() =>
      db.saveRuntimeEntry(workspace.id, {
        id: "entry_missing_requireds",
        kind: "page",
        title: "Missing Requireds",
        summary: "",
        bodyMarkdown: "",
        aliases: [],
        tags: [],
        status: "",
        sourceRefs: [],
        compiledFrom: [],
        updatedAt: "",
        version: 0,
      }),
    ).toThrow(/runtime entry/i);

    expect(() =>
      db.saveRuntimeEdge(workspace.id, {
        fromEntryId: "entry_page_aurora",
        toEntryId: "",
        type: "mentions",
        evidenceRefs: [],
        confidence: 0.9,
      }),
    ).toThrow(/runtime edge/i);

    expect(() =>
      db.saveRuntimeEntry(workspace.id, {
        id: "entry_invalid_provenance",
        kind: "page",
        title: "Invalid Provenance",
        summary: "Valid summary",
        bodyMarkdown: "# Invalid Provenance",
        aliases: [],
        tags: [],
        status: "active",
        sourceRefs: [{ sourceType: "upload" }],
        compiledFrom: [],
        updatedAt: "2026-06-05T00:00:00.000Z",
        version: 1,
      }),
    ).toThrow(/provenance/i);
  });

  it("rejects runtime writes for nonexistent workspaces when foreign key integrity is enforced", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });

    expect(() =>
      db.saveRuntimeEntry("workspace_missing", {
        id: "entry_orphan",
        kind: "page",
        title: "Orphan Entry",
        summary: "Should fail",
        bodyMarkdown: "# Orphan",
        aliases: [],
        tags: [],
        status: "active",
        sourceRefs: [],
        compiledFrom: [],
        updatedAt: "2026-06-05T00:00:00.000Z",
        version: 1,
      }),
    ).toThrow(/foreign key|constraint/i);

    expect(() =>
      db.saveRuntimeEdge("workspace_missing", {
        fromEntryId: "entry_page_aurora",
        toEntryId: "entry_entity_customer_a",
        type: "mentions",
        evidenceRefs: [],
        confidence: 0.9,
      }),
    ).toThrow(/foreign key|constraint/i);
  });
});

describe("llm-wiki runtime incremental and indexed query", () => {
  function runtimeEntry({ id, title, sourceId, bodyMarkdown = "# Runtime Entry", status = "active" }) {
    return {
      id,
      kind: "page",
      title,
      summary: `${title} summary`,
      bodyMarkdown,
      aliases: [],
      tags: ["scale-test"],
      status,
      sourceRefs: [
        {
          sourceId,
          sourceType: "upload",
          locator: { sectionHeading: title, blockIndex: 0 },
          excerpt: bodyMarkdown,
          confidence: 0.8,
        },
      ],
      compiledFrom: [sourceId],
      updatedAt: "2026-06-05T00:00:00.000Z",
      version: 1,
    };
  }

  it("narrows incremental compile snapshots to the changed source instead of loading the whole runtime", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-incremental-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "runtime-incremental@example.com",
      passwordHash: "hash",
      displayName: "Runtime Incremental",
    });

    db.saveRuntimeEntry(workspace.id, runtimeEntry({
      id: "entry_source_a",
      title: "Source A Only",
      sourceId: "source_a",
      bodyMarkdown: "# Source A\n\nOnly source A should be returned.",
    }));
    db.saveRuntimeEntry(workspace.id, runtimeEntry({
      id: "entry_source_b",
      title: "Source B Only",
      sourceId: "source_b",
      bodyMarkdown: "# Source B\n\nOnly source B should stay outside the source A incremental snapshot.",
    }));
    db.saveRuntimeEdge(workspace.id, {
      fromEntryId: "entry_source_a",
      toEntryId: "entry_entity_a",
      type: "mentions",
      evidenceRefs: [{ sourceId: "source_a", sourceType: "upload", excerpt: "entity A" }],
      confidence: 0.7,
    });

    const sourceSnapshot = db.getRuntimeSourceSnapshot(workspace.id, "source_a");
    expect(sourceSnapshot.entries).toEqual([
      expect.objectContaining({ id: "entry_source_a", compiledFrom: ["source_a"] }),
    ]);
    expect(sourceSnapshot.edges).toEqual([
      expect.objectContaining({ fromEntryId: "entry_source_a", type: "mentions" }),
    ]);
    expect(sourceSnapshot.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "source_a", ownerId: "entry_source_a" }),
      ]),
    );
    expect(sourceSnapshot.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "entry_source_b" })]),
    );
  });

  it("uses the runtime search index to retrieve a needle from a large workspace without scanning the full snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-search-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "runtime-search@example.com",
      passwordHash: "hash",
      displayName: "Runtime Search",
    });

    const bulkInsert = db.db.transaction(() => {
      for (let i = 0; i < 10000; i += 1) {
        db.saveRuntimeEntry(workspace.id, runtimeEntry({
          id: `entry_bulk_${i}`,
          title: `Bulk Runtime Page ${i}`,
          sourceId: `bulk_source_${i}`,
          bodyMarkdown: `# Bulk Runtime Page ${i}\n\nGeneric runtime content ${i}.`,
        }));
      }
      db.saveRuntimeEntry(workspace.id, runtimeEntry({
        id: "entry_unique_needle",
        title: "Quantum Needle Capacity",
        sourceId: "needle_source",
        bodyMarkdown: "# Quantum Needle Capacity\n\nUniqueNeedleAlpha capacity evidence for indexed retrieval.",
      }));
    });
    bulkInsert();

    const startedAt = performance.now();
    const indexedSnapshot = db.queryRuntimeSnapshot(workspace.id, "UniqueNeedleAlpha", { limit: 5 });
    const elapsedMs = performance.now() - startedAt;

    expect(indexedSnapshot.entries).toEqual([
      expect.objectContaining({ id: "entry_unique_needle", title: "Quantum Needle Capacity" }),
    ]);
    expect(indexedSnapshot.entries.length).toBeLessThanOrEqual(5);
    expect(elapsedMs).toBeLessThan(750);
  }, 60000);
});
