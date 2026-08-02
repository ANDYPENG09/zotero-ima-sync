# Zotero IMA Sync

> **English** | [中文](#中文)

A Zotero plugin that syncs your Zotero items and their **PDF attachments** to the [Tencent ima knowledge base](https://ima.qq.com) (ima.qq.com), building a searchable literature RAG knowledge base. Ideal for researchers maintaining a personal "Literature Library" in ima.

**Compatibility: Zotero 7 / 8 / 9** (manifest declares `strict_max_version: 9.*`, fully adapted to Zotero 9: no `ChromeUtils.import`, uses `applications.zotero`, `registerChrome` + `loadSubScript` architecture, native `Zotero.PreferencePanes`, `#zotero-itemmenu` context-menu injection).

---

## Features

- **Three sync scopes**: selected items / a specific Collection / all items
- **Entry points**: item context menu "Sync to ima Knowledge Base…" / Preferences panel (Settings → Advanced → Plugins → IMA Sync)
- Syncs only literature items with PDF attachments (`application/pdf`)
- **Upload pipeline**: `create_media` (obtain upload URL + COS temporary credentials) → upload file → `add_knowledge` (add to knowledge base)
- Prefers the `cos_url` returned by `create_media` (pre-signed / gateway URL); falls back to COS V5 signed upload
- Synced items are marked in the Zotero `Extra` field with `ima-sync-media-id`, so repeat syncs are **automatically skipped** (optional "force re-sync" checkbox)
- Duplicate-name strategy: Keep both (SAVE) / Replace (REPLACE) / Skip (CANCEL)
- API mode: OpenAPI (default) / MCP
- Real-time progress window (per-item success / skipped / failure status)

## Installation

1. Zotero 7/8/9 → Menu "Tools → Plugins"
2. Gear icon → **Install Plugin From File…** → select `zotero-ima-sync-0.0.1.xpi`
3. Restart Zotero. Right-click any item to see "Sync to ima Knowledge Base…"; the "IMA Sync" tab appears under Settings → Advanced → Plugins.

> **Note on signing**: This plugin is **unsigned** (like the reference plugins used during development). If your Zotero enforces signature requirements, open the config editor (Settings → Advanced → General → Open Config Editor) and set `xpinstall.signatures.required` to `false`, then restart Zotero before installing.

## Configuration (two steps)

### 1. Get an IMA Skills API Key (recommended)

1. Open [ima.qq.com/agent-interface](https://ima.qq.com/agent-interface) in a browser
   (or in the ima client: avatar at bottom-left → Settings → **IMA Skills** / developer options)
2. Find "Generate API Key" and generate one (the API key is usually shown only once — copy it immediately)
3. Copy both: **Client ID** and **Api Key** (format `ima_sk_xxxxxxxx`)
4. Paste them into the plugin's "Control Panel / Preferences" **Client ID** and **Api Key** fields

> The API Key is valid for about **1 month**. When syncing fails with `ima 认证失败` (authentication failed), go back to `agent-interface`, regenerate, and paste the new key. This is the official developer credential — far more stable than scraping a `Bearer token` from the web page (which expires within hours, and the `token` in localStorage is not an API token).

### 2. Specify the target knowledge base

- Click **"获取我的知识库" (Get My Knowledge Bases)** in the control panel — it lists all your knowledge bases; click one to select and fill in its ID.
- Or manually paste an ID into the "Knowledge Base ID" field.

> **⚠️ The knowledge-base ID is NOT the numeric ID in the ima web URL!**
> The OpenAPI channel (default) requires the **encoded-string ID** (e.g. `edSsDBQXgg0b6abuuUadtkfe4NO6InDx8JhMmWv90n0=`), returned by `/get_addable_knowledge_base_list`. The numeric ID (`7489224555130210`) you see in the ima address bar belongs to a **different ID system** — feeding it to OpenAPI returns `220004` (permission / not found). **Always use the "获取我的知识库" button; don't hand-type the URL numeric ID.**

> **Legacy Bearer token fallback**: if you cannot use an IMA Skills API Key, you may fill a `Bearer token` in the Preferences panel "Advanced" section (obtained from the `Authorization: Bearer` header in the web DevTools → Network panel). This method is unstable and expires quickly — use it only as a last resort.

## Usage

1. Right-click an item in Zotero → **Sync to ima Knowledge Base…** (or open the control panel from the preferences panel)
2. Confirm the credential / knowledge-base ID / sync scope
3. Click **Start Sync** — the progress panel shows per-item status
4. When done, check the ima knowledge base; files appear shortly after parsing, and are then searchable

## Technical Notes

- Protocol: Tencent ima (`https://ima.qq.com`)
  - **IMA Skills OpenAPI (default)**: `POST /openapi/wiki/v1/get_addable_knowledge_base_list` (list writable bases — **`limit:50` is required**, otherwise error `51`), `/create_media`, `/add_knowledge`, `/get_knowledge_list`, `/import_urls`. Auth headers `ima-openapi-clientid` / `ima-openapi-apikey` (from the API Key generated at `agent-interface`). Responses: `{code, msg, data}`
  - **Bearer / MCP (legacy fallback)**: `POST /openapi/media/v1/create_media`, `/openapi/knowledge_base/v1/add_knowledge`, `POST /mcp` (JSON-RPC). Auth `Authorization: Bearer <token>`
- **`add_knowledge` request body (OpenAPI)**: must include `media_id` + `knowledge_base_id` + `media_type` (PDF=1, WEB=2, mapped by extension) + `title` + `folder_id` (empty string for root) + `file_info.{cos_key, file_name, file_size}` (`cos_key` comes from `cos_credential.cos_key` returned by `create_media`). Missing `media_type/title/file_info` → error `220001`.
- Upload: prefers `cos_url` direct PUT; falls back to COS XML API (V5 signature, HMAC-SHA1, credentials dynamically issued by `create_media`, using the standard domain `<bucket>.cos.<region>.myqcloud.com`)
- Network layer: global `fetch` first, falls back to `Zotero.HTTP`; file reads via `IOUtils` (available in Zotero 7/8/9)
- Plugin architecture (Zotero 9 adapted): bootstrap (`registerChrome` + `loadSubScript`) → `content/ima-sync-main.js` (preferences panel + context menu + control panel window)
- Sync state stored in the item `Extra` field: `ima-sync-media-id` / `ima-sync-time`

## Known Limitations (tested, Aug 2026)

- **Two ID systems (important)**: OpenAPI (`/get_addable_knowledge_base_list` etc.) returns **base64/URL-safe encoded** knowledge-base IDs (e.g. `edSsDBQXgg0b...n0=`); the ima web address bar and the MCP connector use **numeric** IDs (e.g. `7489224555130210`). They cannot be mixed — the numeric ID fed to OpenAPI yields `220004`. The plugin's "获取我的知识库" button always retrieves the encoded ID; don't hand-type the URL numeric ID.
- IMA Skills API Keys expire after ~1 month; regenerate at `agent-interface` when needed. Legacy Bearer tokens expire quickly (hours to days).

## Directory Structure

```
zotero-ima-sync/
├── manifest.json          # Plugin metadata (applications.zotero, Zotero 7/8/9)
├── bootstrap.js           # Zotero entry point (registerChrome + loadSubScript)
├── content/
│   ├── ima-sync-main.js   # Main script: preferences / context menu / control panel
│   ├── kbselect.xhtml     # Knowledge-base picker dialog (replaces fragile Services.prompt.select)
│   ├── imaClient.js       # ima client (OpenAPI/MCP dual mode, fetch-first)
│   ├── cosUploader.js     # cos_url direct PUT + COS V5 signed upload (with pure-JS SHA-1 fallback)
│   ├── syncEngine.js      # Sync engine
│   ├── config.js          # Config read/write (Zotero.Prefs)
│   ├── pane.xhtml/js      # Sync control panel
│   └── prefs.xhtml/js     # Preferences tab
├── icons/
├── build.py               # Build script (python build.py)
└── zotero-ima-sync-0.0.1.xpi
```

## Build from Source

```bash
python build.py
```

## Privacy & Security

- Credentials are stored in Zotero's local `prefs.js` (same directory as your Zotero data), used only on this machine;
- The plugin performs **one-way "local → ima" sync only**; it does not read other knowledge-base content from ima;
- PDFs are uploaded as raw files to Tencent Cloud COS (ima's official storage) and indexed by ima;
- No telemetry, no third-party tracking, no analytics.

## License

[MIT](LICENSE)

---

# 中文

# Zotero IMA Sync — Zotero 文献同步到 ima 知识库

将 Zotero 条目及其 **PDF 附件** 一键同步到腾讯 ima 知识库（ima.qq.com），
在 ima 中即可对全部文献做 AI 检索 / RAG 问答。适合维护「文献库」类个人知识库的科研用户。

**兼容性：Zotero 7 / 8 / 9**（manifest 声明 `strict_max_version: 9.*`，已适配 Zotero 9：
移除 `ChromeUtils.import`、改用 `applications.zotero` 声明、`registerChrome` + `loadSubScript` 架构、原生 `Zotero.PreferencePanes`、`#zotero-itemmenu` 右键菜单注入）。

## 功能

- 三种同步范围：当前选中条目 / 某个 Collection / 全部条目
- 入口：条目右键菜单「同步到 ima 知识库…」 / 偏好面板（设置 → 高级 → 插件 → IMA Sync）
- 只同步带 PDF 附件的文献条目（`application/pdf`）
- 上传链路：`create_media`（获取上传地址 + COS 临时凭证）→ 上传文件 → `add_knowledge` 入库
- 上传优先使用 `create_media` 返回的 `cos_url`（预签名/网关地址）；未返回时回退 COS V5 签名上传
- 已同步条目自动在 Zotero `Extra` 字段记录 `ima-sync-media-id`，重复同步自动跳过（可勾选强制重传）
- 重名策略可选：保留两个（SAVE）/ 覆盖（REPLACE）/ 跳过（CANCEL）
- API 模式可选：OpenAPI（默认）/ MCP
- 实时进度窗口（成功 / 跳过 / 失败逐条显示）

## 安装

1. Zotero 7/8/9 → 菜单「工具 → 插件」
2. 齿轮图标 → **Install Plugin From File…** → 选择 `zotero-ima-sync-0.0.1.xpi`
3. 重启 Zotero 后，在条目上右键即可看到「同步到 ima 知识库…」；设置 → 高级 → 插件 中有「IMA Sync」选项卡

> **关于插件签名**：本插件**未签名**。若你的 Zotero 强制要求签名（部分新版本默认开启），
> 可在 Zotero 中打开 config 编辑器（设置 → 高级 → 常规 → Open Config Editor），
> 将 `xpinstall.signatures.required` 设为 `false`，重启 Zotero 后再安装。

## 配置（只需两步）

### 1. 获取 IMA Skills API Key（推荐）

1. 浏览器打开 [ima.qq.com/agent-interface](https://ima.qq.com/agent-interface)
   （或在 ima 客户端：左下角头像 → 设置 → **IMA Skills** / 开发者选项）
2. 找到「生成 API Key」入口，点击生成（Api Key 通常只显示一次，请立即复制）
3. 复制两样东西：**Client ID** 与 **Api Key**（格式 `ima_sk_xxxxxxxx`）
4. 粘贴到插件「控制面板 / 偏好设置」的 **Client ID** 与 **Api Key** 输入框

> API Key 有效期约 **1 个月**，过期后在同步时若提示 `ima 认证失败`，回到
> `agent-interface` 重新生成并粘贴新 Key 即可。这是官方开放的开发者凭证，稳定可靠，
> 比从网页版抓 `Bearer token`（数小时就过期、且 localStorage 的 `token` 字段并非 API token）更适合长期使用。

### 2. 指定目标知识库

- 在控制面板点 **「获取我的知识库」**，自动列出你名下的知识库，点击即可选中并填入 ID；
- 或手动在「知识库 ID」填入 ID。

> **⚠️ 知识库 ID 不是 ima 网页 URL 里的纯数字 ID！**
> OpenAPI 通道（本插件默认）要求的是 **编码串 ID**（形如 `edSsDBQXgg0b6abuuUadtkfe4NO6InDx8JhMmWv90n0=`），
> 由 `/get_addable_knowledge_base_list` 接口返回。ima 网页地址栏里的 `7489224555130210` 这类纯数字 ID 是**另一套体系**，
> 直接填进 OpenAPI 调用会报 `220004`（权限/不存在）。**正确做法**：用「获取我的知识库」按钮自动填入，不要手填 URL 数字。

> **旧版 Bearer token 回退**：若因环境限制无法使用 IMA Skills API Key，可在偏好设置面板
> 「高级」折叠区填写 `Bearer token`（从网页版 DevTools → Network 面板 `Authorization: Bearer` 请求头获取）。
> 该方式不稳定、易过期，仅作兜底。

## 使用

1. 在 Zotero 条目上右键 → **同步到 ima 知识库…**（或在偏好面板打开控制面板）
2. 确认 token / 知识库 ID / 同步范围
3. 点击 **开始同步**，进度面板逐条显示状态
4. 完成后到 ima 知识库中确认文件已入库（解析需要一点时间，稍后即可检索）

## 技术说明

- 协议：腾讯 ima（`https://ima.qq.com`）
  - **IMA Skills OpenAPI（默认）**：`POST /openapi/wiki/v1/get_addable_knowledge_base_list`（列可写库，**必须带 `limit:50`**，否则报 `51`）、`/create_media`、`/add_knowledge`、`/get_knowledge_list`、`/import_urls`
    认证头 `ima-openapi-clientid` / `ima-openapi-apikey`（来自 `agent-interface` 生成的 API Key），响应 `{code,msg,data}`
  - **Bearer / MCP（旧回退）**：`POST /openapi/media/v1/create_media`、`/openapi/knowledge_base/v1/add_knowledge`、`POST /mcp`（JSON-RPC），
    认证 `Authorization: Bearer <token>`
- **`add_knowledge` 请求体（OpenAPI）**：必须含 `media_id` + `knowledge_base_id` + `media_type`（PDF=1，WEB=2，由扩展名映射）+ `title` + `folder_id`（根目录为空串）+ `file_info.{cos_key, file_name, file_size}`（`cos_key` 取自 `create_media` 返回的 `cos_credential.cos_key`）。缺 `media_type/title/file_info` 会报 `220001`。
- 上传：优先 `cos_url` 直传；回退 COS XML API（V5 签名，HMAC-SHA1，凭证由 `create_media` 动态下发，使用标准域 `<bucket>.cos.<region>.myqcloud.com`）
- 网络层：全局 `fetch` 优先，回退 `Zotero.HTTP`；读文件用 `IOUtils`（Zotero 7/8/9 均可用）
- 插件架构（Zotero 9 适配）：bootstrap（`registerChrome` + `loadSubScript`）→ `content/ima-sync-main.js`（偏好面板 + 右键菜单 + 面板窗口）
- 同步状态存于条目 `Extra` 字段：`ima-sync-media-id` / `ima-sync-time`

## 已知限制（实测结论，2026-08）

- **两套 ID 体系（重要）**：OpenAPI 通道（`/get_addable_knowledge_base_list` 等）返回的 `knowledge_base_id` 是 **base64/URL-safe 编码串**（如 `edSsDBQXgg0b...n0=`）；
  而 ima 网页地址栏、MCP 连接器返回的是**纯数字 ID**（如 `7489224555130210`）。两者**不能混用**——把纯数字 ID 喂给 OpenAPI 会报 `220004`。
  插件「获取我的知识库」按钮取的就是编码串，因此不要手动填 URL 里的数字 ID。
- IMA Skills API Key 有效期约 1 个月，过期后需在 `agent-interface` 重新生成。旧版 Bearer token 会过期（数小时～数天）。

## 目录结构

```
zotero-ima-sync/
├── manifest.json          # 插件元数据（applications.zotero，兼容 7/8/9）
├── bootstrap.js           # Zotero 入口（registerChrome + loadSubScript）
├── content/
│   ├── ima-sync-main.js   # 主脚本：偏好面板 / 右键菜单 / 控制面板入口
│   ├── kbselect.xhtml     # 多知识库选择对话框（替代脆弱的 Services.prompt.select）
│   ├── imaClient.js       # ima 客户端（OpenAPI/MCP 双模式，fetch 优先）
│   ├── cosUploader.js     # cos_url 直传 + COS V5 签名上传（含纯 JS SHA-1 回退）
│   ├── syncEngine.js      # 同步引擎
│   ├── config.js          # 配置读写（Zotero.Prefs）
│   ├── pane.xhtml/js      # 同步控制面板
│   └── prefs.xhtml/js     # 偏好设置选项卡
├── icons/
├── build.py               # 构建脚本（python build.py）
└── zotero-ima-sync-0.0.1.xpi
```

## 重新构建

```bash
python build.py
```

## 隐私与安全

- token 保存在 Zotero 本地 `prefs.js`（与你 Zotero 数据同目录），仅本机使用；
- 本插件只做「本地 → ima」单向同步，不读取 ima 中的其他知识库内容；
- PDF 以原始文件上传至腾讯云 COS（ima 官方存储），由 ima 解析建索引；
- 无遥测、无第三方追踪、无统计上报。

## 许可证

[MIT](LICENSE)
