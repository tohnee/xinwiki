import { describe, expect, it } from "vitest";

import { renderReportHtml, renderReportPlainText } from "../server/services/report-exporter.js";

const sampleReport = {
  title: "先进封装研究报告",
  summary: "聚焦 CoWoS 产能、ABF 基板与 AI 服务器需求的联动变化。",
  scope: "wiki",
  reportType: "tech",
  chartType: "roadmap",
  model: "deepseek v4 pro",
  metrics: [
    { label: "源文档", value: "3", detail: "财报、纪要、行业报告" },
    { label: "知识页", value: "5", detail: "已完成结构化整理" },
  ],
  sections: [
    {
      title: "核心结论",
      body: "CoWoS 产能依旧偏紧，扩产节奏与 ABF 基板恢复速度共同决定交付拐点。",
      bullets: [
        "台积电先进封装扩产仍是中短期核心变量。",
        "ABF 基板供应恢复速度慢于 GPU 需求释放速度。",
      ],
      citations: ["wiki:CoWoS 先进封装", "source:TSMC_Q4_Earnings_2025.pdf"],
    },
  ],
};

describe("report exporter templates", () => {
  it("renders styled html with report meta, metrics, sections, and citations", () => {
    const html = renderReportHtml(sampleReport);

    expect(html).toContain("<title>先进封装研究报告</title>");
    expect(html).toContain("报告概览");
    expect(html).toContain("关键指标");
    expect(html).toContain("生成模型");
    expect(html).toContain("deepseek v4 pro");
    expect(html).toContain("核心结论");
    expect(html).toContain("引用来源");
    expect(html).toContain("TSMC_Q4_Earnings_2025.pdf");
  });

  it("renders plain text layout for pdf export with cover, metrics, and body sections", () => {
    const plainText = renderReportPlainText(sampleReport);

    expect(plainText).toContain("先进封装研究报告");
    expect(plainText).toContain("报告概览");
    expect(plainText).toContain("关键指标");
    expect(plainText).toContain("生成模型: deepseek v4 pro");
    expect(plainText).toContain("## 核心结论");
    expect(plainText).toContain("引用来源: wiki:CoWoS 先进封装 | source:TSMC_Q4_Earnings_2025.pdf");
  });
});
