import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const tempDirs = [];

function responseSize(response) {
  if (Buffer.isBuffer(response.body)) {
    return response.body.length;
  }
  if (typeof response.text === "string") {
    return Buffer.byteLength(response.text);
  }
  return Number(response.headers["content-length"] || 0);
}

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-report-"));
  tempDirs.push(rootDir);

  const app = await createApp({
    dataDir: path.join(rootDir, "data"),
    uploadsDir: path.join(rootDir, "uploads"),
    llmWikiDir: path.join(rootDir, "llm-wiki"),
    jwtSecret: "test-secret",
  });

  return { app, rootDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("report generation API", () => {
  it("generates structured report JSON and markdown from workspace data", async () => {
    const { app } = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "report@example.com",
      password: "Passw0rd!",
      displayName: "Report Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const response = await request(app)
      .post("/api/reports/generate")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "deepseek v4 pro",
        format: "report",
      });

    expect(response.status).toBe(201);
    expect(response.body.report.title).toMatch(/报告|简报|研究/);
    expect(response.body.report.sections.length).toBeGreaterThan(1);
    expect(response.body.report.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "源文档" }),
      ]),
    );
    expect(response.body.markdown).toContain("# ");
    expect(response.body.markdown).toMatch(/CoWoS|N2|台积电/);
    expect(response.body.report.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringMatching(/核心|结论|正文/),
        }),
      ]),
    );
  });

  it("exports generated report as real docx and pdf files", async () => {
    const { app, rootDir } = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "export-report@example.com",
      password: "Passw0rd!",
      displayName: "Export Report Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const docxResponse = await request(app)
      .post("/api/reports/export")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "deepseek v4 pro",
        exportFormat: "docx",
      });

    expect(docxResponse.status).toBe(201);
    expect(docxResponse.body.format).toBe("docx");
    expect(docxResponse.body.fileName).toMatch(/\.docx$/);
    expect(docxResponse.body.downloadUrl).toMatch(/\/exports\//);
    expect(docxResponse.body.outputPath).toBeUndefined();

    const unauthenticatedDownload = await request(app)
      .get(docxResponse.body.downloadUrl);

    expect(unauthenticatedDownload.status).toBe(401);

    const docxDownload = await request(app)
      .get(docxResponse.body.downloadUrl)
      .set("Cookie", cookie);

    expect(docxDownload.status).toBe(200);
    expect(docxDownload.headers["content-type"]).toMatch(/word|docx|application\/zip/i);
    expect(responseSize(docxDownload)).toBeGreaterThan(500);

    const pdfResponse = await request(app)
      .post("/api/reports/export")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "deepseek v4 pro",
        exportFormat: "pdf",
      });

    expect(pdfResponse.status).toBe(201);
    expect(pdfResponse.body.format).toBe("pdf");
    expect(pdfResponse.body.fileName).toMatch(/\.pdf$/);
    expect(pdfResponse.body.downloadUrl).toMatch(/\/exports\//);
    expect(pdfResponse.body.outputPath).toBeUndefined();

    const otherRegisterResponse = await request(app).post("/api/auth/register").send({
      email: "other-report@example.com",
      password: "Passw0rd!",
      displayName: "Other Report Tester",
    });

    const otherCookie = otherRegisterResponse.headers["set-cookie"];
    const forbiddenDownload = await request(app)
      .get(pdfResponse.body.downloadUrl)
      .set("Cookie", otherCookie);

    expect(forbiddenDownload.status).toBe(404);

    const pdfDownload = await request(app)
      .get(pdfResponse.body.downloadUrl)
      .set("Cookie", cookie);

    expect(pdfDownload.status).toBe(200);
    expect(pdfDownload.headers["content-type"]).toMatch(/pdf/i);
    expect(responseSize(pdfDownload)).toBeGreaterThan(500);

    const workspaceExportDir = path.join(rootDir, "data", "exports");
    const exportWorkspaces = await fs.readdir(workspaceExportDir);
    expect(exportWorkspaces.length).toBeGreaterThan(0);
  }, 15000);
});
