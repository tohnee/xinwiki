import crypto from "node:crypto";

import Database from "better-sqlite3";

import { DEMO_WORKSPACE } from "./data/demo-workspace.js";
import {
  buildEdgeProvenanceRecords,
  buildEntryProvenanceRecords,
  createRuntimeSnapshot,
  normalizeRuntimeIndexView,
  normalizeRuntimeLintIssue,
  normalizeRuntimeLog,
  normalizeRuntimeStalenessMarker,
  normalizeRuntimeSupersededMarker,
  normalizeRuntimeEdge,
  normalizeRuntimeEntry,
  stripEdgeInlineProvenance,
  stripEntryInlineProvenance,
} from "./services/llm-wiki-runtime.js";
import { ensureDir, nowIso, safeJsonParse } from "./utils.js";

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function entityRowId(workspaceId, entityId) {
  return `${workspaceId}:${entityId}`;
}

const DEFAULT_FOCUSES = {
  公司: [["TSMC", true], ["ASML", true], ["NVIDIA", true], ["Qualcomm", false], ["Broadcom", false]],
  制程: [["N2", true], ["N3", true], ["N5", true], ["28nm", false]],
  技术: [["CoWoS", true], ["GAA", true], ["EUV", true], ["SiC", false]],
  材料: [["EUV Photoresist", true], ["Silicon Wafer", true], ["CMP Slurry", false]],
};

function cloneDefaultFocuses() {
  return JSON.parse(JSON.stringify(DEFAULT_FOCUSES));
}

