import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const tempDirs = [];

async function makeApp() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-auth-"));
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

describe("auth API", () => {
  it("registers a user, sets a session cookie, and returns the current user", async () => {
    const app = await makeApp();

    const registerResponse = await request(app).post("/api/auth/register").send({
      email: "alice@example.com",
      password: "Passw0rd!",
      displayName: "Alice",
    });

    expect(registerResponse.status).toBe(201);
    expect(registerResponse.body.user.email).toBe("alice@example.com");
    expect(registerResponse.headers["set-cookie"]).toBeTruthy();

    const meResponse = await request(app)
      .get("/api/auth/me")
      .set("Cookie", registerResponse.headers["set-cookie"]);

    expect(meResponse.status).toBe(200);
    expect(meResponse.body.user.displayName).toBe("Alice");
    expect(meResponse.body.workspace).toMatchObject({
      name: "Alice 的工作空间",
    });
  });

  it("rejects invalid login credentials", async () => {
    const app = await makeApp();

    await request(app).post("/api/auth/register").send({
      email: "bob@example.com",
      password: "Passw0rd!",
      displayName: "Bob",
    });

    const loginResponse = await request(app).post("/api/auth/login").send({
      email: "bob@example.com",
      password: "wrong-password",
    });

    expect(loginResponse.status).toBe(401);
    expect(loginResponse.body.error).toMatch(/invalid/i);
  });

  // === 安全修复测试 ===

  // Fix 1: JWT secret production enforcement
  it("refuses to start in production without JWT_SECRET", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const prevSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    try {
      await expect(
        createApp({ dataDir: "/tmp/test", jwtSecret: undefined }),
      ).rejects.toThrow(/JWT_SECRET/);
    } finally {
      process.env.NODE_ENV = prevEnv;
      process.env.JWT_SECRET = prevSecret;
    }
  });

  // Fix 2: Cookie secure flags in production
  it("sets secure cookie options in production", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const app = await makeApp();

    try {
      const registerResponse = await request(app).post("/api/auth/register").send({
        email: "secure-cookie@example.com",
        password: "Passw0rd!",
        displayName: "Secure Cookie",
      });

      const cookies = registerResponse.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const tokenCookie = cookies.find((c) => c.startsWith("xinwiki_token="));
      expect(tokenCookie).toBeDefined();
      // In production, samesite=strict should be in the cookie string
      expect(tokenCookie).toMatch(/SameSite=Strict/i);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  // Fix 3: Logout requires authentication
  it("requires authentication for logout", async () => {
    const app = await makeApp();
    const response = await request(app).post("/api/auth/logout");
    expect(response.status).toBe(401);
  });

  // Fix 4: Error messages sanitized in production
  it("sanitizes error messages in production", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const app = await makeApp();

    try {
      // Trigger a 500 by sending invalid JSON
      const response = await request(app)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send("not-valid-json");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe(
        "Internal server error. Please try again later.",
      );
      // Should NOT leak internal details
      expect(response.body.error).not.toMatch(/path|sql|file|stack/i);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
