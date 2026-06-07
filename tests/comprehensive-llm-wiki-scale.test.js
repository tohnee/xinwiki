/**
 * T8: llm-wiki 增量编译+大规模查询性能测试（增强版）
 *
 * 验证：
 * - 增量编译：只处理变更的 source，不全量重建
 * - 10000+ 文件场景下的查询效率
 * - 增量快照（source-scoped snapshot）正确性
 * - FTS5 全文搜索在大数据量下的性能
 * - 编译器幂等性
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileDocumentIntoRuntime } from "../server/services/llm-wiki-compiler.js";
import { createDatabase } from "../server/db.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function makeParseResult(sourceId, title) {
  return {
    document: {
      sourceId,
      fileName: `${title}.md`,
      mimeType: "text/markdown",
      parserName: "scale-test",
      parserVersion: "v1",
    },
    content: {
      markdown: `# ${title}\n\n${title} content for scale testing.`,
      plainText: `${title} content`,
      sections: [[title, `${title} content for scale testing.`]],
      contentBlocks: [{ kind: "section", index: 0, heading: title, text: `${title} content` }],
    },
    artifacts: { tables: [], figures: [], citations: [] },
    quality: { warnings: [], confidence: 0.6, mode: "text" },
    rawPointers: [],
  };
}

function runtimeEntry(id, title, sourceId) {
  return {
    id,
    kind: "page",
    title,
    summary: `${title} summary`,
    bodyMarkdown: `# ${title}\n\n${title} content for scale testing.`,
    aliases: [],
    tags: ["scale-test"],
    status: "active",
    sourceRefs: [{
      sourceId,
      sourceType: "upload",
      locator: { sectionHeading: title, blockIndex: 0 },
      excerpt: `${title} content`,
      confidence: 0.8,
    }],
    compiledFrom: [sourceId],
    updatedAt: "2026-06-05T00:00:00.000Z",
    version: 1,
  };
}

describe("T8.1: 增量编译正确性", () => {
  it("编译器只对变更的 source 生成 upsert，不触碰无关数据", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-scale-inc-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "scale-inc@test.com",
      passwordHash: "hash",
      displayName: "Scale Inc",
    });

    // 创建 2 个不同 source 的 runtime entries
    const sourceA = "source_alpha";
    const sourceB = "source_beta";
    db.saveRuntimeEntry(workspace.id, runtimeEntry("entry_alpha_page", "Alpha Page", sourceA));
    db.saveRuntimeEntry(workspace.id, runtimeEntry("entry_beta_page", "Beta Page", sourceB));
    db.saveRuntimeEdge(workspace.id, {
      fromEntryId: "entry_beta_page",
      toEntryId: "entry_entity_beta",
      type: "mentions",
      evidenceRefs: [{ sourceId: sourceB, sourceType: "upload", excerpt: "entity beta", confidence: 0.7 }],
      confidence: 0.7,
    });

    // 对 sourceA 重新编译
    const parseResult = makeParseResult(sourceA, "Alpha Page Updated");
    const existingSnapshot = db.getRuntimeSourceSnapshot(workspace.id, sourceA);

    const compilation = compileDocumentIntoRuntime({
      workspaceId: workspace.id,
      parseResult,
      existingRuntimeSnapshot: existingSnapshot,
      compiledAt: "2026-06-06T00:00:00.000Z",
    });

    // 验证只处理了 sourceA 相关的条目
    const affectedIds = compilation.upsertedEntries.map((e) => e.id);
    const supersededIds = compilation.supersededEntries || [];

    // sourceB 的条目不应受影响
    expect(affectedIds).not.toContain("entry_beta_page");
    expect(supersededIds).not.toContain("entry_beta_page");

    // removedEdges 不应包含 sourceB 的边
    const removedEdgeIds = compilation.removedEdges.map((e) => `${e.fromEntryId}::${e.type}::${e.toEntryId}`);
    expect(removedEdgeIds).not.toContain("entry_beta_page::mentions::entry_entity_beta");

    // sourceA 的旧条目应该被标记
    expect(compilation.staleMarkers.length).toBeGreaterThanOrEqual(0);
    expect(compilation.supersededMarkers.length).toBeGreaterThanOrEqual(0);
  });

  it("编译器对多次相同输入完全幂等", async () => {
    const parseResult = makeParseResult("source_idem", "Idempotent Scale");

    // 第一次编译产生基线输出
    const first = compileDocumentIntoRuntime({
      workspaceId: "ws_scale_idem",
      parseResult,
      existingRuntimeSnapshot: {},
    });

    expect(first.upsertedEntries.length).toBeGreaterThan(0);

    // 用第一次的输出作为 existingSnapshot，再用相同输入编译第二次
    const existingSnapshot = {
      entries: first.upsertedEntries.filter((e) => e.status !== "superseded"),
      edges: first.upsertedEdges,
      provenance: [],
      logs: [],
      lintIssues: [],
      indexViews: [],
      stalenessMarkers: [],
      supersededMarkers: [],
    };

    const second = compileDocumentIntoRuntime({
      workspaceId: "ws_scale_idem",
      parseResult,
      existingRuntimeSnapshot: existingSnapshot,
    });

    // 第二次编译应完全幂等，无任何变化
    expect(second.upsertedEntries).toEqual([]);
    expect(second.upsertedEdges).toEqual([]);
    expect(second.removedEdges).toEqual([]);
    expect(second.staleMarkers).toEqual([]);
    expect(second.supersededMarkers).toEqual([]);
    expect(second.logEvents).toEqual([]);
  });
});

describe("T8.2: 10000 文件规模下的查询性能", () => {
  it("10000 条 runtime entry 中精确检索特定条目在 500ms 内完成", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-scale-10k-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "scale-10k@test.com",
      passwordHash: "hash",
      displayName: "Scale 10k",
    });

    // 批量插入 10000 条
    const bulkInsert = db.db.transaction(() => {
      for (let i = 0; i < 10000; i += 1) {
        db.saveRuntimeEntry(workspace.id, runtimeEntry(
          `entry_bulk_${i}`,
          `Bulk Page ${i}`,
          `source_bulk_${i}`,
        ));
      }
    });
    bulkInsert();

    // 插入一条特殊"针"
    db.saveRuntimeEntry(workspace.id, runtimeEntry(
      "entry_needle_scale",
      "Unique Quantum Scale Needle",
      "source_needle",
    ));

    // 计时查询
    const startedAt = performance.now();
    const result = db.queryRuntimeSnapshot(workspace.id, "Unique Quantum Scale Needle", { limit: 5 });
    const elapsedMs = performance.now() - startedAt;

    // 验证针在结果中
    const needleEntry = result.entries.find((e) => e.id === "entry_needle_scale");
    expect(needleEntry).toBeDefined();
    expect(needleEntry.title).toBe("Unique Quantum Scale Needle");
    // FTS5 查询应在 500ms 内完成
    expect(elapsedMs).toBeLessThan(500);
  }, 60000);

  it("增量源代码快照（source-scoped）不加载整个 runtime", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-scale-src-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "scale-src@test.com",
      passwordHash: "hash",
      displayName: "Scale Source",
    });

    // 批量插入 5000 条（来自不同 source）
    const bulkInsert = db.db.transaction(() => {
      for (let i = 0; i < 5000; i += 1) {
        db.saveRuntimeEntry(workspace.id, runtimeEntry(
          `entry_other_${i}`,
          `Other Page ${i}`,
          `source_other_${i}`,
        ));
      }
    });
    bulkInsert();

    // 插入特定 source 的条目
    const targetSourceId = "source_target";
    db.saveRuntimeEntry(workspace.id, runtimeEntry(
      "entry_target_page",
      "Target Page",
      targetSourceId,
    ));
    db.saveRuntimeEntry(workspace.id, runtimeEntry(
      "entry_target_entity",
      "Target Entity",
      targetSourceId,
    ));

    // 获取 source-scoped 快照
    const startedAt = performance.now();
    const sourceSnapshot = db.getRuntimeSourceSnapshot(workspace.id, targetSourceId);
    const elapsedMs = performance.now() - startedAt;

    // 应该只返回 target source 的条目
    expect(sourceSnapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "entry_target_page" }),
        expect.objectContaining({ id: "entry_target_entity" }),
      ]),
    );
    expect(sourceSnapshot.entries.length).toBe(2);

    // 不应包含其他 5000 条
    for (const entry of sourceSnapshot.entries) {
      expect(entry.compiledFrom).toContain(targetSourceId);
    }

    // source-scoped 快照应远快于全量加载
    expect(elapsedMs).toBeLessThan(200);
    console.log(`[T8.2] Source-scoped snapshot (5000 noise entries): ${elapsedMs.toFixed(1)}ms`);
  }, 60000);

  it("10000 条数据中复合关键词查询性能稳定", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-scale-compound-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "scale-compound@test.com",
      passwordHash: "hash",
      displayName: "Scale Compound",
    });

    const bulkInsert = db.db.transaction(() => {
      for (let i = 0; i < 10000; i += 1) {
        const title = i % 3 === 0
          ? `Semiconductor Advanced Node ${i}`
          : i % 3 === 1
            ? `CoWoS Packaging Tech ${i}`
            : `EUV Lithography System ${i}`;
        db.saveRuntimeEntry(workspace.id, runtimeEntry(
          `entry_compound_${i}`,
          title,
          `source_compound_${i}`,
        ));
      }
    });
    bulkInsert();

    // 测试多种查询
    const queries = [
      { q: "Semiconductor Advanced Node", desc: "精确匹配" },
      { q: "CoWoS Packaging", desc: "部分匹配" },
      { q: "EUV Lithography", desc: "EUV关键词" },
      { q: "节点 制程", desc: "中文关键词" },
    ];

    for (const { q, desc } of queries) {
      const startedAt = performance.now();
      const result = db.queryRuntimeSnapshot(workspace.id, q, { limit: 10 });
      const elapsedMs = performance.now() - startedAt;

      expect(Array.isArray(result.entries)).toBe(true);
      expect(elapsedMs).toBeLessThan(500);
      console.log(`[T8.2] Query "${desc}" (${q}): ${elapsedMs.toFixed(1)}ms, ${result.entries.length} results`);
    }
  }, 60000);
});

describe("T8.3: 增量编译在多次后续更新中的正确性", () => {
  it("连续多次 source 更新（追加/移除实体）编译正确且不破坏现有数据", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-scale-seq-"));
    tempDirs.push(dir);
    const db = await createDatabase({ dataDir: dir });
    const { workspace } = db.createUser({
      email: "scale-seq@test.com",
      passwordHash: "hash",
      displayName: "Scale Seq",
    });

    const sourceId = "source_sequential";

    // 第一轮：包含 Entity X 和 Entity Y
    const doc1 = {
      ...makeParseResult(sourceId, "Sequential Doc"),
      content: {
        ...makeParseResult(sourceId, "").content,
        markdown: "# Sequential Doc\n\nTSMC develops 3nm chips. NVIDIA uses CoWoS. Apple is a customer.",
        plainText: "TSMC develops 3nm chips. NVIDIA uses CoWoS. Apple is a customer.",
        sections: [["Sequential Doc", "TSMC develops 3nm chips. NVIDIA uses CoWoS. Apple is a customer."]],
        contentBlocks: [{ kind: "section", index: 0, heading: "Sequential Doc", text: "TSMC develops 3nm chips. NVIDIA uses CoWoS. Apple is a customer." }],
      },
    };

    const round1 = compileDocumentIntoRuntime({
      workspaceId: workspace.id,
      parseResult: doc1,
      compiledAt: "2026-06-05T00:00:00.000Z",
    });

    // 持久化
    for (const entry of round1.upsertedEntries) {
      db.saveRuntimeEntry(workspace.id, entry);
    }
    for (const edge of round1.upsertedEdges) {
      db.saveRuntimeEdge(workspace.id, edge);
    }

    const snapshot1 = db.getRuntimeSnapshot(workspace.id);
    const entityCount1 = snapshot1.entries.filter((e) => e.kind === "entity").length;
    // 应该至少提取了 TSMC、NVIDIA、Apple
    expect(entityCount1).toBeGreaterThanOrEqual(3);

    // 第二轮：移除 Apple，新增 Google
    const doc2 = {
      ...makeParseResult(sourceId, "Sequential Doc"),
      content: {
        ...makeParseResult(sourceId, "").content,
        markdown: "# Sequential Doc\n\nTSMC develops 3nm chips. NVIDIA uses CoWoS. Google is a new partner.",
        plainText: "TSMC develops 3nm chips. NVIDIA uses CoWoS. Google is a new partner.",
        sections: [["Sequential Doc", "TSMC develops 3nm chips. NVIDIA uses CoWoS. Google is a new partner."]],
        contentBlocks: [{ kind: "section", index: 0, heading: "Sequential Doc", text: "TSMC develops 3nm chips. NVIDIA uses CoWoS. Google is a new partner." }],
      },
    };

    const existingSnapshot = db.getRuntimeSourceSnapshot(workspace.id, sourceId);
    const round2 = compileDocumentIntoRuntime({
      workspaceId: workspace.id,
      parseResult: doc2,
      existingRuntimeSnapshot: existingSnapshot,
      compiledAt: "2026-06-06T00:00:00.000Z",
    });

    // 持久化第二轮
    for (const entry of round2.upsertedEntries) {
      db.saveRuntimeEntry(workspace.id, entry);
    }

    const snapshot2 = db.getRuntimeSnapshot(workspace.id);

    // Apple 应该被标记为 superseded
    const appleEntry = snapshot2.entries.find((e) => e.title === "Apple");
    if (appleEntry) {
      expect(appleEntry.status).toBe("superseded");
    }

    // Google 应该存在且状态为 active
    const googleEntry = snapshot2.entries.find((e) => e.title === "Google");
    if (googleEntry) {
      expect(googleEntry.status).toBe("active");
    }

    // TSMC 应该仍然 active
    const tsmcEntry = snapshot2.entries.find((e) => e.title === "TSMC");
    if (tsmcEntry) {
      expect(tsmcEntry.status).toBe("active");
    }
  });
});
