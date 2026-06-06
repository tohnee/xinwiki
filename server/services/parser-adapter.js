import { createLocalDocumentParser } from "./document-parser.js";

function toPlainText(markdown) {
  return String(markdown || "").replace(/^\s{0,3}#{1,6}\s+/gm, "").trim();
}

function toContentBlocks(sections) {
  return (sections || []).map(([heading, content], index) => ({
    kind: "section",
    index,
    heading,
    text: content,
  }));
}

export function createDefaultParserAdapter() {
  const parser = createLocalDocumentParser();

  return {
    name: parser.name,
    async parse({ sourceId, file }) {
      const parsed = await parser.parse(file);

      return {
        document: {
          sourceId,
          fileName: file.originalname,
          mimeType: file.mimetype || "application/octet-stream",
          parserName: parser.name,
          parserVersion: parser.version,
        },
        content: {
          markdown: parsed.markdown,
          plainText: toPlainText(parsed.markdown),
          sections: parsed.sections || [],
          contentBlocks: toContentBlocks(parsed.sections),
        },
        artifacts: {
          tables: [],
          figures: [],
          citations: [],
        },
        quality: {
          mode: parsed.parserMeta?.mode || "text",
          warnings: [],
          confidence: 0.6,
        },
        rawPointers: [],
      };
    },
  };
}
