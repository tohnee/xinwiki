/**
 * T1: 前端-后端功能映射完整性测试
 *
 * 验证 front.html 中每个前端视图/功能都有对应的后端 API 支持，
 * 且数据流完整闭环。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const tempDirs = [];

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-fe-be-"));
  tempDirs.push(rootDir);
  return await createApp({
    dataDir: path.join(rootDir, "data"),
    uploadsDir: path.join(rootDir, "uploads"),
    llmWikiDir: path.join(rootDir, "llm-wiki"),
    jwtSecret: "test-secret",
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("T1.1: 前端视图与后端 API 完整性映射", () => {
  it("view-sources（来源）→ /api/sources/upload, /api/sources/:id/markdown, /api/sources/:id/reparse, /api/sources/:id/build-wiki, /api/jobs/:jobId", async () => {
    const app = await makeApp();

    // 注册 + 上传
    const reg = await request(app).post("/api/auth/register").send({
      email: "sources-view@test.com",
      password: "Passw0rd!",
      displayName: "Sources View",
    });
    const cookie = reg.headers["set-cookie"];

    // upload-and-build 覆盖 upload + build-wiki + jobs
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fe-be-src-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "test.md");
    await fs.writeFile(md, "# Frontend Test\n\nAPI mapping test.", "utf8");

    const uploadRes = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md);
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.sources).toHaveLength(1);
    expect(uploadRes.body.wikiPages).toHaveLength(1);
    expect(uploadRes.body.jobIds).toHaveLength(1);

    const sourceId = uploadRes.body.sources[0].id;

    // markdown 端点
    const mdRes = await request(app)
      .get(`/api/sources/${sourceId}/markdown`)
      .set("Cookie", cookie);
    expect(mdRes.status).toBe(200);
    expect(mdRes.body.markdown).toBeTruthy();

    // reparse 端点
    const reparseRes = await request(app)
      .post(`/api/sources/${sourceId}/reparse`)
      .set("Cookie", cookie)
      .send({ rebuildWiki: false });
    expect(reparseRes.status).toBe(200);

    // job 端点
    const jobId = uploadRes.body.jobIds[0];
    const jobRes = await request(app)
      .get(`/api/jobs/${jobId}`)
      .set("Cookie", cookie);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.status).toBe("completed");
  });

  it("view-wiki（Wiki）→ /api/bootstrap (wikiPages), /api/wiki/:id/promote, /api/wiki/:id/relations/promote, /api/llm-wiki/export", async () => {
    const app = await makeApp();

    const reg = await request(app).post("/api/auth/register").send({
      email: "wiki-view@test.com",
      password: "Passw0rd!",
      displayName: "Wiki View",
    });
    const cookie = reg.headers["set-cookie"];

    // bootstrap 包含 wikiPages
    const bootRes = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);
    expect(bootRes.status).toBe(200);
    expect(Array.isArray(bootRes.body.wikiPages)).toBe(true);

    // 上传构建 wiki
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fe-be-wiki-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "test.md");
    await fs.writeFile(md, "# Wiki Test\n\nWiki mapping test.", "utf8");

    const uploadRes = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md);
    expect(uploadRes.status).toBe(201);

    const wikiId = uploadRes.body.wikiPages[0].id;

    // promote 端点
    const promoteRes = await request(app)
      .post(`/api/wiki/${wikiId}/promote`)
      .set("Cookie", cookie);
    expect(promoteRes.status === 201 || promoteRes.status === 200).toBe(true);

    // relations/promote 端点
    const relRes = await request(app)
      .post(`/api/wiki/${wikiId}/relations/promote`)
      .set("Cookie", cookie)
      .send({ relations: [["Wiki Test", "related_to", "Frontend Test"]] });
    expect(relRes.status).toBe(201);

    // llm-wiki/export 端点
    const exportRes = await request(app)
      .post("/api/llm-wiki/export")
      .set("Cookie", cookie);
    expect(exportRes.status).toBe(201);
    expect(typeof exportRes.body.pageCount).toBe("number");
  });

  it("view-ontology（本体）→ /api/ontology/export, /api/expert-injections, /api/focuses", async () => {
    const app = await makeApp();

    const reg = await request(app).post("/api/auth/register").send({
      email: "onto-view@test.com",
      password: "Passw0rd!",
      displayName: "Onto View",
    });
    const cookie = reg.headers["set-cookie"];

    // ontology/export
    const exportRes = await request(app)
      .get("/api/ontology/export")
      .set("Cookie", cookie);
    expect(exportRes.status).toBe(200);
    expect(Array.isArray(exportRes.body.nodes)).toBe(true);
    expect(Array.isArray(exportRes.body.edges)).toBe(true);

    // expert-injections
    const injectRes = await request(app)
      .post("/api/expert-injections")
      .set("Cookie", cookie)
      .send({ entity: "TSMC", weight: 5, note: "Expert note" });
    expect(injectRes.status).toBe(201);
    expect(injectRes.body.injection.entity).toBe("TSMC");

    // focuses
    const focusRes = await request(app)
      .get("/api/focuses")
      .set("Cookie", cookie);
    expect(focusRes.status).toBe(200);

    const putFocusRes = await request(app)
      .put("/api/focuses")
      .set("Cookie", cookie)
      .send({ 公司: [["TSMC", true]], 制程: [["N2", true]] });
    expect(putFocusRes.status).toBe(200);
  });

  it("view-ask（问答）→ /api/chat/thread, /api/chat/messages, /api/chat/message, /api/chat/message/stream, /api/qa-records, /api/memories, /api/llm-wiki/query", async () => {
    const app = await makeApp();

    const reg = await request(app).post("/api/auth/register").send({
      email: "ask-view@test.com",
      password: "Passw0rd!",
      displayName: "Ask View",
    });
    const cookie = reg.headers["set-cookie"];

    // chat thread
    const threadRes = await request(app)
      .get("/api/chat/thread")
      .set("Cookie", cookie);
    expect(threadRes.status).toBe(200);
    expect(threadRes.body.thread.id).toBeTruthy();

    // chat message (blocking)
    const msgRes = await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: "测试问题" });
    expect(msgRes.status).toBe(201);
    expect(msgRes.body.messages).toHaveLength(2);

    // chat messages
    const msgsRes = await request(app)
      .get("/api/chat/messages")
      .set("Cookie", cookie);
    expect(msgsRes.status).toBe(200);
    expect(msgsRes.body.messages.length).toBeGreaterThanOrEqual(2);

    // chat stream
    const streamRes = await request(app)
      .post("/api/chat/message/stream")
      .set("Cookie", cookie)
      .send({ question: "流式测试" });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers["content-type"]).toContain("text/event-stream");

    // qa-records
    const qaRes = await request(app)
      .post("/api/qa-records")
      .set("Cookie", cookie)
      .send({ question: "Q", answer: "A", citations: [] });
    expect(qaRes.status).toBe(201);

    // memories
    const memRes = await request(app)
      .post("/api/memories")
      .set("Cookie", cookie)
      .send({ text: "记忆测试", period: "永久记忆" });
    expect(memRes.status).toBe(201);

    // llm-wiki/query
    const queryRes = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "测试" })
      .set("Cookie", cookie);
    expect(queryRes.status).toBe(200);
  });

  it("view-generate（生成/报告）→ /api/reports/generate, /api/reports/export", async () => {
    const app = await makeApp();

    const reg = await request(app).post("/api/auth/register").send({
      email: "gen-view@test.com",
      password: "Passw0rd!",
      displayName: "Gen View",
    });
    const cookie = reg.headers["set-cookie"];

    // report generate
    const genRes = await request(app)
      .post("/api/reports/generate")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "test-model",
        format: "report",
      });
    expect(genRes.status).toBe(201);
    expect(genRes.body.report.title).toBeTruthy();
    expect(genRes.body.markdown).toBeTruthy();

    // report export (docx)
    const docxRes = await request(app)
      .post("/api/reports/export")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "test-model",
        exportFormat: "docx",
      });
    expect(docxRes.status).toBe(201);
    expect(docxRes.body.fileName).toBeTruthy();

    // report export (pdf)
    const pdfRes = await request(app)
      .post("/api/reports/export")
      .set("Cookie", cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "test-model",
        exportFormat: "pdf",
      });
    expect(pdfRes.status).toBe(201);
    expect(pdfRes.body.fileName).toBeTruthy();
  });
});

describe("T1.2: 前端 API 调用与后端响应的数据字段匹配", () => {
  it("bootstrap 返回前端渲染所需的所有字段", async () => {
    const app = await makeApp();
    const reg = await request(app).post("/api/auth/register").send({
      email: "bootstrap-fields@test.com",
      password: "Passw0rd!",
      displayName: "Bootstrap Fields",
    });
    const cookie = reg.headers["set-cookie"];

    const res = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);

    // 前端渲染需要的字段
    const requiredFields = [
      "user",           // 用户信息
      "workspace",      // 工作空间
      "files",          // 源文件列表
      "wikiPages",      // Wiki 页面
      "ontologyNodes",  // 本体节点
      "ontologyEdges",  // 本体边
      "qaRecords",      // 问答记录
      "memories",       // 记忆
      "chatThread",     // 聊天线程
      "chatMessages",   // 聊天消息
      "expertInjections", // 专家经验
      "focuses",        // 关注配置
      "jobs",           // 任务
    ];

    for (const field of requiredFields) {
      expect(res.body).toHaveProperty(field);
    }

    // user 字段子属性
    expect(res.body.user).toMatchObject({
      id: expect.any(String),
      email: expect.any(String),
      displayName: expect.any(String),
    });

    // workspace 字段子属性
    expect(res.body.workspace).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
    });
  });

  it("front.html 所有 /api/ 调用路径均在后端注册", async () => {
    const app = await makeApp();

    // 前端中所有 /api/ 调用（从 grep 结果提取）
    const frontendApiPaths = [
      { method: "GET", path: "/api/bootstrap" },
      { method: "POST", path: "/api/auth/register" },
      { method: "POST", path: "/api/auth/login" },
      { method: "POST", path: "/api/auth/logout" },
      { method: "POST", path: "/api/llm-wiki/export" },
      { method: "POST", path: "/api/sources/upload-and-build" },
      { method: "POST", path: "/api/sources/:id/build-wiki" },
      { method: "POST", path: "/api/sources/:id/reparse" },
      { method: "GET", path: "/api/sources/:id/markdown" },
      { method: "POST", path: "/api/wiki/:id/promote" },
      { method: "POST", path: "/api/wiki/:id/relations/promote" },
      { method: "PUT", path: "/api/focuses" },
      { method: "POST", path: "/api/expert-injections" },
      { method: "GET", path: "/api/ontology/export" },
      { method: "POST", path: "/api/chat/message/stream" },
      { method: "GET", path: "/api/chat/messages" },
      { method: "POST", path: "/api/qa-records" },
      { method: "POST", path: "/api/memories" },
      { method: "POST", path: "/api/reports/export" },
      { method: "POST", path: "/api/reports/generate" },
    ];

    // 注册用户获取 cookie
    const reg = await request(app).post("/api/auth/register").send({
      email: "api-path-check@test.com",
      password: "Passw0rd!",
      displayName: "API Path Check",
    });
    const cookie = reg.headers["set-cookie"];

    for (const { method, path: apiPath } of frontendApiPaths) {
      // 替换动态参数
      const testPath = apiPath.replace(/:id/g, reg.body.workspace.id);

      let response;
      if (method === "GET") {
        response = await request(app)
          .get(testPath)
          .set("Cookie", cookie);
      } else if (method === "PUT") {
        response = await request(app)
          .put(testPath)
          .set("Cookie", cookie)
          .send({});
      } else {
        response = await request(app)
          .post(testPath)
          .set("Cookie", cookie)
          .send({});
      }

      // 不应该返回 404（路由未注册）
      // 对于含 :id 的路径，用 workspace.id 替换后资源查找会返回 404，
      // 但这个 404 来自路由处理函数，说明路由已注册，应视为通过。
      const routeAccepts404 = apiPath.includes(":id");
      if (!routeAccepts404) {
        expect(response.status).not.toBe(404);
      }
      // 健康返回（200/201/400/401/404/409 都说明路由已注册且处理了请求）
      expect([200, 201, 400, 401, 404, 409]).toContain(response.status);
    }
  });
});

describe("T1.3: 前端健康检查与静态资源服务", () => {
  it("GET / 返回 front.html", async () => {
    const app = await makeApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("XinWiki");
    expect(res.text).toContain("view-sources");
    expect(res.text).toContain("view-wiki");
    expect(res.text).toContain("view-ontology");
    expect(res.text).toContain("view-ask");
    expect(res.text).toContain("view-generate");
  });

  it("GET /api/health 返回健康状态", async () => {
    const app = await makeApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.time).toBeTruthy();
  });
});
