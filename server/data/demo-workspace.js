export const DEMO_WORKSPACE = {
  files: [
    {
      id: "tsmc-2026-packaging-note",
      name: "TSMC_N2_CoWoS_2026.md",
      title: "台积电 N2 与 CoWoS 跟踪笔记",
      source: "系统种子数据",
      date: "2026-06-05",
      type: "行业研究",
      mimeType: "text/markdown",
      size: "18 KB",
      parsed: true,
      wikiBuilt: true,
      progress: 100,
      abstract: "台积电 N2 制程与 CoWoS 先进封装仍是 AI/HPC 供应链的关键变量，扩产节奏、EUV 能力和 ABF 基板供给共同影响交付质量。",
      facts: [
        "N2 面向 AI 与 HPC 芯片，关注 GAA 晶体管、良率爬坡和客户验证节奏。",
        "CoWoS 产能是高端 GPU 与 AI 加速器交付的重要瓶颈。",
        "EUV Photoresist、硅晶圆与 ABF 基板是需要持续跟踪的材料环节。",
      ],
      sections: [
        ["核心结论", "台积电 N2 与 CoWoS 需要联动观察：前道制程决定性能窗口，先进封装决定 AI 服务器交付节奏。"],
        ["关键风险", "若 CoWoS 扩产慢于 AI 需求，NVIDIA 等客户的高端 GPU 供给可能受到限制。"],
      ],
      markdown: "# 台积电 N2 与 CoWoS 跟踪笔记\n\n台积电 N2 制程与 CoWoS 先进封装仍是 AI/HPC 供应链的关键变量。\n\n## 核心结论\n\n- N2 面向 AI 与 HPC 芯片。\n- CoWoS 产能是高端 GPU 与 AI 加速器交付的重要瓶颈。\n- EUV Photoresist、硅晶圆与 ABF 基板是需要持续跟踪的材料环节。",
    },
    {
      id: "asml-euv-supply-note",
      name: "ASML_EUV_Supply.md",
      title: "ASML EUV 供应链观察",
      source: "系统种子数据",
      date: "2026-06-05",
      type: "供应链研究",
      mimeType: "text/markdown",
      size: "12 KB",
      parsed: true,
      wikiBuilt: true,
      progress: 100,
      abstract: "ASML EUV 设备交付能力影响先进制程扩产速度，需结合光刻胶、掩模和晶圆供应进行交叉验证。",
      facts: [
        "EUV 设备交付周期影响 N2/N3 产能部署。",
        "先进光刻胶质量影响良率稳定性。",
      ],
      sections: [
        ["供应链重点", "EUV 设备、EUV Photoresist 与高纯材料需要作为同一条证据链观察。"],
      ],
      markdown: "# ASML EUV 供应链观察\n\nASML EUV 设备交付能力影响先进制程扩产速度。",
    },
  ],
  wikiPages: [
    {
      id: "tsmc",
      title: "台积电先进制程与先进封装",
      source: "TSMC_N2_CoWoS_2026.md",
      type: "Company",
      summary: "台积电是 N2、N3 与 CoWoS 先进封装的核心节点，报告生成应优先引用其 Wiki 结论和源文档摘要。",
      sections: [
        ["定位", "台积电承担先进制程制造与先进封装扩产，是 AI/HPC 供应链的关键枢纽。"],
        ["观察指标", "关注 N2 风险试产、CoWoS 扩产、EUV 设备到位、材料供应和客户验证。"],
      ],
      entities: ["台积电", "N2", "N3", "CoWoS", "NVIDIA", "EUV"],
      relations: [
        ["台积电", "usesNode", "N2"],
        ["台积电", "providesPackaging", "CoWoS"],
        ["NVIDIA", "dependsOn", "CoWoS"],
      ],
    },
    {
      id: "cowos",
      title: "CoWoS 先进封装",
      source: "TSMC_N2_CoWoS_2026.md",
      type: "Technology",
      summary: "CoWoS 是 AI 加速器供应链中的先进封装能力，影响高端 GPU 交付、HBM 集成与服务器放量。",
      sections: [
        ["瓶颈", "CoWoS 的瓶颈来自封装设备、ABF 基板、HBM 协同和产线爬坡。"],
      ],
      entities: ["CoWoS", "HBM", "ABF 基板", "NVIDIA", "台积电"],
      relations: [
        ["CoWoS", "supports", "AI GPU"],
        ["台积电", "expands", "CoWoS"],
      ],
    },
  ],
  ontologyNodes: [
    { id: "台积电", type: "Company", x: 320, y: 220, color: "#5b6ef5", wiki: "tsmc", expertWeight: 5, expertNote: "先进制程与封装主线节点。" },
    { id: "N2", type: "Process", x: 520, y: 180, color: "#7c3aed", wiki: "tsmc", expertWeight: 4, expertNote: "关注 GAA 与良率爬坡。" },
    { id: "CoWoS", type: "Technology", x: 520, y: 320, color: "#14b8a6", wiki: "cowos", expertWeight: 5, expertNote: "AI 供应链交付瓶颈。" },
    { id: "NVIDIA", type: "Company", x: 760, y: 300, color: "#f43f5e", wiki: "cowos", expertWeight: 4, expertNote: "高端 GPU 需求核心客户。" },
    { id: "ASML", type: "Company", x: 220, y: 420, color: "#f59e0b", wiki: null, expertWeight: 3, expertNote: "EUV 设备供应节点。" },
  ],
  ontologyEdges: [
    ["台积电", "N2", "usesNode"],
    ["台积电", "CoWoS", "providesPackaging"],
    ["NVIDIA", "CoWoS", "dependsOn"],
    ["ASML", "台积电", "suppliesEUV"],
  ],
  expertInjections: [
    { time: "2026/6/5 09:30", entity: "CoWoS", weight: 5, note: "若只看前道制程会低估先进封装对 AI 交付的约束。" },
    { time: "2026/6/5 10:15", entity: "台积电", weight: 5, note: "报告结论必须同时核对来源文档与 Wiki 页面。" },
  ],
  qaRecords: [
    {
      question: "CoWoS 产业链涉及哪些环节？",
      answer: "基于当前 Wiki，CoWoS 需要关注封装设备、ABF 基板、HBM 协同、台积电扩产和 NVIDIA 需求。",
      citations: ["wiki:CoWoS 先进封装", "source:TSMC_N2_CoWoS_2026.md"],
    },
  ],
  memories: [
    { time: "2026/6/5 · 永久记忆", text: "生成内容必须引用工作空间内的来源、Wiki、问答或专家经验，不允许脱离证据自由发挥。", period: "永久记忆" },
  ],
};
