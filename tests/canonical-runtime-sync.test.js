import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const tempDirs = [];

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-canonical-"));
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("canonical runtime synchronization", () => {
  it("syncs QA records, memories, and expert injections into first-class runtime entries", async () => {
    const { app } = await makeApp();
    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "canonical-notes@example.com",
      password: "Passw0rd!",
      displayName: "Canonical Notes",
    });
    const cookie = registerResponse.headers["set-cookie"];

    const qaResponse = await request(app)
      .post("/api/qa-records")
      .set("Cookie", cookie)
      .send({
        question: "What is Quasar Runtime Note?",
        answer: "Quasar Runtime Note is a canonical qa-note entry.",
        citations: ["source:manual"],
      });
    expect(qaResponse.status).toBe(201);

    const memoryResponse = await request(app)
      .post("/api/memories")
      .set("Cookie", cookie)
      .send({ text: "Remember Quasar Memory Anchor for runtime search.", period: "永久记忆" });
    expect(memoryResponse.status).toBe(201);

    const expertResponse = await request(app)
      .post("/api/expert-injections")
      .set("Cookie", cookie)
      .send({ entity: "Quasar Entity", weight: 4, note: "Quasar expert annotation must be searchable." });
    expect(expertResponse.status).toBe(201);

    const runtime = app.locals.db.getRuntimeSnapshot(registerResponse.body.workspace.id);
    expect(runtime.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "qa-note", title: "What is Quasar Runtime Note?" }),
        expect.objectContaining({ kind: "memory-note", title: expect.stringMatching(/Quasar Memory Anchor/) }),
        expect.objectContaining({ kind: "memory-note", title: "专家注入：Quasar Entity" }),
      ]),
    );

    const queryResponse = await request(app)
      .get("/api/llm-wiki/query")
      .query({ q: "Quasar Runtime Note" })
      .set("Cookie", cookie);
    expect(queryResponse.status).toBe(200);
    expect(queryResponse.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "qa-note", title: "What is Quasar Runtime Note?" }),
      ]),
    );
  });

  it("promotes wiki pages without existing ontology nodes and writes relation edges to runtime", async () => {
    const { app } = await makeApp();
    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "canonical-promote@example.com",
      password: "Passw0rd!",
      displayName: "Canonical Promote",
    });
    const cookie = registerResponse.headers["set-cookie"];
    const workspaceId = registerResponse.body.workspace.id;

    app.locals.db.saveWikiPage(workspaceId, {
      id: "orphan-wiki",
      title: "Orphan Wiki Promote Target",
      type: "Concept",
      summary: "Unique orphan wiki page with no ontology node.",
      sections: [["Overview", "Orphan promote content."]],
      relations: [["Orphan Source", "supports", "Orphan Target"]],
    });

    const promoteResponse = await request(app)
      .post("/api/wiki/orphan-wiki/promote")
      .set("Cookie", cookie);
    expect(promoteResponse.status).toBe(201);
    expect(promoteResponse.body.node.runtimeEntryId).toMatch(/^entry_entity_/);

    const relationResponse = await request(app)
      .post("/api/wiki/orphan-wiki/relations/promote")
      .set("Cookie", cookie)
      .send({ relations: [["Orphan Source", "supports", "Orphan Target"]] });
    expect(relationResponse.status).toBe(201);
    expect(relationResponse.body.runtimeEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "supports" }),
      ]),
    );

    const runtime = app.locals.db.getRuntimeSnapshot(workspaceId);
    expect(runtime.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "supports" }),
      ]),
    );
  });
});
