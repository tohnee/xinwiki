# XinWiki Backend Demo

基于现有 `front.html` 补齐的完整后端示例，提供：

- 多用户注册、登录、会话隔离
- 来源、Wiki、本体、专家经验、记忆、问答记录的持久化
- 文档上传、重新解析、结构化 Markdown 导出、来源 jobs 状态追踪
- 上传后自动构建 Wiki，并支持从来源重新构建 / 更新 Wiki
- Dify Chatbot 后端代理
- 结构化报告生成与 Word / PDF 真导出
- `llm-wiki` 兼容导出

## 技术栈

- Node.js
- Express
- SQLite (`better-sqlite3`)
- JWT + HttpOnly Cookie
- Vitest + Supertest

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

3. 启动服务

```bash
npm start
```

4. 打开浏览器

- 访问 [http://localhost:3000](http://localhost:3000)
- 如你在 `.env` 中把 `PORT` 改成 `3111`，则访问 [http://localhost:3111](http://localhost:3111)

5. 注册账号

- 示例账号不是内置默认用户
- 需要先通过注册页创建账号，再使用该账号登录

## 默认行为

- 首次注册会创建独立工作空间
- 每个工作空间会自动写入一份半导体领域的 seed 数据
- 前端登录后会通过 `/api/bootstrap` 拉取真实数据
- 如果未配置 Dify，聊天接口会回退到本地 grounded fallback
- `/api/bootstrap` 会返回来源、Wiki、本体、聊天历史、focus 配置和最近 jobs，供单文件前端直接水合
- 上传仅允许白名单扩展名，单文件大小上限为 `5MB`

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | HTTP 端口，默认 `3000` |
| `JWT_SECRET` | JWT 签名密钥 |
| `DATA_DIR` | SQLite 数据目录 |
| `UPLOADS_DIR` | 上传文件目录 |
| `LLM_WIKI_DIR` | `llm-wiki` 导出目录 |
| `DIFY_API_BASE_URL` | Dify API 根地址，例如 `https://api.dify.ai/v1` |
| `DIFY_API_KEY` | Dify API Key |

## 主要接口

### 认证

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### 工作空间

- `GET /api/bootstrap`
- `POST /api/sources/upload`
- `POST /api/sources/upload-and-build`
- `POST /api/sources/:sourceId/reparse`
- `GET /api/sources/:sourceId/markdown`
- `GET /api/jobs/:jobId`
- `POST /api/sources/:sourceId/build-wiki`
- `POST /api/wiki/:wikiId/promote`
- `POST /api/wiki/:wikiId/relations/promote`
- `GET /api/ontology/export`
- `GET /api/focuses`
- `PUT /api/focuses`
- `POST /api/expert-injections`
- `POST /api/qa-records`
- `POST /api/memories`
- `GET /api/chat/thread`
- `GET /api/chat/messages`
- `POST /api/chat/message`
- `POST /api/chat/message/stream`
- `POST /api/reports/generate`
- `POST /api/reports/export`
- `POST /api/llm-wiki/export`
- `GET /api/llm-wiki/query?q=关键词`

## 上传与来源流程

- 允许类型：`.md`, `.markdown`, `.txt`, `.html`, `.htm`, `.pdf`, `.doc`, `.docx`, `.ppt`, `.pptx`
- 大小限制：单文件 `5MB`
- 推荐前端流程：
  - `upload-and-build` 创建 source、Wiki 和 job
  - `bootstrap` 回填 jobs 与来源详情
  - `reparse` 重新抽取内容并可同步重建 Wiki
  - `markdown` 返回结构化 Markdown，供预览或下载

## 报告导出

- `POST /api/reports/generate` 返回结构化 `report` 和 `markdown`
- `POST /api/reports/export` 支持 `docx` 与 `pdf`
- 导出结果会写入 `/exports/<workspace-id>/`
- 下载链接需要登录态 Cookie，未认证或跨工作空间访问会被拒绝
- 导出接口不再向前端暴露服务器绝对路径
- Word 导出使用带封面、指标卡、章节与引用块的 HTML 模板
- PDF 导出使用结构化纯文本模板，经系统 PDF 管线转换生成

## llm-wiki 统一知识运行时

系统以 **llm-wiki Runtime** 作为唯一知识本体——上传解析、知识编译、查询检索、聊天问答、导出投影全部操作同一份持久化知识库。

### 架构

```
Upload → Parser Adapter → DocumentParseResult → Compiler → Runtime (entries/edges/logs)
                                                      ↓
                                            Query Service ← Chat / API
                                                      ↓
                                              Export Projection
```

- **Parser Adapter**：可插拔解析边界，当前内置 local-basic 解析器，为未来接入 MinerU 等模型解析服务预留接口
- **Runtime**：entries（页面/实体）、edges（语义关系）、provenance（溯源）、logs（编译日志）等持久化表，全部按 workspace 隔离
- **Compiler**：增量编译器，从 `DocumentParseResult` 编译到 runtime，支持幂等重编译与 supersede/stale 标记
- **Query Service**：`/api/llm-wiki/query` 和 `/api/chat/message` 共用同一 runtime 检索路径，Finance 类问题有 runtime 证据可答、无证据拒答
- **Export Projection**：从 runtime snapshot 投影生成导出文件

### 导出

导出接口会在 `LLM_WIKI_DIR/<workspace-id>/` 下生成：

- `wiki/*.md` — 每篇活跃条目的 Markdown（含 frontmatter 与关系链接）
- `_schema/graph.json` — 节点与边图谱
- `index.md` — 全部活跃条目索引
- `log.md` — 编译日志

输出遵循公开的 `llm-wiki` 格式规范，适合接入 Obsidian 等工具链。

## 测试

```bash
npm test
```

当前测试覆盖（11 文件 / 42 用例）：

- 注册、登录、当前用户
- Parser Adapter 契约与 `.markdown` 文本解析
- Runtime 持久化（entries / edges / provenance / maintenance metadata / workspace 隔离 / foreign key 完整性）
- Compiler 增量编译（page/entity/edge 生成、provenance 保留、supersede/stale 标记、幂等重编译）
- Shared Runtime Query Service（query 与 chat 共用检索路径、Finance strict-evidence）
- Export Runtime Projection（`wiki/*.md` / `_schema/graph.json` / `index.md` / `log.md`）
- `llm-wiki` 查询接口
- 注册后 `bootstrap`、来源解析、jobs 回填与导出流程
- 上传安全校验
- 双用户 source / chat / memory 隔离
- 报告模板结构与 Word / PDF 真导出

## 当前限制

- 上传后的文档解析仍是轻量摘要，不包含真正的 PDF/DOCX 内容抽取
- PDF / DOCX 依赖 macOS 系统工具导出，跨平台兼容性尚未额外封装
- 前端仍是单文件应用，但来源页、报告页、Wiki / 本体关键动作已切到真实后端 API
- Dify 流式端点已实现，但未覆盖 token 用量统计
