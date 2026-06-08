import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { z } from "zod";

import { createDatabase } from "./db.js";
import {
  expertRuntimeEntry,
  manualEntityEntry,
  memoryRuntimeEntry,
  normalizeLegacyOntologyEdge,
  qaRuntimeEntry,
  runtimeEdgeFromNames,
} from "./services/canonical-runtime-sync.js";
import { createLlmWikiBuildService } from "./services/llm-wiki-build-service.js";
import { buildGroundedAnswerFromQuery, queryRuntimeSnapshot } from "./services/llm-wiki-query.js";
import { createDefaultParserAdapter } from "./services/parser-adapter.js";
import { createReportService } from "./services/report-service.js";
import { exportRuntimeToLlmWiki } from "./services/llm-wiki-exporter.js";
import { createSourceParsingService } from "./services/source-parsing-service.js";
import { ensureDir, nowIso, uploadFileName } from "./utils.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  displayName: z.string().min(2).max(50),
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const expertInjectionSchema = z.object({
  entity: z.string().min(1),
  weight: z.number().int().min(1).max(5),
  note: z.string().min(1),
});

const qaRecordSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  citations: z.array(z.string()).default([]),
});

const memorySchema = z.object({
  text: z.string().min(1),
  period: z.string().default("永久记忆"),
});

const chatSchema = z.object({
  question: z.string().min(1),
});

const reportSchema = z.object({
  scope: z.enum(["wiki", "ontology", "sources", "qa"]).default("wiki"),
  reportType: z.string().min(1),
  chartType: z.string().min(1),
  model: z.string().min(1),
  format: z.enum(["report", "ppt", "md"]).default("report"),
});

