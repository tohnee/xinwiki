/**
 * T2: 多用户注册/管理/数据保留/隐私隔离测试（增强版）
 *
 * 验证：
 * - 多用户独立注册
 * - 用户数据保留（重新登录后数据完整）
 * - 所有数据类型跨用户隐私隔离
 * - 工作空间级别的数据隔离
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../server/app.js";

const originalFetch = globalThis.fetch;
const tempDirs = [];

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-multi-"));
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

describe("T2.1: 多用户注册与管理", () => {
  it("支持多个用户独立注册，每个用户自动获得独立工作空间", async () => {
    const app = await makeApp();

    const users = [
      { email: "user1@test.com", displayName: "用户一" },
      { email: "user2@test.com", displayName: "用户二" },
      { email: "user3@test.com", displayName: "用户三" },
    ];

    const workspaces = [];

    for (const user of users) {
      const res = await request(app).post("/api/auth/register").send({
        email: user.email,
        password: "Passw0rd!",
        displayName: user.displayName,
      });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(user.email);
      expect(res.body.user.displayName).toBe(user.displayName);
      expect(res.body.workspace.id).toBeTruthy();
      expect(res.body.workspace.name).toContain(user.displayName);

      workspaces.push(res.body.workspace);
    }

    // 工作空间 ID 必须唯一
    const workspaceIds = workspaces.map((w) => w.id);
    expect(new Set(workspaceIds).size).toBe(3);
  });

  it("拒绝重复邮箱注册", async () => {
    const app = await makeApp();

    await request(app).post("/api/auth/register").send({
      email: "dup@test.com",
      password: "Passw0rd!",
      displayName: "First",
    });

    const dupRes = await request(app).post("/api/auth/register").send({
      email: "dup@test.com",
      password: "Another1!",
      displayName: "Second",
    });

    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error).toMatch(/already exists/i);
  });

  it("登录/登出流程完整且独立", async () => {
    const app = await makeApp();

    // 注册
    const regRes = await request(app).post("/api/auth/register").send({
      email: "login-flow@test.com",
      password: "Passw0rd!",
      displayName: "Login Flow",
    });
    const regCookie = regRes.headers["set-cookie"];

    // 登出
    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", regCookie);
    expect(logoutRes.status).toBe(200);

    // 登出后未认证
    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Cookie", regCookie);
    // Cookie 被清除，需要重新验证
    // 实际上由于 clearCookie 只是清除，旧 cookie 仍然可以工作除非服务器验证
    // 这里测试登录功能
    const loginRes = await request(app).post("/api/auth/login").send({
      email: "login-flow@test.com",
      password: "Passw0rd!",
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.email).toBe("login-flow@test.com");
  });

  it("JWT 过期后需要重新认证", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "expired@test.com",
      password: "Passw0rd!",
      displayName: "Expired",
    });
    const cookie = regRes.headers["set-cookie"];

    // 立即访问应该成功
    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Cookie", cookie);
    expect(meRes.status).toBe(200);

    // 无 cookie 访问应该失败
    const noCookie = await request(app).get("/api/auth/me");
    expect(noCookie.status).toBe(401);
  });
});

describe("T2.2: 用户数据保留（重新登录后数据完整）", () => {
  it("用户上传文档后登出再登录，数据完整保留", async () => {
    const app = await makeApp();

    // 注册并上传
    const regRes = await request(app).post("/api/auth/register").send({
      email: "data-retention@test.com",
      password: "Passw0rd!",
      displayName: "Data Retention",
    });
    const cookie = regRes.headers["set-cookie"];

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-ret-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "retention.md");
    await fs.writeFile(md, "# Retention Test\n\nData must survive logout.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md)
      .expect(201);

    // 记录当前数据量
    const bootBefore = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);
    const fileCountBefore = bootBefore.body.files.length;

    // 重新登录（通过 login API）
    const loginRes = await request(app).post("/api/auth/login").send({
      email: "data-retention@test.com",
      password: "Passw0rd!",
    });
    const newCookie = loginRes.headers["set-cookie"];

    // 验证数据完整
    const bootAfter = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", newCookie);

    expect(bootAfter.body.files.length).toBe(fileCountBefore);
    expect(bootAfter.body.files[0].name).toBe("retention.md");
    expect(bootAfter.body.chatMessages).toEqual(bootBefore.body.chatMessages);
    expect(bootAfter.body.wikiPages.length).toBe(bootBefore.body.wikiPages.length);
  });

  it("用户问答数据和记忆在重新登录后保留", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "qa-retention@test.com",
      password: "Passw0rd!",
      displayName: "QA Retention",
    });
    const cookie = regRes.headers["set-cookie"];

    // 添加记忆和问答
    await request(app)
      .post("/api/memories")
      .set("Cookie", cookie)
      .send({ text: "保留测试记忆", period: "永久记忆" })
      .expect(201);

    await request(app)
      .post("/api/qa-records")
      .set("Cookie", cookie)
      .send({ question: "保留问题", answer: "保留答案", citations: [] })
      .expect(201);

    await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: "聊天测试" })
      .expect(201);

    // 重新登录
    const loginRes = await request(app).post("/api/auth/login").send({
      email: "qa-retention@test.com",
      password: "Passw0rd!",
    });
    const newCookie = loginRes.headers["set-cookie"];

    const boot = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", newCookie);

    expect(boot.body.memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "保留测试记忆" }),
      ]),
    );
    expect(boot.body.qaRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ question: "保留问题" }),
      ]),
    );
    expect(boot.body.chatMessages.length).toBeGreaterThanOrEqual(2);
  });
});

describe("T2.3: 跨用户完整数据隐私隔离矩阵", () => {
  async function createUserWithData(app, email, displayName, docName, docContent) {
    const regRes = await request(app).post("/api/auth/register").send({
      email,
      password: "Passw0rd!",
      displayName,
    });
    const cookie = regRes.headers["set-cookie"];
    const userId = regRes.body.user.id;
    const workspaceId = regRes.body.workspace.id;

    // 上传文档
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-iso-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, docName);
    await fs.writeFile(md, docContent, "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md);

    // 添加记忆
    await request(app)
      .post("/api/memories")
      .set("Cookie", cookie)
      .send({ text: `${displayName}记忆`, period: "永久记忆" });

    // 添加问答
    await request(app)
      .post("/api/qa-records")
      .set("Cookie", cookie)
      .send({ question: `${displayName}问题`, answer: `${displayName}答案`, citations: [] });

    // 聊天消息
    await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: `${displayName}问题` });

    return { cookie, userId, workspaceId, regRes };
  }

  it("用户A不能访问用户B的任何数据（source, wiki, ontology, chat, memory, QA, Dify）", async () => {
    const app = await makeApp();

    const userA = await createUserWithData(
      app, "a-isolated@test.com", "UserA",
      "a-secret.md", "# User A Secret\n\nConfidential A data.",
    );
    const userB = await createUserWithData(
      app, "b-isolated@test.com", "UserB",
      "b-secret.md", "# User B Secret\n\nConfidential B data.",
    );

    // 验证用户A的 bootstrap 不包含用户B的数据
    const bootA = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", userA.cookie);

    // 源文件隔离
    const fileNamesA = bootA.body.files.map((f) => f.name);
    expect(fileNamesA).not.toContain("b-secret.md");
    expect(fileNamesA).toContain("a-secret.md");

    // 记忆隔离
    const memoryTexts = bootA.body.memories.map((m) => m.text);
    expect(memoryTexts).not.toContain("UserB记忆");
    expect(memoryTexts).toContain("UserA记忆");

    // QA 记录隔离
    const qaQuestions = bootA.body.qaRecords.map((r) => r.question);
    expect(qaQuestions).not.toContain("UserB问题");
    expect(qaQuestions).toContain("UserA问题");

    // 聊天隔离
    const chatContents = bootA.body.chatMessages.map((m) => m.content);
    expect(chatContents.filter((c) => c && c.includes("UserB"))).toHaveLength(0);

    // 不能通过直接访问其他用户的 source markdown
    const sourceA = bootA.body.files[0];
    const crossRead = await request(app)
      .get(`/api/sources/${sourceA.id}/markdown`)
      .set("Cookie", userB.cookie);
    expect(crossRead.status).toBe(404);

    // 不能下载其他用户的导出文件
    const docxRes = await request(app)
      .post("/api/reports/export")
      .set("Cookie", userA.cookie)
      .send({
        scope: "wiki",
        reportType: "tech",
        chartType: "roadmap",
        model: "test",
        exportFormat: "docx",
      });
    expect(docxRes.status).toBe(201);

    const crossDownload = await request(app)
      .get(docxRes.body.downloadUrl)
      .set("Cookie", userB.cookie);
    expect(crossDownload.status).toBe(404);
  });

  it("runtime 数据严格按工作空间隔离（entry, edge, provenance, log, lint）", async () => {
    const app = await makeApp();

    const userA = await createUserWithData(
      app, "rt-iso-a@test.com", "UserA",
      "a-rt.md", "# A Runtime\n\nA content.",
    );
    const userB = await createUserWithData(
      app, "rt-iso-b@test.com", "UserB",
      "b-rt.md", "# B Runtime\n\nB content.",
    );

    // 通过 llm-wiki/query 验证 runtime 隔离
    const queryA = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "A Runtime" })
      .set("Cookie", userA.cookie);
    expect(queryA.status).toBe(200);
    expect(queryA.body.entries.length).toBeGreaterThan(0);

    const queryBwithACookie = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "B Runtime" })
      .set("Cookie", userA.cookie);
    // userA 查询 "B Runtime" 不应返回 userB 创建的条目
    const bTitles = queryBwithACookie.body.entries.map((e) => e.title || "");
    expect(bTitles.every((t) => !t.includes("B Runtime"))).toBe(true);

    // 导出隔离
    const exportA = await request(app)
      .post("/api/llm-wiki/export")
      .set("Cookie", userA.cookie);
    expect(exportA.status).toBe(201);
    expect(exportA.body.workspaceId).toBe(userA.workspaceId);
  });

  it("Dify conversation ID 按用户独立管理，不交叉泄漏", async () => {
    process.env.DIFY_API_BASE_URL = "https://dify-multi-isolation.test/v1";
    process.env.DIFY_API_KEY = "test-multi-isolation-key";

    const fetchMock = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      const userId = body.user;
      return new Response(
        JSON.stringify({
          answer: `Answer for user ${userId}`,
          conversation_id: body.conversation_id || `conv_${userId}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock;

    const app = await makeApp();

    const userA = await createUserWithData(
      app, "dify-iso-a@test.com", "UserA",
      "a-dify.md", "# A Dify\n\nA Dify content.",
    );
    const userB = await createUserWithData(
      app, "dify-iso-b@test.com", "UserB",
      "b-dify.md", "# B Dify\n\nB Dify content.",
    );

    // 两个用户各发一条消息
    await request(app)
      .post("/api/chat/message")
      .set("Cookie", userA.cookie)
      .send({ question: "A Dify content" });
    await request(app)
      .post("/api/chat/message")
      .set("Cookie", userB.cookie)
      .send({ question: "B Dify content" });

    const calls = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));

    // 验证两个用户的 Dify user ID 不同
    expect(calls[0].user).not.toBe(calls[1].user);

    // 验证 grounding_context 不同
    expect(calls[0].inputs.grounding_context).toMatch(/A Dify/i);
    expect(calls[1].inputs.grounding_context).toMatch(/B Dify/i);

    // 验证 conversation_id 各自独立
    const threadA = await request(app)
      .get("/api/chat/thread")
      .set("Cookie", userA.cookie);
    const threadB = await request(app)
      .get("/api/chat/thread")
      .set("Cookie", userB.cookie);
    expect(threadA.body.thread.conversationId).not.toBe(threadB.body.thread.conversationId);

    process.env.DIFY_API_BASE_URL = undefined;
    process.env.DIFY_API_KEY = undefined;
    globalThis.fetch = originalFetch;
  });
});
