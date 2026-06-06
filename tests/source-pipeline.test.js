import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";
import { createDatabase } from "../server/db.js";

const tempDirs = [];

function makeParseResult(sourceId, file, bodyText) {
  return {
    document: {
      sourceId,
      fileName: file.originalname,
      mimeType: file.mimetype || "text/markdown",
      parserName: "test-adapter",
      parserVersion: "v1",
    },
    content: {
      markdown: `# ${file.originalname}\n\n${bodyText}`,
      plainText: `${file.originalname} ${bodyText}`,
      sections: [[file.originalname, bodyText]],
      contentBlocks: [{ kind: "section", index: 0, heading: file.originalname, text: bodyText }],
    },
    artifacts: {
      tables: [],
      figures: [],
      citations: [],
    },
    quality: {
      mode: "text",
      warnings: [],
      confidence: 0.6,
    },
    rawPointers: [],
  };
}

async function makeApp(overrides = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-source-"));
  tempDirs.push(rootDir);
  const dataDir = path.join(rootDir, "data");

  const app = await createApp({
    dataDir,
    uploadsDir: path.join(rootDir, "uploads"),
    llmWikiDir: path.join(rootDir, "llm-wiki"),
    jwtSecret: "test-secret",
    ...overrides,
  });

  return { app, rootDir, dataDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("source parsing pipeline", () => {
  it("rejects unsupported file types and oversized uploads", async () => {
    const { app, rootDir } = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "upload-guard@example.com",
      password: "Passw0rd!",
      displayName: "Upload Guard",
    });

    const cookie = registerResponse.headers["set-cookie"];
    const exePath = path.join(rootDir, "payload.exe");
    const hugePath = path.join(rootDir, "huge.md");

    await fs.writeFile(exePath, "MZ fake executable", "utf8");
    await fs.writeFile(hugePath, "A".repeat(1024 * 1024 * 6), "utf8");

    const invalidTypeResponse = await request(app)
      .post("/api/sources/upload")
      .set("Cookie", cookie)
      .attach("files", exePath);

    expect(invalidTypeResponse.status).toBe(400);
    expect(invalidTypeResponse.body.error).toMatch(/unsupported|type|格式/i);

    const oversizedResponse = await request(app)
      .post("/api/sources/upload")
      .set("Cookie", cookie)
      .attach("files", hugePath);

    expect(oversizedResponse.status).toBe(400);
    expect(oversizedResponse.body.error).toMatch(/large|size|大小/i);
  });

  it("extracts content-based abstract, facts, and sections from uploaded markdown", async () => {
    const { app, rootDir } = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "source@example.com",
      password: "Passw0rd!",
      displayName: "Source Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const markdownPath = path.join(rootDir, "sample.md");
    await fs.writeFile(
      markdownPath,
      [
        "# CoWoS Supply Chain",
        "",
        "CoWoS capacity remains tight because AI demand is rising.",
        "",
        "## Bottlenecks",
        "",
        "- ABF substrate supply is constrained.",
        "- Packaging equipment lead time remains long.",
      ].join("\n"),
      "utf8",
    );

    const uploadResponse = await request(app)
      .post("/api/sources/upload")
      .set("Cookie", cookie)
      .attach("files", markdownPath);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.files).toHaveLength(1);
    expect(uploadResponse.body.files[0].storagePath).toBeUndefined();

    const bootstrapResponse = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);

    expect(bootstrapResponse.status).toBe(200);

    const uploadedSource = bootstrapResponse.body.files.find(
      (file) => file.name === "sample.md",
    );

    expect(uploadedSource).toBeTruthy();
    expect(uploadedSource.abstract).toMatch(/cowos|substrate|ai demand/i);
    expect(uploadedSource.facts).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/abf substrate supply/i),
      ]),
    );
    expect(uploadedSource.sections).toEqual(
      expect.arrayContaining([
        ["CoWoS Supply Chain", expect.stringMatching(/ai demand is rising/i)],
        ["Bottlenecks", expect.stringMatching(/packaging equipment lead time/i)],
      ]),
    );
  });

  it("supports .markdown files through HTTP upload and reparse", async () => {
    const { app, rootDir } = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "markdown-http@example.com",
      password: "Passw0rd!",
      displayName: "Markdown HTTP",
    });

    const cookie = registerResponse.headers["set-cookie"];
    const markdownPath = path.join(rootDir, "roadmap.markdown");
    await fs.writeFile(
      markdownPath,
      [
        "# Aurora Notes",
        "",
        "Initial markdown upload content.",
        "",
        "## Signals",
        "",
        "- First signal is present.",
      ].join("\n"),
      "utf8",
    );

    const uploadResponse = await request(app)
      .post("/api/sources/upload")
      .set("Cookie", cookie)
      .attach("files", markdownPath);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.files).toHaveLength(1);
    expect(uploadResponse.body.files[0].name).toBe("roadmap.markdown");
    expect(uploadResponse.body.files[0].abstract).toMatch(/initial markdown upload content/i);
    expect(uploadResponse.body.files[0].sections).toEqual(
      expect.arrayContaining([
        ["Aurora Notes", expect.stringMatching(/initial markdown upload content/i)],
      ]),
    );

    const sourceId = uploadResponse.body.files[0].id;
    const [storedFileName] = await fs.readdir(path.join(rootDir, "uploads"));
    await fs.writeFile(
      path.join(rootDir, "uploads", storedFileName),
      [
        "# Aurora Notes",
        "",
        "Updated markdown reparse content.",
        "",
        "## Signals",
        "",
        "- Second signal is present.",
      ].join("\n"),
      "utf8",
    );

    const reparseResponse = await request(app)
      .post(`/api/sources/${sourceId}/reparse`)
      .set("Cookie", cookie)
      .send({ rebuildWiki: false });

    expect(reparseResponse.status).toBe(200);
    expect(reparseResponse.body.source.name).toBe("roadmap.markdown");
    expect(reparseResponse.body.source.abstract).toMatch(/updated markdown reparse content/i);
    expect(reparseResponse.body.source.sections).toEqual(
      expect.arrayContaining([
        ["Aurora Notes", expect.stringMatching(/updated markdown reparse content/i)],
      ]),
    );
  });

  it("uploads and builds wiki, compiles runtime entries with provenance, and reparses updated source content", async () => {
    const { app, rootDir, dataDir } = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "pipeline@example.com",
      password: "Passw0rd!",
      displayName: "Pipeline Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];
    const markdownPath = path.join(rootDir, "roadmap.md");

    await fs.writeFile(
      markdownPath,
      [
        "# N2 Roadmap",
        "",
        "N2 is entering risk production for AI and HPC chips.",
        "",
        "## Customers",
        "",
        "- NVIDIA is a key customer.",
      ].join("\n"),
      "utf8",
    );

    const uploadAndBuildResponse = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", markdownPath);

    expect(uploadAndBuildResponse.status).toBe(201);
    expect(uploadAndBuildResponse.body.sources).toHaveLength(1);
    expect(uploadAndBuildResponse.body.wikiPages).toHaveLength(1);

    const source = uploadAndBuildResponse.body.sources[0];
    const wikiPage = uploadAndBuildResponse.body.wikiPages[0];

    expect(source.wikiBuilt).toBe(true);
    expect(wikiPage.title).toMatch(/Wiki/i);
    expect(source.storagePath).toBeUndefined();

    const markdownResponse = await request(app)
      .get(`/api/sources/${source.id}/markdown`)
      .set("Cookie", cookie);

    expect(markdownResponse.status).toBe(200);
    expect(markdownResponse.body.markdown).toMatch(/N2 Roadmap/);
    expect(markdownResponse.body.markdown).toMatch(/NVIDIA is a key customer/i);

    const [storedFileName] = await fs.readdir(path.join(rootDir, "uploads"));
    await fs.writeFile(
      path.join(rootDir, "uploads", storedFileName),
      [
        "# N2 Roadmap",
        "",
        "N2 now targets broader mobile adoption in addition to AI.",
        "",
        "## Customers",
        "",
        "- Apple is an additional customer candidate.",
      ].join("\n"),
      "utf8",
    );

    const reparseResponse = await request(app)
      .post(`/api/sources/${source.id}/reparse`)
      .set("Cookie", cookie)
      .send({ rebuildWiki: true });

    expect(reparseResponse.status).toBe(200);
    expect(reparseResponse.body.source.abstract).toMatch(/mobile adoption/i);
    expect(reparseResponse.body.wikiPage.id).toBe(wikiPage.id);
    expect(reparseResponse.body.source.storagePath).toBeUndefined();

    const db = await createDatabase({ dataDir });
    const bootstrapResponse = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);
    const runtimeSnapshot = db.getRuntimeSnapshot(bootstrapResponse.body.workspace.id);

    expect(runtimeSnapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "page",
          title: "N2 Roadmap",
          compiledFrom: [source.id],
          sourceRefs: [
            expect.objectContaining({
              sourceId: source.id,
              locator: expect.objectContaining({
                sectionHeading: "N2 Roadmap",
              }),
            }),
          ],
        }),
        expect.objectContaining({
          kind: "entity",
          title: "Apple",
          compiledFrom: [source.id],
        }),
        expect.objectContaining({
          kind: "entity",
          title: "NVIDIA",
          status: "superseded",
          compiledFrom: [source.id],
        }),
      ]),
    );
    expect(runtimeSnapshot.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mentions",
          evidenceRefs: [
            expect.objectContaining({
              sourceId: source.id,
              excerpt: expect.stringMatching(/apple/i),
            }),
          ],
        }),
      ]),
    );
    expect(runtimeSnapshot.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toEntryId: expect.stringMatching(/nvidia/i),
          type: "mentions",
        }),
      ]),
    );
    expect(runtimeSnapshot.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ingest",
          sourceId: source.id,
        }),
      ]),
    );
    expect(runtimeSnapshot.stalenessMarkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: "entry",
          targetId: expect.stringMatching(/nvidia/i),
          reason: "source-recompiled",
        }),
        expect.objectContaining({
          targetType: "edge",
          targetId: expect.stringMatching(/nvidia/i),
          reason: "source-recompiled",
        }),
      ]),
    );
    expect(runtimeSnapshot.supersededMarkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: "entry",
          targetId: expect.stringMatching(/nvidia/i),
          reason: "source-recompiled",
        }),
      ]),
    );
  });

  it("reuses persisted raw parse result when building wiki after upload instead of reconstructing from source summary", async () => {
    const parserAdapter = {
      async parse({ sourceId, file }) {
        const bodyText = await fs.readFile(file.path, "utf8");
        return {
          document: {
            sourceId,
            fileName: file.originalname,
            mimeType: file.mimetype || "text/markdown",
            parserName: "high-fidelity-test",
            parserVersion: "v9",
          },
          content: {
            markdown: `# Alpha Build\n\n${bodyText}`,
            plainText: `Alpha Build ${bodyText}`,
            sections: [["Alpha Build", bodyText.trim()]],
            contentBlocks: [{ kind: "section", index: 0, heading: "Alpha Build", text: bodyText.trim() }],
          },
          artifacts: {
            tables: [],
            figures: [],
            citations: [],
          },
          quality: {
            mode: "ocr",
            warnings: [],
            confidence: 0.91,
          },
          rawPointers: [{ storage: "original-pdf", page: 3 }],
        };
      },
    };
    const { app, rootDir, dataDir } = await makeApp({ parserAdapter });

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "raw-parse-result@example.com",
      password: "Passw0rd!",
      displayName: "Raw Parse Result",
    });

    const cookie = registerResponse.headers["set-cookie"];
    const markdownPath = path.join(rootDir, "alpha.md");
    await fs.writeFile(markdownPath, "客户 A 已进入验证阶段。", "utf8");

    const uploadResponse = await request(app)
      .post("/api/sources/upload")
      .set("Cookie", cookie)
      .attach("files", markdownPath);

    expect(uploadResponse.status).toBe(201);
    const sourceId = uploadResponse.body.files[0].id;

    const bootstrapResponse = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);
    const workspaceId = bootstrapResponse.body.workspace.id;

    const db = await createDatabase({ dataDir });
    const persistedSource = db.getSource(workspaceId, sourceId);
    expect(persistedSource.parseResult).toEqual(
      expect.objectContaining({
        quality: expect.objectContaining({ confidence: 0.91 }),
        rawPointers: [{ storage: "original-pdf", page: 3 }],
      }),
    );

    const buildResponse = await request(app)
      .post(`/api/sources/${sourceId}/build-wiki`)
      .set("Cookie", cookie);

    expect(buildResponse.status).toBe(200);

    const runtimeSnapshot = db.getRuntimeSnapshot(workspaceId);
    expect(runtimeSnapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Alpha Build",
          sourceRefs: [
            expect.objectContaining({
              sourceId,
              confidence: 0.91,
            }),
          ],
        }),
      ]),
    );
    expect(runtimeSnapshot.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceRefs: [
            expect.objectContaining({
              sourceId,
              confidence: 0.91,
            }),
          ],
        }),
      ]),
    );
  });

  it("returns persisted source jobs in bootstrap for source workflow UI", async () => {
    const { app, rootDir } = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "jobs@example.com",
      password: "Passw0rd!",
      displayName: "Jobs Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];
    const markdownPath = path.join(rootDir, "jobs.md");

    await fs.writeFile(
      markdownPath,
      [
        "# Job Visibility",
        "",
        "This file is used to verify persisted parsing jobs in bootstrap.",
      ].join("\n"),
      "utf8",
    );

    const uploadAndBuildResponse = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", markdownPath);

    expect(uploadAndBuildResponse.status).toBe(201);
    expect(uploadAndBuildResponse.body.jobIds).toHaveLength(1);

    const bootstrapResponse = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.body.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: uploadAndBuildResponse.body.jobIds[0],
          status: "completed",
          stage: "build_wiki",
        }),
      ]),
    );
  });

  it("routes upload and reparse through the parser adapter boundary", async () => {
    const calls = [];
    const parserAdapter = {
      async parse({ sourceId, file }) {
        calls.push({ sourceId, fileName: file.originalname });
        const bodyText = await fs.readFile(file.path, "utf8");
        return makeParseResult(sourceId, file, bodyText.trim());
      },
    };
    const { app, rootDir } = await makeApp({ parserAdapter });

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "adapter-route@example.com",
      password: "Passw0rd!",
      displayName: "Adapter Route",
    });

    const cookie = registerResponse.headers["set-cookie"];
    const markdownPath = path.join(rootDir, "adapter.md");
    await fs.writeFile(markdownPath, "initial adapter content", "utf8");

    const uploadResponse = await request(app)
      .post("/api/sources/upload")
      .set("Cookie", cookie)
      .attach("files", markdownPath);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.files[0].abstract).toContain("initial adapter content");
    expect(calls).toHaveLength(1);

    const sourceId = uploadResponse.body.files[0].id;
    const [storedFileName] = await fs.readdir(path.join(rootDir, "uploads"));
    await fs.writeFile(path.join(rootDir, "uploads", storedFileName), "updated adapter content", "utf8");

    const reparseResponse = await request(app)
      .post(`/api/sources/${sourceId}/reparse`)
      .set("Cookie", cookie)
      .send({ rebuildWiki: false });

    expect(reparseResponse.status).toBe(200);
    expect(reparseResponse.body.source.abstract).toContain("updated adapter content");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.fileName)).toEqual(["adapter.md", "adapter.md"]);
  });

  it("rejects malformed parser adapter output instead of silently accepting it", async () => {
    const parserAdapter = {
      async parse() {
        return {
          document: {
            sourceId: "",
            fileName: "",
          },
          content: {
            markdown: null,
            sections: "broken",
          },
        };
      },
    };
    const { app, rootDir } = await makeApp({ parserAdapter });

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "adapter-malformed@example.com",
      password: "Passw0rd!",
      displayName: "Adapter Malformed",
    });

    const cookie = registerResponse.headers["set-cookie"];
    const markdownPath = path.join(rootDir, "broken.md");
    await fs.writeFile(markdownPath, "# Broken\n\npayload", "utf8");

    const uploadResponse = await request(app)
      .post("/api/sources/upload")
      .set("Cookie", cookie)
      .attach("files", markdownPath);

    expect(uploadResponse.status).toBe(500);
    expect(uploadResponse.body.error).toMatch(/parser adapter output/i);
  });

  it("prevents one user from reading another user's source markdown", async () => {
    const { app, rootDir } = await makeApp();

    const ownerResponse = await request(app).post("/api/auth/register").send({
      email: "owner-source@example.com",
      password: "Passw0rd!",
      displayName: "Owner",
    });
    const ownerCookie = ownerResponse.headers["set-cookie"];

    const viewerResponse = await request(app).post("/api/auth/register").send({
      email: "viewer-source@example.com",
      password: "Passw0rd!",
      displayName: "Viewer",
    });
    const viewerCookie = viewerResponse.headers["set-cookie"];

    const markdownPath = path.join(rootDir, "isolation.md");
    await fs.writeFile(markdownPath, "# Private Source\n\nOnly owner should see this.", "utf8");

    const uploadResponse = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", ownerCookie)
      .attach("files", markdownPath);

    const sourceId = uploadResponse.body.sources[0].id;

    const otherUserRead = await request(app)
      .get(`/api/sources/${sourceId}/markdown`)
      .set("Cookie", viewerCookie);

    expect(otherUserRead.status).toBe(404);
  });
});
