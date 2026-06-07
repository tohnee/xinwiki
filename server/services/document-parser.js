import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

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


function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function findZipEntries(buffer) {
  const entries = new Map();
  let offset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (offset < 0 || offset + 22 > buffer.length) {
    return entries;
  }
  const centralOffset = buffer.readUInt32LE(offset + 16);
  let cursor = centralOffset;
  while (cursor + 46 <= buffer.length && buffer.readUInt32LE(cursor) === 0x02014b50) {
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      try {
        const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
        if (data && (!uncompressedSize || data.length === uncompressedSize || data.length > 0)) {
          entries.set(name, data);
        }
      } catch {
        // Skip malformed entries and keep best-effort parsing.
      }
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlTextRuns(xml, tagPattern) {
  return Array.from(String(xml || "").matchAll(tagPattern), (match) => decodeXmlEntities(match[1]))
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
}

function openXmlToMarkdown(buffer, fallbackTitle, kind) {
  const entries = findZipEntries(buffer);
  const texts = [];
  if (kind === "docx") {
    const documentXml = entries.get("word/document.xml")?.toString("utf8") || "";
    texts.push(...xmlTextRuns(documentXml, /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g));
  } else {
    const slideNames = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
    for (const name of slideNames) {
      texts.push(...xmlTextRuns(entries.get(name)?.toString("utf8") || "", /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g));
    }
  }
  const body = normalizeWhitespace(texts.join("\n\n"));
  return body ? `# ${fallbackTitle}\n\n${body}` : `# ${fallbackTitle}\n\n暂未能从该 ${kind.toUpperCase()} 文件抽取可读正文。`;
}

function pdfToMarkdown(buffer, fallbackTitle) {
  const raw = buffer.toString("latin1");
  const literalText = Array.from(raw.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*T[jJ]/g), (match) => match[1])
    .map((part) => part.replace(/\\([nrtbf()\\])/g, (_, ch) => ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" }[ch] ?? ch)))
    .map((part) => normalizeWhitespace(part))
    .filter((part) => /[A-Za-z\u4e00-\u9fff0-9]{2,}/.test(part));
  const body = normalizeWhitespace(literalText.join("\n\n"));
  return body ? `# ${fallbackTitle}\n\n${body}` : `# ${fallbackTitle}\n\n暂未能从该 PDF 文件抽取可读正文。`;
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
        const rawBuffer = await fs.readFile(file.path);
        const markdown = ext === ".docx"
          ? openXmlToMarkdown(rawBuffer, fallbackTitle, "docx")
          : ext === ".pptx"
            ? openXmlToMarkdown(rawBuffer, fallbackTitle, "pptx")
            : ext === ".pdf"
              ? pdfToMarkdown(rawBuffer, fallbackTitle)
              : `# ${fallbackTitle}

暂不支持该文件类型的正文解析。`;
        const sections = markdownSections(markdown, fallbackTitle);
        const extractedText = sections.some(([, content]) => !/暂未能|暂不支持/.test(content));
        return {
          abstract: extractedText
            ? extractAbstract(markdown)
            : "由用户上传文档解析生成的来源摘要。系统已完成基础入库，等待构建 Wiki 页面。",
          facts: extractedText
            ? extractFacts(markdown)
            : [
                "文档已保存到服务器并生成基础元数据。",
                "可进一步构建 Workspace Wiki 页面。",
              ],
          sections,
          markdown,
          parserMeta: {
            mode: extractedText ? "text" : "metadata-only",
            extension: ext || "unknown",
            sectionCount: sections.length,
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
