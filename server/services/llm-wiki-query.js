function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripMarkdown(value) {
  return normalizeText(
    String(value || "")
      .replace(/[`*_>#-]+/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
  );
}

function buildSearchTerms(query) {
  const normalized = normalizeText(query).toLowerCase();
  if (!normalized) {
    return [];
  }

  const sanitized = normalized.replace(/[，。！？?!；;:：/]/g, " ").trim();
  const terms = new Set([sanitized]);
  const trimmedQuestion = sanitized
    .replace(/(是什么呢|是什么样的|是什么|是啥|有哪些|多少|吗|么|呢)$/u, "")
    .trim();

  if (trimmedQuestion) {
    terms.add(trimmedQuestion);
  }

  for (const token of sanitized.split(/\s+/)) {
    if (token.length >= 2) {
      terms.add(token);
    }
    if (/[\u4e00-\u9fff]/u.test(token)) {
      for (let size = 2; size <= 4; size++) {
        for (let index = 0; index <= token.length - size; index++) {
          terms.add(token.slice(index, index + size));
        }
      }
    }
  }

  return Array.from(terms).filter(Boolean);
}

function scoreSearchText(text, query) {
  const searchable = normalizeText(text).toLowerCase();
  const terms = buildSearchTerms(query);
  if (!searchable || !terms.length) {
    return 0;
  }

  return terms.reduce((score, term, index) => {
    if (!term || !searchable.includes(term)) {
      return score;
    }
    return score + (index === 0 ? 5 : 1);
  }, 0);
}

function bestMatchingChunk(text, query) {
  const chunks = stripMarkdown(text)
    .split(/(?:\n{2,}|。|！|？|\.\s+)/u)
    .map((chunk) => normalizeText(chunk))
    .filter((chunk) => chunk.length >= 8);
  if (!chunks.length) {
    return stripMarkdown(text);
  }
  return chunks
    .map((chunk, index) => ({ chunk, score: scoreSearchText(chunk, query) + Math.max(0, 1 - index * 0.05) }))
    .sort((left, right) => right.score - left.score)[0].chunk;
}

function buildExcerpt(text, query) {
  const source = bestMatchingChunk(text, query);
  if (!source) {
    return "";
  }

  const terms = buildSearchTerms(query);
  const match = terms.find((term) => source.toLowerCase().includes(term));
  if (!match) {
    return source.slice(0, 220);
  }

  const loweredSource = source.toLowerCase();
  const matchIndex = loweredSource.indexOf(match);
  const start = Math.max(0, matchIndex - 70);
  const end = Math.min(source.length, matchIndex + match.length + 110);
  return source.slice(start, end);
}

function collectEntryText(entry) {
  return [
    entry.title,
    entry.summary,
    stripMarkdown(entry.bodyMarkdown),
    ...(entry.aliases || []),
    ...(entry.tags || []),
    ...(entry.sourceRefs || []).flatMap((ref) => [
      ref.sourceId,
      ref.excerpt,
      ref.locator?.sectionHeading,
    ]),
  ]
    .filter(Boolean)
    .join(" ");
}

function dedupeEvidence(records) {
  const seen = new Set();
  const result = [];

  for (const record of records) {
    if (!record) {
      continue;
    }

    const key = JSON.stringify([
      record.ownerType || null,
      record.ownerId || null,
      record.role || null,
      record.sourceId || null,
      record.excerpt || null,
      record.locator || null,
    ]);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(record);
  }

  return result;
}

function mapRuntimeEntry(entry, query, ontologyWeights) {
  const baseScore = scoreSearchText(collectEntryText(entry), query);
  if (baseScore <= 0) {
    return null;
  }

  // 专家权重加权：expertWeight 作为排序因子，权重越高排名越靠前
  const expertWeight = (ontologyWeights && ontologyWeights.get(entry.title)) || 0;
  const expertBonus = expertWeight > 0 ? expertWeight * 0.3 : 0;

  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    excerpt: buildExcerpt(collectEntryText(entry), query),
    // Prefer page-level evidence so query/chat ground on the canonical page entry.
    score: baseScore + (entry.kind === "page" ? 2 : 0) + expertBonus,
    status: entry.status,
    sourceRefs: entry.sourceRefs || [],
  };
}

function mapRuntimeRelation(edge, entryMap, query) {
  const fromTitle = entryMap.get(edge.fromEntryId)?.title || edge.fromEntryId;
  const toTitle = entryMap.get(edge.toEntryId)?.title || edge.toEntryId;
  const searchable = [
    fromTitle,
    edge.type,
    toTitle,
    ...(edge.evidenceRefs || []).map((ref) => ref.excerpt),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: edge.id || `${edge.fromEntryId}::${edge.type}::${edge.toEntryId}`,
    fromEntryId: edge.fromEntryId,
    fromTitle,
    toEntryId: edge.toEntryId,
    toTitle,
    type: edge.type,
    score: scoreSearchText(searchable, query) + (edge.type === "mentions" ? 10 : 0),
    evidenceRefs: edge.evidenceRefs || [],
  };
}

export function queryRuntimeSnapshot({ snapshot = {}, query, ontologyWeights }) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return {
      query: "",
      entries: [],
      relations: [],
      evidence: [],
      pages: [],
      graph: [],
    };
  }

  const activeEntries = (snapshot.entries || []).filter((entry) => entry.status !== "superseded");
  const entryMap = new Map(activeEntries.map((entry) => [entry.id, entry]));
  const entries = activeEntries
    .map((entry) => mapRuntimeEntry(entry, normalizedQuery, ontologyWeights))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  const matchedEntryIds = new Set(entries.map((entry) => entry.id));
  const relations = (snapshot.edges || [])
    .map((edge) => mapRuntimeRelation(edge, entryMap, normalizedQuery))
    .filter((edge) =>
      matchedEntryIds.has(edge.fromEntryId)
      || matchedEntryIds.has(edge.toEntryId)
      || edge.score > 0
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  const evidence = dedupeEvidence([
    ...entries.flatMap((entry) => (entry.sourceRefs || []).map((ref) => ({
      ...ref,
      ownerType: "entry",
      ownerId: entry.id,
      role: "sourceRef",
    }))),
    ...relations.flatMap((edge) => (edge.evidenceRefs || []).map((ref) => ({
      ...ref,
      ownerType: "edge",
      ownerId: edge.id,
      role: "evidenceRef",
    }))),
  ]);

  return {
    query: normalizedQuery,
    entries,
    relations: relations.map((edge) => ({
      id: edge.id,
      fromEntryId: edge.fromEntryId,
      fromTitle: edge.fromTitle,
      toEntryId: edge.toEntryId,
      toTitle: edge.toTitle,
      type: edge.type,
      score: edge.score,
      evidenceRefs: edge.evidenceRefs,
    })),
    evidence,
    pages: entries
      .filter((entry) => entry.kind === "page")
      .map((entry) => ({
        title: entry.title,
        source: entry.source || null,
        excerpt: entry.excerpt,
        score: entry.score,
      })),
    graph: entries
      .filter((entry) => entry.kind !== "page")
      .map((entry) => ({
        id: entry.title,
        type: entry.kind,
        excerpt: entry.excerpt,
        score: entry.score,
      })),
  };
}

export function buildGroundedAnswerFromQuery(queryResult, question) {
  const entries = Array.isArray(queryResult?.entries) ? queryResult.entries : [];
  if (!entries.length) {
    return {
      canAnswer: false,
      answer:
        "当前没有足够的意图级证据来回答这个问题。按照 grounded-only 规则，我会拒绝回答；"
        + "请先补充相关来源、Wiki 或明确包含该问题意图的文档证据。",
      citations: [],
      context: "",
    };
  }

  const preferredEntries = [
    ...entries.filter((entry) => entry.kind === "page"),
    ...entries.filter((entry) => entry.kind !== "page"),
  ];
  const topEntry = preferredEntries[0];
  const citations = preferredEntries.slice(0, 3).map((entry) => `${entry.kind}:${entry.title}`);
  const relationContext = (queryResult.relations || [])
    .slice(0, 3)
    .map((relation) => `${relation.fromTitle} -${relation.type}-> ${relation.toTitle}`)
    .join("\n");

  return {
    canAnswer: true,
    answer: `根据当前工作空间 runtime 检索结果，${topEntry.title} 与“${question}”最相关。${topEntry.excerpt || topEntry.summary}`,
    citations,
    context: [
      ...preferredEntries
        .slice(0, 3)
        .map((entry) => `[${entry.kind}] ${entry.title}: ${entry.excerpt || entry.summary}`),
      relationContext ? `[relations]\n${relationContext}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
