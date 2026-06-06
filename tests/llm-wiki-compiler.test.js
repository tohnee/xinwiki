import { describe, expect, it } from "vitest";

import { compileDocumentIntoRuntime } from "../server/services/llm-wiki-compiler.js";

function makeParseResult() {
  return {
    document: {
      sourceId: "source_aurora",
      fileName: "aurora.md",
      mimeType: "text/markdown",
      parserName: "local-basic",
      parserVersion: "v1",
    },
    content: {
      markdown: [
        "# Project Aurora",
        "",
        "客户 A 采购计划。",
        "",
        "## Signals",
        "",
        "- NVIDIA 是关键客户。",
      ].join("\n"),
      plainText: "Project Aurora 客户 A 采购计划。NVIDIA 是关键客户。",
      sections: [
        ["Project Aurora", "客户 A 采购计划。"],
        ["Signals", "NVIDIA 是关键客户。"],
      ],
      contentBlocks: [
        { kind: "section", index: 0, heading: "Project Aurora", text: "客户 A 采购计划。" },
        { kind: "section", index: 1, heading: "Signals", text: "NVIDIA 是关键客户。" },
      ],
    },
    artifacts: {
      tables: [],
      figures: [],
      citations: [],
    },
    quality: {
      warnings: [],
      confidence: 0.6,
      mode: "text",
    },
    rawPointers: [],
  };
}

