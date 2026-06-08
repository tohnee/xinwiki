import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../server/app.js";

const tempDirs = [];
const originalFetch = globalThis.fetch;
const originalDifyBaseUrl = process.env.DIFY_API_BASE_URL;
const originalDifyApiKey = process.env.DIFY_API_KEY;

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-chat-"));
  tempDirs.push(rootDir);

  const app = await createApp({
    dataDir: path.join(rootDir, "data"),
    uploadsDir: path.join(rootDir, "uploads"),
    llmWikiDir: path.join(rootDir, "llm-wiki"),
    jwtSecret: "test-secret",
  });

  return app;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env.DIFY_API_BASE_URL = originalDifyBaseUrl;
  process.env.DIFY_API_KEY = originalDifyApiKey;
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("chat APIs", () => {
  it("restores the latest chat thread and messages through API and bootstrap", async () => {
    const app = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "chat@example.com",
      password: "Passw0rd!",
      displayName: "Chat Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const threadResponse = await request(app)
      .get("/api/chat/thread")
      .set("Cookie", cookie);

    expect(threadResponse.status).toBe(200);
    expect(threadResponse.body.thread.id).toBeTruthy();

    const askResponse = await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: "CoWoS 产能" });

    expect(askResponse.status).toBe(201);
    expect(askResponse.body.messages).toHaveLength(2);

    const messagesResponse = await request(app)
      .get("/api/chat/messages")
      .set("Cookie", cookie);

    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.thread.id).toBe(threadResponse.body.thread.id);
    expect(messagesResponse.body.messages).toHaveLength(2);
    expect(messagesResponse.body.messages[0].role).toBe("user");
    expect(messagesResponse.body.messages[1].role).toBe("assistant");

    const bootstrapResponse = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.body.chatThread.id).toBe(threadResponse.body.thread.id);
    expect(bootstrapResponse.body.chatMessages).toHaveLength(2);
  });

  it("refuses finance forecast questions without runtime evidence before calling dify", async () => {
    const app = await makeApp();

    process.env.DIFY_API_BASE_URL = "https://dify.example.test/v1";
    process.env.DIFY_API_KEY = "test-key";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answer: "This should not be used.",
          conversation_id: "conv_demo",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ));
    globalThis.fetch = fetchMock;

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "grounded@example.com",
      password: "Passw0rd!",
      displayName: "Grounded Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const askResponse = await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: "台积电 2026 年营收预测" });

    expect(askResponse.status).toBe(201);
    expect(askResponse.body.answer).toMatch(/拒绝|没有足够证据|无法回答/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(askResponse.body.messages[1].content).toMatch(/拒绝|没有足够证据|无法回答/);
  });

  it("answers finance forecast questions when runtime evidence exists", async () => {
    const app = await makeApp();
    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-finance-runtime-"));
    tempDirs.push(uploadDir);

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "finance-runtime@example.com",
      password: "Passw0rd!",
      displayName: "Finance Runtime",
    });
    const cookie = registerResponse.headers["set-cookie"];

    const markdownPath = path.join(uploadDir, "tsmc-forecast.md");
    await fs.writeFile(
      markdownPath,
      [
        "# 台积电 2026 年营收预测",
        "",
        "根据当前工作空间文档，台积电 2026 年营收预测为 1.2 万亿元新台币。",
        "",
        "## Basis",
        "",
        "- 预测基于先进封装与 AI 需求增长。",
      ].join("\n"),
      "utf8",
    );

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", markdownPath)
      .expect(201);

    const askResponse = await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: "台积电 2026 年营收预测" });

    expect(askResponse.status).toBe(201);
    expect(askResponse.body.answer).toMatch(/台积电|1\.2 万亿元|营收预测/);
    expect(askResponse.body.citations.join(" ")).toMatch(/page:台积电 2026 年营收预测/i);
  });

  it("keeps chat and memory data isolated between different users", async () => {
    const app = await makeApp();

    const ownerRegister = await request(app).post("/api/auth/register").send({
      email: "owner-chat@example.com",
      password: "Passw0rd!",
      displayName: "Owner Chat",
    });
    const ownerCookie = ownerRegister.headers["set-cookie"];

    const otherRegister = await request(app).post("/api/auth/register").send({
      email: "other-chat@example.com",
      password: "Passw0rd!",
      displayName: "Other Chat",
    });
    const otherCookie = otherRegister.headers["set-cookie"];

    await request(app)
      .post("/api/memories")
      .set("Cookie", ownerCookie)
      .send({ text: "客户 A 内部代号是 Project Aurora", period: "季度记忆" })
      .expect(201);

    await request(app)
      .post("/api/chat/message")
      .set("Cookie", ownerCookie)
      .send({ question: "CoWoS 产能" })
      .expect(201);

    const otherBootstrap = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", otherCookie);

    expect(otherBootstrap.status).toBe(200);
    expect(otherBootstrap.body.memories).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Project Aurora"),
        }),
      ]),
    );
    expect(otherBootstrap.body.chatMessages).toEqual([]);
  });

  it("answers from QA and memory notes after they are synced into runtime", async () => {
    const app = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "memory-grounding@example.com",
      password: "Passw0rd!",
      displayName: "Memory Grounding",
    });
    const cookie = registerResponse.headers["set-cookie"];

    await request(app)
      .post("/api/memories")
      .set("Cookie", cookie)
      .send({
        text: "Project Aurora 是客户 A 在 2026 年的内部采购代号。",
        period: "年度记忆",
      })
      .expect(201);

    await request(app)
      .post("/api/qa-records")
      .set("Cookie", cookie)
      .send({
        question: "客户 A 的内部采购代号是什么？",
        answer: "Project Aurora",
        citations: ["memory:Project Aurora"],
      })
      .expect(201);

    const askResponse = await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: "客户 A 的内部采购代号是什么？" });

    expect(askResponse.status).toBe(201);
    expect(askResponse.body.answer).toMatch(/Project Aurora|内部采购代号|runtime/);
    expect(askResponse.body.citations).toEqual(
      expect.arrayContaining([expect.stringMatching(/qa-note|memory-note/)]),
    );
  });

  it("serves query and chat from the same runtime retrieval path", async () => {
    const app = await makeApp();
    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-runtime-query-"));
    tempDirs.push(uploadDir);

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "runtime-query@example.com",
      password: "Passw0rd!",
      displayName: "Runtime Query",
    });
    const cookie = registerResponse.headers["set-cookie"];

    const markdownPath = path.join(uploadDir, "aurora.md");
    await fs.writeFile(
      markdownPath,
      [
        "# Project Aurora",
        "",
        "Project Aurora 是客户 A 采购代号。",
        "",
        "## Context",
        "",
        "- 客户 A 在 2026 年启动采购计划。",
      ].join("\n"),
      "utf8",
    );

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", markdownPath)
      .expect(201);

    const queryResponse = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "客户 A 采购代号" })
      .set("Cookie", cookie);

    const chatResponse = await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: "客户 A 采购代号是什么？" });

    expect(queryResponse.status).toBe(200);
    expect(queryResponse.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "page",
          title: "Project Aurora",
          excerpt: expect.stringMatching(/客户 A 采购代号/i),
        }),
      ]),
    );
    expect(queryResponse.body.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mentions",
        }),
      ]),
    );

    expect(chatResponse.status).toBe(201);
    expect(chatResponse.body.answer).toMatch(/Project Aurora/);
    expect(chatResponse.body.citations.join(" ")).toMatch(/page:Project Aurora/i);
  });

  it("passes AbortSignal to fetch when calling Dify", async () => {
    process.env.DIFY_API_BASE_URL = "https://dify-signal.example.test/v1";
    process.env.DIFY_API_KEY = "test-signal-key";
    process.env.DIFY_TIMEOUT_MS = "5000";

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answer: "Dify answer with signal.",
          conversation_id: "conv_signal",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ));
    globalThis.fetch = fetchMock;

    const app = await makeApp();
    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-signal-"));
    tempDirs.push(uploadDir);

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "signal@example.com",
      password: "Passw0rd!",
      displayName: "Signal Tester",
    });
    const cookie = registerResponse.headers["set-cookie"];

    const markdownPath = path.join(uploadDir, "signal-doc.md");
    await fs.writeFile(
      markdownPath,
      "# Signal Test\n\n文档中包含测试数据。\n",
      "utf8",
    );

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", markdownPath)
      .expect(201);

    await request(app)
      .post("/api/chat/message")
      .set("Cookie", cookie)
      .send({ question: "测试数据" });

    const difyCall = fetchMock.mock.calls.find(
      (call) => call[0]?.includes?.("chat-messages"),
    );
    expect(difyCall).toBeTruthy();
    expect(difyCall[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("chat stream", () => {
  it("calls dify with streaming mode and persists the answer", async () => {
    process.env.DIFY_API_BASE_URL = "https://dify-stream.example.test/v1";
    process.env.DIFY_API_KEY = "test-stream-key";

    const sseChunks = [
      'data: {"event":"agent_message","conversation_id":"conv_stream","message_id":"msg_stream","answer":"台积电"}\n\n',
      'data: {"event":"message_end","conversation_id":"conv_stream","message_id":"msg_stream","answer":"台积电 2026 年营收预测为 1.2 万亿元。"}\n\n',
    ];

    const fetchMock = vi.fn(async () => {
      const encoder = new TextEncoder();
      let chunkIndex = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          if (chunkIndex < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[chunkIndex]));
            chunkIndex++;
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    globalThis.fetch = fetchMock;

    const app = await makeApp();
    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-stream-"));
    tempDirs.push(uploadDir);

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "stream@example.com",
      password: "Passw0rd!",
      displayName: "Stream Tester",
    });
    const cookie = registerResponse.headers["set-cookie"];

    const markdownPath = path.join(uploadDir, "tsmc-stream.md");
    await fs.writeFile(
      markdownPath,
      "# 台积电 2026 年营收预测\n\n台积电 2026 年营收预测为 1.2 万亿元。\n",
      "utf8",
    );

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", markdownPath)
      .expect(201);

    // 用 supertest 调流式端点
    const streamResponse = await request(app)
      .post("/api/chat/message/stream")
      .set("Cookie", cookie)
      .send({ question: "台积电 2026 年营收预测" });

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers["content-type"]).toContain("text/event-stream");

    // 验证 Dify 以 streaming 模式被调用
    const difyCall = fetchMock.mock.calls.find(
      (call) => call[0]?.includes?.("chat-messages"),
    );
    expect(difyCall).toBeTruthy();
    const difyBody = JSON.parse(difyCall[1].body);
    expect(difyBody.response_mode).toBe("streaming");
    expect(difyCall[1].signal).toBeInstanceOf(AbortSignal);

    // 验证消息持久化 (通过 messages API)
    const messagesResponse = await request(app)
      .get("/api/chat/messages")
      .set("Cookie", cookie);

    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.messages).toHaveLength(2);
    expect(messagesResponse.body.messages[1].content).toContain("台积电");
  });

  it("refuses finance forecast without runtime evidence in streaming mode too", async () => {
    process.env.DIFY_API_BASE_URL = "https://dify-stream-refuse.example.test/v1";
    process.env.DIFY_API_KEY = "test-refuse-key";

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ answer: "Should not be reached." }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ));
    globalThis.fetch = fetchMock;

    const app = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "stream-refuse@example.com",
      password: "Passw0rd!",
      displayName: "Stream Refuse",
    });
    const cookie = registerResponse.headers["set-cookie"];

    const streamResponse = await request(app)
      .post("/api/chat/message/stream")
      .set("Cookie", cookie)
      .send({ question: "台积电 2026 年营收预测" });

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers["content-type"]).toContain("text/event-stream");

    // 不应调用 Dify（grounded check 先拦截）
    const difyCall = fetchMock.mock.calls.find(
      (call) => call[0]?.includes?.("chat-messages"),
    );
    expect(difyCall).toBeFalsy();

    // 验证拒答消息持久化
    const messagesResponse = await request(app)
      .get("/api/chat/messages")
      .set("Cookie", cookie);

    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.messages).toHaveLength(2);
    expect(messagesResponse.body.messages[1].content).toMatch(/拒绝|没有足够证据|无法回答/);
  });
});

