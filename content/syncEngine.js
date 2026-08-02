/* syncEngine.js — 同步引擎
 *
 * 流程（每篇 PDF）：
 *   1) create_media  → 获得 media_id + COS 临时凭证
 *   2) 读取本地 PDF 二进制（Zotero.File.getBinaryContentsAsync）
 *   3) cosUpload    → PUT 到腾讯云 COS
 *   4) add_knowledge → 加入指定知识库
 *   5) 在 Zotero 条目 extra 字段记录 ima-sync-media-id（去重依据）
 */
"use strict";

const SYNC_TAG = "ima-sync";

class ImaSyncEngine {
  /**
   * @param {object} opts {credType, clientId, apiKey, token, mode, knowledgeBaseId, duplicateStrategy, folderId, forceResync, onProgress}
   */
  constructor(opts) {
    this.opts = opts || {};
    this.onProgress = this.opts.onProgress || (() => {});
    // 凭证优先级：skills（clientId+apiKey）> bearer（token）
    const credType = (this.opts.clientId && this.opts.apiKey) ? "skills" : (this.opts.credType || "bearer");
    this.client = new ImaClient({
      credType,
      clientId: this.opts.clientId,
      apiKey: this.opts.apiKey,
      token: this.opts.token,
      mode: this.opts.mode || "openapi",
    });
    this.stats = { total: 0, done: 0, skipped: 0, failed: 0, uploadedBytes: 0 };
    this._stopped = false;
  }

  stop() { this._stopped = true; }

  /* ---------- 条目收集 ---------- */

  /**
   * 根据范围收集条目。
   * @param {string} scope "selected" | "collection" | "all"
   * @param {string|null} collectionId
   */
  async collectItems(scope, collectionId) {
    let items = [];
    if (scope === "selected") {
      const win = Zotero.getMainWindow();
      if (!win || !win.ZoteroPane) {
        throw new Error("无法访问 Zotero 主窗口，请重试或改用其它同步范围。");
      }
      const ids = win.ZoteroPane.getSelectedItems();
      items = ids;
    } else if (scope === "collection") {
      const col = Zotero.Collections.get(collectionId);
      if (!col) throw new Error("未找到指定的 collection。");
      const top = col.getChildItems(false); // 仅本层条目
      items = top;
    } else if (scope === "all") {
      items = await Zotero.Items.getAll();
    }
    // 只保留有 PDF 附件的条目（文献类）
    const withPdf = [];
    for (const item of items) {
      if (!item || item.isAttachment()) continue;
      const atts = item.getAttachments();
      for (const aid of atts) {
        const att = Zotero.Items.get(aid);
        if (att && !att.deleted && att.attachmentContentType === "application/pdf") {
          withPdf.push(item);
          break;
        }
      }
    }
    return withPdf;
  }

  /** 取条目下所有 PDF 附件（含文件路径） */
  async _getPdfAttachments(item) {
    const out = [];
    const atts = item.getAttachments();
    for (const aid of atts) {
      const att = Zotero.Items.get(aid);
      if (!att || att.deleted || att.attachmentContentType !== "application/pdf") continue;
      try {
        const path = await att.getFilePathAsync();
        if (path) out.push({ att, path });
      } catch (e) {
        // 无法解析路径（如链接文件失效）则跳过
      }
    }
    return out;
  }

  /* ---------- 已同步状态（extra 字段） ---------- */

  _readSyncState(item) {
    const extra = item.getField("extra") || "";
    const m = extra.match(/(?:^|\n)ima-sync-media-id:\s*(\S+)/);
    return m ? m[1] : null;
  }

  _writeSyncState(item, mediaId) {
    let extra = item.getField("extra") || "";
    // 移除旧的 ima-sync-* 行
    extra = extra.replace(/\n?ima-sync-media-id:\s*\S+/g, "");
    extra = extra.replace(/\n?ima-sync-time:\s*\S+/g, "");
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const newLines = `ima-sync-media-id: ${mediaId}\nima-sync-time: ${ts}`;
    item.setField("extra", (extra ? extra + "\n" : "") + newLines);
    try { item.saveTx(); } catch (e) { try { item.save(); } catch (e2) {} }
  }

  /* ---------- 单个 PDF 同步 ---------- */

