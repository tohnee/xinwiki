import path from "node:path";

import { createApp } from "./app.js";

const port = Number(process.env.PORT || 3000);

const app = await createApp({
  dataDir: process.env.DATA_DIR || path.resolve("data"),
  uploadsDir: process.env.UPLOADS_DIR || path.resolve("data/uploads"),
  llmWikiDir: process.env.LLM_WIKI_DIR || path.resolve("data/llm-wiki"),
});

app.listen(port, () => {
  console.log(`XinWiki backend listening on http://localhost:${port}`);
});
