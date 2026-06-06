import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, nowIso, wikiFileName } from "../utils.js";

function buildFrontmatter(page, relatedLinks) {
  const timestamp = nowIso();
  const aliases = Array.from(new Set(page.entities || []))
    .filter((entity) => entity !== page.title)
    .slice(0, 5);

  return `---
title: ${page.title}
aliases:
${aliases.map((alias) => `  - ${alias}`).join("\n") || "  - " + page.title}
tags:
  - xinwiki
  - ${page.type.toLowerCase()}
tier: semantic
source_type: xinwiki-export
source_path: ${page.source}
entity_type: ${page.type}
created: ${timestamp}
modified: ${timestamp}
related:
${relatedLinks.map((link) => `  - "${link}"`).join("\n") || "  - "}
supersedes: []
confidence:
  value: 0.82
  last_evaluated: ${timestamp}
  source_date: ${timestamp}
  corroborations: ${Math.max(1, relatedLinks.length)}
  disputed: false
---`;
}

function buildPageBody(page) {
  return page.sections
    .map(([heading, content]) => `## ${heading}\n\n${content}`)
    .join("\n\n");
}

export async function exportWorkspaceToLlmWiki({
  outputDir,
  workspace,
  wikiPages,
  ontologyNodes,
  ontologyEdges,
}) {
  const wikiDir = path.join(outputDir, "wiki");
  const schemaDir = path.join(outputDir, "_schema");

  await ensureDir(wikiDir);
  await ensureDir(schemaDir);

  for (const page of wikiPages) {
    const relatedLinks = Array.from(
      new Set([
        ...(page.entities || []).map((entity) => `[[${entity}]]`),
        ...(page.relations || []).map((relation) => `[[${relation[2]}]]`),
      ]),
    ).slice(0, 12);

    const content = [
      buildFrontmatter(page, relatedLinks),
      `# ${page.title}`,
      "",
      page.summary,
      "",
      buildPageBody(page),
      "",
      "## Relations",
      "",
      ...(page.relations || []).map(
        ([from, type, to]) => `- ${from} -> ${type} -> ${to}`,
      ),
    ].join("\n");

    await fs.writeFile(path.join(wikiDir, `${wikiFileName(page.title)}.md`), content, "utf8");
  }

  const graph = {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      exportedAt: nowIso(),
    },
    nodes: ontologyNodes.map((node) => ({
      id: node.id,
      title: node.id,
      entityType: node.type,
      tier: node.expertWeight >= 4 ? "procedural" : "semantic",
      confidence: Math.min(0.99, 0.5 + (node.expertWeight || 1) * 0.08),
    })),
    edges: ontologyEdges.map(([from, to, type]) => ({
      from,
      to,
      type,
    })),
  };

  await fs.writeFile(
    path.join(schemaDir, "graph.json"),
    JSON.stringify(graph, null, 2),
    "utf8",
  );

  return {
    outputDir,
    pageCount: wikiPages.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}

// ── Runtime projection exporter ───────────────────────────────────────────────

function buildRuntimeEntryTitleMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.id, entry.title);
  }
  return map;
}

function buildRuntimeFrontmatter(entry, relatedTitles) {
  const timestamp = entry.updatedAt || nowIso();
  const aliases = (entry.aliases || [])
    .filter((alias) => alias !== entry.title)
    .slice(0, 5);

  const tagList = [
    "xinwiki",
    entry.kind.toLowerCase(),
    ...(entry.tags || []),
  ].slice(0, 10);

  const sourcePath = entry.sourceRefs?.[0]?.sourceId || "unknown";

  return `---
title: ${entry.title}
aliases:
${aliases.map((alias) => `  - ${alias}`).join("\n") || "  - " + entry.title}
tags:
${tagList.map((tag) => `  - ${tag}`).join("\n")}
tier: semantic
source_type: xinwiki-export
source_path: ${sourcePath}
entity_type: ${entry.kind}
created: ${timestamp}
modified: ${timestamp}
related:
${relatedTitles.map((title) => `  - "[[${title}]]"`).join("\n") || "  - "}
supersedes: []
confidence:
  value: 0.82
  last_evaluated: ${timestamp}
  source_date: ${timestamp}
  corroborations: ${Math.max(1, relatedTitles.length)}
  disputed: false
---`;
}