  async _syncOne(item, att, path) {
    const fileName = att.getField("title") || att.attachmentFilename || path.split(/[\\/]/).pop() || "untitled.pdf";
    const ext = (fileName.split(".").pop() || "pdf").toLowerCase();
    const mime = mimeForExt(ext);
    if (!mime) {
      throw new Error(`不支持的文件类型：${ext}`);
    }
    const stat = await IOUtils.stat(path);
    const fileSize = stat.size;

    // 1. create_media
    const created = await this.client.createMedia({
      knowledge_base_id: this.opts.knowledgeBaseId,
      file_name: fileName,
      file_ext: ext,
      content_type: mime,
      file_size: fileSize,
    });
    const mediaId = created.media_id;
    const cosKey = created.cos_credential && created.cos_credential.cos_key;

    // 2. 读取本地文件（IOUtils 为 Firefox 平台 API，Zotero 7/8/9 均可用；回退 Zotero.File）
    let buf;
    try {
      buf = await IOUtils.read(path);
    } catch (e1) {
      try {
        const ab = await Zotero.File.getBinaryContentsAsync(path);
        buf = new Uint8Array(ab);
      } catch (e2) {
        throw new Error("读取 PDF 文件失败：" + (e1.message || String(e1)));
      }
    }

    // 3. 上传（优先 cos_url，其次 COS 凭证）
    await uploadMedia(created, buf, mime);
    this.stats.uploadedBytes += fileSize;

    // 4. 入库（OpenAPI 通道必须带 media_type / title / file_info）
    await this.client.addKnowledge({
      knowledge_base_id: this.opts.knowledgeBaseId,
      media_id: mediaId,
      media_type: (typeof imaMediaTypeForExt === "function" ? imaMediaTypeForExt(ext) : 1),
      title: fileName,
      file_name: fileName,
      file_size: fileSize,
      cos_key: cosKey,
      folder_id: this.opts.folderId || "",
    });

    // 5. 记录状态
    this._writeSyncState(item, mediaId);
    return mediaId;
  }

  /* ---------- 主入口 ---------- */

  /**
   * @param {string} scope
   * @param {string|null} collectionId
   */
  async run(scope, collectionId) {
    this._stopped = false;
    this.stats = { total: 0, done: 0, skipped: 0, failed: 0, uploadedBytes: 0 };

    if (!this.opts.clientId && !this.opts.apiKey && !this.opts.token) {
      throw new Error("请先在设置中填写 IMA Skills API Key（Client ID + Api Key）或 Bearer token。");
    }
    if (!this.opts.knowledgeBaseId) throw new Error("请先在设置中指定 ima 知识库 ID。");

    const items = await this.collectItems(scope, collectionId);
    const tasks = [];
    for (const item of items) {
      const pdfs = await this._getPdfAttachments(item);
      for (const p of pdfs) tasks.push({ item, ...p });
    }

    this.stats.total = tasks.length;
    this.onProgress({ type: "start", stats: this.stats });

    const results = [];
    for (let i = 0; i < tasks.length; i++) {
      if (this._stopped) break;
      const { item, att, path } = tasks[i];
      const title = (item.getField("title") || item.getField("citekey") || "").slice(0, 60) || path.split(/[\\/]/).pop();
      try {
        // 去重：已同步过且未强制重传 → 跳过
        const prev = this._readSyncState(item);
        if (prev && !this.opts.forceResync) {
          this.stats.skipped++;
          this.onProgress({ type: "skip", index: i, title, message: "已同步过，跳过" });
          results.push({ title, status: "skipped" });
          continue;
        }
        this.onProgress({ type: "progress", index: i, title, message: "上传中…" });
        const mediaId = await this._syncOne(item, att, path);
        this.stats.done++;
        this.onProgress({ type: "done", index: i, title, message: `已入库（${mediaId.slice(0, 28)}…）` });
        results.push({ title, status: "ok", mediaId });
      } catch (e) {
        this.stats.failed++;
        this.onProgress({ type: "error", index: i, title, message: e.message || String(e) });
        results.push({ title, status: "error", error: e.message || String(e) });
      }
    }
    this.onProgress({ type: "end", stats: this.stats, results });
    return { stats: this.stats, results };
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.ImaSyncEngine = ImaSyncEngine;
  globalThis.SYNC_TAG = SYNC_TAG;
}
