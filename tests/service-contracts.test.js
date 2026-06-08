import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import request from "supertest";

import { createApp } from "../server/app.js";
import { createDefaultParserAdapter } from "../server/services/parser-adapter.js";
import { createLlmWikiBuildService } from "../server/services/llm-wiki-build-service.js";
import { createReportService } from "../server/services/report-service.js";
import { createSourceParsingService } from "../server/services/source-parsing-service.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("MCP-ready service contracts", () => {
  it("wraps document parsing behind an adapter registry and exposes MCP tool metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-source-service-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "aurora.md");
    await fs.writeFile(filePath, "# Project Aurora\n\n客户 A 的采购代号。", "utf8");

    const service = createSourceParsingService({
      adapters: { "local-basic": createDefaultParserAdapter() },
      createSourceId: () => "source_service_test",
    });

    expect(service.capabilities).toEqual(expect.objectContaining({ mcpReady: true }));
    expect(service.getMcpToolDefinitions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "xinwiki.source_parser.parse_document" })]),
    );
    expect(service.listAdapters()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "local-basic" })]),
    );

    const source = await service.summarizeUpload({
      file: {
        path: filePath,
        originalname: "aurora.md",
        mimetype: "text/markdown",
        size: 32,
      },
    });

    expect(source.id).toBe("source_service_test");
    expect(source.parseResult.document.sourceId).toBe("source_service_test");
    expect(source.markdown).toContain("Project Aurora");
  });

  it("wraps llm-wiki compilation behind a compiler registry for future agent/LLM compilers", () => {
    const compileCalls = [];
    const service = createLlmWikiBuildService({
      compilers: {
        agent: {
          name: "agent compiler",
          compile(input) {
            compileCalls.push(input);
            return { upsertedEntries: [], upsertedEdges: [], removedEdges: [], staleMarkers: [], supersededMarkers: [], logEvents: [], lintHints: [] };
          },
        },
      },
      defaultCompilerId: "agent",
    });

    expect(service.capabilities).toEqual(expect.objectContaining({ supportsAgentCompilers: true, mcpReady: true }));
    expect(service.getMcpToolDefinitions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "xinwiki.llm_wiki_builder.compile_document" })]),
    );

    const result = service.compileDocument({
      workspaceId: "workspace_contract",
      parseResult: { document: { sourceId: "source_contract" } },
    });

    expect(result.upsertedEntries).toEqual([]);
    expect(compileCalls[0]).toEqual(expect.objectContaining({ workspaceId: "workspace_contract" }));
  });

  it("wraps report generation and export behind generator/exporter registries", async () => {
    const service = createReportService({
      generators: {
        mock: {
          generate({ options }) {
            return { report: { title: `Mock ${options.reportType}`, sections: [] }, markdown: "# mock" };
          },
        },
      },
      exporters: {
        md: {
          format: "md",
          async export({ outputDir, report }) {
            await fs.mkdir(outputDir, { recursive: true });
            const outputPath = path.join(outputDir, "mock.md");
            await fs.writeFile(outputPath, `# ${report.title}`, "utf8");
            return { fileName: "mock.md", outputPath };
          },
        },
      },
      defaultGeneratorId: "mock",
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-report-service-"));
    tempDirs.push(dir);

    expect(service.capabilities).toEqual(expect.objectContaining({ mcpReady: true }));
    expect(service.getMcpToolDefinitions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "xinwiki.report_service.export_report" })]),
    );

    const payload = await service.generateAndExport({
      workspace: { id: "workspace_contract", name: "Contract" },
      bootstrap: { files: [], wikiPages: [], ontologyNodes: [], ontologyEdges: [], qaRecords: [], expertInjections: [] },
      options: { reportType: "tech" },
      outputDir: dir,
      format: "md",
    });

    expect(payload.report.title).toBe("Mock tech");
    expect(payload.exported.fileName).toBe("mock.md");
  });
  it("exposes service capabilities through an HTTP endpoint for MCP discovery", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-service-http-"));
    tempDirs.push(dir);
    const app = await createApp({
      dataDir: path.join(dir, "data"),
      uploadsDir: path.join(dir, "uploads"),
      llmWikiDir: path.join(dir, "llm-wiki"),
      jwtSecret: "test-secret",
    });

    const response = await request(app).get("/api/service-capabilities");

    expect(response.status).toBe(200);
    expect(response.body.sourceParser.mcpReady).toBe(true);
    expect(response.body.llmWikiBuilder.mcpTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "xinwiki.llm_wiki_builder.compile_document" })]),
    );
    expect(response.body.reportService.exporters).toEqual(
      expect.arrayContaining([expect.objectContaining({ format: "pdf" })]),
    );
  });

});
