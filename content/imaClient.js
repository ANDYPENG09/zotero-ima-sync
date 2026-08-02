/* imaClient.js — 腾讯 ima 客户端
 *
 * 两种认证模式：
 *   1) IMA Skills API Key（默认，推荐）
 *      - 凭证来源：ima.qq.com/agent-interface 生成的 Client ID + Api Key
 *      - 请求头：ima-openapi-clientid / ima-openapi-apikey
 *      - 端点：https://ima.qq.com/openapi/wiki/v1/...
 *      - 响应：{ code, msg, data }，code=0 成功，业务数据在 data 中
 *      - 有效期约 1 个月，需定期重新生成
 *
 *   2) Bearer token（旧/高级模式，MCP）
 *      - 凭证来源：ima 网页版 DevTools Network 面板 Authorization: Bearer 后的字符串
 *      - 请求头：Authorization: Bearer <token>
 *      - 端点：https://ima.qq.com/mcp（JSON-RPC）
 *
 * 凭证自动识别：clientId/apiKey 同时存在 → skills 模式；否则若 token 存在 → bearer 模式。
 *
 * 网络层：优先全局 fetch（Zotero 7/8/9 chrome 环境均可用），回退 Zotero.HTTP。
 */
"use strict";

const IMA_ORIGIN = "https://ima.qq.com";
const WIKI_BASE = "/openapi/wiki/v1";

/* ---------- 统一请求层（fetch 优先，Zotero.HTTP 兜底） ---------- */

function _httpFallback(method, url, headers, body, timeout) {
  if (typeof Zotero !== "undefined" && Zotero.HTTP && typeof Zotero.HTTP.request === "function") {
    return Zotero.HTTP.request(method, url, {
      headers,
      body,
      responseType: "text",
      timeout: timeout || 60000,
    }).then((resp) => ({ status: resp.status, response: resp.response !== undefined ? resp.response : resp.responseText }));
  }
  return Promise.reject(new Error("当前环境不支持网络请求（无 fetch 且无 Zotero.HTTP）"));
}

async function httpRequest(method, url, headers, body, timeout) {
  if (typeof fetch === "function") {
    try {
      const init = { method, headers };
      if (body !== undefined && body !== null) init.body = body;
      if (timeout && typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
        init.signal = AbortSignal.timeout(timeout);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      return { status: res.status, response: text };
    } catch (e) {
      // fetch 失败（含 AbortError）时回退 Zotero.HTTP
      try {
        return await _httpFallback(method, url, headers, body, timeout);
      } catch (e2) {
        if (e && e.name === "AbortError") throw new Error("请求超时");
        throw e;
      }
    }
  }
  return _httpFallback(method, url, headers, body, timeout);
}

/* ---------- 客户端 ---------- */

class ImaClientError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ImaClientError";
    this.code = code;
  }
}

class ImaClient {
  /**
   * @param {object} opts
   *  - credType: "skills"（默认，推荐）| "bearer"
   *  - clientId, apiKey（skills 模式）
   *  - token（bearer 模式）
   *  - mode: "openapi" | "mcp"（仅 bearer 模式）
   */
  constructor(opts) {
    opts = opts || {};
    this.credType = opts.credType || "skills";
    this.clientId = (opts.clientId || "").trim();
    this.apiKey = (opts.apiKey || "").trim();
    this.token = (opts.token || "").trim().replace(/^Bearer\s+/i, "");
    this.mode = opts.mode || "openapi";
    this._id = 0;
    this._initialized = false;
  }

