import { buildReportPackage } from "./report-generator.js";
import { exportReportAsDocx, exportReportAsPdf } from "./report-exporter.js";

function defaultMcpTools(serviceName) {
  return [
    {
      name: `${serviceName}.generate_report`,
      description: "Generate a structured report package from workspace context.",
      inputSchema: {
        type: "object",
        required: ["workspace", "bootstrap", "options"],
        properties: {
          workspace: { type: "object" },
          bootstrap: { type: "object" },
          options: { type: "object" },
          generatorId: { type: "string" },
        },
      },
      outputSchema: { type: "object", description: "Report package with report and markdown." },
    },
    {
      name: `${serviceName}.export_report`,
      description: "Export a generated report package to a target format such as docx, pdf, pptx, xlsx, or markdown.",
      inputSchema: {
        type: "object",
        required: ["outputDir", "report", "format"],
        properties: {
          outputDir: { type: "string" },
          report: { type: "object" },
          format: { type: "string", enum: ["docx", "pdf", "pptx", "xlsx", "md", "html"] },
          exporterId: { type: "string" },
        },
      },
      outputSchema: { type: "object", description: "Exported artifact descriptor." },
    },
  ];
}

export function createReportService({
  generators = {},
  exporters = {},
  defaultGeneratorId = "structured-rule-v1",
  serviceName = "xinwiki.report_service",
} = {}) {
  const generatorRegistry = new Map(Object.entries({
    [defaultGeneratorId]: {
      id: defaultGeneratorId,
      name: "structured report generator",
      generate: buildReportPackage,
    },
    ...generators,
  }));
  const exporterRegistry = new Map(Object.entries({
    docx: { id: "docx", format: "docx", export: exportReportAsDocx },
    pdf: { id: "pdf", format: "pdf", export: exportReportAsPdf },
    ...exporters,
  }));

  function getGenerator(generatorId = defaultGeneratorId) {
    const generator = generatorRegistry.get(generatorId) || generatorRegistry.get(defaultGeneratorId);
    if (!generator) {
      throw new Error(`Report generator not registered: ${generatorId || defaultGeneratorId}`);
    }
    return generator;
  }

  function getExporter(format, exporterId) {
    const exporter = exporterRegistry.get(exporterId || format);
    if (!exporter) {
      throw new Error(`Report exporter not registered for format: ${format}`);
    }
    return exporter;
  }

  return {
    id: serviceName,
    contractVersion: "2026-06-07.v1",
    capabilities: {
      mcpReady: true,
      generatorBoundary: "WorkspaceContext -> ReportPackage",
      exporterBoundary: "ReportPackage -> ArtifactDescriptor",
      supportedFormats: Array.from(exporterRegistry.keys()),
      futureFormats: ["pptx", "xlsx", "html", "md"],
      supportsAgentGenerators: true,
      supportsLlmGenerators: true,
    },
    registerGenerator(id, generator) {
      generatorRegistry.set(id, generator);
      return this;
    },
    registerExporter(id, exporter) {
      exporterRegistry.set(id, exporter);
      return this;
    },
    listGenerators() {
      return Array.from(generatorRegistry.entries()).map(([id, generator]) => ({
        id,
        name: generator.name || id,
        version: generator.version || null,
      }));
    },
    listExporters() {
      return Array.from(exporterRegistry.entries()).map(([id, exporter]) => ({
        id,
        format: exporter.format || id,
        name: exporter.name || id,
        version: exporter.version || null,
      }));
    },
    getMcpToolDefinitions() {
      return defaultMcpTools(serviceName);
    },
    generateReport({ workspace, bootstrap, options, generatorId } = {}) {
      const generator = getGenerator(generatorId);
      const generate = generator.generate || generator;
      return generate({ workspace, bootstrap, options });
    },
    async exportReport({ outputDir, report, format, exporterId } = {}) {
      const exporter = getExporter(format, exporterId);
      const exportFn = exporter.export || exporter;
      return exportFn({ outputDir, report, format });
    },
    async generateAndExport({ workspace, bootstrap, options, outputDir, format, generatorId, exporterId } = {}) {
      const payload = this.generateReport({ workspace, bootstrap, options, generatorId });
      const exported = await this.exportReport({ outputDir, report: payload.report, format, exporterId });
      return { ...payload, exported };
    },
  };
}