describe("llm-wiki compiler", () => {
  it("compiles a parse result into runtime page, entity, and edge records with provenance", () => {
    const result = compileDocumentIntoRuntime({
      workspaceId: "workspace_demo",
      parseResult: makeParseResult(),
      compiledAt: "2026-06-05T00:00:00.000Z",
    });

    expect(result.upsertedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "workspace_demo",
          kind: "page",
          title: "Project Aurora",
          compiledFrom: ["source_aurora"],
          sourceRefs: [
            expect.objectContaining({
              sourceId: "source_aurora",
              sourceType: "upload",
              locator: expect.objectContaining({
                sectionHeading: "Project Aurora",
                blockIndex: 0,
              }),
            }),
          ],
        }),
        expect.objectContaining({
          workspaceId: "workspace_demo",
          kind: "entity",
          title: "客户 A",
          compiledFrom: ["source_aurora"],
          sourceRefs: [
            expect.objectContaining({
              sourceId: "source_aurora",
              excerpt: expect.stringContaining("客户 A"),
            }),
          ],
        }),
      ]),
    );
    expect(result.upsertedEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mentions",
          confidence: expect.any(Number),
          evidenceRefs: [
            expect.objectContaining({
              sourceId: "source_aurora",
              excerpt: expect.stringContaining("客户 A"),
            }),
          ],
        }),
      ]),
    );
    expect(result.logEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ingest",
          sourceId: "source_aurora",
        }),
      ]),
    );
  });

  it("generates stable ids for incremental recompilation of the same parse result", () => {
    const first = compileDocumentIntoRuntime({
      workspaceId: "workspace_demo",
      parseResult: makeParseResult(),
      compiledAt: "2026-06-05T00:00:00.000Z",
    });
    const second = compileDocumentIntoRuntime({
      workspaceId: "workspace_demo",
      parseResult: makeParseResult(),
      compiledAt: "2026-06-05T00:05:00.000Z",
    });

    expect(first.upsertedEntries.map((entry) => entry.id)).toEqual(
      second.upsertedEntries.map((entry) => entry.id),
    );
    expect(first.upsertedEdges.map((edge) => edge.fromEntryId)).toEqual(
      second.upsertedEdges.map((edge) => edge.fromEntryId),
    );
    expect(first.upsertedEdges.map((edge) => edge.toEntryId)).toEqual(
      second.upsertedEdges.map((edge) => edge.toEntryId),
    );
    expect(first.upsertedEdges.map((edge) => edge.type)).toEqual(
      second.upsertedEdges.map((edge) => edge.type),
    );
  });

  it("marks removed source-owned entries and edges as superseded or stale during incremental recompilation", () => {
    const existingRuntimeSnapshot = {
      entries: [
        {
          id: "entry_page_project_aurora",
          workspaceId: "workspace_demo",
          kind: "page",
          title: "Project Aurora",
          summary: "客户 A 采购计划。",
          bodyMarkdown: "# Project Aurora\n\n客户 A 采购计划。",
          aliases: [],
          tags: ["compiled", "page"],
          status: "active",
          sourceRefs: [{ sourceId: "source_aurora", sourceType: "upload", excerpt: "客户 A 采购计划。", confidence: 0.6 }],
          compiledFrom: ["source_aurora"],
          updatedAt: "2026-06-05T00:00:00.000Z",
          version: 1,
        },
        {
          id: "entry_entity_nvidia",
          workspaceId: "workspace_demo",
          kind: "entity",
          title: "NVIDIA",
          summary: "Mentioned in Project Aurora",
          bodyMarkdown: "# NVIDIA\n\nNVIDIA 是关键客户。",
          aliases: [],
          tags: ["compiled", "entity"],
          status: "active",
          sourceRefs: [{ sourceId: "source_aurora", sourceType: "upload", excerpt: "NVIDIA 是关键客户。", confidence: 0.6 }],
          compiledFrom: ["source_aurora"],
          updatedAt: "2026-06-05T00:00:00.000Z",
          version: 1,
        },
      ],
      edges: [
        {
          id: "entry_page_project_aurora::mentions::entry_entity_nvidia",
          workspaceId: "workspace_demo",
          fromEntryId: "entry_page_project_aurora",
          toEntryId: "entry_entity_nvidia",
          type: "mentions",
          evidenceRefs: [{ sourceId: "source_aurora", sourceType: "upload", excerpt: "NVIDIA 是关键客户。", confidence: 0.6 }],
          confidence: 0.6,
        },
      ],
      provenance: [],
      logs: [],
      lintIssues: [],
      indexViews: [],
      stalenessMarkers: [],
      supersededMarkers: [],
    };

    const result = compileDocumentIntoRuntime({
      workspaceId: "workspace_demo",
      parseResult: {
        ...makeParseResult(),
        content: {
          ...makeParseResult().content,
          markdown: "# Project Aurora\n\n客户 A 采购计划。",
          plainText: "Project Aurora 客户 A 采购计划。",
          sections: [["Project Aurora", "客户 A 采购计划。"]],
          contentBlocks: [{ kind: "section", index: 0, heading: "Project Aurora", text: "客户 A 采购计划。" }],
        },
      },
      existingRuntimeSnapshot,
      compiledAt: "2026-06-05T01:00:00.000Z",
    });

    expect(result.upsertedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "entry_entity_nvidia",
          status: "superseded",
          compiledFrom: ["source_aurora"],
        }),
      ]),
    );
    expect(result.removedEdges).toEqual([
      expect.objectContaining({
        id: "entry_page_project_aurora::mentions::entry_entity_nvidia",
      }),
    ]);
    expect(result.staleMarkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: "entry",
          targetId: "entry_entity_nvidia",
          reason: "source-recompiled",
        }),
        expect.objectContaining({
          targetType: "edge",
          targetId: "entry_page_project_aurora::mentions::entry_entity_nvidia",
          reason: "source-recompiled",
        }),
      ]),
    );
    expect(result.supersededMarkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: "entry",
          targetId: "entry_entity_nvidia",
          reason: "source-recompiled",
        }),
        expect.objectContaining({
          targetType: "edge",
          targetId: "entry_page_project_aurora::mentions::entry_entity_nvidia",
          reason: "source-recompiled",
        }),
      ]),
    );
  });

  it("is idempotent for repeated ingest when the source-owned runtime state already matches", () => {
    const first = compileDocumentIntoRuntime({
      workspaceId: "workspace_demo",
      parseResult: makeParseResult(),
      compiledAt: "2026-06-05T00:00:00.000Z",
    });

    const second = compileDocumentIntoRuntime({
      workspaceId: "workspace_demo",
      parseResult: makeParseResult(),
      existingRuntimeSnapshot: {
        entries: first.upsertedEntries,
        edges: first.upsertedEdges.map((edge, index) => ({
          id: `${edge.fromEntryId}::${edge.type}::${edge.toEntryId}`,
          workspaceId: "workspace_demo",
          ...edge,
          confidence: edge.confidence,
          evidenceRefs: first.upsertedEdges[index].evidenceRefs,
        })),
        provenance: [],
        logs: [],
        lintIssues: [],
        indexViews: [],
        stalenessMarkers: [],
        supersededMarkers: [],
      },
      compiledAt: "2026-06-05T00:05:00.000Z",
    });

    expect(second.upsertedEntries).toEqual([]);
    expect(second.upsertedEdges).toEqual([]);
    expect(second.removedEdges).toEqual([]);
    expect(second.staleMarkers).toEqual([]);
    expect(second.supersededMarkers).toEqual([]);
    expect(second.logEvents).toEqual([]);
  });
});
