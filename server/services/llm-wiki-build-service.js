import { compileDocumentIntoRuntime } from "./llm-wiki-compiler.js";

function defaultMcpTools(serviceName) {
  return [
    {
      name: `${serviceName}.compile_document`,
      description: "Compile a DocumentParseResult into llm-wiki runtime mutations.",
      inputSchema: {
        type: "object",
        required: ["workspaceId", "parseResult"],
        properties: {
          workspaceId: { type: "string" },
          parseResult: { type: "object", description: "DocumentParseResult" },
          compilerId: { type: "string", description: "Optional compiler/agent/LLM compiler id." },
          existingRuntimeSnapshot: { type: "object" },
        },
      },
      outputSchema: { type: "object", description: "Runtime compilation mutation package." },
    },
    {
      name: `${serviceName}.persist_compilation`,
      description: "Persist compiled runtime entries, edges, provenance, logs, and maintenance markers.",
      inputSchema: {
        type: "object",
        required: ["workspaceId", "compilation"],
        properties: {
          workspaceId: { type: "string" },
          compilation: { type: "object" },
        },
      },
      outputSchema: { type: "object" },
    },
  ];
}

export function createLlmWikiBuildService({
  db,
  compilers = {},
  defaultCompilerId = "rule-based-v1",
  serviceName = "xinwiki.llm_wiki_builder",
  onSupersededEntry,
} = {}) {
  const compilerRegistry = new Map(Object.entries({
    [defaultCompilerId]: {
      id: defaultCompilerId,
      name: "rule-based compiler",
      compile: compileDocumentIntoRuntime,
    },
    ...compilers,
  }));

  function getCompiler(compilerId = defaultCompilerId) {
    const compiler = compilerRegistry.get(compilerId) || compilerRegistry.get(defaultCompilerId);
    if (!compiler) {
      throw new Error(`llm-wiki compiler not registered: ${compilerId || defaultCompilerId}`);
    }
    return compiler;
  }

  return {
    id: serviceName,
    contractVersion: "2026-06-07.v1",
    capabilities: {
      mcpReady: true,
      compilerBoundary: "DocumentParseResult -> RuntimeCompilation",
      supportsAgentCompilers: true,
      supportsLlmCompilers: true,
      defaultCompilerId,
    },
    registerCompiler(id, compiler) {
      compilerRegistry.set(id, compiler);
      return this;
    },
    listCompilers() {
      return Array.from(compilerRegistry.entries()).map(([id, compiler]) => ({
        id,
        name: compiler.name || id,
        version: compiler.version || null,
      }));
    },
    getMcpToolDefinitions() {
      return defaultMcpTools(serviceName);
    },
    compileDocument({ workspaceId, parseResult, existingRuntimeSnapshot = {}, compilerId, compiledAt } = {}) {
      const compiler = getCompiler(compilerId);
      const compile = compiler.compile || compiler;
      return compile({
        workspaceId,
        parseResult,
        existingRuntimeSnapshot,
        compiledAt,
      });
    },
    persistCompilation({ workspaceId, compilation } = {}) {
      if (!db) {
        throw new Error("A database API is required to persist llm-wiki compilations.");
      }
      for (const entry of compilation.upsertedEntries || []) {
        db.saveRuntimeEntry(workspaceId, entry);
      }
      for (const edge of compilation.upsertedEdges || []) {
        db.saveRuntimeEdge(workspaceId, edge);
      }
      for (const edge of compilation.removedEdges || []) {
        db.deleteRuntimeEdge(workspaceId, edge.id || `${edge.fromEntryId}::${edge.type}::${edge.toEntryId}`);
      }
      for (const marker of compilation.staleMarkers || []) {
        db.addRuntimeStalenessMarker(workspaceId, marker);
      }
      for (const marker of compilation.supersededMarkers || []) {
        db.addRuntimeSupersededMarker(workspaceId, marker);
      }
      for (const entry of (compilation.upsertedEntries || []).filter((item) => item.status === "superseded")) {
        onSupersededEntry?.({ workspaceId, entry, compilation, db });
      }
      for (const logEvent of compilation.logEvents || []) {
        db.addRuntimeLog(workspaceId, logEvent);
      }
      for (const lintHint of compilation.lintHints || []) {
        db.addRuntimeLintIssue(workspaceId, lintHint);
      }
      return compilation;
    },
    compileAndPersistSource({ workspaceId, source, compilerId } = {}) {
      if (!source?.parseResult) {
        throw new Error("Source parse result is unavailable; please reparse the source before building wiki.");
      }
      const compilation = this.compileDocument({
        workspaceId,
        parseResult: source.parseResult,
        existingRuntimeSnapshot: db.getRuntimeSourceSnapshot(workspaceId, source.id),
        compilerId,
      });
      return this.persistCompilation({ workspaceId, compilation });
    },
  };
}
