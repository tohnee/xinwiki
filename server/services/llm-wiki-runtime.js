function normalizeLocator(locator) {
  if (!locator || typeof locator !== "object") {
    return null;
  }

  const normalized = {
    sectionHeading: locator.sectionHeading ?? null,
    blockIndex: locator.blockIndex ?? null,
    pageRange: locator.pageRange ?? null,
    bbox: locator.bbox ?? null,
    tableId: locator.tableId ?? null,
    figureId: locator.figureId ?? null,
  };

  return Object.values(normalized).some((value) => value !== null) ? normalized : null;
}

function assertNonEmptyString(value, label, scope) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${scope}: ${label} is required`);
  }
}

function assertPositiveInteger(value, label, scope) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${scope}: ${label} must be a positive integer`);
  }
}

function assertIsoDateString(value, label, scope) {
  assertNonEmptyString(value, label, scope);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${scope}: ${label} must be an ISO date string`);
  }
}

function normalizeProvenanceRef(ref) {
  if (!ref || typeof ref !== "object") {
    return null;
  }

  assertNonEmptyString(ref.sourceId, "sourceId", "runtime provenance");

  return {
    sourceId: ref.sourceId,
    sourceType: ref.sourceType ?? "unknown",
    locator: normalizeLocator(ref.locator),
    excerpt: ref.excerpt ?? null,
    confidence: typeof ref.confidence === "number" ? ref.confidence : null,
  };
}

function buildProvenanceId(ownerType, ownerId, refRole, index) {
  return `${ownerType}::${ownerId}::${refRole}::${index}`;
}

function normalizeRelationTuple(tuple) {
  if (!Array.isArray(tuple) || tuple.length < 2) {
    return null;
  }

  if (tuple.length >= 3) {
    return {
      fromEntryId: tuple[0],
      type: tuple[1],
      toEntryId: tuple[2],
      evidenceRefs: [],
      confidence: null,
    };
  }

  return {
    type: tuple[0],
    toEntryId: tuple[1],
    evidenceRefs: [],
    confidence: null,
  };
}

function normalizeRelationObject(relation) {
  if (!relation || typeof relation !== "object") {
    return null;
  }

  return {
    type: relation.type ?? relation.relation ?? null,
    toEntryId: relation.toEntryId ?? relation.targetId ?? relation.entryId ?? null,
    evidenceRefs: Array.isArray(relation.evidenceRefs)
      ? relation.evidenceRefs
      : Array.isArray(relation.evidence)
        ? relation.evidence
        : [],
    confidence: typeof relation.confidence === "number" ? relation.confidence : null,
  };
}

function attachProvenance(records, ownerType, ownerId, refRole) {
  return records
    .filter((record) => record.ownerType === ownerType && record.ownerId === ownerId && record.refRole === refRole)
    .map(({ sourceId, sourceType, locator, excerpt, confidence }) => ({
      sourceId,
      sourceType,
      locator,
      excerpt,
      confidence,
    }));
}

export function normalizeRuntimeEntry(workspaceId, entry) {
  assertNonEmptyString(entry?.id, "id", "runtime entry");
  assertNonEmptyString(entry?.kind, "kind", "runtime entry");
  assertNonEmptyString(entry?.title, "title", "runtime entry");
  assertNonEmptyString(entry?.summary, "summary", "runtime entry");
  assertNonEmptyString(entry?.bodyMarkdown, "bodyMarkdown", "runtime entry");
  assertNonEmptyString(entry?.status, "status", "runtime entry");
  assertIsoDateString(entry?.updatedAt, "updatedAt", "runtime entry");
  assertPositiveInteger(entry?.version, "version", "runtime entry");

  return {
    id: entry.id,
    workspaceId,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    bodyMarkdown: entry.bodyMarkdown,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    status: entry.status ?? "active",
    sourceRefs: Array.isArray(entry.sourceRefs)
      ? entry.sourceRefs.map(normalizeProvenanceRef).filter(Boolean)
      : [],
    compiledFrom: Array.isArray(entry.compiledFrom) ? entry.compiledFrom : [],
    updatedAt: entry.updatedAt,
    version: entry.version ?? 1,
  };
}

export function buildRuntimeEdgeId(edge) {
  return `${edge.fromEntryId}::${edge.type}::${edge.toEntryId}`;
}

export function normalizeRuntimeEdge(workspaceId, edge) {
  assertNonEmptyString(edge?.fromEntryId, "fromEntryId", "runtime edge");
  assertNonEmptyString(edge?.toEntryId, "toEntryId", "runtime edge");
  assertNonEmptyString(edge?.type, "type", "runtime edge");

  return {
    id: buildRuntimeEdgeId(edge),
    workspaceId,
    fromEntryId: edge.fromEntryId,
    toEntryId: edge.toEntryId,
    type: edge.type,
    evidenceRefs: Array.isArray(edge.evidenceRefs)
      ? edge.evidenceRefs.map(normalizeProvenanceRef).filter(Boolean)
      : [],
    confidence: typeof edge.confidence === "number" ? edge.confidence : null,
  };
}

export function buildEntryProvenanceRecords(workspaceId, entry) {
  return (Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [])
    .map(normalizeProvenanceRef)
    .filter(Boolean)
    .map((ref, index) => ({
      id: buildProvenanceId("entry", entry.id, "sourceRef", index),
      workspaceId,
      ownerType: "entry",
      ownerId: entry.id,
      refRole: "sourceRef",
      ...ref,
    }));
}

export function buildEdgeProvenanceRecords(workspaceId, edge) {
  const edgeId = buildRuntimeEdgeId(edge);
  return (Array.isArray(edge.evidenceRefs) ? edge.evidenceRefs : [])
    .map(normalizeProvenanceRef)
    .filter(Boolean)
    .map((ref, index) => ({
      id: buildProvenanceId("edge", edgeId, "evidenceRef", index),
      workspaceId,
      ownerType: "edge",
      ownerId: edgeId,
      refRole: "evidenceRef",
      ...ref,
    }));
}

export function stripEntryInlineProvenance(entry) {
  const { sourceRefs, ...rest } = entry;
  return {
    ...rest,
    sourceRefs: [],
  };
}

export function stripEdgeInlineProvenance(edge) {
  const { evidenceRefs, ...rest } = edge;
  return {
    ...rest,
    evidenceRefs: [],
  };
}

export function normalizeRuntimeLog(workspaceId, log, id) {
  return {
    id,
    workspaceId,
    kind: log.kind ?? "runtime",
    sourceId: log.sourceId ?? null,
    detail: log.detail ?? null,
    createdAt: log.createdAt ?? null,
  };
}

export function normalizeRuntimeLintIssue(workspaceId, lintIssue, id) {
  return {
    id,
    workspaceId,
    code: lintIssue.code ?? "runtime-lint",
    severity: lintIssue.severity ?? "low",
    entryId: lintIssue.entryId ?? null,
    edgeId: lintIssue.edgeId ?? null,
    message: lintIssue.message ?? "",
    createdAt: lintIssue.createdAt ?? null,
  };
}

export function normalizeRuntimeIndexView(workspaceId, indexView, id) {
  return {
    id,
    workspaceId,
    key: indexView.key ?? "default",
    title: indexView.title ?? "Runtime Index",
    entryIds: Array.isArray(indexView.entryIds) ? indexView.entryIds : [],
    createdAt: indexView.createdAt ?? null,
  };
}

export function normalizeRuntimeStalenessMarker(workspaceId, marker, id) {
  return {
    id,
    workspaceId,
    targetType: marker.targetType ?? "entry",
    targetId: marker.targetId ?? null,
    reason: marker.reason ?? "stale",
    severity: marker.severity ?? "low",
    createdAt: marker.createdAt ?? null,
  };
}

export function normalizeRuntimeSupersededMarker(workspaceId, marker, id) {
  return {
    id,
    workspaceId,
    targetType: marker.targetType ?? "entry",
    targetId: marker.targetId ?? null,
    supersededById: marker.supersededById ?? null,
    reason: marker.reason ?? "superseded",
    createdAt: marker.createdAt ?? null,
  };
}

export function normalizeLegacyRelationArrays({ workspaceId, fromEntryId, relations = [] }) {
  return relations
    .map((relation) => (Array.isArray(relation) ? normalizeRelationTuple(relation) : normalizeRelationObject(relation)))
    .filter((relation) => relation?.type && relation?.toEntryId)
    .map((relation) =>
      normalizeRuntimeEdge(workspaceId, {
        fromEntryId: relation.fromEntryId ?? fromEntryId,
        toEntryId: relation.toEntryId,
        type: relation.type,
        evidenceRefs: relation.evidenceRefs,
        confidence: relation.confidence,
      }),
    );
}

export function createRuntimeSnapshot({
  entries = [],
  edges = [],
  provenance = [],
  logs = [],
  lintIssues = [],
  indexViews = [],
  stalenessMarkers = [],
  supersededMarkers = [],
} = {}) {
  return {
    entries: entries.map((entry) => ({
      ...entry,
      sourceRefs: attachProvenance(provenance, "entry", entry.id, "sourceRef"),
    })),
    edges: edges.map((edge) => ({
      ...edge,
      evidenceRefs: attachProvenance(provenance, "edge", edge.id, "evidenceRef"),
    })),
    provenance,
    logs,
    lintIssues,
    indexViews,
    stalenessMarkers,
    supersededMarkers,
  };
}
