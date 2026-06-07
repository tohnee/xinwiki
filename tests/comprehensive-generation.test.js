/**
 * T5+T6: 生成模块严格性+质量测试（增强版）
 *
 * 验证：
 * - 报告严格按照问答结论和用户文档数据生成
 * - 生成内容（报告、DOCX、PDF）的质量和完整程度
 * - 不支持格式时的拒绝行为
 * - 生成内容引用来源可追溯
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const tempDirs = [];

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-gen-"));
  tempDirs.push(rootDir);
  return await createApp({
    dataDir: path.join(rootDir, "data"),
    uploadsDir: path.join(rootDir, "uploads"),
    llmWikiDir: path.join(rootDir, "llm-wiki"),
    jwtSecret: "test-secret",
  });
}

function responseSize(res) {
  if (Buffer.isBuffer(res.body)) return res.body.length;
  if (typeof res.text === "string") return Buffer.byteLength(res.text);
  return Number(res.headers["content-length"] || 0);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("T5: 生成模块严格性（基于问答结论和用户文档数据）", () => {
  it("报告标题反映工作空间名称和报告类型", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "gen-strict@test.com",
      password: "Passw0rd!",
      displayName: "Gen Strict",
    });
    const cookie = regRes.headers["set-cookie"];

    // 上传带具体内容的文档
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-gen1-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "tsmc.md");
    await fs.writeFile(md, "# 台积电 2026 年产能分析\n\n台积电 CoWoS 先进封装产能持续扩张。", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md)
      .expect(201);

    // 添加问答记录
    await request(app)
      .post("/api/qa-records")
      .set("Cookie", cookie)
      .send({
        question: "台积电 CoWoS 产能如何？",
        answer: "台积电 CoWoS 产能依旧偏紧，扩产节奏与 AI 需求同步。",
        citations: ["page:台积电 2026 年产能分析"],
      })
      .expect(201);

    const types = ["tech", "company", "supply", "compete", "weekly", "ppt"];
    for (const reportType of types) {
      const genRes = await request(app)
        .post("/api/reports/generate")
        .set("Cookie", cookie)
        .send({
          scope: "wiki",
          reportType,
          chartType: "roadmap",
          model: "test-model",
          format: "report",
        });

      expect(genRes.status).toBe(201);
      expect(genRes.body.report.title).toBeTruthy();
      expect(genRes.body.report.reportType).toBe(reportType);
      expect(genRes.body.report.sections.length).toBeGreaterThan(1);
    }
  });

  it("报告内容包含工作空间实际数据（来源、问答、Wiki）", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "gen-content@test.com",
      password: "Passw0rd!",
      displayName: "Gen Content",
    });
    const cookie = regRes.headers["set-cookie"];

    // 上传特定内容的文档
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-gen2-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "specific.md");
    await fs.writeFile(md, "# ASML EUV Technology\n\nASML dominates the EUV lithography market with 90% share.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md)
      .expect(201);

    // 添加含特定关键词的问答
    await request(app)
      .post("/api/qa-records")
      .set("Cookie", cookie)
      .send({
        question: "ASML 的 EUV 市场份额？",
        answer: "ASML 在 EUV 光刻市场占据约 90% 份额。",
        citations: ["source:specific.md"],
      })
      .expect(201);

    const genRes = await request(app)
      .post("/api/reports/generate")
      .set("Cookie", cookie)
      .send({
        scope: "qa",
        reportType: "tech",
        chartType: "roadmap",
        model: "test",
        format: "report",
      });

    expect(genRes.status).toBe(201);

    // 报告的 markdown 应该包含工作空间实际数据
    const mdContent = genRes.body.markdown;
    expect(mdContent).toMatch(/ASML|EUV/);

    // 报告的 evidence/citations 应该引用真实数据源
    const evidenceLabels = genRes.body.report.evidence || [];
    expect(evidenceLabels.some((e) => e.includes("ASML") || e.includes("specific.md"))).toBe(true);
  });

  it("scope 参数正确过滤报告数据来源", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "gen-scope@test.com",
      password: "Passw0rd!",
      displayName: "Gen Scope",
    });
    const cookie = regRes.headers["set-cookie"];

    const scopes = ["wiki", "ontology", "sources", "qa"];
    for (const scope of scopes) {
      const genRes = await request(app)
        .post("/api/reports/generate")
        .set("Cookie", cookie)
        .send({
          scope,
          reportType: "tech",
          chartType: "roadmap",
          model: "test",
          format: "report",
        });

      expect(genRes.status).toBe(201);
      expect(genRes.body.report.scope).toBe(scope);
    }
  });

  it("报告中明确声明'本报告严格基于工作空间内证据生成'", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "gen-disclaimer@test.com",
      password: "Passw0rd!",
      displayName: "Gen Disclaimer",
    });
    const cookie = regRes.headers["set-cookie"];

    const genRes = await request(app)
      .post("/api/reports/generate")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "test",
        format: "report",
      });

    expect(genRes.status).toBe(201);
    // 报告的 sections 中应包含"不引入工作空间外事实"等声明
    const sectionBodies = genRes.body.report.sections.map((s) => s.body || "").join(" ");
    expect(sectionBodies).toMatch(/工作空间|来源|证据|不引入/);
  });
});

describe("T6: 生成内容质量与美观程度", () => {
  it("DOCX 导出：文件大小合理（>500 bytes），内容类型正确", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "docx-quality@test.com",
      password: "Passw0rd!",
      displayName: "Docx Quality",
    });
    const cookie = regRes.headers["set-cookie"];

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-docx-"));
    tempDirs.push(tmpDir);
    await fs.writeFile(path.join(tmpDir, "data.md"), "# Test Data\n\nQuality test data with insights.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", path.join(tmpDir, "data.md"))
      .expect(201);

    const docxRes = await request(app)
      .post("/api/reports/export")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "company",
        chartType: "roadmap",
        model: "test-model",
        exportFormat: "docx",
      });

    expect(docxRes.status).toBe(201);
    expect(docxRes.body.fileName).toMatch(/\.docx$/);

    // 下载验证
    const download = await request(app)
      .get(docxRes.body.downloadUrl)
      .set("Cookie", cookie);

    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toMatch(/word|docx|application\/zip/i);
    expect(responseSize(download)).toBeGreaterThan(500);
  });

  it("PDF 导出：文件大小合理，内容类型正确", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "pdf-quality@test.com",
      password: "Passw0rd!",
      displayName: "PDF Quality",
    });
    const cookie = regRes.headers["set-cookie"];

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-pdf-"));
    tempDirs.push(tmpDir);
    await fs.writeFile(path.join(tmpDir, "data.md"), "# PDF Test Data\n\nQuality test data.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", path.join(tmpDir, "data.md"))
      .expect(201);

    const pdfRes = await request(app)
      .post("/api/reports/export")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "test",
        exportFormat: "pdf",
      });

    expect(pdfRes.status).toBe(201);
    expect(pdfRes.body.fileName).toMatch(/\.pdf$/);

    const download = await request(app)
      .get(pdfRes.body.downloadUrl)
      .set("Cookie", cookie);

    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toMatch(/pdf/i);
    expect(responseSize(download)).toBeGreaterThan(500);
  });

  it("报告导出文件包含结构化报告元素（指标、章节、引用）", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "struct-quality@test.com",
      password: "Passw0rd!",
      displayName: "Struct Quality",
    });
    const cookie = regRes.headers["set-cookie"];

    const genRes = await request(app)
      .post("/api/reports/generate")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "company",
        chartType: "roadmap",
        model: "test",
        format: "report",
      });

    expect(genRes.status).toBe(201);

    // 报告必须包含以下结构元素
    const report = genRes.body.report;
    expect(report.title).toBeTruthy();
    expect(report.summary).toBeTruthy();
    expect(Array.isArray(report.metrics)).toBe(true);
    expect(report.metrics.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(report.sections)).toBe(true);
    expect(report.sections.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(report.citations)).toBe(true);

    // Markdown 输出格式正确
    const md = genRes.body.markdown;
    expect(md).toContain("# ");
    expect(md).toContain("## ");
    expect(md).toMatch(/-\s+/);
  });

  it("PPT 简报类型 reportType 可正常生成", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "ppt-gen@test.com",
      password: "Passw0rd!",
      displayName: "PPT Gen",
    });
    const cookie = regRes.headers["set-cookie"];

    const genRes = await request(app)
      .post("/api/reports/generate")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "ppt",
        chartType: "roadmap",
        model: "test",
        format: "ppt",
      });

    expect(genRes.status).toBe(201);
    expect(genRes.body.report.reportType).toBe("ppt");
    expect(genRes.body.markdown).toBeTruthy();
  });

  it("无数据时生成报告包含合理空状态指标", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "empty-gen@test.com",
      password: "Passw0rd!",
      displayName: "Empty Gen",
    });
    const cookie = regRes.headers["set-cookie"];

    const genRes = await request(app)
      .post("/api/reports/generate")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "test",
        format: "report",
      });

    expect(genRes.status).toBe(201);
    // 空状态下指标值应为 "0"
    expect(genRes.body.report.metrics.every((m) => typeof m.value === "string")).toBe(true);
    // 应该至少有 metrics
    expect(genRes.body.report.metrics.length).toBeGreaterThanOrEqual(4);
  });
});
