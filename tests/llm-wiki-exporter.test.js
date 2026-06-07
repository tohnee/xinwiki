import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exportRuntimeToLlmWiki, exportWorkspaceToLlmWiki } from "../server/services/llm-wiki-exporter.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("llm-wiki exporter", () => {
  it("writes wiki markdown pages and a graph.json file", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-llm-wiki-"));
    tempDirs.push(outputDir);

    const result = await exportWorkspaceToLlmWiki({
      outputDir,
      workspace: {
        id: "workspace-1",
        name: "半导体研究工作空间",
      },
      wikiPages: [
        {
          id: "tsmc",
          title: "台积电 / TSMC",
          type: "Company",
          source: "TSMC_Q4_Earnings_2025.pdf",
          summary: "台积电是全球主要晶圆代工企业。",
          sections: [
            ["相关制程", "N2 · N3 · N5"],
            ["相关技术", "CoWoS · GAA"],
          ],
          entities: ["台积电", "TSMC", "N2", "CoWoS", "GAA"],
          relations: [
            ["台积电", "usesNode", "N2"],
            ["台积电", "usesTechnology", "CoWoS"],
          ],
        },
      ],
      ontologyNodes: [
        {
          id: "台积电",
          type: "Company",
          expertWeight: 5,
        },
      ],
      ontologyEdges: [
        ["台积电", "N2", "usesNode"],
        ["台积电", "CoWoS", "usesTechnology"],
      ],
    });

    const wikiFile = await fs.readFile(path.join(outputDir, "wiki", "台积电-TSMC.md"), "utf8");
    const graphFile = JSON.parse(await fs.readFile(path.join(outputDir, "_schema", "graph.json"), "utf8"));

    expect(result.pageCount).toBe(1);
    expect(wikiFile).toContain("title: 台积电 / TSMC");
    expect(wikiFile).toContain("tier: semantic");
    expect(wikiFile).toContain("[[N2]]");
    expect(graphFile.nodes).toHaveLength(1);
    expect(graphFile.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "台积电",
          to: "N2",
          type: "usesNode",
        }),
      ]),
    );
  });
});

