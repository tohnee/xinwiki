function isSectionTuple(value) {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === "string"
    && typeof value[1] === "string";
}

export function assertValidDocumentParseResult(parseResult) {
  if (!parseResult || typeof parseResult !== "object") {
    throw new Error("Invalid parser adapter output: parse result must be an object.");
  }
  if (!parseResult.document || typeof parseResult.document !== "object") {
    throw new Error("Invalid parser adapter output: missing document metadata.");
  }
  if (!String(parseResult.document.sourceId || "").trim()) {
    throw new Error("Invalid parser adapter output: document.sourceId is required.");
  }
  if (!parseResult.content || typeof parseResult.content !== "object") {
    throw new Error("Invalid parser adapter output: missing content payload.");
  }
  if (typeof parseResult.content.markdown !== "string") {
    throw new Error("Invalid parser adapter output: content.markdown must be a string.");
  }
  if (!Array.isArray(parseResult.content.sections)) {
    throw new Error("Invalid parser adapter output: content.sections must be an array.");
  }
  if (!parseResult.content.sections.every(isSectionTuple)) {
    throw new Error("Invalid parser adapter output: content.sections entries must be [heading, text] tuples.");
  }
}

function extractBulletFacts(markdown) {
  return String(markdown || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function defaultMcpTools(serviceName) {
  return [
    {
      name: `${serviceName}.parse_document`,
      description: "Parse an uploaded source file into the XinWiki DocumentParseResult contract.",
      inputSchema: {
        type: "object",
        required: ["sourceId", "file"],
        properties: {
          sourceId: { type: "string" },
          file: { type: "object", description: "Upload metadata/path object supplied by the host runtime." },
          parserId: { type: "string", description: "Optional parser adapter id such as local-basic or mineru." },
        },
      },
      outputSchema: { type: "object", description: "DocumentParseResult" },
    },
    {
      name: `${serviceName}.summarize_upload`,
      description: "Parse an upload and project it into the persisted XinWiki source payload.",
      inputSchema: {
        type: "object",
        required: ["file"],
        properties: {
          file: { type: "object" },
          overrides: { type: "object" },
          parserId: { type: "string" },
        },
      },
      outputSchema: { type: "object", description: "XinWiki source payload with parseResult." },
    },
  ];
}

export function createSourceParsingService({
  adapters = {},
  defaultAdapterId = "local-basic",
  createSourceId,
  serviceName = "xinwiki.source_parser",
} = {}) {
  const adapterRegistry = new Map(Object.entries(adapters));

  function getAdapter(parserId = defaultAdapterId) {
    const adapter = adapterRegistry.get(parserId) || adapterRegistry.get(defaultAdapterId);
    if (!adapter) {
      throw new Error(`Parser adapter not registered: ${parserId || defaultAdapterId}`);
    }
    return adapter;
  }

  return {
    id: serviceName,
    contractVersion: "2026-06-07.v1",
    capabilities: {
      mcpReady: true,
      adapterBoundary: "DocumentParseResult",
      supportsExternalParsers: true,
      suggestedExternalAdapters: ["mineru", "unstructured", "custom-http-parser"],
    },
    registerAdapter(id, adapter) {
      adapterRegistry.set(id, adapter);
      return this;
    },
    getAdapter,
    listAdapters() {
      return Array.from(adapterRegistry.entries()).map(([id, adapter]) => ({
        id,
        name: adapter.name || id,
        version: adapter.version || adapter.parserVersion || null,
      }));
    },
    getMcpToolDefinitions() {
      return defaultMcpTools(serviceName);
    },
    async parseUploadedFile({ sourceId, file, parserId } = {}) {
      const adapter = getAdapter(parserId);
      const parseResult = await adapter.parse({ sourceId, file });
      assertValidDocumentParseResult(parseResult);
      return parseResult;
    },
    async summarizeUpload({ file, overrides = {}, parserId } = {}) {
      const sourceId = overrides.id || createSourceId?.() || `source_${Date.now()}`;
      const parseResult = await this.parseUploadedFile({ sourceId, file, parserId });
      const markdown = parseResult.content?.markdown || "";
      const sections = Array.isArray(parseResult.content?.sections) ? parseResult.content.sections : [];
      const abstract = sections.find(([, content]) => String(content || "").trim())?.[1]
        || parseResult.content?.plainText
        || "已完成基础文本解析，等待进一步构建 Wiki 页面。";
      return {
        id: parseResult.document.sourceId,
        name: overrides.name || file.originalname,
        title: overrides.title || `上传文档 · ${file.originalname}`,
        source: overrides.source || "用户上传",
        date: overrides.date || new Date().toLocaleDateString("zh-CN"),
        type: overrides.type || "上传文档",
        mimeType: parseResult.document?.mimeType || file.mimetype || "application/octet-stream",
        size: overrides.size || `${Math.max(1, Math.round(file.size / 1024))} KB`,
        parsed: true,
        wikiBuilt: overrides.wikiBuilt ?? false,
        progress: 100,
        abstract,
        facts: extractBulletFacts(markdown),
        sections,
        markdown,
        parserMeta: {
          mode: parseResult.quality?.mode || "text",
          parserName: parseResult.document?.parserName,
          parserVersion: parseResult.document?.parserVersion,
          parserId: parserId || defaultAdapterId,
        },
        storagePath: overrides.storagePath || file.path,
        parseResult,
      };
    },
  };
}
