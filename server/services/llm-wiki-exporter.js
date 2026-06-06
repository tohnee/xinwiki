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
  const rawDir = path.join(outputDir, "raw");

  await ensureDir(wikiDir);
  await ensureDir(schemaDir);
  await ensureDir(rawDir);

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
  await fs.writeFile(
    path.join(schemaDir, "AGENTS.md"),
    buildLlmWikiProtocol({ workspace }),
    "utf8",
  );
  await fs.writeFile(
    path.join(rawDir, "manifest.md"),
    [
      `# ${workspace.name || "Workspace"} Raw Sources`,
      "",
      "Raw source binaries remain in XinWiki protected storage. This manifest records immutable source identifiers referenced by legacy wiki pages.",
      "",
      ...wikiPages.map((page) => `- ${page.source || page.title}`),
    ].join("\n"),
    "utf8",
  );

  return {
    outputDir,
    pageCount: wikiPages.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}


function buildLlmWikiProtocol({ workspace }) {
  return [
    `# ${workspace.name || "XinWiki"} llm-wiki Protocol`,
    "",
    "This workspace follows the llm-wiki pattern: raw sources are immutable evidence, wiki pages are LLM-maintained synthesis, and this schema governs ingest, query, lint, and export behavior.",
    "",
    "## Layers",
    "",
    "1. `raw/` — immutable source manifest and pointers. Do not rewrite evidence; ingest a newer source instead.",
    "2. `wiki/` — generated Markdown pages with frontmatter, provenance, and wikilinks.",
    "3. `_schema/` — operating protocol plus `graph.json` for the entry/edge projection.",
    "4. `index.md` — content-oriented catalog read before answering.",
    "5. `log.md` — append-only chronological compilation history.",
    "",
    "## Query workflow",
    "",
    "- Read `index.md` first, then relevant `wiki/*.md` pages.",
    "- Answer only from cited wiki/source evidence. If evidence is missing, say what source is needed.",
    "- Valuable answers should be filed back as new sourced wiki pages in future ingests.",
    "",
    "## Generation workflow",
    "",
    "- Reports, PPT outlines, briefs, images, and other generated artifacts must be grounded in user documents, compiled wiki entries, QA records, or explicit expert injections.",
    "- Preserve citations in every conclusion-bearing section.",
    "- Prefer clear hierarchy, concise claims, and visually scannable layouts.",
  ].join("\n");
}

function buildRawManifest({ workspace, runtime }) {
  const sourceIds = Array.from(new Set([
    ...(runtime.entries || []).flatMap((entry) => entry.sourceRefs || []).map((ref) => ref.sourceId),
    ...(runtime.edges || []).flatMap((edge) => edge.evidenceRefs || []).map((ref) => ref.sourceId),
  ].filter(Boolean))).sort();

  return [
    `# ${workspace.name || "Workspace"} Raw Sources`,
    "",
    "Raw source binaries remain in XinWiki protected storage. This manifest records immutable source identifiers referenced by the exported wiki projection.",
    "",
    ...(sourceIds.length ? sourceIds.map((sourceId) => `- ${sourceId}`) : ["_No runtime source references exported yet._"]),
  ].join("\n");
}

// ── YAML safe helpers ────────────────────────────────────────────────────────

function yamlSafeValue(value) {
  const str = String(value || "");
  // Quote if contains special YAML chars
  if (/[:\n\r'"#&*!|>%@`{}\[\],?=\-]/.test(str) || str !== str.trim()) {
    // Use double-quoted style with escape
    return JSON.stringify(str);
  }
  return str || '""';
}

function yamlSafeFlowList(items) {
  if (!items || !items.length) return "[]";
  return "[" + items.map(item => JSON.stringify(String(item))).join(", ") + "]";
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
  const aliasesArr = Array.from(new Set(entry.aliases || []))
    .filter((alias) => alias !== entry.title)
    .slice(0, 5);

  const lines = [
    "---",
    `title: ${yamlSafeValue(entry.title)}`,
    "aliases:",
    ...(aliasesArr.length
      ? aliasesArr.map((alias) => `  - ${yamlSafeValue(alias)}`)
      : [`  - ${yamlSafeValue(entry.title)}`]),
    "tags:",
    ...((entry.tags && entry.tags.length ? entry.tags : ["xinwiki"])
      .map((tag) => `  - ${yamlSafeValue(tag)}`)
      .slice(0, 10)),
    `tier: ${yamlSafeValue(entry.kind === "page" ? "semantic" : "procedural")}`,
    `source_type: xinwiki-runtime-export`,
    `source_path: ${yamlSafeValue(entry.sourceRefs?.[0]?.sourceId || "unknown")}`,
    `entity_type: ${yamlSafeValue(entry.kind)}`,
    `created: ${timestamp}`,
    `modified: ${timestamp}`,
    "related:",
    ...(relatedTitles.length
      ? relatedTitles.map((title) => `  - "[[${String(title).replace(/"/g, '\\"')}]]"`)
      : ["  - "]),
    "supersedes: []",
    "confidence:",
    `  value: 0.82`,
    `  last_evaluated: ${timestamp}`,
    `  source_date: ${timestamp}`,
    `  corroborations: ${Math.max(1, relatedTitles.length)}`,
    `  disputed: false`,
    "---",
  ];
  return lines.join("\n");
}

export async function exportRuntimeToLlmWiki({
  outputDir,
  workspace,
  runtime,
}) {
  const wikiDir = path.join(outputDir, "wiki");
  const schemaDir = path.join(outputDir, "_schema");
  const rawDir = path.join(outputDir, "raw");

  await ensureDir(wikiDir);
  await ensureDir(schemaDir);
  await ensureDir(rawDir);

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
  const usedNames = new Set();

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

    let baseName = wikiFileName(entry.title);
    // 拒绝路径穿越
    if (baseName.includes("..") || baseName.includes("/") || baseName.includes("\\") || baseName.includes("\0")) {
      baseName = "untitled";
    }
    if (!baseName) baseName = "untitled";

    // 处理 slug 撞名
    let fileName = `${baseName}.md`;
    let counter = 1;
    while (usedNames.has(fileName)) {
      fileName = `${baseName}-${counter}.md`;
      counter++;
    }
    usedNames.add(fileName);

    await fs.writeFile(
      path.join(wikiDir, fileName),
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
  await fs.writeFile(
    path.join(schemaDir, "AGENTS.md"),
    buildLlmWikiProtocol({ workspace }),
    "utf8",
  );
  await fs.writeFile(
    path.join(rawDir, "manifest.md"),
    buildRawManifest({ workspace, runtime }),
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