export async function exportRuntimeToLlmWiki({
  outputDir,
  workspace,
  runtime,
}) {
  const wikiDir = path.join(outputDir, "wiki");
  const schemaDir = path.join(outputDir, "_schema");

  await ensureDir(wikiDir);
  await ensureDir(schemaDir);

  const activeEntries = (runtime.entries || []).filter(
    (e) => e.status !== "superseded",
  );
  const titleMap = buildRuntimeEntryTitleMap(runtime.entries || []);
  const edges = runtime.edges || [];

  // Build per-entry relation links from edges
  const entryRelations = new Map();
  for (const edge of edges) {
    if (!entryRelations.has(edge.fromEntryId)) {
      entryRelations.set(edge.fromEntryId, []);
    }
    const toTitle = titleMap.get(edge.toEntryId) || edge.toEntryId;
    entryRelations.get(edge.fromEntryId).push({ type: edge.type, toTitle });
  }

  // Write wiki markdown pages
  for (const entry of activeEntries) {
    const relations = entryRelations.get(entry.id) || [];
    const relatedTitles = [...new Set(relations.map((r) => r.toTitle))].slice(0, 12);

    const frontmatter = buildRuntimeFrontmatter(entry, relatedTitles);

    const relationsSection = relations.length > 0
      ? [
          "",
          "## Relations",
          "",
          ...relations.map((r) => `- [[${r.toTitle}]] (${r.type})`),
        ]
      : [];

    const content = [
      frontmatter,
      `# ${entry.title}`,
      "",
      entry.summary || "",
      "",
      entry.bodyMarkdown || "",
      ...relationsSection,
    ].join("\n");

    await fs.writeFile(
      path.join(wikiDir, `${wikiFileName(entry.title)}.md`),
      content,
      "utf8",
    );
  }

  // Write index.md
  const indexLines = [
    `# ${workspace.name || "Workspace"} — Index`,
    "",
    ...activeEntries.map(
      (e) => `- [[${e.title}]] — ${e.summary || ""}`,
    ),
  ];
  await fs.writeFile(
    path.join(outputDir, "index.md"),
    indexLines.join("\n"),
    "utf8",
  );

  // Write _schema/graph.json
  const graph = {
    workspace: {
      id: workspace.id,
      name: workspace.name || "",
      exportedAt: nowIso(),
    },
    nodes: activeEntries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      entityType: entry.kind,
      tier: "semantic",
      confidence: 0.82,
    })),
    edges: edges.map((edge) => ({
      from: titleMap.get(edge.fromEntryId) || edge.fromEntryId,
      to: titleMap.get(edge.toEntryId) || edge.toEntryId,
      type: edge.type,
    })),
  };

  await fs.writeFile(
    path.join(schemaDir, "graph.json"),
    JSON.stringify(graph, null, 2),
    "utf8",
  );

  // Write log.md
  const logEntries = runtime.logs || [];
  const logLines = [
    "# Compilation Log",
    `Exported: ${nowIso()}`,
    "",
    ...logEntries.map(
      (log) => `- [${log.kind || "runtime"}] ${log.detail || ""}${log.sourceId ? ` (source: ${log.sourceId})` : ""}`,
    ),
  ];
  if (logEntries.length === 0) {
    logLines.push("_No log entries._");
  }
  await fs.writeFile(
    path.join(outputDir, "log.md"),
    logLines.join("\n"),
    "utf8",
  );

  return {
    outputDir,
    pageCount: activeEntries.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}
