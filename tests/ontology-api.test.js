import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const tempDirs = [];

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-ontology-"));
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
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("ontology APIs", () => {
  it("promotes wiki relations into ontology edges and skips duplicates", async () => {
    const app = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "ontology@example.com",
      password: "Passw0rd!",
      displayName: "Ontology Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const firstPromotionResponse = await request(app)
      .post("/api/wiki/tsmc/relations/promote")
      .set("Cookie", cookie)
      .send({
        relations: [["台积电", "operates", "Arizona Fab"]],
      });

    expect(firstPromotionResponse.status).toBe(201);
    expect(firstPromotionResponse.body.createdEdges).toEqual([
      ["台积电", "Arizona Fab", "operates"],
    ]);
    expect(firstPromotionResponse.body.skippedEdges).toEqual([]);

    const duplicatePromotionResponse = await request(app)
      .post("/api/wiki/tsmc/relations/promote")
      .set("Cookie", cookie)
      .send({
        relations: [
          ["台积电", "operates", "Arizona Fab"],
          ["台积电", "usesNode", "N2"],
        ],
      });

    expect(duplicatePromotionResponse.status).toBe(201);
    expect(duplicatePromotionResponse.body.createdEdges).toEqual([]);
    expect(duplicatePromotionResponse.body.skippedEdges).toEqual(
      expect.arrayContaining([
        ["台积电", "Arizona Fab", "operates"],
        ["台积电", "N2", "usesNode"],
      ]),
    );
  });

  it("exports ontology graph with nodes, edges, and expert injections", async () => {
    const app = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "export@example.com",
      password: "Passw0rd!",
      displayName: "Export Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const exportResponse = await request(app)
      .get("/api/ontology/export")
      .set("Cookie", cookie);

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body.nodes.length).toBeGreaterThan(0);
    expect(exportResponse.body.edges.length).toBeGreaterThan(0);
    expect(exportResponse.body.expertInjections.length).toBeGreaterThan(0);
    expect(exportResponse.body.edges).toEqual(
      expect.arrayContaining([
        ["台积电", "N2", "usesNode"],
      ]),
    );
  });

  it("persists focus config through GET and PUT APIs and returns it from bootstrap", async () => {
    const app = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "focus@example.com",
      password: "Passw0rd!",
      displayName: "Focus Tester",
    });

    const cookie = registerResponse.headers["set-cookie"];

    const initialFocusResponse = await request(app)
      .get("/api/focuses")
      .set("Cookie", cookie);

    expect(initialFocusResponse.status).toBe(200);
    expect(initialFocusResponse.body["公司"]).toEqual(
      expect.arrayContaining([["TSMC", true]]),
    );

    const updatedFocuses = {
      公司: [["TSMC", false], ["ASML", true]],
      制程: [["N2", true], ["N3", false]],
      技术: [["CoWoS", true], ["GAA", false]],
      材料: [["EUV Photoresist", true], ["Silicon Wafer", false]],
    };

    const updateResponse = await request(app)
      .put("/api/focuses")
      .set("Cookie", cookie)
      .send(updatedFocuses);

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.focuses).toEqual(updatedFocuses);

    const bootstrapResponse = await request(app)
      .get("/api/bootstrap")
      .set("Cookie", cookie);

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.body.focuses).toEqual(updatedFocuses);
  });
});