const reportExportSchema = z.object({
  scope: z.enum(["wiki", "ontology", "sources", "qa"]).default("wiki"),
  reportType: z.string().min(1),
  chartType: z.string().min(1),
  model: z.string().min(1),
  exportFormat: z.enum(["docx", "pdf"]),
});

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES || 10);
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
]);

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function setAuthCookie(res, token) {
  res.cookie("xinwiki_token", token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

function clearAuthCookie(res) {
  res.clearCookie("xinwiki_token");
}

async function summarizeUpload(file, overrides = {}) {
  if (!overrides.sourceParsingService) {
    throw new Error("Source parsing service is required.");
  }
  return overrides.sourceParsingService.summarizeUpload({
    file,
    overrides,
    parserId: overrides.parserId,
  });
}


function buildWikiFromSource(source) {
  const summary = source.abstract || `这是由 ${source.name} 自动构建的 Workspace Wiki 页面。`;
  const sections = Array.isArray(source.sections) && source.sections.length
    ? source.sections
    : [
        ["来源文件", source.name],
        ["处理流程", "上传 → 入库 → 结构化摘要 → Wiki 页面"],
      ];
  const entities = Array.from(
    new Set(["上传文档", source.name, ...(source.facts || []).flatMap((fact) => String(fact).split(/[，,]/))]),
  )
    .map((item) => String(item).trim())
    .filter((item) => item.length >= 2)
    .slice(0, 8);
  return {
    id: `wiki_${source.id}`,
    title: source.title.replace(/^上传文档 · /, "Wiki · "),
    source: source.name,
    type: "UploadedAsset",
    summary,
    sections,
    entities,
    relations: [["上传文档", "mentionedIn", source.name]],
  };
}

function buildCompletedJob(sourceId) {
  return {
    id: createId("job"),
    sourceId,
    status: "completed",
    stage: "build_wiki",
    progress: 100,
    stages: [
      "upload",
      "parse_content",
      "structure_markdown",
      "extract_entities",
      "build_wiki",
    ],
  };
}

function normalizeRelationToEdge(relation) {
  if (!Array.isArray(relation) || relation.length < 3) {
    return null;
  }

  const [from, type, to] = relation;
  if (!from || !type || !to) {
    return null;
  }

  return [String(from), String(to), String(type)];
}

function normalizeFocusPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const normalized = {};
  for (const [group, items] of Object.entries(payload)) {
    if (!Array.isArray(items)) {
      return null;
    }
    normalized[group] = items
      .filter((item) => Array.isArray(item) && item.length >= 2)
      .map(([name, enabled]) => [String(name), Boolean(enabled)]);
  }

  return normalized;
}

function sanitizeSource(source) {
  if (!source) {
    return source;
  }

  const {
    storagePath: _storagePath,
    parseResult: _parseResult,
    ...publicSource
  } = source;
  return publicSource;
}

function sanitizeBootstrap(bootstrap) {
  return {
    ...bootstrap,
    files: (bootstrap.files || []).map(sanitizeSource),
  };
}

function resolveWorkspaceFile(baseDir, fileName) {
  const safeBaseDir = path.resolve(baseDir);
  const resolvedPath = path.resolve(safeBaseDir, fileName);
  if (!resolvedPath.startsWith(`${safeBaseDir}${path.sep}`)) {
    return null;
  }
  return resolvedPath;
}

const FINANCE_INTENT_KEYWORDS = [
  "营收",
  "收入",
  "revenue",
  "利润",
  "净利",
  "毛利",
  "profit",
  "估值",
  "valuation",
  "预测",
  "forecast",
  "guidance",
  "指引",
  "eps",
  "市盈率",
];

function groundedAnswer({ runtimeSnapshot, question, ontologyWeights }) {
  const runtimeQuery = queryRuntimeSnapshot({
    snapshot: runtimeSnapshot,
    query: question,
    ontologyWeights,
  });
  const lowered = question.toLowerCase();
  const requiresStrictEvidence = FINANCE_INTENT_KEYWORDS.some((keyword) => lowered.includes(keyword));
  if (requiresStrictEvidence) {
    const hasIntentEvidence = (runtimeQuery.entries || []).some((entry) => {
      const text = [entry.title, entry.summary, entry.excerpt, ...(entry.sourceRefs || []).map((ref) => ref.excerpt)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return FINANCE_INTENT_KEYWORDS.some((keyword) => text.includes(keyword));
    });
    if (!hasIntentEvidence) {
      return {
        canAnswer: false,
        answer: "当前没有足够的 runtime 证据来回答这个问题。按照 grounded-only 规则，我会拒绝回答；该问题属于金融预测/指标类，请先提供明确的 runtime 文档证据。",
        citations: [],
        context: "",
      };
    }
  }

  const runtimeGrounded = buildGroundedAnswerFromQuery(runtimeQuery, question);
  if (runtimeGrounded.canAnswer) {
    return runtimeGrounded;
  }

  return {
    canAnswer: false,
    answer:
      "当前没有足够的 runtime 证据来回答这个问题。按照 grounded-only 规则，我会拒绝回答；"
      + (requiresStrictEvidence
        ? "该问题属于金融预测/指标类，请先提供明确的 runtime 文档证据。"
        : "请先补充相关来源并完成 runtime 编译。"),
    citations: [],
    context: "",
  };
}

function threadDifyConversationId(thread) {
  return thread?.dify_conversation_id ?? thread?.difyConversationId ?? thread?.conversationId ?? null;
}

async function askDify({ config, userId, question, thread, grounded }) {
  if (!config.apiBaseUrl || !config.apiKey) {
    return null;
  }

  const conversationId = threadDifyConversationId(thread);

  const timeout = parseInt(process.env.DIFY_TIMEOUT_MS || "30000", 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/chat-messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: {
          grounding_context: grounded.context,
          grounding_citations: grounded.citations.join(" | "),
        },
        query: question,
        response_mode: "blocking",
        conversation_id: conversationId || undefined,
        user: userId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Dify request failed: ${response.status} ${body}`);
    }

    const data = await response.json();
    return {
      answer: data.answer || "Dify 没有返回文本。",
      citations: grounded.citations,
      conversationId: data.conversation_id || conversationId || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(projectRoot, "data");
  const uploadsDir = options.uploadsDir || path.join(dataDir, "uploads");
  const llmWikiDir = options.llmWikiDir || path.join(dataDir, "llm-wiki");
  const exportsDir = options.exportsDir || path.join(dataDir, "exports");

  let jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
  if (!jwtSecret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "JWT_SECRET is required in production. Set it in .env or pass jwtSecret option.",
      );
    }
    jwtSecret = "xinwiki-dev-secret";
    console.warn(
      "WARNING: Using default JWT secret. Set JWT_SECRET in .env for your environment.",
    );
  }

  const staticRoot = options.staticRoot || projectRoot;
  const parserAdapter = options.parserAdapter || createDefaultParserAdapter();

  await ensureDir(uploadsDir);
  await ensureDir(llmWikiDir);
  await ensureDir(exportsDir);

  const db = await createDatabase({ dataDir });

  const sourceParsingService = options.sourceParsingService || createSourceParsingService({
    adapters: {
      "local-basic": parserAdapter,
      [parserAdapter.name || "default"]: parserAdapter,
    },
    defaultAdapterId: parserAdapter.name || "local-basic",
    createSourceId: () => createId("source"),
  });
  const llmWikiBuildService = options.llmWikiBuildService || createLlmWikiBuildService({
    db,
    onSupersededEntry: ({ workspaceId, entry, compilation }) => {
      const bootstrap = db.getBootstrap(workspaceId);
      const upsertedTitles = new Set(
        (compilation.upsertedEntries || [])
          .filter((item) => item.status !== "superseded")
          .map((item) => item.title),
      );
      if (upsertedTitles.has(entry.title)) {
        return;
      }
      const matchingNode = bootstrap.ontologyNodes.find(
        (node) => node.id === entry.title || node.id === entry.title.slice(0, 10),
      );
      if (matchingNode) {
        db.saveOntologyNode(workspaceId, {
          ...matchingNode,
          status: "stale",
          version: (matchingNode.version || 0) + 1,
          staleReason: `Runtime entry ${entry.id} 已被 supersede。`,
          updatedAt: new Date().toISOString(),
        });
      }
    },
  });
  const reportService = options.reportService || createReportService();

  const app = express();
  app.locals.db = db;
  app.locals.services = { sourceParsingService, llmWikiBuildService, reportService };
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());

  const uploader = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        try {
          await ensureDir(uploadsDir);
          cb(null, uploadsDir);
        } catch (error) {
          cb(error);
        }
      },
      filename(_req, file, cb) {
        cb(null, uploadFileName(file.originalname));
      },
    }),
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: MAX_UPLOAD_FILES,
    },
    fileFilter(_req, file, cb) {
      const extension = path.extname(file.originalname || "").toLowerCase();
      if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
        cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
        return;
      }
      cb(null, true);
    },
  });

  function issueToken(user) {
    return jwt.sign({ sub: user.id, email: user.email }, jwtSecret, {
      expiresIn: "7d",
    });
  }

  function getAuth(req) {
    const token = req.cookies.xinwiki_token;
    if (!token) {
      return null;
    }

    try {
      const payload = jwt.verify(token, jwtSecret);
      return payload;
    } catch {
      return null;
    }
  }

  function saveCompiledRuntimeArtifacts(workspaceId, source) {
    return llmWikiBuildService.compileAndPersistSource({ workspaceId, source });
  }


  function saveWikiArtifacts(workspaceId, source) {
    return db.transaction(() => {
      source.wikiBuilt = true;
      db.updateSource(workspaceId, source);
      const compilation = saveCompiledRuntimeArtifacts(workspaceId, source);

      const wikiPage = buildWikiFromSource(source);
      // P5: 链接 Wiki page → Runtime page entry
      const pageEntry = compilation.upsertedEntries.find((e) => e.kind === "page" && e.status !== "superseded");
      if (pageEntry) {
        wikiPage.runtimeEntryId = pageEntry.id;
      }
      db.saveWikiPage(workspaceId, wikiPage);

      const bootstrap = db.getBootstrap(workspaceId);
      const nodeExists = bootstrap.ontologyNodes.some((node) => node.id === wikiPage.title);
      if (!nodeExists) {
        // P5: 找到对应的 Runtime entity entry 并链接
        const entityEntry = compilation.upsertedEntries.find(
          (e) => e.kind === "entity" && e.title === wikiPage.title && e.status !== "superseded",
        );
        db.saveOntologyNode(workspaceId, {
          id: wikiPage.title,
          type: wikiPage.type,
          x: 160 + Math.round(Math.random() * 500),
          y: 160 + Math.round(Math.random() * 320),
          color: "#5b6ef5",
          wiki: wikiPage.id,
          runtimeEntryId: entityEntry ? entityEntry.id : undefined,
          expertWeight: 2,
          expertNote: "由上传文档自动生成的本体节点。",
          status: "active",
          version: 1,
        });
      }

      return wikiPage;
    });
  }

  function saveHumanRuntimeEntry(workspaceId, entry) {
    const saved = db.saveRuntimeEntry(workspaceId, entry);
    db.addRuntimeLog(workspaceId, {
      kind: "human-sync",
      sourceId: entry.compiledFrom?.[0] || null,
      detail: `Synced ${entry.kind} runtime entry: ${entry.title}`,
    });
    return saved;
  }

  function ensureManualEntityRuntimeEntry(workspaceId, title, updatedAt = new Date().toISOString()) {
    return db.saveRuntimeEntry(workspaceId, manualEntityEntry({
      workspaceId,
      title,
      type: "ontology",
      updatedAt,
    }));
  }

  function syncLegacyRelationToRuntime(workspaceId, relation, { sourceId, confidence = 0.75 } = {}) {
    const normalized = normalizeLegacyOntologyEdge(relation);
    if (!normalized?.fromTitle || !normalized?.toTitle || !normalized?.type) {
      return null;
    }
    const updatedAt = new Date().toISOString();
    ensureManualEntityRuntimeEntry(workspaceId, normalized.fromTitle, updatedAt);
    ensureManualEntityRuntimeEntry(workspaceId, normalized.toTitle, updatedAt);
    const edge = runtimeEdgeFromNames({
      ...normalized,
      sourceId: sourceId || `manual_relation_${normalized.fromTitle}_${normalized.type}_${normalized.toTitle}`,
      excerpt: `${normalized.fromTitle} -${normalized.type}-> ${normalized.toTitle}`,
      confidence,
    });
    return db.saveRuntimeEdge(workspaceId, edge);
  }

  async function requireAuth(req, res, next) {
    const payload = getAuth(req);
    if (!payload) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const user = db.findUserById(payload.sub);
    if (!user) {
      clearAuthCookie(res);
      res.status(401).json({ error: "Session is no longer valid." });
      return;
    }

    const workspace = db.getWorkspaceByUserId(user.id);
    req.auth = { user, workspace };
    next();
  }

  app.get("/exports/:workspaceId/:fileName", requireAuth, async (req, res, next) => {
    try {
      if (req.params.workspaceId !== req.auth.workspace.id) {
        res.status(404).json({ error: "Export file not found." });
        return;
      }

      const workspaceDir = path.join(exportsDir, req.auth.workspace.id);
      const exportPath = resolveWorkspaceFile(workspaceDir, req.params.fileName);
      if (!exportPath) {
        res.status(404).json({ error: "Export file not found." });
        return;
      }

      await fs.access(exportPath);
      res.sendFile(exportPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        res.status(404).json({ error: "Export file not found." });
        return;
      }
      next(error);
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: nowIso() });
  });

  app.get("/api/service-capabilities", (_req, res) => {
    res.json({
      sourceParser: {
        ...sourceParsingService.capabilities,
        adapters: sourceParsingService.listAdapters(),
        mcpTools: sourceParsingService.getMcpToolDefinitions(),
      },
      llmWikiBuilder: {
        ...llmWikiBuildService.capabilities,
        compilers: llmWikiBuildService.listCompilers(),
        mcpTools: llmWikiBuildService.getMcpToolDefinitions(),
      },
      reportService: {
        ...reportService.capabilities,
        generators: reportService.listGenerators(),
        exporters: reportService.listExporters(),
        mcpTools: reportService.getMcpToolDefinitions(),
      },
    });
  });

  app.get("/api/openapi.json", (_req, res) => {
    res.json({
      openapi: "3.1.0",
      info: { title: "XinWiki API", version: "1.0.0" },
      paths: {
        "/api/auth/register": { post: { summary: "Register a user and workspace" } },
        "/api/auth/login": { post: { summary: "Login and set session cookie" } },
        "/api/bootstrap": { get: { summary: "Load workspace state" } },
        "/api/service-capabilities": { get: { summary: "List MCP-ready service capabilities and tool contracts" } },
        "/api/sources/upload-and-build": { post: { summary: "Upload sources and compile runtime wiki" } },
        "/api/chat/message/stream": { post: { summary: "Stream grounded runtime chat answers" } },
        "/api/reports/export": { post: { summary: "Export grounded report artifacts" } },
        "/api/llm-wiki/export": { post: { summary: "Project canonical runtime to llm-wiki files" } },
        "/api/llm-wiki/query": { get: { summary: "Query canonical runtime" } },
      },
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid registration payload." });
      return;
    }

    const { email, password, displayName } = parsed.data;
    if (db.findUserByEmail(email)) {
      res.status(409).json({ error: "A user with this email already exists." });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { user, workspace } = db.createUser({
      email,
      passwordHash,
      displayName,
    });
    const token = issueToken(user);
    setAuthCookie(res, token);

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
      },
    });
  });

  app.post("/api/auth/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid login payload." });
      return;
    }

    const user = db.findUserByEmail(parsed.data.email);
    if (!user) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    const valid = await bcrypt.compare(parsed.data.password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    const workspace = db.getWorkspaceByUserId(user.id);
    const token = issueToken(user);
    setAuthCookie(res, token);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
      },
    });
  });

  app.post("/api/auth/logout", requireAuth, (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({
      user: {
        id: req.auth.user.id,
        email: req.auth.user.email,
        displayName: req.auth.user.display_name,
      },
      workspace: {
        id: req.auth.workspace.id,
        name: req.auth.workspace.name,
      },
    });
  });

  app.get("/api/bootstrap", requireAuth, (req, res) => {
    const bootstrap = sanitizeBootstrap(db.getBootstrap(req.auth.workspace.id));
    res.json({
      user: {
        id: req.auth.user.id,
        email: req.auth.user.email,
        displayName: req.auth.user.display_name,
      },
      workspace: {
        id: req.auth.workspace.id,
        name: req.auth.workspace.name,
      },
      ...bootstrap,
    });
  });

  app.get("/api/focuses", requireAuth, (req, res) => {
    res.json(db.getFocuses(req.auth.workspace.id));
  });

  app.put("/api/focuses", requireAuth, (req, res) => {
    const focuses = normalizeFocusPayload(req.body);
    if (!focuses) {
      res.status(400).json({ error: "Invalid focus payload." });
      return;
    }

    res.json({
      focuses: db.saveFocuses(req.auth.workspace.id, focuses),
    });
  });

  app.post("/api/sources/upload", requireAuth, uploader.array("files", MAX_UPLOAD_FILES), async (req, res, next) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      const created = [];

      for (const file of files) {
        const source = await summarizeUpload(file, { sourceParsingService });
        created.push(db.createSource(req.auth.workspace.id, source));
      }

      res.status(201).json({ files: created.map(sanitizeSource) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sources/upload-and-build", requireAuth, uploader.array("files", MAX_UPLOAD_FILES), async (req, res, next) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      const createdSources = [];
      const wikiPages = [];
      const jobIds = [];

      for (const file of files) {
        const source = await summarizeUpload(file, { sourceParsingService });
        db.createSource(req.auth.workspace.id, source);
        createdSources.push(source);

        const wikiPage = saveWikiArtifacts(req.auth.workspace.id, source);
        wikiPages.push(wikiPage);

        const job = buildCompletedJob(source.id);
        db.saveJob(req.auth.workspace.id, job);
        jobIds.push(job.id);
      }

      res.status(201).json({
        sources: createdSources.map(sanitizeSource),
        wikiPages,
        jobIds,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sources/:sourceId/markdown", requireAuth, (req, res) => {
    const source = db.getSource(req.auth.workspace.id, req.params.sourceId);
    if (!source) {
      res.status(404).json({ error: "Source not found." });
      return;
    }

    res.json({
      sourceId: source.id,
      markdown: source.markdown || "",
    });
  });

  app.get("/api/jobs/:jobId", requireAuth, (req, res) => {
    const job = db.getJob(req.auth.workspace.id, req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    res.json(job);
  });

  app.post("/api/sources/:sourceId/reparse", requireAuth, async (req, res, next) => {
    try {
      const source = db.getSource(req.auth.workspace.id, req.params.sourceId);
      if (!source) {
        res.status(404).json({ error: "Source not found." });
        return;
      }

      const stats = await fs.stat(source.storagePath);
      const reparsed = await summarizeUpload(
        {
          originalname: source.name,
          mimetype: source.mimeType,
          size: stats.size,
          path: source.storagePath,
        },
        { ...source, sourceParsingService },
      );

      reparsed.wikiBuilt = false;
      db.updateSource(req.auth.workspace.id, reparsed);

      let wikiPage = null;
      if (req.body?.rebuildWiki) {
        wikiPage = saveWikiArtifacts(req.auth.workspace.id, reparsed);
      }

      const job = buildCompletedJob(reparsed.id);
      db.saveJob(req.auth.workspace.id, job);

      res.json({
        source: sanitizeSource(reparsed),
        wikiPage,
        jobId: job.id,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sources/:sourceId/build-wiki", requireAuth, (req, res) => {
    const source = db.getSource(req.auth.workspace.id, req.params.sourceId);
    if (!source) {
      res.status(404).json({ error: "Source not found." });
      return;
    }

    const wikiPage = saveWikiArtifacts(req.auth.workspace.id, source);

    res.json({ source: sanitizeSource(source), wikiPage });
  });

  app.post("/api/wiki/:wikiId/promote", requireAuth, (req, res) => {
    const workspaceId = req.auth.workspace.id;
    const bootstrap = db.getBootstrap(workspaceId);
    const wikiPage = bootstrap.wikiPages.find((page) => page.id === req.params.wikiId);
    if (!wikiPage) {
      res.status(404).json({ error: "Wiki page not found." });
      return;
    }

    const existingNode = bootstrap.ontologyNodes.find((node) => node.wiki === wikiPage.id);
    if (existingNode) {
      res.json({ node: existingNode, existed: true });
      return;
    }

    // P2: Promote 同步创建 Runtime entity entry（如果不存在）
    const entityEntry = ensureManualEntityRuntimeEntry(
      workspaceId,
      wikiPage.title,
      new Date().toISOString(),
    );
    const entityId = entityEntry.id;
    const node = {
      id: wikiPage.title.slice(0, 10),
      type: wikiPage.type,
      x: 180 + Math.round(Math.random() * 560),
      y: 160 + Math.round(Math.random() * 360),
      color: "#5b6ef5",
      wiki: wikiPage.id,
      runtimeEntryId: entityId,
      expertWeight: 2,
      expertNote: "由 Wiki 页面提升为本体对象，等待专家确认。",
      status: "active",
      version: 1,
    };
    db.saveOntologyNode(workspaceId, node);

    res.status(201).json({ node, existed: false });
  });

  app.post("/api/wiki/:wikiId/relations/promote", requireAuth, (req, res) => {
    const relations = Array.isArray(req.body?.relations) ? req.body.relations : [];
    const bootstrap = db.getBootstrap(req.auth.workspace.id);
    const wikiPage = bootstrap.wikiPages.find((page) => page.id === req.params.wikiId);
    if (!wikiPage) {
      res.status(404).json({ error: "Wiki page not found." });
      return;
    }

    const edges = relations
      .map(normalizeRelationToEdge)
      .filter(Boolean);

    const workspaceId = req.auth.workspace.id;
    const result = db.addOntologyEdges(workspaceId, edges);
    const runtimeEdges = result.createdEdges
      .map((edge) => syncLegacyRelationToRuntime(workspaceId, edge, {
        sourceId: `wiki_relation_${wikiPage.id}`,
        confidence: 0.8,
      }))
      .filter(Boolean);
    res.status(201).json({ ...result, runtimeEdges });
  });

  app.get("/api/ontology/export", requireAuth, (req, res) => {
    const bootstrap = db.getBootstrap(req.auth.workspace.id);
    res.json({
      nodes: bootstrap.ontologyNodes,
      edges: bootstrap.ontologyEdges,
      expertInjections: bootstrap.expertInjections,
    });
  });

  app.post("/api/expert-injections", requireAuth, (req, res) => {
    const parsed = expertInjectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid expert injection payload." });
      return;
    }

    const injection = {
      time: new Date().toLocaleString("zh-CN"),
      ...parsed.data,
    };
    const savedInjection = db.addExpertInjection(req.auth.workspace.id, injection);
    saveHumanRuntimeEntry(req.auth.workspace.id, expertRuntimeEntry({
      workspaceId: req.auth.workspace.id,
      injection: savedInjection,
      updatedAt: new Date().toISOString(),
    }));
    ensureManualEntityRuntimeEntry(req.auth.workspace.id, savedInjection.entity, new Date().toISOString());

    const bootstrap = db.getBootstrap(req.auth.workspace.id);
    const existingNode = bootstrap.ontologyNodes.find((node) => node.id === injection.entity);
    if (existingNode) {
      db.saveOntologyNode(req.auth.workspace.id, {
        ...existingNode,
        expertWeight: injection.weight,
        expertNote: injection.note,
      });
    }

    res.status(201).json({ injection: savedInjection });
  });

  app.post("/api/qa-records", requireAuth, (req, res) => {
    const parsed = qaRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid QA record payload." });
      return;
    }

    const record = db.addQaRecord(req.auth.workspace.id, parsed.data);
    saveHumanRuntimeEntry(req.auth.workspace.id, qaRuntimeEntry({
      workspaceId: req.auth.workspace.id,
      record,
      updatedAt: new Date().toISOString(),
    }));
    res.status(201).json({ record });
  });

  app.post("/api/memories", requireAuth, (req, res) => {
    const parsed = memorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid memory payload." });
      return;
    }

    const memory = {
      time: `${new Date().toLocaleString("zh-CN")} · ${parsed.data.period}`,
      ...parsed.data,
    };
    const savedMemory = db.addMemory(req.auth.workspace.id, memory);
    saveHumanRuntimeEntry(req.auth.workspace.id, memoryRuntimeEntry({
      workspaceId: req.auth.workspace.id,
      memory: savedMemory,
      updatedAt: new Date().toISOString(),
    }));
    res.status(201).json({ memory: savedMemory });
  });

  app.get("/api/chat/thread", requireAuth, (req, res) => {
    res.json({
      thread: db.getCurrentThread(req.auth.workspace.id),
    });
  });

  app.get("/api/chat/messages", requireAuth, (req, res) => {
    res.json(db.listCurrentMessages(req.auth.workspace.id));
  });

  app.post("/api/chat/message", requireAuth, async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid chat payload." });
      return;
    }

    const thread = db.getOrCreateThread(req.auth.workspace.id);
    const question = parsed.data.question;
    db.addMessage(thread.id, "user", question);
    const runtimeSnapshot = db.queryRuntimeSnapshot(req.auth.workspace.id, question);
    const ontologyWeights = db.getOntologyWeights(req.auth.workspace.id);
    const grounded = groundedAnswer({ runtimeSnapshot, question, ontologyWeights });

    let result;
    if (!grounded.canAnswer) {
      result = {
        answer: grounded.answer,
        citations: grounded.citations,
        conversationId: threadDifyConversationId(thread),
      };
    } else {
      try {
        result = await askDify({
          config: {
            apiBaseUrl: process.env.DIFY_API_BASE_URL,
            apiKey: process.env.DIFY_API_KEY,
          },
          userId: req.auth.user.id,
          question,
          thread,
          grounded,
        });
      } catch (error) {
        result = {
          answer: `${grounded.answer}\n\n注：Dify 调用失败，已返回本地 grounded 答案。错误：${error.message}`,
          citations: grounded.citations,
          conversationId: threadDifyConversationId(thread),
        };
      }

      if (!result) {
        result = {
          answer: grounded.answer,
          citations: grounded.citations,
          conversationId: threadDifyConversationId(thread),
        };
      }
    }

    if (result.conversationId && result.conversationId !== threadDifyConversationId(thread)) {
      db.updateThread(req.auth.workspace.id, {
        ...thread,
        difyConversationId: result.conversationId,
      });
    }

    db.addMessage(thread.id, "assistant", result.answer, result.citations);
    res.status(201).json({
      thread: db.getCurrentThread(req.auth.workspace.id),
      answer: result.answer,
      citations: result.citations,
      messages: db.listMessages(thread.id),
    });
  });

  app.post("/api/chat/message/stream", requireAuth, async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid chat payload." });
      return;
    }

    const thread = db.getOrCreateThread(req.auth.workspace.id);
    const question = parsed.data.question;
    db.addMessage(thread.id, "user", question);
    const runtimeSnapshot = db.queryRuntimeSnapshot(req.auth.workspace.id, question);
    const ontologyWeights = db.getOntologyWeights(req.auth.workspace.id);
    const grounded = groundedAnswer({ runtimeSnapshot, question, ontologyWeights });

    // 设置 SSE 响应头
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sseWrite = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (!grounded.canAnswer) {
      sseWrite({ event: "message", answer: grounded.answer, citations: grounded.citations });
      sseWrite({ event: "message_end", answer: grounded.answer, citations: grounded.citations });
      db.addMessage(thread.id, "assistant", grounded.answer, grounded.citations);
      res.end();
      return;
    }

    if (!process.env.DIFY_API_BASE_URL || !process.env.DIFY_API_KEY) {
      sseWrite({ event: "message", answer: grounded.answer, citations: grounded.citations });
      sseWrite({ event: "message_end", answer: grounded.answer, citations: grounded.citations });
      db.addMessage(thread.id, "assistant", grounded.answer, grounded.citations);
      res.end();
      return;
    }

    // 调用 Dify 流式 API
    try {
      const streamTimeout = parseInt(process.env.DIFY_TIMEOUT_MS || "30000", 10);
      const streamController = new AbortController();
      const streamTimer = setTimeout(() => streamController.abort(), streamTimeout);

      let difyResponse;
      try {
        difyResponse = await fetch(
          `${process.env.DIFY_API_BASE_URL.replace(/\/$/, "")}/chat-messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.DIFY_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              inputs: {
                grounding_context: grounded.context,
                grounding_citations: grounded.citations.join(" | "),
              },
              query: question,
              response_mode: "streaming",
              conversation_id: threadDifyConversationId(thread) || undefined,
              user: req.auth.user.id,
            }),
            signal: streamController.signal,
          },
        );
      } finally {
        clearTimeout(streamTimer);
      }

      if (!difyResponse.ok) {
        const errorBody = await difyResponse.text();
        sseWrite({ event: "error", message: `Dify request failed: ${difyResponse.status}` });
        sseWrite({ event: "message_end", answer: grounded.answer, citations: grounded.citations });
        db.addMessage(thread.id, "assistant", grounded.answer, grounded.citations);
        res.end();
        return;
      }

      // 代理 Dify 的 SSE 流
      const reader = difyResponse.body.getReader();
      const decoder = new TextDecoder();
      let fullAnswer = "";
      let conversationId = threadDifyConversationId(thread);
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (!data) continue;

              res.write(`data: ${data}\n\n`);

              try {
                const parsedEvent = JSON.parse(data);
                if (parsedEvent.event === "message_end") {
                  fullAnswer = parsedEvent.answer || fullAnswer;
                  conversationId = parsedEvent.conversation_id || conversationId;
                } else if (parsedEvent.answer) {
                  fullAnswer += parsedEvent.answer;
                }
              } catch {
                // JSON 解析失败，继续
              }
            }
          }
        }
      } catch (streamError) {
        sseWrite({ event: "error", message: streamError.message });
      }

      // 持久化完整回答
      db.addMessage(thread.id, "assistant", fullAnswer || grounded.answer, grounded.citations);
      if (conversationId && conversationId !== threadDifyConversationId(thread)) {
        db.updateThread(req.auth.workspace.id, {
          ...thread,
          difyConversationId: conversationId,
        });
      }

      res.end();
    } catch (error) {
      sseWrite({ event: "error", message: error.message });
      sseWrite({ event: "message_end", answer: grounded.answer, citations: grounded.citations });
      db.addMessage(thread.id, "assistant", grounded.answer, grounded.citations);
      res.end();
    }
  });

  app.post("/api/reports/generate", requireAuth, (req, res) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid report payload." });
      return;
    }

    const bootstrap = db.getBootstrap(req.auth.workspace.id);
    const payload = reportService.generateReport({
      workspace: {
        id: req.auth.workspace.id,
        name: req.auth.workspace.name,
      },
      bootstrap,
      options: parsed.data,
    });

    res.status(201).json({
      ...payload,
      generatedAt: nowIso(),
    });
  });

  app.post("/api/reports/export", requireAuth, async (req, res, next) => {
    try {
      const parsed = reportExportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid report export payload." });
        return;
      }

      const bootstrap = db.getBootstrap(req.auth.workspace.id);
      const payload = reportService.generateReport({
        workspace: {
          id: req.auth.workspace.id,
          name: req.auth.workspace.name,
        },
        bootstrap,
        options: {
          ...parsed.data,
          format: "report",
        },
      });

      const workspaceExportDir = path.join(exportsDir, req.auth.workspace.id);
      const exported = await reportService.exportReport({
        outputDir: workspaceExportDir,
        report: payload.report,
        format: parsed.data.exportFormat,
      });

      res.status(201).json({
        format: parsed.data.exportFormat,
        fileName: exported.fileName,
        downloadUrl: `/exports/${req.auth.workspace.id}/${exported.fileName}`,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/llm-wiki/export", requireAuth, async (req, res, next) => {
    try {
      const workspaceId = req.auth.workspace.id;
      const runtime = db.getRuntimeSnapshot(workspaceId);

      const outputDir = path.join(llmWikiDir, workspaceId);
      const tmpDir = path.join(llmWikiDir, `${workspaceId}.tmp.${Date.now()}`);

      let result;
      try {
        result = await exportRuntimeToLlmWiki({
          outputDir: tmpDir,
          workspace: {
            id: workspaceId,
            name: req.auth.workspace.name,
          },
          runtime,
        });

        // 原子替换
        try { await fs.rm(outputDir, { recursive: true, force: true }); } catch {}
        await fs.rename(tmpDir, outputDir);
      } catch (innerError) {
        try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
        throw innerError;
      }

      res.status(201).json({
        pageCount: result.pageCount,
        workspaceId,
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/llm-wiki/query", requireAuth, (req, res) => {
    const query = String(req.query.q || "").trim();
    if (!query) {
      res.status(400).json({ error: "Query is required." });
      return;
    }

    const runtimeSnapshot = db.queryRuntimeSnapshot(req.auth.workspace.id, query);
    res.json(queryRuntimeSnapshot({
      snapshot: runtimeSnapshot,
      query,
    }));
  });

  app.get("/", async (_req, res, next) => {
    try {
      const html = await fs.readFile(path.join(staticRoot, "front.html"), "utf8");
      res.type("html").send(html);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ error: `Upload exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB size limit.` });
        return;
      }
      if (error.code === "LIMIT_UNEXPECTED_FILE") {
        res.status(400).json({ error: "Unsupported file type." });
        return;
      }
      if (error.code === "LIMIT_FILE_COUNT") {
        res.status(400).json({ error: `Upload supports at most ${MAX_UPLOAD_FILES} files at a time.` });
        return;
      }
    }

    if (process.env.NODE_ENV !== "production") {
      console.error("Unhandled server error:", error);
      res.status(500).json({
        error: error.message || "Internal server error.",
      });
    } else {
      console.error("Unhandled server error:", error.message);
      res.status(500).json({
        error: "Internal server error. Please try again later.",
      });
    }
  });

  return app;
}
