/* pane.js — 同步控制面板逻辑 */
"use strict";

function $id(id) { return document.getElementById(id); }

function logLine(text, cls) {
  const log = $id("log");
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function updateStat(stats) {
  $id("stat").textContent =
    `总数 ${stats.total} ｜ 完成 ${stats.done} ｜ 跳过 ${stats.skipped} ｜ 失败 ${stats.failed} ｜ 已上传 ${(stats.uploadedBytes / 1048576).toFixed(1)} MB`;
  const pct = stats.total ? Math.round(((stats.done + stats.skipped + stats.failed) / stats.total) * 100) : 0;
  $id("barFill").style.width = pct + "%";
}

function readClientId() { return ($id("clientId").value || "").trim() || ImaSyncConfig.clientId; }
function readApiKey() { return ($id("apiKey").value || "").trim() || ImaSyncConfig.apiKey; }
function readToken() { return ($id("token") && $id("token").value || "").trim() || ImaSyncConfig.token; }

function makeClientFromPane() {
  const clientId = readClientId();
  const apiKey = readApiKey();
  const token = readToken();
  if (clientId && apiKey) {
    return new ImaClient({ credType: "skills", clientId, apiKey, mode: $id("apiMode").value });
  }
  if (token) {
    return new ImaClient({ credType: "bearer", token, mode: $id("apiMode").value });
  }
  return ImaSyncConfig.makeClient();
}

/* ---------- 事件 ---------- */
function bindEvents() {
  $id("btnLoadKb").addEventListener("click", async () => {
    const clientId = readClientId();
    const apiKey = readApiKey();
    if (!clientId || !apiKey) {
      if (!readToken()) { logLine("请先填写 Client ID 与 Api Key（或 Bearer token）", "log-err"); return; }
    }
    // 持久化
    ImaSyncConfig.clientId = clientId;
    ImaSyncConfig.apiKey = apiKey;
    const btn = $id("btnLoadKb");
    btn.disabled = true;
    btn.textContent = "加载中…";
    try {
      const client = makeClientFromPane();
      const kbs = await client.getKnowledgeBaseList();
      const list = $id("kbList");
      list.innerHTML = "";
      if (!kbs.length) {
        logLine("未获取到知识库（可能凭证无效或没有知识库）", "log-err");
      }
      for (const kb of kbs) {
        const item = document.createElement("div");
        item.style.cssText = "padding:4px 0;cursor:pointer;";
        item.textContent = `📚 ${kb.name}  (${kb.id})`;
        item.addEventListener("click", () => {
          $id("kbId").value = kb.id;
          ImaSyncConfig.knowledgeBaseId = kb.id;
          logLine(`已选择知识库：${kb.name}`, "log-ok");
        });
        list.appendChild(item);
      }
      logLine(`获取到 ${kbs.length} 个知识库`, "log-ok");
    } catch (e) {
      logLine("获取知识库失败：" + e.message, "log-err");
    } finally {
      btn.disabled = false;
      btn.textContent = "获取我的知识库";
    }
  });

  // 同步范围联动
  document.querySelectorAll('input[name="scope"]').forEach((r) => {
    r.addEventListener("change", () => {
      $id("collectionRow").style.display = r.value === "collection" ? "" : "none";
    });
  });

  // 加载 collections 下拉
  (async () => {
    try {
      const cols = Zotero.Collections.getAll();
      const sel = $id("collectionSelect");
      for (const c of cols) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name;
        sel.appendChild(opt);
      }
    } catch (e) {}
  })();

  let engine = null;
  $id("btnSync").addEventListener("click", async () => {
    const clientId = readClientId();
    const apiKey = readApiKey();
    const token = readToken();
    const kbId = $id("kbId").value.trim() || ImaSyncConfig.knowledgeBaseId;
    const dup = $id("dup").value;
    const forceResync = $id("forceResync").checked;
    const scope = document.querySelector('input[name="scope"]:checked').value;
    const collectionId = scope === "collection" ? $id("collectionSelect").value : null;

    if (!clientId || !apiKey) {
      if (!token) { logLine("请先在上方填写 Client ID 与 Api Key", "log-err"); return; }
    }
    if (!kbId) { logLine("请先指定目标知识库 ID（或点「获取我的知识库」）", "log-err"); return; }

    // 持久化
    ImaSyncConfig.clientId = clientId;
    ImaSyncConfig.apiKey = apiKey;
    ImaSyncConfig.token = token;
    ImaSyncConfig.knowledgeBaseId = kbId;
    ImaSyncConfig.duplicateStrategy = dup;
    ImaSyncConfig.forceResync = forceResync;
    ImaSyncConfig.apiMode = $id("apiMode").value;

    $id("log").innerHTML = "";
    $id("barFill").style.width = "0";
    $id("btnSync").disabled = true;
    $id("btnStop").disabled = false;

    engine = new ImaSyncEngine({
      credType: (clientId && apiKey) ? "skills" : "bearer",
      clientId, apiKey, token,
      knowledgeBaseId: kbId, duplicateStrategy: dup,
      folderId: ImaSyncConfig.folderId, forceResync,
      mode: $id("apiMode").value,
      onProgress: (p) => {
        if (p.type === "progress") logLine(`↻ ${p.title} — ${p.message}`);
        else if (p.type === "done") logLine(`✓ ${p.title} — ${p.message}`, "log-ok");
        else if (p.type === "skip") logLine(`– ${p.title} — ${p.message}`, "log-skip");
        else if (p.type === "error") logLine(`✗ ${p.title} — ${p.message}`, "log-err");
        if (p.stats) updateStat(p.stats);
      },
    });

    try {
      await engine.run(scope, collectionId);
      logLine("════ 同步完成 ════", "log-ok");
    } catch (e) {
      logLine("同步中断：" + e.message, "log-err");
    } finally {
      $id("btnSync").disabled = false;
      $id("btnStop").disabled = true;
    }
  });

  $id("btnStop").addEventListener("click", () => {
    if (engine) engine.stop();
    logLine("正在停止…");
  });
}

/* ---------- 初始化 ---------- */
window.addEventListener("DOMContentLoaded", () => {
  // 回填配置
  if ($id("clientId")) $id("clientId").value = ImaSyncConfig.clientId;
  if ($id("apiKey")) $id("apiKey").value = ImaSyncConfig.apiKey;
  if ($id("token")) $id("token").value = ImaSyncConfig.token;
  $id("kbId").value = ImaSyncConfig.knowledgeBaseId;
  $id("dup").value = ImaSyncConfig.duplicateStrategy || "DUPLICATE_NAME_STRATEGY_SAVE";
  $id("apiMode").value = ImaSyncConfig.apiMode;
  $id("forceResync").checked = ImaSyncConfig.forceResync;
  bindEvents();
});
