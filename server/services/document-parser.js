import fs from "node:fs/promises";
import path from "node:path";

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fileTitleFromName(fileName) {
  return path.basename(fileName, path.extname(fileName)) || "上传文档";
}

function markdownSections(markdown, fallbackTitle) {
  const lines = String(markdown || "").split("\n");
  const sections = [];
  let currentHeading = fallbackTitle;
  let buffer = [];

  function flush() {
    const content = normalizeWhitespace(buffer.join("\n"));
    if (content) {
      sections.push([currentHeading, content]);
    }
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (headingMatch) {
      flush();
      currentHeading = normalizeWhitespace(headingMatch[1]) || fallbackTitle;
      continue;
    }
    buffer.push(line);
  }

  flush();
  return sections;
}

function extractFacts(markdown) {
  const bulletFacts = String(markdown || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);

  if (bulletFacts.length) {
    return bulletFacts.slice(0, 6);
  }

  return String(markdown || "")
    .split(/\.\s+|\n+/)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 20)
    .slice(0, 6);
}

function extractAbstract(markdown) {
  const paragraphs = String(markdown || "")
    .split(/\n{2,}/)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part && !part.startsWith("#") && !/^[-*]\s+/.test(part));

  return paragraphs[0] || "已完成基础文本解析，等待进一步构建 Wiki 页面。";
}

function htmlToMarkdown(html, fallbackTitle) {
  const headingReplaced = String(html || "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n");

  const stripped = headingReplaced
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  const markdown = normalizeWhitespace(stripped).replace(/\n /g, "\n");
  if (/^\s*#/.test(markdown)) {
    return markdown;
  }
  return `# ${fallbackTitle}\n\n${markdown}`.trim();
}

function textToMarkdown(text, fallbackTitle) {
  const normalized = normalizeWhitespace(text);
  if (/^\s{0,3}#{1,6}\s+/.test(normalized)) {
    return normalized;
  }
  return `# ${fallbackTitle}\n\n${normalized}`.trim();
}

export function createLocalDocumentParser() {
  return {
    name: "local-basic",
    version: "v1",
    async parse(file) {
      const ext = path.extname(file.originalname || file.path).toLowerCase();
      const fallbackTitle = fileTitleFromName(file.originalname || file.path);
      const isTextLike = [".md", ".markdown", ".txt", ".html", ".htm"].includes(ext);

      if (!isTextLike) {
        return {
          abstract: "由用户上传文档解析生成的来源摘要。系统已完成基础入库，等待构建 Wiki 页面。",
          facts: [
            "文档已保存到服务器并生成基础元数据。",
            "可进一步构建 Workspace Wiki 页面。",
          ],
          sections: [["来源文件", file.originalname]],
          markdown: `# ${fallbackTitle}\n\n暂不支持该文件类型的正文解析。`,
          parserMeta: {
            mode: "metadata-only",
            extension: ext || "unknown",
          },
        };
      }

      const raw = await fs.readFile(file.path, "utf8");
      const markdown = ext === ".html" || ext === ".htm"
        ? htmlToMarkdown(raw, fallbackTitle)
        : textToMarkdown(raw, fallbackTitle);
      const sections = markdownSections(markdown, fallbackTitle);

      return {
        abstract: extractAbstract(markdown),
        facts: extractFacts(markdown),
        sections,
        markdown,
        parserMeta: {
          mode: "text",
          extension: ext,
          sectionCount: sections.length,
        },
      };
    },
  };
}

export async function parseDocumentFile(file) {
  return createLocalDocumentParser().parse(file);
}
