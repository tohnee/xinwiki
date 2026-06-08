import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const tempDirs = [];

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-bootstrap-"));
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

describe("bootstrap and export flow", () => {
  it("returns seeded workspace data and exports llm-wiki files", async () => {
    const { app, rootDir } = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "carol@example.com",
      password: "Passw0rd!",
      displayName: "Carol",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const bootstrapResponse = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.body.files.length).toBeGreaterThan(0);
    expect(bootstrapResponse.body.wikiPages.length).toBeGreaterThan(0);
    expect(bootstrapResponse.body.ontologyNodes.length).toBeGreaterThan(0);

    const workspaceExportDir = path.join(rootDir, "llm-wiki", bootstrapResponse.body.workspace.id);

    const seededQueryResponse = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "CoWoS" })
      .set("Cookie", cookie);

    expect(seededQueryResponse.status).toBe(200);
    expect(seededQueryResponse.body.query).toBe("CoWoS");
    expect(seededQueryResponse.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: expect.stringMatching(/CoWoS/) }),
      ]),
    );
    expect(seededQueryResponse.body.evidence.length).toBeGreaterThan(0);

    const markdownPath = path.join(rootDir, "aurora.md");
    await fs.writeFile(
      markdownPath,
      [
        "# Project Aurora",
        "",
        "Project Aurora 是客户 A 采购代号。",
        "",
        "## Signals",
        "",
        "- 客户 A 在 2026 年推进采购计划。",
      ].join("\n"),
      "utf8",
    );

    const uploadResponse = await request(app)
      .post("/api/sources/upload-and-build")
      .set("Cookie", cookie)
      .attach("files", markdownPath);

    expect(uploadResponse.status).toBe(201);

    const queryResponse = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "客户 A 采购代号" })
      .set("Cookie", cookie);

    expect(queryResponse.status).toBe(200);
    expect(queryResponse.body.query).toBe("客户 A 采购代号");
    expect(queryResponse.body.entries.length).toBeGreaterThan(0);
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
    expect(queryResponse.body.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: expect.any(String),
        }),
      ]),
    );
    expect(queryResponse.body.entries[0]).toEqual(
      expect.objectContaining({
        title: expect.any(String),
        excerpt: expect.any(String),
      }),
    );

    // Export after runtime entries are populated
    const exportResponse = await request(app)
      .post("/api/llm-wiki/export")
      .set("Cookie", cookie);

    expect(exportResponse.status).toBe(201);
    expect(exportResponse.body.pageCount).toBeGreaterThan(0);
    expect(exportResponse.body.outputDir).toBeUndefined();

    // Verify runtime projection output files
    const indexFile = await fs.readFile(path.join(workspaceExportDir, "index.md"), "utf8");
    expect(indexFile).toContain("Index");

    const logFile = await fs.readFile(path.join(workspaceExportDir, "log.md"), "utf8");
    expect(logFile).toContain("Compilation Log");

    const graphFile = await fs.readFile(
      path.join(workspaceExportDir, "_schema", "graph.json"),
      "utf8",
    );
    const graph = JSON.parse(graphFile);
    expect(graph.nodes).toBeDefined();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges).toBeDefined();
  });
});
