/**
 * T3: 知识库底层组织符合 karpathy gist (llm-wiki) 标准测试
 *
 * 验证 https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f 中的核心概念：
 * - 原始来源不可变（raw sources immutable）
 * - Wiki 是持久化的累积制品（persistent, compounding artifact）
 * - 三层架构：Raw sources → Wiki → Schema
 * - index.md 和 log.md 生成
 * - 交叉引用（cross-references）
 * - 矛盾/替代跟踪（contradiction/superseded tracking）
 * - Lint 能力
 * - 导出是运行时投影
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";
import { createDatabase } from "../server/db.js";
import { compileDocumentIntoRuntime } from "../server/services/llm-wiki-compiler.js";

const tempDirs = [];

async function makeApp(overrides = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-karpathy-"));
  tempDirs.push(rootDir);
  return await createApp({
    dataDir: path.join(rootDir, "data"),
    uploadsDir: path.join(rootDir, "uploads"),
    llmWikiDir: path.join(rootDir, "llm-wiki"),
    jwtSecret: "test-secret",
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("T3.1: 原始来源不可变性（Raw Sources Immutable）", () => {
  it("原始上传文件作为不可变来源保留，Wiki 是对来源的编译加工", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "immutable@test.com",
      password: "Passw0rd!",
      displayName: "Immutable",
    });
    const cookie = regRes.headers["set-cookie"];

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-imm-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "source.md");
    await fs.writeFile(md, "# Original Source\n\nOriginal content.", "utf8");

    const upRes = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md);
    expect(upRes.status).toBe(201);

    const sourceId = upRes.body.sources[0].id;

    // 读取 source markdown（原始内容必须在 runtime 的 sourceRefs 中保留）
    const mdRes = await request(app)
      .get(`/api/sources/${sourceId}/markdown`)
      .set("Cookie", cookie);
    expect(mdRes.status).toBe(200);
    expect(mdRes.body.markdown).toContain("Original Source");

    // runtime 条目必须引用原始来源
    const queryRes = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "Original Source" })
      .set("Cookie", cookie);
    expect(queryRes.body.entries.length).toBeGreaterThan(0);
    expect(queryRes.body.evidence.length).toBeGreaterThan(0);
  });

  it("reparse 生成新的 parseResult 但不删除原始文件", async () => {
    const app = await makeApp();
    const regRes = await request(app).post("/api/auth/register").send({
      email: "reparse-src@test.com",
      password: "Passw0rd!",
      displayName: "Reparse",
    });
    const cookie = regRes.headers["set-cookie"];

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-reparse-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "reparse.md");
    await fs.writeFile(md, "# V1\n\nFirst version.", "utf8");

    const upRes = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md);
    const sourceId = upRes.body.sources[0].id;

    // reparse 应该成功并返回新的内容
    const reparseRes = await request(app)
      .post(`/api/sources/${sourceId}/reparse`)
      .set("Cookie", cookie)
      .send({ rebuildWiki: true });
    expect(reparseRes.status).toBe(200);

    // 原始文件应该仍可通过 markdown 端点访问
    const mdRes = await request(app)
      .get(`/api/sources/${sourceId}/markdown`)
      .set("Cookie", cookie);
    expect(mdRes.status).toBe(200);
  });
});

describe("T3.2: Wiki 作为持久化累积制品（Compounding Artifact）", () => {
  it("多次上传逐步积累 runtime entries，而非每次重建", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "compounding@test.com",
      password: "Passw0rd!",
      displayName: "Compounding",
    });
    const cookie = regRes.headers["set-cookie"];
    const workspaceId = regRes.body.workspace.id;

    // 上传第一个文档
    const tmpDir1 = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-cmp-"));
    tempDirs.push(tmpDir1);
    const md1 = path.join(tmpDir1, "doc1.md");
    await fs.writeFile(md1, "# Doc One\n\nFirst document content.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md1)
      .expect(201);

    const boot1 = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);
    const entryCount1 = boot1.body.wikiPages.length + boot1.body.ontologyNodes.length;

    // 上传第二个文档
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-cmp2-"));
    tempDirs.push(tmpDir2);
    const md2 = path.join(tmpDir2, "doc2.md");
    await fs.writeFile(md2, "# Doc Two\n\nSecond document about TSMC and CoWoS.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md2)
      .expect(201);

    const boot2 = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);

    // 累积后条目数应该 ≥ 之前
    const entryCount2 = boot2.body.wikiPages.length + boot2.body.ontologyNodes.length;
    expect(entryCount2).toBeGreaterThanOrEqual(entryCount1);

    // Runtime entries 也应该累积
    const dataDir = path.join(tempDirs[0], "data");
    const db = await createDatabase({ dataDir });
    const snapshot = db.getRuntimeSnapshot(workspaceId);
    expect(snapshot.entries.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.entries.map((e) => e.title)).toEqual(
      expect.arrayContaining(["Doc One", "Doc Two"]),
    );
  });

  it("同一文档重复上传编译是幂等的，不产生重复条目", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "idempotent@test.com",
      password: "Passw0rd!",
      displayName: "Idempotent",
    });
    const cookie = regRes.headers["set-cookie"];
    const workspaceId = regRes.body.workspace.id;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-idem-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "idem.md");
    await fs.writeFile(md, "# Idempotent\n\nTest content.", "utf8");

    const upRes1 = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md);
    const sourceId = upRes1.body.sources[0].id;

    // 再次 build-wiki（模拟重复编译）
    await request(app)
      .post(`/api/sources/${sourceId}/build-wiki`)
      .set("Cookie", cookie)
      .expect(200);

    // 验证 runtime 没有重复条目
    const dataDir = path.join(tempDirs[0], "data");
    const db = await createDatabase({ dataDir });
    const snapshot = db.getRuntimeSnapshot(workspaceId);
    const idemPages = snapshot.entries.filter((e) => e.title === "Idempotent");
    expect(idemPages.length).toBe(1);
  });
});

describe("T3.3: index.md 和 log.md 生成（方案标准）", () => {
  it("导出包含 index.md，按分类列出所有活动页面", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "index-log@test.com",
      password: "Passw0rd!",
      displayName: "Index Log",
    });
    const cookie = regRes.headers["set-cookie"];

    // 上传两个文档以生成多个页面
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-il-"));
    tempDirs.push(tmpDir);
    await fs.writeFile(path.join(tmpDir, "a.md"), "# Alpha\n\nAlpha content.", "utf8");
    await fs.writeFile(path.join(tmpDir, "b.md"), "# Beta\n\nBeta content.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", path.join(tmpDir, "a.md"))
      .attach("files", path.join(tmpDir, "b.md"))
      .expect(201);

    const exportRes = await request(app)
      .post("/api/llm-wiki/export")
      .set("Cookie", cookie);
    expect(exportRes.status).toBe(201);

    // 读取导出目录
    const llmWikiDir = path.join(tempDirs[0], "llm-wiki");
    const wsDirs = await fs.readdir(llmWikiDir);
    const workspaceDir = path.join(llmWikiDir, wsDirs[0]);

    // index.md 存在并包含页面链接
    const indexContent = await fs.readFile(path.join(workspaceDir, "index.md"), "utf8");
    expect(indexContent).toContain("Index");
    expect(indexContent).toContain("Alpha");
    expect(indexContent).toContain("Beta");

    // log.md 存在并包含编译事件
    const logContent = await fs.readFile(path.join(workspaceDir, "log.md"), "utf8");
    expect(logContent).toContain("Log");
    expect(logContent).toContain("ingest");

    // wiki/ 目录包含页面文件
    const wikiFiles = await fs.readdir(path.join(workspaceDir, "wiki"));
    expect(wikiFiles.length).toBeGreaterThanOrEqual(2);

    // _schema/graph.json 存在
    const graphPath = path.join(workspaceDir, "_schema", "graph.json");
    const graph = JSON.parse(await fs.readFile(graphPath, "utf8"));
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it("log.md 是追加式且可解析的（chronological, parseable）", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "log-parse@test.com",
      password: "Passw0rd!",
      displayName: "Log Parse",
    });
    const cookie = regRes.headers["set-cookie"];

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-lp-"));
    tempDirs.push(tmpDir);
    await fs.writeFile(path.join(tmpDir, "lp.md"), "# Log Test\n\nParse test.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", path.join(tmpDir, "lp.md"))
      .expect(201);

    const exportRes = await request(app)
      .post("/api/llm-wiki/export")
      .set("Cookie", cookie);

    const llmWikiDir = path.join(tempDirs[0], "llm-wiki");
    const wsDirs = await fs.readdir(llmWikiDir);
    const workspaceDir = path.join(llmWikiDir, wsDirs[0]);
    const logContent = await fs.readFile(path.join(workspaceDir, "log.md"), "utf8");

    // 每行事件应该可解析（包含 kind 标签）
    expect(logContent).toMatch(/\[ingest\]/);
  });
});

describe("T3.4: 交叉引用与关系跟踪", () => {
  it("编译器从文档中提取实体并建立 mentions 关系", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "crossref@test.com",
      password: "Passw0rd!",
      displayName: "Crossref",
    });
    const cookie = regRes.headers["set-cookie"];

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-xref-"));
    tempDirs.push(tmpDir);
    const md = path.join(tmpDir, "xref.md");
    await fs.writeFile(md, "# CoWoS Analysis\n\nCoWoS uses TSMC technology. NVIDIA is a key customer.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", md)
      .expect(201);

    // 查询应该返回关系和实体
    const queryRes = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "CoWoS" })
      .set("Cookie", cookie);

    expect(queryRes.status).toBe(200);
    expect(queryRes.body.entries.length).toBeGreaterThan(0);
    // 应该有关联项
    expect(queryRes.body.relations.length).toBeGreaterThan(0);
    expect(queryRes.body.relations[0]).toMatchObject({
      type: "mentions",
    });
  });

  it("编译器直接输出 superseded/staleness 标记（通过编译器 API 而非 HTTP）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-sup-"));
    tempDirs.push(dir);

    const sourceId = "source_sup_test";
    const workspaceId = "ws_sup_test";

    // 第一次编译：含有 Company X 的文档
    const parseResult1 = {
      document: {
        sourceId,
        fileName: "sup.md",
        mimeType: "text/markdown",
        parserName: "test",
        parserVersion: "v1",
      },
      content: {
        markdown: "# Supersede Test\n\nCompany X is a key player.",
        plainText: "Supersede Test Company X is a key player.",
        sections: [["Supersede Test", "Company X is a key player."]],
        contentBlocks: [{ kind: "section", index: 0, heading: "Supersede Test", text: "Company X is a key player." }],
      },
      artifacts: { tables: [], figures: [], citations: [] },
      quality: { warnings: [], confidence: 0.6, mode: "text" },
      rawPointers: [],
    };

    const firstCompilation = compileDocumentIntoRuntime({
      workspaceId,
      parseResult: parseResult1,
      existingRuntimeSnapshot: {},
    });

    // 第一次编译应产生条目
    expect(firstCompilation.upsertedEntries.length).toBeGreaterThan(0);

    // 构建 existingRuntimeSnapshot 用于第二次编译
    const existingSnapshot = {
      entries: firstCompilation.upsertedEntries.filter((e) => e.status !== "superseded"),
      edges: firstCompilation.upsertedEdges,
      provenance: [],
      logs: [],
      lintIssues: [],
      indexViews: [],
      stalenessMarkers: [],
      supersededMarkers: [],
    };

    // 第二次编译：使用不同的文档标题（触发旧条目的 superseded 标记）
    const parseResult2 = {
      document: {
        sourceId,
        fileName: "sup.md",
        mimeType: "text/markdown",
        parserName: "test",
        parserVersion: "v1",
      },
      content: {
        markdown: "# Supersede Test V2\n\nOnly Company Y remains now.",
        plainText: "Supersede Test V2 Only Company Y remains now.",
        sections: [["Supersede Test V2", "Only Company Y remains now."]],
        contentBlocks: [{ kind: "section", index: 0, heading: "Supersede Test V2", text: "Only Company Y remains now." }],
      },
      artifacts: { tables: [], figures: [], citations: [] },
      quality: { warnings: [], confidence: 0.6, mode: "text" },
      rawPointers: [],
    };

    const secondCompilation = compileDocumentIntoRuntime({
      workspaceId,
      parseResult: parseResult2,
      existingRuntimeSnapshot: existingSnapshot,
    });

    // 第二次编译应产生 superseded/staleness 标记
    expect(
      secondCompilation.supersededMarkers.length + secondCompilation.staleMarkers.length,
    ).toBeGreaterThan(0);
  });
});

describe("T3.5: Schema / Lint 机制", () => {
  it("导出不包含绝对路径（karpathy 标准：wiki 是纯 markdown git 仓库）", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "no-paths@test.com",
      password: "Passw0rd!",
      displayName: "No Paths",
    });
    const cookie = regRes.headers["set-cookie"];

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-np-"));
    tempDirs.push(tmpDir);
    await fs.writeFile(path.join(tmpDir, "np.md"), "# No Paths\n\nContent.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", path.join(tmpDir, "np.md"))
      .expect(201);

    const exportRes = await request(app)
      .post("/api/llm-wiki/export")
      .set("Cookie", cookie);

    const llmWikiDir = path.join(tempDirs[0], "llm-wiki");
    const wsDirs = await fs.readdir(llmWikiDir);
    const workspaceDir = path.join(llmWikiDir, wsDirs[0]);

    // 读取所有导出文件
    const allFiles = await fs.readdir(path.join(workspaceDir, "wiki"));
    for (const fileName of allFiles) {
      const content = await fs.readFile(path.join(workspaceDir, "wiki", fileName), "utf8");
      // 不应包含绝对路径
      expect(content).not.toMatch(/\/Users\//);
      expect(content).not.toMatch(/\/tmp\//);
    }
  });

  it("runtime 维护 lint 问题记录", async () => {
    const app = await makeApp();

    const regRes = await request(app).post("/api/auth/register").send({
      email: "lint-test@test.com",
      password: "Passw0rd!",
      displayName: "Lint Test",
    });
    const cookie = regRes.headers["set-cookie"];
    const workspaceId = regRes.body.workspace.id;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-lint-"));
    tempDirs.push(tmpDir);
    await fs.writeFile(path.join(tmpDir, "lint.md"), "# Lint\n\nTest.", "utf8");

    await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", path.join(tmpDir, "lint.md"))
      .expect(201);

    const dataDir = path.join(tempDirs[0], "data");
    const db = await createDatabase({ dataDir });
    const snapshot = db.getRuntimeSnapshot(workspaceId);

    // lintIssues 数组应该存在
    expect(Array.isArray(snapshot.lintIssues)).toBe(true);
  });
});