describe("exportRuntimeToLlmWiki", () => {
  it("exports active runtime entries as wiki pages with edges, index, log, and graph", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-export-"));
    tempDirs.push(outputDir);

    const runtime = {
      entries: [
        {
          id: "entry_1",
          kind: "page",
          title: "Project Aurora",
          summary: "客户 A 采购计划。",
          bodyMarkdown: "# Project Aurora\n\nProject Aurora 是客户 A 采购代号。\n\n## Signals\n\n- 客户 A 在 2026 年推进采购计划。",
          aliases: ["Aurora", "极光计划"],
          tags: ["customer", "procurement"],
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
        },
        {
          id: "entry_2",
          kind: "entity",
          title: "Customer A",
          summary: "主要半导体客户。",
          bodyMarkdown: "# Customer A\n\n采购 N2 制程。",
          aliases: [],
          tags: ["customer"],
          status: "active",
          sourceRefs: [],
          compiledFrom: [],
          updatedAt: "2026-06-05T00:00:00.000Z",
          version: 1,
        },
        {
          id: "entry_3",
          kind: "page",
          title: "Old Report",
          summary: "已被替代的旧报告。",
          bodyMarkdown: "",
          aliases: [],
          tags: [],
          status: "superseded",
          sourceRefs: [],
          compiledFrom: [],
          updatedAt: "2026-06-01T00:00:00.000Z",
          version: 1,
        },
      ],
      edges: [
        {
          fromEntryId: "entry_1",
          toEntryId: "entry_2",
          type: "mentions",
          evidenceRefs: [],
          confidence: 0.9,
        },
      ],
      logs: [
        {
          kind: "ingest",
          sourceId: "source_1",
          detail: "compiled aurora runtime entry",
        },
        {
          kind: "lint",
          sourceId: null,
          detail: "missing-alias warning for entry_2",
        },
      ],
    };

    const result = await exportRuntimeToLlmWiki({
      outputDir,
      workspace: {
        id: "workspace-1",
        name: "半导体研究工作空间",
      },
      runtime,
    });

    // Assert return value
    expect(result.pageCount).toBe(2); // only active entries (entry_3 is superseded)
    expect(result.nodeCount).toBe(2);
    expect(result.edgeCount).toBe(1);

    // Assert wiki files exist
    const auroraFile = await fs.readFile(path.join(outputDir, "wiki", "Project-Aurora.md"), "utf8");
    const customerFile = await fs.readFile(path.join(outputDir, "wiki", "Customer-A.md"), "utf8");

    // Check frontmatter content for Project Aurora
    expect(auroraFile).toContain("title: Project Aurora");
    expect(auroraFile).toContain("- Aurora");
    expect(auroraFile).toContain("- 极光计划");
    expect(auroraFile).toContain("entity_type: page");
    expect(auroraFile).toContain("tier: semantic");
    expect(auroraFile).toContain('"[[Customer A]]"');
    expect(auroraFile).toContain("source_path: source_1");

    // Check body content preserved
    expect(auroraFile).toContain("# Project Aurora");
    expect(auroraFile).toContain("Project Aurora 是客户 A 采购代号。");
    expect(auroraFile).toContain("## Signals");
    expect(auroraFile).toContain("## Relations");
    expect(auroraFile).toContain("[[Customer A]] (mentions)");

    // Check Customer A file
    expect(customerFile).toContain("title: Customer A");
    expect(customerFile).toContain("entity_type: entity");
    expect(customerFile).toContain("主要半导体客户。");

    // Superseded entry should NOT have a file
    await expect(
      fs.access(path.join(outputDir, "wiki", "Old-Report.md")),
    ).rejects.toThrow();

    // Assert index.md
    const indexFile = await fs.readFile(path.join(outputDir, "index.md"), "utf8");
    expect(indexFile).toContain("半导体研究工作空间 — Index");
    expect(indexFile).toContain("[[Project Aurora]]");
    expect(indexFile).toContain("[[Customer A]]");
    expect(indexFile).not.toContain("Old Report");

    // Assert graph.json
    const graphFile = JSON.parse(await fs.readFile(path.join(outputDir, "_schema", "graph.json"), "utf8"));
    expect(graphFile.workspace.id).toBe("workspace-1");
    expect(graphFile.nodes).toHaveLength(2);
    expect(graphFile.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "entry_1", title: "Project Aurora", entityType: "page" }),
        expect.objectContaining({ id: "entry_2", title: "Customer A", entityType: "entity" }),
      ]),
    );
    expect(graphFile.edges).toHaveLength(1);
    expect(graphFile.edges[0]).toEqual(
      expect.objectContaining({
        from: "Project Aurora",
        to: "Customer A",
        type: "mentions",
      }),
    );

    // Assert log.md
    const logFile = await fs.readFile(path.join(outputDir, "log.md"), "utf8");
    expect(logFile).toContain("# Compilation Log");
    expect(logFile).toContain("[ingest] compiled aurora runtime entry");
    expect(logFile).toContain("[lint] missing-alias warning for entry_2");

    // Assert NO absolute paths in any output file
    const allFiles = [auroraFile, customerFile, indexFile, JSON.stringify(graphFile), logFile];
    const absPathPattern = new RegExp(os.tmpdir().replace(/[/\\]/g, "[/\\\\]"), "i");
    for (const content of allFiles) {
      expect(content).not.toMatch(absPathPattern);
    }
  });

  it("handles empty runtime gracefully", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-export-empty-"));
    tempDirs.push(outputDir);

    const result = await exportRuntimeToLlmWiki({
      outputDir,
      workspace: { id: "ws-empty", name: "Empty" },
      runtime: { entries: [], edges: [], logs: [] },
    });

    expect(result.pageCount).toBe(0);
    expect(result.nodeCount).toBe(0);
    expect(result.edgeCount).toBe(0);

    const indexFile = await fs.readFile(path.join(outputDir, "index.md"), "utf8");
    expect(indexFile).toContain("Empty — Index");

    const logFile = await fs.readFile(path.join(outputDir, "log.md"), "utf8");
    expect(logFile).toContain("_No log entries._");

    const graphFile = JSON.parse(await fs.readFile(path.join(outputDir, "_schema", "graph.json"), "utf8"));
    expect(graphFile.nodes).toHaveLength(0);
    expect(graphFile.edges).toHaveLength(0);
  });

  it("sanitizes entry titles that would break YAML frontmatter", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-safe-yaml-"));
    tempDirs.push(outputDir);

    const result = await exportRuntimeToLlmWiki({
      outputDir,
      workspace: { id: "ws-safe", name: "Safe" },
      runtime: {
        entries: [{
          id: "entry_malicious",
          kind: "page",
          title: "Bad\nkey: injected\n# comment: true",
          summary: "test",
          bodyMarkdown: "# test",
          aliases: ["alias\ninjected: true"],
          tags: ["test"],
          sourceRefs: [],
        }],
        edges: [],
        logs: [],
      },
    });

    expect(result.pageCount).toBe(1);

    // 文件应该用安全名称创建
    const wikiFiles = await fs.readdir(path.join(outputDir, "wiki"));
    expect(wikiFiles.length).toBe(1);
    const wikiFile = await fs.readFile(path.join(outputDir, "wiki", wikiFiles[0]), "utf8");

    // 提取 frontmatter 部分（第一个 --- 到第二个 --- 之间）
    const fmStart = wikiFile.indexOf("---\n");
    const fmEnd = wikiFile.indexOf("\n---", fmStart + 4);
    const frontmatter = fmStart >= 0 && fmEnd > fmStart ? wikiFile.slice(fmStart, fmEnd + 4) : wikiFile;

    // 不应该有注入的独立 YAML key（在 frontmatter 中）
    expect(frontmatter).not.toMatch(/^key:/m);
    expect(frontmatter).not.toMatch(/^# comment:/m);
    // 标题与别名应被正确引用（在 frontmatter 中）
    expect(frontmatter).toContain('"Bad\\nkey: injected\\n# comment: true"');
    expect(frontmatter).toContain('"alias\\ninjected: true"');
  });

  it("rejects path traversal in entry title slugs", { timeout: 10000 }, async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-traversal-"));
    tempDirs.push(outputDir);

    await exportRuntimeToLlmWiki({
      outputDir,
      workspace: { id: "ws-traversal", name: "Traversal" },
      runtime: {
        entries: [{
          id: "entry_traversal",
          kind: "page",
          title: "../../etc/passwd",
          summary: "should not escape",
          bodyMarkdown: "# test",
          sourceRefs: [],
        }],
        edges: [],
        logs: [],
      },
    });

    // 不应该在父目录创建文件（wiki dir 在 outputDir 内部）
    const parentFiles = await fs.readdir(path.dirname(outputDir));
    expect(parentFiles).not.toContain("passwd");

    // 应该在 wiki 目录下创建安全文件名（wikiFileName 已将 / 转为 -）
    const wikiFiles = await fs.readdir(path.join(outputDir, "wiki"));
    expect(wikiFiles.length).toBe(1);
    // 文件名不应对宿主系统造成路径穿越
    expect(wikiFiles[0]).not.toMatch(/\.\./);
    expect(wikiFiles[0]).toMatch(/\.md$/);
  });
});
