function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function topExpertNodes(ontologyNodes = []) {
  return [...ontologyNodes]
    .sort((a, b) => (b.expertWeight || 0) - (a.expertWeight || 0))
    .slice(0, 5);
}

function collectHighlights(bootstrap) {
  const highlights = [];

  for (const file of bootstrap.files.slice(0, 3)) {
    if (file.abstract) {
      highlights.push(file.abstract);
    }
    for (const fact of file.facts || []) {
      highlights.push(fact);
    }
  }

  for (const wikiPage of bootstrap.wikiPages.slice(0, 3)) {
    if (wikiPage.summary) {
      highlights.push(wikiPage.summary);
    }
  }

  return unique(highlights).slice(0, 8);
}

function formatSectionMarkdown(section) {
  const bullets = (section.bullets || []).map((bullet) => `- ${bullet}`).join("\n");
  const citations = (section.citations || []).length
    ? `\n\n引用：${section.citations.join(" | ")}`
    : "";
  return `## ${section.title}\n\n${section.body}${bullets ? `\n\n${bullets}` : ""}${citations}`;
}

export function buildReportPackage({ workspace, bootstrap, options }) {
  const reportTypeLabel = {
    company: "公司分析报告",
    tech: "技术专题报告",
    supply: "供应链报告",
    compete: "竞争格局报告",
    weekly: "周报 / 月报",
    ppt: "PPT 简报",
  }[options.reportType] || "研究报告";

  const scopeLabel = {
    wiki: "Workspace Wiki",
    ontology: "本体图谱",
    sources: "源文档",
    qa: "问答记录",
  }[options.scope] || options.scope;

  const expertNodes = topExpertNodes(bootstrap.ontologyNodes);
  const highlights = collectHighlights(bootstrap);
  const trackedEntities = unique([
    ...expertNodes.map((node) => node.id),
    ...bootstrap.wikiPages.flatMap((page) => page.entities || []).slice(0, 6),
  ]).slice(0, 6);

  const citations = unique([
    ...bootstrap.files.slice(0, 3).map((file) => `source:${file.name}`),
    ...bootstrap.wikiPages.slice(0, 3).map((page) => `wiki:${page.title}`),
    ...bootstrap.ontologyEdges.slice(0, 3).map((edge) => `edge:${edge.join(" -> ")}`),
  ]);

  const metrics = [
    { label: "源文档", value: String(bootstrap.files.length), detail: "可追溯来源" },
    { label: "Wiki 页面", value: String(bootstrap.wikiPages.length), detail: "结构化知识页" },
    { label: "本体对象", value: String(bootstrap.ontologyNodes.length), detail: "图谱节点" },
    { label: "专家经验", value: String(bootstrap.expertInjections.length), detail: "经验层注入" },
  ];

  const sections = [
    {
      title: "核心结论",
      body:
        `${workspace.name} 当前的报告主线聚焦于 ${trackedEntities.join("、")}。` +
        ` 本次生成基于 ${scopeLabel} 范围，优先提炼已结构化的 Wiki、来源摘要和本体关系。`,
      bullets: highlights.slice(0, 4),
      citations,
    },
    {
      title: "专家重点与本体路径",
      body:
        expertNodes.length
          ? `专家权重最高的对象包括 ${expertNodes.map((node) => `${node.id}（E${node.expertWeight || 1}/5）`).join("、")}。`
          : "当前还没有专家高权重对象，报告主线仅依据来源和 Wiki 内容生成。",
      bullets: bootstrap.ontologyEdges.slice(0, 4).map((edge) => `${edge[0]} -> ${edge[2]} -> ${edge[1]}`),
      citations: unique([
        ...expertNodes.map((node) => `ontology:${node.id}`),
        ...bootstrap.expertInjections.slice(0, 3).map((item) => `expert:${item.entity}`),
      ]),
    },
    {
      title: "后续跟踪建议",
      body: "建议围绕高权重本体、关键关系与最新来源变化持续跟踪。",
      bullets: [
        "跟踪重点来源的新增事实与摘要变化",
        "关注高权重本体关联的关系边新增或变更",
        "将高质量问答沉淀为报告补充证据",
      ],
      citations: bootstrap.qaRecords.slice(0, 2).map((record) => `qa:${record.question}`),
    },
  ];

  const outline = [
    "封面与范围说明",
    "核心结论与关键指标",
    "专家重点与本体路径",
    "后续跟踪建议",
  ];

  const title = `XinWiki · ${reportTypeLabel}`;
  const summary = highlights[0] || `${workspace.name} 已基于当前工作空间数据生成结构化报告。`;
  const markdown = [
    `# ${title}`,
    "",
    `- 工作空间：${workspace.name}`,
    `- 模型：${options.model}`,
    `- 范围：${scopeLabel}`,
    `- 图表：${options.chartType}`,
    "",
    summary,
    "",
    "## 关键指标",
    "",
    ...metrics.map((metric) => `- ${metric.label}：${metric.value}（${metric.detail}）`),
    "",
    ...sections.map(formatSectionMarkdown),
  ].join("\n");

  return {
    report: {
      title,
      summary,
      scope: options.scope,
      reportType: options.reportType,
      chartType: options.chartType,
      model: options.model,
      metrics,
      sections,
      outline,
      citations,
    },
    markdown,
  };
}