  _headers(extra) {
    let base;
    if (this.credType === "skills") {
      base = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "ima-openapi-clientid": this.clientId,
        "ima-openapi-apikey": this.apiKey,
      };
    } else {
      base = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer " + (this.token || ""),
      };
    }
    return Object.assign(base, extra || {});
  }

  /** skills 模式通用请求：自动解包 { code, msg, data } */
  async _skillHttp(path, bodyObj) {
    const resp = await httpRequest("POST", IMA_ORIGIN + WIKI_BASE + path, this._headers(), JSON.stringify(bodyObj || {}), 60000);
    if (resp.status === 401 || resp.status === 403) {
      throw new ImaClientError("ima 认证失败：Client ID / Api Key 无效或已过期（有效期约 1 个月，请到 ima.qq.com/agent-interface 重新生成）。", resp.status);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new ImaClientError("ima 服务返回 HTTP " + resp.status + "：" + String(resp.response || "").slice(0, 200), resp.status);
    }
    let data;
    try {
      data = JSON.parse(resp.response);
    } catch (e) {
      throw new ImaClientError("ima 响应解析失败（非 JSON）：" + String(resp.response || "").slice(0, 200));
    }
    if (typeof data.code !== "undefined" && data.code !== 0 && data.code !== "0") {
      throw new ImaClientError("ima 返回错误(" + data.code + ")：" + (data.msg || "未知错误"), data.code);
    }
    return data.data !== undefined ? data.data : data;
  }

  /** bearer 模式通用请求（MCP / 旧 OpenAPI） */
  async _bearerHttp(method, path, bodyObj, extraHeaders) {
    let url = IMA_ORIGIN + path;
    let payload = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
    if (this.mode === "mcp") {
      url = IMA_ORIGIN + "/mcp";
      payload = JSON.stringify({ jsonrpc: "2.0", id: ++this._id, method: path, params: bodyObj });
    }
    let resp;
    try {
      resp = await httpRequest(method, url, this._headers(extraHeaders), payload, 60000);
    } catch (e) {
      throw new ImaClientError("请求 ima 服务失败：" + (e && e.message ? e.message : String(e)));
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new ImaClientError("ima 认证失败：Bearer token 无效或已过期，请重新获取。", resp.status);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new ImaClientError("ima 服务返回 HTTP " + resp.status + "：" + String(resp.response || "").slice(0, 200), resp.status);
    }
    let raw = resp.response;
    if (typeof raw !== "string") raw = String(raw);
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e1) {
      const lines = raw.split(/\r?\n/).filter((l) => l.startsWith("data:"));
      if (lines.length) {
        try { data = JSON.parse(lines[lines.length - 1].slice(5).trim()); }
        catch (e2) { throw new ImaClientError("ima 响应解析失败：" + raw.slice(0, 200)); }
      } else {
        throw new ImaClientError("ima 响应解析失败（非 JSON）：" + raw.slice(0, 200));
      }
    }
    if (data && data.error) {
      throw new ImaClientError("ima 返回错误：" + (data.error.message || data.error.code || "未知错误"));
    }
    if (data && typeof data.code !== "undefined" && data.code !== 0 && data.code !== "0") {
      throw new ImaClientError("ima 返回错误(" + data.code + ")：" + (data.msg || "未知错误"), data.code);
    }
    return data;
  }

  async _mcpCall(method, params) {
    if (!this._initialized) {
      try {
        await this._bearerHttp("POST", "/mcp", { jsonrpc: "2.0", id: ++this._id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "zotero-ima-sync", version: "0.0.1" } } }, { "Content-Type": "application/json" });
      } catch (e) { /* initialize 失败不阻塞 */ }
      this._initialized = true;
    }
    const data = await this._bearerHttp("POST", "/mcp", { jsonrpc: "2.0", id: ++this._id, method, params }, { "Content-Type": "application/json" });
    return data && data.result;
  }

  /* ---------- 知识库列表 ---------- */

  /**
   * 获取可写入的知识库列表。
   *
   * 重要：skills 模式必须用 /get_addable_knowledge_base_list（返回可添加知识的库）。
   *   - limit 必须落在 (0, 50]，传 100 会报 code 51。
   *   - 返回 { addable_knowledge_base_list: [{id, name}], next_cursor, is_end }
   *   - id 是 base64/URL-safe 编码串（如 "edSsDBQXgg0b...n0="），
   *     不是 ima 网页 URL 里看到的纯数字 ID；用纯数字 ID 调 create_media 会报 220004。
   */
  async getKnowledgeBaseList() {
    if (this.credType === "skills") {
      const kbs = [];
      let cursor = "";
      for (let page = 0; page < 20; page++) {
        const body = { limit: 50 };
        if (cursor) body.cursor = cursor;
        const data = await this._skillHttp("/get_addable_knowledge_base_list", body);
        const arr = this._pickKbArray(data);
        for (const kb of arr) {
          if (!kb) continue;
          const id = kb.id || kb.knowledge_base_id || kb.kb_id;
          const name = kb.name || (kb.basic_info && kb.basic_info.name) || kb.title || kb.knowledge_base_name || "(未命名)";
          if (id) kbs.push({ id: String(id), name: String(name) });
        }
        const isEnd = data && (data.is_end === true || data.is_end === undefined);
        cursor = (data && data.next_cursor) || "";
        if (isEnd || !cursor) break;
      }
      return kbs;
    }
    const r = await this._mcpCall("get_knowledge_base_list", { params: [{ type: "KBT_MINE_KB", limit: 50 }] });
    return this._flattenKbList(r);
  }

  /** 从 skills 响应 data 中取出知识库数组（容错多种字段名） */
  _pickKbArray(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    const candidates = [
      "addable_knowledge_base_list",
      "knowledge_base_list",
      "knowledge_bases",
      "list",
      "items",
    ];
    for (const key of candidates) {
      if (Array.isArray(data[key])) return data[key];
      if (data[key] && Array.isArray(data[key].list)) return data[key].list;
    }
    const found = [];
    for (const k in data) { if (Array.isArray(data[k])) found.push.apply(found, data[k]); }
    if (found.length) return found;
    throw new ImaClientError("无法解析知识库列表响应，原始 data：" + JSON.stringify(data).slice(0, 300));
  }

  _flattenKbList(r) {
    const list = (r && r.results) || r || [];
    const kbs = [];
    for (const entry of list) {
      const inner = (entry && entry.knowledge_base_list) || [];
      for (const kb of inner) {
        kbs.push({ id: kb.id, name: (kb.basic_info && kb.basic_info.name) || kb.id });
      }
    }
    return kbs;
  }

  /* ---------- 媒体创建 / 入库 ---------- */

  /**
   * create_media
   * @returns {{media_id: string, cos_credential?: object, cos_url?: string}}
   */
  async createMedia(p) {
    if (this.credType === "skills") {
      const r = await this._skillHttp("/create_media", {
        knowledge_base_id: p.knowledge_base_id,
        file_name: p.file_name,
        file_size: p.file_size,
        content_type: p.content_type,
        file_ext: p.file_ext,
      });
      const mediaId = r.media_id || r.id;
      if (!mediaId) throw new ImaClientError("create_media 未返回 media_id：" + JSON.stringify(r || {}).slice(0, 200));
      return {
        media_id: mediaId,
        cos_credential: r.cos_credential || r.cosCredential || null,
        cos_url: r.cos_url || r.url || r.upload_url || "",
      };
    }
    // bearer 模式
    const body = {
      file_name: p.file_name, file_size: p.file_size, content_type: p.content_type,
      knowledge_base_id: p.knowledge_base_id, file_ext: p.file_ext,
    };
    let r;
    if (this.mode === "mcp") {
      r = await this._mcpCall("create_media", body);
    } else {
      r = await this._bearerHttp("POST", "/openapi/media/v1/create_media", body);
    }
    if (!r || !r.media_id) throw new ImaClientError("create_media 未返回 media_id：" + JSON.stringify(r || {}).slice(0, 200));
    return { media_id: r.media_id, cos_credential: r.cos_credential || null, cos_url: r.cos_url || r.url || "" };
  }

  /**
   * 将已上传的 media 加入知识库。
   *
   * 关键：OpenAPI 通道的 add_knowledge 必须携带 media_type / title / file_info，
   * 仅传 { media_id, knowledge_base_id } 会持续报 220001 参数错误（官方示例亦如此）。
   *
   * @param {object} p
   *  - media_id, knowledge_base_id, folder_id
   *  - media_type：由扩展名映射（PDF=1，WEB=2），见 imaMediaTypeForExt
   *  - title：展示标题（默认 file_name）
   *  - file_name, file_size：回传原始文件名与大小
   *  - cos_key：create_media 下发的 COS 对象键（必填，位于 cos_credential.cos_key）
   */
  async addKnowledge(p) {
    const body = {
      media_id: p.media_id,
      knowledge_base_id: p.knowledge_base_id,
      media_type: p.media_type,
      title: p.title || p.file_name || "",
      folder_id: p.folder_id || "",
      file_info: {
        cos_key: p.cos_key,
        file_name: p.file_name,
        file_size: p.file_size,
      },
    };
    if (this.credType === "skills") {
      return (await this._skillHttp("/add_knowledge", body)) || {};
    }
    if (this.mode === "mcp") {
      return (await this._mcpCall("add_knowledge", body)) || {};
    }
    return (await this._bearerHttp("POST", "/openapi/knowledge_base/v1/add_knowledge", body)) || {};
  }
}

/* ---------- ima media_type 枚举（来自 get_knowledge_list 实测） ---------- */
const IMA_MEDIA_TYPE_BY_EXT = {
  pdf: 1, doc: 1, docx: 1, ppt: 1, pptx: 1, xls: 1, xlsx: 1,
  txt: 1, md: 1, markdown: 1, csv: 1, html: 1, epub: 1,
  png: 1, jpg: 1, jpeg: 1, webp: 1, gif: 1,
  mp3: 1, wav: 1, m4a: 1, aac: 1,
  web: 2, url: 2,
};

function imaMediaTypeForExt(ext) {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  return IMA_MEDIA_TYPE_BY_EXT[e] !== undefined ? IMA_MEDIA_TYPE_BY_EXT[e] : 1;
}

if (typeof globalThis !== "undefined") {
  globalThis.ImaClient = ImaClient;
  globalThis.ImaClientError = ImaClientError;
  globalThis.httpRequest = httpRequest;
  globalThis.imaMediaTypeForExt = imaMediaTypeForExt;
  ImaClient.mediaTypeForExt = imaMediaTypeForExt;
}