describe("Dify conversation isolation", () => {
  it("stores and reuses one Dify conversation id per authenticated user's workspace", async () => {
    process.env.DIFY_API_BASE_URL = "https://dify-isolation.example.test/v1";
    process.env.DIFY_API_KEY = "test-isolation-key";

    const fetchMock = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      const suffix = /Owner Evidence|owner isolated/i.test(body.inputs.grounding_context) ? "owner" : "other";
      return new Response(
        JSON.stringify({
          answer: `Dify answer for ${suffix}`,
          conversation_id: body.conversation_id || `conv_${suffix}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock;

    const app = await makeApp();
    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-dify-isolation-"));
    tempDirs.push(uploadDir);

    const ownerRegister = await request(app).post("/api/auth/register").send({
      email: "owner-dify@example.com",
      password: "Passw0rd!",
      displayName: "owner dify",
    });
    const ownerCookie = ownerRegister.headers["set-cookie"];

    const otherRegister = await request(app).post("/api/auth/register").send({
      email: "other-dify@example.com",
      password: "Passw0rd!",
      displayName: "other dify",
    });
    const otherCookie = otherRegister.headers["set-cookie"];

    const ownerDoc = path.join(uploadDir, "owner-evidence.md");
    const otherDoc = path.join(uploadDir, "other-evidence.md");
    await fs.writeFile(ownerDoc, "# Owner Evidence\n\nowner isolated runtime evidence.", "utf8");
    await fs.writeFile(otherDoc, "# Other Evidence\n\nother isolated runtime evidence.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", ownerCookie)
      .attach("files", ownerDoc)
      .expect(201);
    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", otherCookie)
      .attach("files", otherDoc)
      .expect(201);

    await request(app)
      .post("/api/chat/message")
      .set("Cookie", ownerCookie)
      .send({ question: "owner isolated runtime evidence" })
      .expect(201);
    await request(app)
      .post("/api/chat/message")
      .set("Cookie", otherCookie)
      .send({ question: "other isolated runtime evidence" })
      .expect(201);
    await request(app)
      .post("/api/chat/message")
      .set("Cookie", ownerCookie)
      .send({ question: "owner isolated runtime evidence" })
      .expect(201);

    const bodies = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies).toHaveLength(3);
    expect(bodies[0].conversation_id).toBeUndefined();
    expect(bodies[1].conversation_id).toBeUndefined();
    expect(bodies[2].conversation_id).toBe("conv_owner");
    expect(bodies[0].user).not.toBe(bodies[1].user);
    expect(bodies[0].inputs.grounding_context).toMatch(/Owner Evidence|owner isolated/i);
    expect(bodies[1].inputs.grounding_context).toMatch(/Other Evidence|other isolated/i);

    const ownerThread = await request(app).get("/api/chat/thread").set("Cookie", ownerCookie);
    const otherThread = await request(app).get("/api/chat/thread").set("Cookie", otherCookie);
    expect(ownerThread.body.thread.conversationId).toBe("conv_owner");
    expect(otherThread.body.thread.conversationId).toBe("conv_other");
  });
});
