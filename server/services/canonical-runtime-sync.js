function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stableSuffix(value) {
  return Buffer.from(String(value || ""), "utf8").toString("hex").slice(0, 12) || "item";
}

export function runtimeSlug(value) {
  const text = normalizeText(value).toLowerCase();
  const ascii = text.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/[^\x00-\x7F]/.test(text) && ascii) {
    return ascii;
  }
  if (ascii && ascii.length >= 3) {
    return `${ascii}_${stableSuffix(text)}`;
  }
  return `item_${stableSuffix(text)}`;
}

function truncate(value, maxLength = 180) {
  const text = normalizeText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function sourceRef({ sourceId, sourceType = "human-authored", excerpt, sectionHeading = null, confidence = 0.75 }) {
  return {
    sourceId,
    sourceType,
    locator: {
      sectionHeading,
      blockIndex: null,
      pageRange: null,
      bbox: null,
      tableId: null,
      figureId: null,
    },
    excerpt: excerpt || null,
    confidence,
  };
}

function sectionsToMarkdown(sections = []) {
  return (Array.isArray(sections) ? sections : [])
    .map(([heading, body]) => `## ${normalizeText(heading) || "Section"}\n\n${String(body || "").trim()}`)
    .join("\n\n");
}

export function manualEntityEntry({ workspaceId, title, type = "entity", note, updatedAt }) {
  const safeTitle = normalizeText(title) || "Untitled Entity";
  return {
    id: `entry_entity_${runtimeSlug(safeTitle)}`,
    workspaceId,
    kind: "entity",
    title: safeTitle,
    summary: truncate(note || `人工维护的本体实体「${safeTitle}」。`),
    bodyMarkdown: `# ${safeTitle}\n\n${note || `类型：${type}`}`,
    aliases: [],
    tags: ["manual", "entity", type].filter(Boolean),
    status: "active",
    sourceRefs: [sourceRef({
      sourceId: `manual_entity_${runtimeSlug(safeTitle)}`,
      excerpt: note || safeTitle,
      sectionHeading: safeTitle,
      confidence: 0.7,
    })],
    compiledFrom: [`manual_entity_${runtimeSlug(safeTitle)}`],
    updatedAt,
    version: 1,
  };
}

export function wikiPageRuntimeEntry({ workspaceId, wikiPage, updatedAt }) {
  const title = normalizeText(wikiPage.title) || normalizeText(wikiPage.id) || "Wiki Page";
  const body = sectionsToMarkdown(wikiPage.sections) || `# ${title}\n\n${wikiPage.summary || ""}`;
  const sourceId = wikiPage.sourceId || `legacy_wiki_${wikiPage.id || runtimeSlug(title)}`;
  return {
    id: wikiPage.runtimeEntryId || `entry_wiki_${runtimeSlug(wikiPage.id || title)}`,
    workspaceId,
    kind: "page",
    title,
    summary: truncate(wikiPage.summary || wikiPage.abstract || title),
    bodyMarkdown: body,
    aliases: Array.isArray(wikiPage.entities) ? wikiPage.entities.filter((entity) => entity !== title).slice(0, 8) : [],
    tags: ["wiki", "legacy", wikiPage.type].filter(Boolean),
    status: wikiPage.status || "active",
    sourceRefs: [sourceRef({
      sourceId,
      sourceType: wikiPage.source ? "legacy-source" : "human-authored",
      excerpt: wikiPage.summary || title,
      sectionHeading: title,
      confidence: 0.75,
    })],
    compiledFrom: [sourceId],
    updatedAt: wikiPage.updatedAt || updatedAt,
    version: wikiPage.version || 1,
  };
}

export function ontologyNodeRuntimeEntry({ workspaceId, node, updatedAt }) {
  const title = normalizeText(node.id || node.title) || "Ontology Entity";
  const sourceId = `ontology_node_${runtimeSlug(title)}`;
  return {
    id: node.runtimeEntryId || `entry_entity_${runtimeSlug(title)}`,
    workspaceId,
    kind: "entity",
    title,
    summary: truncate(node.expertNote || `本体节点「${title}」。`),
    bodyMarkdown: `# ${title}\n\n${node.expertNote || ""}\n\n- 类型：${node.type || "Entity"}\n- 专家权重：${node.expertWeight || 0}`,
    aliases: [],
    tags: ["ontology", node.type, node.status === "stale" ? "stale" : null].filter(Boolean),
    status: node.status || "active",
    sourceRefs: [sourceRef({
      sourceId,
      excerpt: node.expertNote || title,
      sectionHeading: title,
      confidence: node.expertWeight ? Math.min(Math.max(node.expertWeight / 5, 0.1), 1) : 0.65,
    })],
    compiledFrom: [sourceId],
    updatedAt: node.updatedAt || updatedAt,
    version: node.version || 1,
  };
}

export function qaRuntimeEntry({ workspaceId, record, updatedAt }) {
  const sourceId = `qa_record_${record.id || runtimeSlug(record.question)}`;
  return {
    id: `entry_qa_${runtimeSlug(record.id || record.question)}`,
    workspaceId,
    kind: "qa-note",
    title: normalizeText(record.question) || "QA Note",
    summary: truncate(record.answer || record.question),
    bodyMarkdown: [
      `# ${record.question}`,
      "",
      "## Answer",
      "",
      record.answer || "",
      Array.isArray(record.citations) && record.citations.length ? "\n## Citations\n\n" + record.citations.map((citation) => `- ${citation}`).join("\n") : "",
    ].join("\n"),
    aliases: [],
    tags: ["qa", "human-authored"],
    status: "active",
    sourceRefs: [sourceRef({
      sourceId,
      excerpt: `${record.question} ${record.answer || ""}`,
      sectionHeading: "QA",
      confidence: 0.9,
    })],
    compiledFrom: [sourceId],
    updatedAt: record.createdAt || updatedAt,
    version: 1,
  };
}

export function memoryRuntimeEntry({ workspaceId, memory, updatedAt }) {
  const sourceId = `memory_${memory.id || runtimeSlug(memory.text)}`;
  const title = truncate(memory.text || "Memory Note", 72);
  return {
    id: `entry_memory_${runtimeSlug(memory.id || memory.text)}`,
    workspaceId,
    kind: "memory-note",
    title,
    summary: truncate(memory.text || title),
    bodyMarkdown: `# ${title}\n\n${memory.text || ""}\n\n- 周期：${memory.period || "永久记忆"}\n- 时间：${memory.time || ""}`,
    aliases: [],
    tags: ["memory", "human-authored", memory.period].filter(Boolean),
    status: "active",
    sourceRefs: [sourceRef({
      sourceId,
      excerpt: memory.text || title,
      sectionHeading: "Memory",
      confidence: 0.9,
    })],
    compiledFrom: [sourceId],
    updatedAt: memory.createdAt || updatedAt,
    version: 1,
  };
}

export function expertRuntimeEntry({ workspaceId, injection, updatedAt }) {
  const sourceId = `expert_injection_${injection.id || runtimeSlug(`${injection.entity}_${injection.note}`)}`;
  const title = `专家注入：${normalizeText(injection.entity) || "未命名实体"}`;
  return {
    id: `entry_expert_${runtimeSlug(injection.id || `${injection.entity}_${injection.note}`)}`,
    workspaceId,
    kind: "memory-note",
    title,
    summary: truncate(injection.note || title),
    bodyMarkdown: `# ${title}\n\n${injection.note || ""}\n\n- 实体：${injection.entity}\n- 权重：${injection.weight}/5\n- 时间：${injection.time || ""}`,
    aliases: [injection.entity].filter(Boolean),
    tags: ["expert", "human-authored"],
    status: "active",
    sourceRefs: [sourceRef({
      sourceId,
      excerpt: injection.note || title,
      sectionHeading: "Expert Injection",
      confidence: Math.min(Math.max((Number(injection.weight) || 1) / 5, 0.2), 1),
    })],
    compiledFrom: [sourceId],
    updatedAt,
    version: 1,
  };
}

export function runtimeEdgeFromNames({ fromTitle, toTitle, type, sourceId, excerpt, confidence = 0.75 }) {
  return {
    fromEntryId: `entry_entity_${runtimeSlug(fromTitle)}`,
    toEntryId: `entry_entity_${runtimeSlug(toTitle)}`,
    type: normalizeText(type) || "related_to",
    evidenceRefs: [sourceRef({
      sourceId: sourceId || `relation_${runtimeSlug(`${fromTitle}_${type}_${toTitle}`)}`,
      excerpt: excerpt || `${fromTitle} -${type}-> ${toTitle}`,
      sectionHeading: "Relation",
      confidence,
    })],
    confidence,
  };
}

export function normalizeLegacyOntologyEdge(edge) {
  if (Array.isArray(edge) && edge.length >= 3) {
    return { fromTitle: edge[0], toTitle: edge[1], type: edge[2] };
  }
  if (edge && typeof edge === "object") {
    return {
      fromTitle: edge.fromName || edge.from || edge.source || edge.fromEntryId,
      toTitle: edge.toName || edge.to || edge.target || edge.toEntryId,
      type: edge.type || edge.relation || "related_to",
    };
  }
  return null;
}
