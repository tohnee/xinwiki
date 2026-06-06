import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultParserAdapter } from "../server/services/parser-adapter.js";

const tempDirs = [];

function fakeUpload(filePath, originalname) {
  return {
    path: filePath,
    originalname,
    mimetype: "text/markdown",
    size: 32,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("parser adapter", () => {
  it("returns the canonical DocumentParseResult shape", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-parser-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "aurora.md");
    await fs.writeFile(filePath, "# Project Aurora\n\n客户 A 的采购代号。", "utf8");

    const adapter = createDefaultParserAdapter();
    const result = await adapter.parse({
      sourceId: "source_demo",
      file: fakeUpload(filePath, "aurora.md"),
    });

    expect(result.document).toEqual(
      expect.objectContaining({
        sourceId: "source_demo",
        fileName: "aurora.md",
        parserName: "local-basic",
      }),
    );
    expect(result.content).toEqual(
      expect.objectContaining({
        markdown: expect.stringContaining("# Project Aurora"),
        plainText: expect.any(String),
        sections: expect.any(Array),
        contentBlocks: expect.any(Array),
      }),
    );
    expect(result.artifacts).toEqual(
      expect.objectContaining({
        tables: expect.any(Array),
        figures: expect.any(Array),
        citations: expect.any(Array),
      }),
    );
    expect(result.quality).toEqual(
      expect.objectContaining({
        mode: expect.any(String),
        warnings: expect.any(Array),
      }),
    );
  });

  it("parses .markdown files as text instead of metadata-only fallback", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xinwiki-parser-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "aurora.markdown");
    await fs.writeFile(filePath, "# Aurora Markdown\n\n这是 markdown 扩展名正文。", "utf8");

    const adapter = createDefaultParserAdapter();
    const result = await adapter.parse({
      sourceId: "source_markdown",
      file: fakeUpload(filePath, "aurora.markdown"),
    });

    expect(result.quality.mode).toBe("text");
    expect(result.content.markdown).toContain("Aurora Markdown");
    expect(result.content.sections).toEqual(
      expect.arrayContaining([
        ["Aurora Markdown", expect.stringMatching(/markdown 扩展名正文/)],
      ]),
    );
  });
});
