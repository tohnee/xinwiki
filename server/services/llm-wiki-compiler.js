function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeTitle(fileName) {
  return String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function stableSuffix(value) {
  return Buffer.from(String(value || ""), "utf8").toString("hex").slice(0, 12) || "item";
}

function slug(value) {
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

function buildEdgeId(edge) {
  return edge.id || `${edge.fromEntryId}::${edge.type}::${edge.toEntryId}`;
}

function truncate(text, maxLength = 160) {
  const normalized = normalizeText(text);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function normalizeLocator(locator) {
  return {
    sectionHeading: locator?.sectionHeading ?? null,
    blockIndex: Number.isInteger(locator?.blockIndex) ? locator.blockIndex : null,
    pageRange: locator?.pageRange ?? null,
    bbox: locator?.bbox ?? null,
    tableId: locator?.tableId ?? null,
    figureId: locator?.figureId ?? null,
  };
}

function normalizeSourceRef(ref) {
  return {
    sourceId: ref?.sourceId ?? null,
    sourceType: ref?.sourceType ?? "upload",
    locator: normalizeLocator(ref?.locator),
    excerpt: ref?.excerpt ?? null,
    confidence: typeof ref?.confidence === "number" ? ref.confidence : null,
  };
}

function sortPrimitiveArray(values) {
  return [...values].map((value) => String(value)).sort();
}

function compareJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function areEntriesEquivalent(existing, next) {
  return compareJson(
    {
      id: existing.id,
      kind: existing.kind,
      title: existing.title,
      summary: existing.summary,
      bodyMarkdown: existing.bodyMarkdown,
      aliases: sortPrimitiveArray(existing.aliases || []),
      tags: sortPrimitiveArray(existing.tags || []),
      status: existing.status,
      compiledFrom: sortPrimitiveArray(existing.compiledFrom || []),
      sourceRefs: (existing.sourceRefs || []).map(normalizeSourceRef),
    },
    {
      id: next.id,
      kind: next.kind,
      title: next.title,
      summary: next.summary,
      bodyMarkdown: next.bodyMarkdown,
      aliases: sortPrimitiveArray(next.aliases || []),
      tags: sortPrimitiveArray(next.tags || []),
      status: next.status,
      compiledFrom: sortPrimitiveArray(next.compiledFrom || []),
      sourceRefs: (next.sourceRefs || []).map(normalizeSourceRef),
    },
  );
}

function areEdgesEquivalent(existing, next) {
  return compareJson(
    {
      id: buildEdgeId(existing),
      fromEntryId: existing.fromEntryId,
      toEntryId: existing.toEntryId,
      type: existing.type,
      confidence: typeof existing.confidence === "number" ? existing.confidence : null,
      evidenceRefs: (existing.evidenceRefs || []).map(normalizeSourceRef),
    },
    {
      id: buildEdgeId(next),
      fromEntryId: next.fromEntryId,
      toEntryId: next.toEntryId,
      type: next.type,
      confidence: typeof next.confidence === "number" ? next.confidence : null,
      evidenceRefs: (next.evidenceRefs || []).map(normalizeSourceRef),
    },
  );
}

function toContentBlocks(parseResult) {
  if (Array.isArray(parseResult?.content?.contentBlocks) && parseResult.content.contentBlocks.length) {
    return parseResult.content.contentBlocks.map((block, index) => ({
      kind: block.kind ?? "section",
      index: Number.isInteger(block.index) ? block.index : index,
      heading: normalizeText(block.heading),
      text: normalizeText(block.text),
    }));
  }

  return (Array.isArray(parseResult?.content?.sections) ? parseResult.content.sections : []).map(
    ([heading, text], index) => ({
      kind: "section",
      index,
      heading: normalizeText(heading),
      text: normalizeText(text),
    }),
  );
}

function buildExcerpt(text, needle) {
  const source = normalizeText(text);
  const match = normalizeText(needle);
  if (!source) {
    return "";
  }
  if (!match) {
    return truncate(source);
  }

  const loweredSource = source.toLowerCase();
  const loweredNeedle = match.toLowerCase();
  const matchIndex = loweredSource.indexOf(loweredNeedle);
  if (matchIndex < 0) {
    return truncate(source);
  }

  const start = Math.max(0, matchIndex - 36);
  const end = Math.min(source.length, matchIndex + match.length + 72);
  return source.slice(start, end);
}

function buildPageTitle(parseResult) {
  const sectionTitle = normalizeText(parseResult?.content?.sections?.[0]?.[0]);
  if (sectionTitle) {
    return sectionTitle;
  }
  return sanitizeTitle(parseResult?.document?.fileName) || "Untitled Page";
}

function buildPageSummary(parseResult, pageTitle) {
  const blocks = toContentBlocks(parseResult);
  const primaryBlock = blocks.find((block) => block.text) || blocks[0];
  return truncate(
    primaryBlock?.text
      || parseResult?.content?.plainText
      || pageTitle,
  );
}

function buildSourceRef({ parseResult, sectionHeading, blockIndex, excerpt }) {
  return {
    sourceId: parseResult.document.sourceId,
    sourceType: "upload",
    locator: {
      sectionHeading: sectionHeading || null,
      blockIndex: Number.isInteger(blockIndex) ? blockIndex : null,
    },
    excerpt: excerpt || null,
    confidence: typeof parseResult?.quality?.confidence === "number"
      ? parseResult.quality.confidence
      : null,
  };
}

function isMeaningfulCandidate(candidate, pageTitle) {
  const normalized = normalizeText(candidate);
  if (normalized.length < 2) {
    return false;
  }

  if (/^\d+$/.test(normalized)) {
    return false;
  }

  if (normalized.toLowerCase() === normalizeText(pageTitle).toLowerCase()) {
    return false;
  }

  if (/^(project|signals|signal|customers|customer|roadmap|notes|overview)$/i.test(normalized)) {
    return false;
  }

  return true;
}

function collectMatches(text, pattern) {
  return Array.from(text.matchAll(pattern), (match) => normalizeText(match[0]));
}

function extractEntityCandidates(parseResult, pageTitle) {
  const candidates = new Map();
  const blocks = toContentBlocks(parseResult);
  const patterns = [
    /[\u4e00-\u9fff]{2,}(?:\s*[A-Za-z0-9][A-Za-z0-9&._-]*)?/g,
    /\b[A-Z][A-Za-z0-9&._-]{1,}\b/g,
  ];

  for (const block of blocks) {
    const searchableText = normalizeText(`${block.heading} ${block.text}`);
    for (const pattern of patterns) {
      for (const match of collectMatches(searchableText, pattern)) {
        if (!isMeaningfulCandidate(match, pageTitle) || candidates.has(match)) {
          continue;
        }
        candidates.set(match, {
          title: match,
          sectionHeading: block.heading || pageTitle,
          blockIndex: block.index,
          excerpt: buildExcerpt(block.text || searchableText, match),
        });
      }
    }
  }

  if (!candidates.size) {
    const fallbackTitle = sanitizeTitle(parseResult?.document?.fileName);
    if (isMeaningfulCandidate(fallbackTitle, pageTitle)) {
      candidates.set(fallbackTitle, {
        title: fallbackTitle,
        sectionHeading: pageTitle,
        blockIndex: 0,
        excerpt: buildPageSummary(parseResult, pageTitle),
      });
    }
  }

  return Array.from(candidates.values()).slice(0, 8);
}

function sourceOwnsEntry(entry, sourceId) {
  return Array.isArray(entry?.compiledFrom) && entry.compiledFrom.includes(sourceId);
}

function sourceOwnsEdge(edge, sourceId) {
  return Array.isArray(edge?.evidenceRefs) && edge.evidenceRefs.some((ref) => ref?.sourceId === sourceId);
}

function buildIncrementalMarkers(removedEntries, removedEdges, compiledAt) {
  const staleMarkers = [
    ...removedEntries.map((entry) => ({
      targetType: "entry",
      targetId: entry.id,
      reason: "source-recompiled",
      severity: "medium",
      createdAt: compiledAt,
    })),
    ...removedEdges.map((edge) => ({
      targetType: "edge",
      targetId: buildEdgeId(edge),
      reason: "source-recompiled",
      severity: "medium",
      createdAt: compiledAt,
    })),
  ];

  const supersededMarkers = [
    ...removedEntries.map((entry) => ({
      targetType: "entry",
      targetId: entry.id,
      supersededById: null,
      reason: "source-recompiled",
      createdAt: compiledAt,
    })),
    ...removedEdges.map((edge) => ({
      targetType: "edge",
      targetId: buildEdgeId(edge),
      supersededById: null,
      reason: "source-recompiled",
      createdAt: compiledAt,
    })),
  ];

  return { staleMarkers, supersededMarkers };
}

function buildDesiredCompilation({ workspaceId, parseResult, compiledAt }) {
  const pageTitle = buildPageTitle(parseResult);
  const pageId = `entry_page_${slug(pageTitle)}`;
  const pageSummary = buildPageSummary(parseResult, pageTitle);
  const pageRef = buildSourceRef({
    parseResult,
    sectionHeading: pageTitle,
    blockIndex: 0,
    excerpt: pageSummary,
  });
  const entities = extractEntityCandidates(parseResult, pageTitle);

  return {
    pageId,
    entries: [
      {
        id: pageId,
        workspaceId,
        kind: "page",
        title: pageTitle,
        summary: pageSummary,
        bodyMarkdown: parseResult.content.markdown,
        aliases: [],
        tags: ["compiled", "page"],
        status: "active",
        sourceRefs: [pageRef],
        compiledFrom: [parseResult.document.sourceId],
        updatedAt: compiledAt,
        version: 1,
      },
      ...entities.map((entity) => ({
        id: `entry_entity_${slug(entity.title)}`,
        workspaceId,
        kind: "entity",
        title: entity.title,
        summary: `Mentioned in ${pageTitle}`,
        bodyMarkdown: `# ${entity.title}\n\n${entity.excerpt || entity.title}`,
        aliases: [],
        tags: ["compiled", "entity"],
        status: "active",
        sourceRefs: [
          buildSourceRef({
            parseResult,
            sectionHeading: entity.sectionHeading,
            blockIndex: entity.blockIndex,
            excerpt: entity.excerpt,
          }),
        ],
        compiledFrom: [parseResult.document.sourceId],
        updatedAt: compiledAt,
        version: 1,
      })),
    ],
    edges: entities.map((entity) => ({
      fromEntryId: pageId,
      toEntryId: `entry_entity_${slug(entity.title)}`,
      type: "mentions",
      evidenceRefs: [
        buildSourceRef({
          parseResult,
          sectionHeading: entity.sectionHeading,
          blockIndex: entity.blockIndex,
          excerpt: entity.excerpt,
        }),
      ],
      confidence: typeof parseResult?.quality?.confidence === "number"
        ? parseResult.quality.confidence
        : 0.5,
    })),
  };
}

export function compileDocumentIntoRuntime({
  workspaceId,
  parseResult,
  existingRuntimeSnapshot = {},
  compiledAt = new Date().toISOString(),
}) {
  const sourceId = parseResult.document.sourceId;
  const desired = buildDesiredCompilation({ workspaceId, parseResult, compiledAt });
  const existingEntries = (existingRuntimeSnapshot.entries || []).filter(
    (entry) => sourceOwnsEntry(entry, sourceId) && entry.status !== "superseded",
  );
  const existingEdges = (existingRuntimeSnapshot.edges || []).filter((edge) => sourceOwnsEdge(edge, sourceId));

  const existingEntryMap = new Map(existingEntries.map((entry) => [entry.id, entry]));
  const existingEdgeMap = new Map(existingEdges.map((edge) => [buildEdgeId(edge), edge]));
  const desiredEntryIds = new Set(desired.entries.map((entry) => entry.id));
  const desiredEdgeIds = new Set(desired.edges.map((edge) => buildEdgeId(edge)));

  const upsertedEntries = desired.entries.filter((entry) => {
    const existing = existingEntryMap.get(entry.id);
    return !existing || !areEntriesEquivalent(existing, entry);
  });
  const upsertedEdges = desired.edges.filter((edge) => {
    const existing = existingEdgeMap.get(buildEdgeId(edge));
    return !existing || !areEdgesEquivalent(existing, edge);
  });

  const removedEntries = existingEntries.filter((entry) => !desiredEntryIds.has(entry.id));
  const supersededEntries = removedEntries.map((entry) => ({
    ...entry,
    status: "superseded",
    updatedAt: compiledAt,
    version: Math.max(1, Number(entry.version) || 1) + 1,
  }));
  const removedEdges = existingEdges.filter((edge) => !desiredEdgeIds.has(buildEdgeId(edge)));
  const { staleMarkers, supersededMarkers } = buildIncrementalMarkers(removedEntries, removedEdges, compiledAt);
  const hasChanges = upsertedEntries.length > 0
    || upsertedEdges.length > 0
    || supersededEntries.length > 0
    || removedEdges.length > 0;

  return {
    upsertedEntries: [...upsertedEntries, ...supersededEntries],
    upsertedEdges,
    removedEdges,
    staleMarkers,
    supersededMarkers,
    supersededEntries: supersededEntries.map((entry) => entry.id),
    logEvents: hasChanges
      ? [
          {
            kind: "ingest",
            sourceId,
            detail: `Compiled ${desired.entries.length} runtime entries from ${parseResult.document.fileName}`,
            createdAt: compiledAt,
          },
        ]
      : [],
    lintHints: [],
  };
}