export async function createDatabase({ dataDir }) {
  await ensureDir(dataDir);

  const db = new Database(`${dataDir}/xinwiki.sqlite`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS ontology_nodes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS ontology_edges (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS expert_injections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS qa_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT,
      dify_conversation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES chat_threads(id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS focus_configs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS llm_wiki_runtime_entries (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS llm_wiki_runtime_edges (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS llm_wiki_runtime_provenance (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      ref_role TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS llm_wiki_runtime_logs (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS llm_wiki_runtime_lint_issues (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS llm_wiki_runtime_index_views (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS llm_wiki_runtime_staleness_markers (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS llm_wiki_runtime_superseded_markers (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sources_workspace ON sources(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_pages_workspace ON wiki_pages(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_ontology_nodes_workspace ON ontology_nodes(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_ontology_edges_workspace ON ontology_edges(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_expert_injections_workspace ON expert_injections(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_qa_records_workspace ON qa_records(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_chat_threads_workspace ON chat_threads(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace_id);
  `);

  return buildApi(db);
}

function buildApi(db) {
  const statements = {
    insertUser: db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, created_at)
      VALUES (@id, @email, @passwordHash, @displayName, @createdAt)
    `),
    getUserByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
    getUserById: db.prepare(`SELECT * FROM users WHERE id = ?`),
    insertWorkspace: db.prepare(`
      INSERT INTO workspaces (id, user_id, name, created_at)
      VALUES (@id, @userId, @name, @createdAt)
    `),
    getWorkspaceByUserId: db.prepare(`SELECT * FROM workspaces WHERE user_id = ?`),
    insertSource: db.prepare(`
      INSERT INTO sources (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
    `),
    updateSource: db.prepare(`
      UPDATE sources SET payload_json = @payloadJson, updated_at = @updatedAt
      WHERE id = @id AND workspace_id = @workspaceId
    `),
    listSources: db.prepare(`SELECT * FROM sources WHERE workspace_id = ? ORDER BY created_at DESC`),
    getSource: db.prepare(`SELECT * FROM sources WHERE id = ? AND workspace_id = ?`),
    insertWikiPage: db.prepare(`
      INSERT INTO wiki_pages (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
    `),
    upsertWikiPage: db.prepare(`
      INSERT INTO wiki_pages (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `),
    listWikiPages: db.prepare(`SELECT * FROM wiki_pages WHERE workspace_id = ? ORDER BY created_at ASC`),
    insertOntologyNode: db.prepare(`
      INSERT INTO ontology_nodes (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
    `),
    upsertOntologyNode: db.prepare(`
      INSERT INTO ontology_nodes (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `),
    listOntologyNodes: db.prepare(`SELECT * FROM ontology_nodes WHERE workspace_id = ? ORDER BY created_at ASC`),
    insertOntologyEdge: db.prepare(`
      INSERT INTO ontology_edges (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
    `),
    listOntologyEdges: db.prepare(`SELECT * FROM ontology_edges WHERE workspace_id = ? ORDER BY created_at ASC`),
    deleteOntologyEdges: db.prepare(`DELETE FROM ontology_edges WHERE workspace_id = ?`),
    insertExpertInjection: db.prepare(`
      INSERT INTO expert_injections (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
    `),
    listExpertInjections: db.prepare(`SELECT * FROM expert_injections WHERE workspace_id = ? ORDER BY created_at DESC`),
    insertQaRecord: db.prepare(`
      INSERT INTO qa_records (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
    `),
    listQaRecords: db.prepare(`SELECT * FROM qa_records WHERE workspace_id = ? ORDER BY created_at DESC`),
    insertMemory: db.prepare(`
      INSERT INTO memories (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
    `),
    listMemories: db.prepare(`SELECT * FROM memories WHERE workspace_id = ? ORDER BY created_at DESC`),
    insertThread: db.prepare(`
      INSERT INTO chat_threads (id, workspace_id, title, dify_conversation_id, created_at, updated_at)
      VALUES (@id, @workspaceId, @title, @difyConversationId, @createdAt, @updatedAt)
    `),
    updateThread: db.prepare(`
      UPDATE chat_threads
      SET title = @title, dify_conversation_id = @difyConversationId, updated_at = @updatedAt
      WHERE id = @id AND workspace_id = @workspaceId
    `),
    getThread: db.prepare(`SELECT * FROM chat_threads WHERE id = ? AND workspace_id = ?`),
    getLatestThread: db.prepare(`
      SELECT * FROM chat_threads WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1
    `),
    insertMessage: db.prepare(`
      INSERT INTO chat_messages (id, thread_id, role, content, citations_json, created_at)
      VALUES (@id, @threadId, @role, @content, @citationsJson, @createdAt)
    `),
    listMessagesByThread: db.prepare(`
      SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC
    `),
    upsertJob: db.prepare(`
      INSERT INTO jobs (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `),
    listJobs: db.prepare(`SELECT * FROM jobs WHERE workspace_id = ? ORDER BY updated_at DESC, created_at DESC`),
    getJob: db.prepare(`SELECT * FROM jobs WHERE id = ? AND workspace_id = ?`),
    upsertFocusConfig: db.prepare(`
      INSERT INTO focus_configs (id, workspace_id, payload_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @payloadJson, @createdAt, @updatedAt)
      ON CONFLICT(workspace_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `),
    getFocusConfig: db.prepare(`SELECT * FROM focus_configs WHERE workspace_id = ?`),
    upsertRuntimeEntry: db.prepare(`
      INSERT INTO llm_wiki_runtime_entries (workspace_id, id, payload_json, created_at, updated_at)
      VALUES (@workspaceId, @id, @payloadJson, @createdAt, @updatedAt)
      ON CONFLICT(workspace_id, id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `),
    listRuntimeEntries: db.prepare(`
      SELECT * FROM llm_wiki_runtime_entries WHERE workspace_id = ? ORDER BY id ASC
    `),
    upsertRuntimeEdge: db.prepare(`
      INSERT INTO llm_wiki_runtime_edges (workspace_id, id, payload_json, created_at, updated_at)
      VALUES (@workspaceId, @id, @payloadJson, @createdAt, @updatedAt)
      ON CONFLICT(workspace_id, id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `),
    listRuntimeEdges: db.prepare(`
      SELECT * FROM llm_wiki_runtime_edges WHERE workspace_id = ? ORDER BY id ASC
    `),
    deleteRuntimeEdge: db.prepare(`
      DELETE FROM llm_wiki_runtime_edges WHERE workspace_id = ? AND id = ?
    `),
    deleteRuntimeProvenanceByOwner: db.prepare(`
      DELETE FROM llm_wiki_runtime_provenance
      WHERE workspace_id = ? AND owner_type = ? AND owner_id = ?
    `),
    insertRuntimeProvenance: db.prepare(`
      INSERT INTO llm_wiki_runtime_provenance
      (workspace_id, id, owner_type, owner_id, ref_role, payload_json, created_at, updated_at)
      VALUES (@workspaceId, @id, @ownerType, @ownerId, @refRole, @payloadJson, @createdAt, @updatedAt)
    `),
    listRuntimeProvenance: db.prepare(`
      SELECT * FROM llm_wiki_runtime_provenance
      WHERE workspace_id = ?
      ORDER BY owner_type ASC, owner_id ASC, id ASC
    `),
    insertRuntimeLog: db.prepare(`
      INSERT INTO llm_wiki_runtime_logs (workspace_id, id, payload_json, created_at, updated_at)
      VALUES (@workspaceId, @id, @payloadJson, @createdAt, @updatedAt)
    `),
    listRuntimeLogs: db.prepare(`
      SELECT * FROM llm_wiki_runtime_logs WHERE workspace_id = ? ORDER BY created_at ASC, id ASC
    `),
    insertRuntimeLintIssue: db.prepare(`
      INSERT INTO llm_wiki_runtime_lint_issues (workspace_id, id, payload_json, created_at, updated_at)
      VALUES (@workspaceId, @id, @payloadJson, @createdAt, @updatedAt)
    `),
    listRuntimeLintIssues: db.prepare(`
      SELECT * FROM llm_wiki_runtime_lint_issues WHERE workspace_id = ? ORDER BY created_at ASC, id ASC
    `),
    insertRuntimeIndexView: db.prepare(`
      INSERT INTO llm_wiki_runtime_index_views (workspace_id, id, payload_json, created_at, updated_at)
      VALUES (@workspaceId, @id, @payloadJson, @createdAt, @updatedAt)
    `),
    listRuntimeIndexViews: db.prepare(`
      SELECT * FROM llm_wiki_runtime_index_views WHERE workspace_id = ? ORDER BY created_at ASC, id ASC
    `),
    insertRuntimeStalenessMarker: db.prepare(`
      INSERT INTO llm_wiki_runtime_staleness_markers (workspace_id, id, payload_json, created_at, updated_at)
      VALUES (@workspaceId, @id, @payloadJson, @createdAt, @updatedAt)
    `),
    listRuntimeStalenessMarkers: db.prepare(`
      SELECT * FROM llm_wiki_runtime_staleness_markers WHERE workspace_id = ? ORDER BY created_at ASC, id ASC
    `),
    insertRuntimeSupersededMarker: db.prepare(`
      INSERT INTO llm_wiki_runtime_superseded_markers (workspace_id, id, payload_json, created_at, updated_at)
      VALUES (@workspaceId, @id, @payloadJson, @createdAt, @updatedAt)
    `),
    listRuntimeSupersededMarkers: db.prepare(`
      SELECT * FROM llm_wiki_runtime_superseded_markers WHERE workspace_id = ? ORDER BY created_at ASC, id ASC
    `),
  };

  function jsonRows(rows) {
    return rows.map((row) => safeJsonParse(row.payload_json, {}));
  }

  function normalizeThread(row) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      title: row.title,
      conversationId: row.dify_conversation_id ?? row.difyConversationId ?? null,
      createdAt: row.created_at ?? row.createdAt,
      updatedAt: row.updated_at ?? row.updatedAt,
    };
  }

  function replaceRuntimeProvenance(workspaceId, ownerType, ownerId, records) {
    const createdAt = nowIso();
    statements.deleteRuntimeProvenanceByOwner.run(workspaceId, ownerType, ownerId);
    for (const record of records) {
      statements.insertRuntimeProvenance.run({
        workspaceId,
        id: record.id,
        ownerType,
        ownerId,
        refRole: record.refRole,
        payloadJson: JSON.stringify(record),
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  function seedWorkspace(workspaceId) {
    const createdAt = nowIso();

    for (const file of DEMO_WORKSPACE.files) {
      statements.insertSource.run({
        id: entityRowId(workspaceId, file.id),
        workspaceId,
        payloadJson: JSON.stringify(file),
        createdAt,
        updatedAt: createdAt,
      });
    }

    for (const wikiPage of DEMO_WORKSPACE.wikiPages) {
      statements.insertWikiPage.run({
        id: entityRowId(workspaceId, wikiPage.id),
        workspaceId,
        payloadJson: JSON.stringify(wikiPage),
        createdAt,
        updatedAt: createdAt,
      });
    }

    for (const node of DEMO_WORKSPACE.ontologyNodes) {
      statements.insertOntologyNode.run({
        id: entityRowId(workspaceId, node.id),
        workspaceId,
        payloadJson: JSON.stringify(node),
        createdAt,
        updatedAt: createdAt,
      });
    }

    for (const edge of DEMO_WORKSPACE.ontologyEdges) {
      statements.insertOntologyEdge.run({
        id: createId("edge"),
        workspaceId,
        payloadJson: JSON.stringify(edge),
        createdAt,
        updatedAt: createdAt,
      });
    }

    for (const injection of DEMO_WORKSPACE.expertInjections) {
      statements.insertExpertInjection.run({
        id: createId("expert"),
        workspaceId,
        payloadJson: JSON.stringify(injection),
        createdAt,
        updatedAt: createdAt,
      });
    }

    for (const record of DEMO_WORKSPACE.qaRecords) {
      const payload = {
        id: record.id || createId("qa"),
        ...record,
      };
      statements.insertQaRecord.run({
        id: entityRowId(workspaceId, payload.id),
        workspaceId,
        payloadJson: JSON.stringify(payload),
        createdAt,
        updatedAt: createdAt,
      });
    }

    for (const memory of DEMO_WORKSPACE.memories) {
      statements.insertMemory.run({
        id: createId("memory"),
        workspaceId,
        payloadJson: JSON.stringify(memory),
        createdAt,
        updatedAt: createdAt,
      });
    }

    statements.upsertFocusConfig.run({
      id: createId("focus"),
      workspaceId,
      payloadJson: JSON.stringify(cloneDefaultFocuses()),
      createdAt,
      updatedAt: createdAt,
    });
  }

  return {
    db,
    createUser({ email, passwordHash, displayName }) {
      const createdAt = nowIso();
      const user = {
        id: createId("user"),
        email,
        passwordHash,
        displayName,
        createdAt,
      };
      const workspace = {
        id: createId("workspace"),
        userId: user.id,
        name: `${displayName} 的工作空间`,
        createdAt,
      };

      const transaction = db.transaction(() => {
        statements.insertUser.run(user);
        statements.insertWorkspace.run(workspace);
        seedWorkspace(workspace.id);
      });

      transaction();
      return { user, workspace };
    },
    findUserByEmail(email) {
      return statements.getUserByEmail.get(email);
    },
    findUserById(id) {
      return statements.getUserById.get(id);
    },
    getWorkspaceByUserId(userId) {
      return statements.getWorkspaceByUserId.get(userId);
    },
    getBootstrap(workspaceId) {
      const chatThreadRow = this.getOrCreateThread(workspaceId);
      return {
        files: jsonRows(statements.listSources.all(workspaceId)),
        wikiPages: jsonRows(statements.listWikiPages.all(workspaceId)),
        ontologyNodes: jsonRows(statements.listOntologyNodes.all(workspaceId)),
        ontologyEdges: jsonRows(statements.listOntologyEdges.all(workspaceId)),
        expertInjections: jsonRows(statements.listExpertInjections.all(workspaceId)),
        qaRecords: jsonRows(statements.listQaRecords.all(workspaceId)),
        memories: jsonRows(statements.listMemories.all(workspaceId)),
        jobs: jsonRows(statements.listJobs.all(workspaceId)),
        focuses: this.getFocuses(workspaceId),
        chatThread: normalizeThread(chatThreadRow),
        chatMessages: this.listMessages(chatThreadRow.id),
      };
    },
    createSource(workspaceId, source) {
      const createdAt = nowIso();
      statements.insertSource.run({
        id: entityRowId(workspaceId, source.id),
        workspaceId,
        payloadJson: JSON.stringify(source),
        createdAt,
        updatedAt: createdAt,
      });
      return source;
    },
    getSource(workspaceId, sourceId) {
      const row = statements.getSource.get(entityRowId(workspaceId, sourceId), workspaceId);
      return row ? safeJsonParse(row.payload_json, null) : null;
    },
    updateSource(workspaceId, source) {
      statements.updateSource.run({
        id: entityRowId(workspaceId, source.id),
        workspaceId,
        payloadJson: JSON.stringify(source),
        updatedAt: nowIso(),
      });
      return source;
    },
    saveWikiPage(workspaceId, wikiPage) {
      const createdAt = nowIso();
      statements.upsertWikiPage.run({
        id: entityRowId(workspaceId, wikiPage.id),
        workspaceId,
        payloadJson: JSON.stringify(wikiPage),
        createdAt,
        updatedAt: createdAt,
      });
      return wikiPage;
    },
    saveOntologyNode(workspaceId, node) {
      const createdAt = nowIso();
      statements.upsertOntologyNode.run({
        id: entityRowId(workspaceId, node.id),
        workspaceId,
        payloadJson: JSON.stringify(node),
        createdAt,
        updatedAt: createdAt,
      });
      return node;
    },
    replaceOntologyEdges(workspaceId, edges) {
      const createdAt = nowIso();
      const transaction = db.transaction(() => {
        statements.deleteOntologyEdges.run(workspaceId);
        for (const edge of edges) {
          statements.insertOntologyEdge.run({
            id: createId("edge"),
            workspaceId,
            payloadJson: JSON.stringify(edge),
            createdAt,
            updatedAt: createdAt,
          });
        }
      });
      transaction();
      return edges;
    },
    addOntologyEdges(workspaceId, edges) {
      const existing = jsonRows(statements.listOntologyEdges.all(workspaceId));
      const edgeKey = (edge) => JSON.stringify(edge);
      const existingKeys = new Set(existing.map(edgeKey));
      const createdAt = nowIso();
      const createdEdges = [];
      const skippedEdges = [];

      for (const edge of edges) {
        if (existingKeys.has(edgeKey(edge))) {
          skippedEdges.push(edge);
          continue;
        }

        statements.insertOntologyEdge.run({
          id: createId("edge"),
          workspaceId,
          payloadJson: JSON.stringify(edge),
          createdAt,
          updatedAt: createdAt,
        });
        existingKeys.add(edgeKey(edge));
        createdEdges.push(edge);
      }

      return { createdEdges, skippedEdges };
    },
    addExpertInjection(workspaceId, injection) {
      const createdAt = nowIso();
      statements.insertExpertInjection.run({
        id: createId("expert"),
        workspaceId,
        payloadJson: JSON.stringify(injection),
        createdAt,
        updatedAt: createdAt,
      });
      return injection;
    },
    addQaRecord(workspaceId, record) {
      const createdAt = nowIso();
      const enriched = {
        id: record.id || createId("qa"),
        createdAt,
        ...record,
      };
      statements.insertQaRecord.run({
        id: entityRowId(workspaceId, enriched.id),
        workspaceId,
        payloadJson: JSON.stringify(enriched),
        createdAt,
        updatedAt: createdAt,
      });
      return enriched;
    },
    addMemory(workspaceId, memory) {
      const createdAt = nowIso();
      const enriched = {
        id: createId("memory"),
        createdAt,
        ...memory,
      };
      statements.insertMemory.run({
        id: enriched.id,
        workspaceId,
        payloadJson: JSON.stringify(enriched),
        createdAt,
        updatedAt: createdAt,
      });
      return enriched;
    },
    getOrCreateThread(workspaceId) {
      const existing = statements.getLatestThread.get(workspaceId);
      if (existing) {
        return existing;
      }

      const createdAt = nowIso();
      const thread = {
        id: createId("thread"),
        workspaceId,
        title: "XinWiki Chat",
        difyConversationId: null,
        createdAt,
        updatedAt: createdAt,
      };
      statements.insertThread.run(thread);
      return thread;
    },
    getCurrentThread(workspaceId) {
      return normalizeThread(this.getOrCreateThread(workspaceId));
    },
    updateThread(workspaceId, thread) {
      const updated = {
        ...thread,
        workspaceId,
        updatedAt: nowIso(),
      };
      statements.updateThread.run(updated);
      return updated;
    },
    addMessage(threadId, role, content, citations = []) {
      statements.insertMessage.run({
        id: createId("msg"),
        threadId,
        role,
        content,
        citationsJson: JSON.stringify(citations),
        createdAt: nowIso(),
      });
    },
    listMessages(threadId) {
      return statements.listMessagesByThread.all(threadId).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        citations: safeJsonParse(row.citations_json, []),
        createdAt: row.created_at,
      }));
    },
    listCurrentMessages(workspaceId) {
      const thread = this.getOrCreateThread(workspaceId);
      return {
        thread: normalizeThread(thread),
        messages: this.listMessages(thread.id),
      };
    },
    saveJob(workspaceId, job) {
      const createdAt = nowIso();
      statements.upsertJob.run({
        id: job.id,
        workspaceId,
        payloadJson: JSON.stringify(job),
        createdAt,
        updatedAt: createdAt,
      });
      return job;
    },
    getJob(workspaceId, jobId) {
      const row = statements.getJob.get(jobId, workspaceId);
      return row ? safeJsonParse(row.payload_json, null) : null;
    },
    getFocuses(workspaceId) {
      const row = statements.getFocusConfig.get(workspaceId);
      return row ? safeJsonParse(row.payload_json, cloneDefaultFocuses()) : cloneDefaultFocuses();
    },
    saveFocuses(workspaceId, focuses) {
      const current = statements.getFocusConfig.get(workspaceId);
      const createdAt = current?.created_at || nowIso();
      const updatedAt = nowIso();
      statements.upsertFocusConfig.run({
        id: current?.id || createId("focus"),
        workspaceId,
        payloadJson: JSON.stringify(focuses),
        createdAt,
        updatedAt,
      });
      return focuses;
    },
    saveRuntimeEntry(workspaceId, entry) {
      const normalized = normalizeRuntimeEntry(workspaceId, entry);
      const provenance = buildEntryProvenanceRecords(workspaceId, normalized);
      const storedEntry = stripEntryInlineProvenance(normalized);
      const createdAt = nowIso();
      const transaction = db.transaction(() => {
        statements.upsertRuntimeEntry.run({
          workspaceId,
          id: storedEntry.id,
          payloadJson: JSON.stringify(storedEntry),
          createdAt,
          updatedAt: createdAt,
        });
        replaceRuntimeProvenance(workspaceId, "entry", storedEntry.id, provenance);
      });
      transaction();
      return normalized;
    },
    saveRuntimeEdge(workspaceId, edge) {
      const normalized = normalizeRuntimeEdge(workspaceId, edge);
      const provenance = buildEdgeProvenanceRecords(workspaceId, normalized);
      const storedEdge = stripEdgeInlineProvenance(normalized);
      const createdAt = nowIso();
      const transaction = db.transaction(() => {
        statements.upsertRuntimeEdge.run({
          workspaceId,
          id: storedEdge.id,
          payloadJson: JSON.stringify(storedEdge),
          createdAt,
          updatedAt: createdAt,
        });
        replaceRuntimeProvenance(workspaceId, "edge", storedEdge.id, provenance);
      });
      transaction();
      return normalized;
    },
    deleteRuntimeEdge(workspaceId, edgeId) {
      const transaction = db.transaction(() => {
        statements.deleteRuntimeEdge.run(workspaceId, edgeId);
        statements.deleteRuntimeProvenanceByOwner.run(workspaceId, "edge", edgeId);
      });
      transaction();
    },
    addRuntimeLog(workspaceId, log) {
      const createdAt = nowIso();
      const normalized = normalizeRuntimeLog(workspaceId, log, createId("runtime_log"));
      statements.insertRuntimeLog.run({
        workspaceId,
        id: normalized.id,
        payloadJson: JSON.stringify({
          ...normalized,
          createdAt: normalized.createdAt ?? createdAt,
        }),
        createdAt,
        updatedAt: createdAt,
      });
      return normalized;
    },
    addRuntimeLintIssue(workspaceId, lintIssue) {
      const createdAt = nowIso();
      const normalized = normalizeRuntimeLintIssue(workspaceId, lintIssue, createId("runtime_lint"));
      statements.insertRuntimeLintIssue.run({
        workspaceId,
        id: normalized.id,
        payloadJson: JSON.stringify({
          ...normalized,
          createdAt: normalized.createdAt ?? createdAt,
        }),
        createdAt,
        updatedAt: createdAt,
      });
      return normalized;
    },
    addRuntimeIndexView(workspaceId, indexView) {
      const createdAt = nowIso();
      const normalized = normalizeRuntimeIndexView(workspaceId, indexView, createId("runtime_index"));
      statements.insertRuntimeIndexView.run({
        workspaceId,
        id: normalized.id,
        payloadJson: JSON.stringify({
          ...normalized,
          createdAt: normalized.createdAt ?? createdAt,
        }),
        createdAt,
        updatedAt: createdAt,
      });
      return normalized;
    },
    addRuntimeStalenessMarker(workspaceId, marker) {
      const createdAt = nowIso();
      const normalized = normalizeRuntimeStalenessMarker(workspaceId, marker, createId("runtime_stale"));
      statements.insertRuntimeStalenessMarker.run({
        workspaceId,
        id: normalized.id,
        payloadJson: JSON.stringify({
          ...normalized,
          createdAt: normalized.createdAt ?? createdAt,
        }),
        createdAt,
        updatedAt: createdAt,
      });
      return normalized;
    },
    addRuntimeSupersededMarker(workspaceId, marker) {
      const createdAt = nowIso();
      const normalized = normalizeRuntimeSupersededMarker(workspaceId, marker, createId("runtime_superseded"));
      statements.insertRuntimeSupersededMarker.run({
        workspaceId,
        id: normalized.id,
        payloadJson: JSON.stringify({
          ...normalized,
          createdAt: normalized.createdAt ?? createdAt,
        }),
        createdAt,
        updatedAt: createdAt,
      });
      return normalized;
    },
    getRuntimeSnapshot(workspaceId) {
      return createRuntimeSnapshot({
        entries: jsonRows(statements.listRuntimeEntries.all(workspaceId)),
        edges: jsonRows(statements.listRuntimeEdges.all(workspaceId)),
        provenance: jsonRows(statements.listRuntimeProvenance.all(workspaceId)),
        logs: jsonRows(statements.listRuntimeLogs.all(workspaceId)),
        lintIssues: jsonRows(statements.listRuntimeLintIssues.all(workspaceId)),
        indexViews: jsonRows(statements.listRuntimeIndexViews.all(workspaceId)),
        stalenessMarkers: jsonRows(statements.listRuntimeStalenessMarkers.all(workspaceId)),
        supersededMarkers: jsonRows(statements.listRuntimeSupersededMarkers.all(workspaceId)),
      });
    },
  };
}
