/* config.js — 插件配置读写（基于 Zotero.Prefs，前缀 imaSync） */
"use strict";

const ImaSyncConfig = {
  PREFIX: "imaSync.",

  // ---- IMA Skills API Key（默认，推荐） ----
  get clientId() { return Zotero.Prefs.get("imaSync.clientId") || ""; },
  set clientId(v) { Zotero.Prefs.set("imaSync.clientId", v); },

  get apiKey() { return Zotero.Prefs.get("imaSync.apiKey") || ""; },
  set apiKey(v) { Zotero.Prefs.set("imaSync.apiKey", v); },

  // ---- 旧 Bearer token（高级回退） ----
  get token() { return Zotero.Prefs.get("imaSync.token") || ""; },
  set token(v) { Zotero.Prefs.set("imaSync.token", v); },

  // ---- 凭证类型自动识别 ----
  get credType() {
    if ((this.clientId && this.apiKey) || Zotero.Prefs.get("imaSync.credType") === "skills") return "skills";
    return "bearer";
  },

  get knowledgeBaseId() { return Zotero.Prefs.get("imaSync.knowledgeBaseId") || ""; },
  set knowledgeBaseId(v) { Zotero.Prefs.set("imaSync.knowledgeBaseId", v); },

  // duplicate_name_strategy: DUPLICATE_NAME_STRATEGY_SAVE / _CANCEL / _REPLACE
  get duplicateStrategy() { return Zotero.Prefs.get("imaSync.duplicateStrategy") || "DUPLICATE_NAME_STRATEGY_SAVE"; },
  set duplicateStrategy(v) { Zotero.Prefs.set("imaSync.duplicateStrategy", v); },

  // 是否强制重传已同步过的附件
  get forceResync() { return !!Zotero.Prefs.get("imaSync.forceResync", false); },
  set forceResync(v) { Zotero.Prefs.set("imaSync.forceResync", !!v); },

  // 目标文件夹 id（可空）
  get folderId() { return Zotero.Prefs.get("imaSync.folderId") || ""; },
  set folderId(v) { Zotero.Prefs.set("imaSync.folderId", v); },

  // API 模式（仅 bearer 回退模式使用）："openapi"（默认）| "mcp"
  get apiMode() { return Zotero.Prefs.get("imaSync.apiMode") || "openapi"; },
  set apiMode(v) { Zotero.Prefs.set("imaSync.apiMode", v === "mcp" ? "mcp" : "openapi"); },

  /** 根据当前配置构造 ImaClient（自动识别 skills / bearer） */
  makeClient() {
    if (typeof ImaClient === "undefined") {
      throw new Error("ImaClient 尚未加载，请确认 imaClient.js 已在脚本中先加载。");
    }
    return new ImaClient({
      credType: this.credType,
      clientId: this.clientId,
      apiKey: this.apiKey,
      token: this.token,
      mode: this.apiMode,
    });
  },
};

if (typeof globalThis !== "undefined") {
  globalThis.ImaSyncConfig = ImaSyncConfig;
}
