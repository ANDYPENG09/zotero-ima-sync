/* cosUploader.js — 腾讯云 COS（XML API / V5 签名）上传模块
 *
 * 流程：create_media 返回 cos_credential（临时密钥 + bucket + region + cos_key），
 *       本模块按 COS V5 签名后用 PUT 上传文件二进制。
 *
 * ============================================================
 * 签名算法（严格对齐 cos-nodejs-sdk-v5/sdk/util.js 的 getAuth()）
 * ============================================================
 *   KeyTime      = "<start_time>;<expired_time>"          // 直接用数字串，不要包 sha1\n...\n\n
 *   SignTime     = "<now>;<expired_time>"
 *   SignKey      = HMAC-SHA1(SecretKey, KeyTime)                    -> hex
 *   FormatString = method + "\n" + pathname + "\n" + urlParamStr + "\n" + headerStr + "\n"
 *                  （urlParamStr 为空串；headerStr 由 obj2str 生成）
 *   StringToSign = "sha1" + "\n" + SignTime + "\n" + SHA1(FormatString) + "\n"
 *   Signature    = HMAC-SHA1(SignKey, StringToSign)                 -> hex
 *
 *   obj2str：key 转小写、按 key 字典序排序，key 与 value 都用 camSafeUrlEncode
 *            （encodeURIComponent 后再把 ! ' ( ) * 替换为 %21 %27 %28 %29 %2A），
 *            以 "k=v" 用 & 连接。
 *
 * 历史坑（已修复）：
 *   1) 旧实现把 SignKey 算成 HMAC-SHA1(SecretKey, "sha1\n<KeyTime>\n\n") —— 多了包裹，
 *      导致 403 SignatureDoesNotMatch。
 *   2) 旧实现的 FormatString 少了 SHA1 摘要与 "sha1\n<SignTime>\n" 前缀。
 *   3) cos_credential.custom_domain 是 image.myqcloud.com 的 CDN 只读域，PUT 会 403；
 *      必须用标准 COS 域 <bucket>.cos.<region>.myqcloud.com。
 *
 * 依赖：优先 WebCrypto（crypto.subtle：HMAC-SHA1 / SHA-1），不可用时回退纯 JS 实现。
 */
"use strict";

/* ---------- 字节工具 ---------- */

function utf8Bytes(str) {
  const s = String(str === undefined || str === null ? "" : str);
  if (typeof TextEncoder !== "undefined") {
    return Array.from(new TextEncoder().encode(s));
  }
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push((c >> 6) | 0xc0, (c & 0x3f) | 0x80);
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = s.charCodeAt(++i);
      const v = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      out.push((v >> 18) | 0xf0, ((v >> 12) & 0x3f) | 0x80, ((v >> 6) & 0x3f) | 0x80, (v & 0x3f) | 0x80);
    } else out.push((c >> 12) | 0xe0, ((c >> 6) & 0x3f) | 0x80, (c & 0x3f) | 0x80);
  }
  return out;
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] & 0xff).toString(16).padStart(2, "0");
  return s;
}

/* ---------- 纯 JS SHA-1（输入/输出均为字节数组） ---------- */

function sha1Bytes(bytes) {
  const msg = bytes.slice();
  const ml = msg.length;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const bitLen = ml * 8;
  for (let i = 7; i >= 0; i--) msg.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);

  const rotl = (n, b) => ((n << b) | (n >>> (32 - b))) >>> 0;
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Array(80);

  for (let block = 0; block < msg.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((msg[block + i * 4] << 24) | (msg[block + i * 4 + 1] << 16) |
              (msg[block + i * 4 + 2] << 8) | msg[block + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
  }
  const out = [];
  for (const x of h) out.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  return out;
}

function jsHmacSha1Bytes(keyBytes, msgBytes) {
  let k = keyBytes.slice();
  if (k.length > 64) k = sha1Bytes(k);
  while (k.length < 64) k.push(0);
  const ipad = k.map((b) => b ^ 0x36);
  const opad = k.map((b) => b ^ 0x5c);
  const inner = sha1Bytes(ipad.concat(msgBytes));
  return sha1Bytes(opad.concat(inner));
}

/* ---------- 摘要门面：优先 WebCrypto，失败回退纯 JS ---------- */

async function sha1Hex(str) {
  const bytes = utf8Bytes(str);
  try {
    if (globalThis.crypto && crypto.subtle && typeof crypto.subtle.digest === "function") {
      const buf = await crypto.subtle.digest("SHA-1", new Uint8Array(bytes));
      return bytesToHex(Array.from(new Uint8Array(buf)));
    }
  } catch (e) { /* 回退 */ }
  return bytesToHex(sha1Bytes(bytes));
}

async function hmacSha1Hex(keyStr, msgStr) {
  const keyBytes = utf8Bytes(keyStr);
  const msgBytes = utf8Bytes(msgStr);
  try {
    if (globalThis.crypto && crypto.subtle && typeof crypto.subtle.importKey === "function") {
      const k = await crypto.subtle.importKey(
        "raw", new Uint8Array(keyBytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", k, new Uint8Array(msgBytes));
      return bytesToHex(Array.from(new Uint8Array(sig)));
    }
  } catch (e) { /* 回退 */ }
  return bytesToHex(jsHmacSha1Bytes(keyBytes, msgBytes));
}

/* ---------- COS V5 签名 ---------- */

function camSafeUrlEncode(str) {
  return encodeURIComponent(String(str === undefined || str === null ? "" : str))
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function obj2str(obj) {
  const keys = Object.keys(obj).sort((a, b) => {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x === y ? 0 : (x > y ? 1 : -1);
  });
  return keys
    .map((k) => camSafeUrlEncode(k).toLowerCase() + "=" + camSafeUrlEncode(obj[k]))
    .join("&");
}

/** 由 cos_credential 推导标准 COS 主机名（CDN custom_domain 不可写，只作最后兜底） */
function cosHostOf(cred) {
  if (cred.bucket_name && cred.region) {
    return `${cred.bucket_name}.cos.${cred.region}.myqcloud.com`;
  }
  if (cred.bucket && cred.region) {
    return `${cred.bucket}.cos.${cred.region}.myqcloud.com`;
  }
  return cred.custom_domain || "";
}

/** cos_key -> 已编码的 URL path（逐段 encodeURIComponent，与 SDK 一致） */
function cosPathOf(cosKey) {
  return "/" + String(cosKey).split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/**
 * 生成 COS V5 Authorization 头。
 * @param {object} cred cos_credential
 * @param {string} method HTTP 方法（小写参与签名）
 * @param {string} mime Content-Type
 * @returns {Promise<{authorization: string, host: string, pathname: string}>}
 */
async function buildCosAuthorization(cred, method, mime) {
  const host = cosHostOf(cred);
  if (!host) throw new Error("cos_credential 缺少 bucket_name/region，无法拼接 COS 主机名");
  const pathname = cosPathOf(cred.cos_key);
  const methodLower = String(method || "put").toLowerCase();

  const startTime = String(cred.start_time || Math.floor(Date.now() / 1000) - 60);
  const expiredTime = String(cred.expired_time || Math.floor(Date.now() / 1000) + 3600);
  const keyTime = `${startTime};${expiredTime}`;
  const signTime = `${Math.floor(Date.now() / 1000)};${expiredTime}`;

  // 参与签名的 header：content-type + host（实测足够，token 走 x-cos-security-token 不签名）
  const signHeaders = { "content-type": mime, "host": host };
  const headerList = Object.keys(signHeaders)
    .map((k) => k.toLowerCase())
    .sort()
    .join(";");

  const formatString = [methodLower, pathname, "", obj2str(signHeaders), ""].join("\n");
  const hashedFormatString = await sha1Hex(formatString);
  const stringToSign = ["sha1", signTime, hashedFormatString, ""].join("\n");
  const signKey = await hmacSha1Hex(cred.secret_key, keyTime);
  const signature = await hmacSha1Hex(signKey, stringToSign);

  const authorization = [
    "q-sign-algorithm=sha1",
    "q-ak=" + camSafeUrlEncode(cred.secret_id),
    "q-sign-time=" + signTime,
    "q-key-time=" + keyTime,
    "q-header-list=" + headerList,
    "q-url-param-list=",
    "q-signature=" + signature,
  ].join("&");

  return { authorization, host, pathname };
}

/**
 * 上传文件：优先预签名 cos_url（若服务端返回），否则用 COS 临时凭证签名上传。
 * 注：实测 ima create_media 只返回 cos_credential，不返回 cos_url，因此常规走凭证签名。
 * @param {object} createMediaResult { media_id, cos_credential, cos_url }
 * @param {ArrayBuffer|Uint8Array} data 文件二进制
 * @param {string} mime MIME 类型
 */
async function uploadMedia(createMediaResult, data, mime) {
  if (createMediaResult.cos_url) {
    try {
      await putUrl(createMediaResult.cos_url, data, mime);
      return;
    } catch (e) {
      if (typeof Zotero !== "undefined" && Zotero.debug) {
        Zotero.debug("IMA Sync: cos_url 上传失败，回退到 COS 凭证签名：" + e, 2);
      }
    }
  }
  const cred = createMediaResult.cos_credential;
  if (!cred || !cred.cos_key) {
    throw new Error("create_media 未返回可用的上传地址（cos_url/cos_credential）");
  }
  await cosUpload(cred, data, mime);
}

/** 直接 PUT 到给定 URL（预签名地址 / 网关地址） */
async function putUrl(url, data, mime) {
  const body = data instanceof Uint8Array ? data : new Uint8Array(data);
  let resp;
  try {
    resp = await httpRequest("PUT", url, { "Content-Type": mime }, body, 300000);
  } catch (e) {
    throw new Error("上传失败：" + ((e && e.message) || String(e)));
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error("上传失败：HTTP " + resp.status + " " + String(resp.response || "").slice(0, 300));
  }
}

/**
 * 用 create_media 下发的临时凭证 + COS V5 签名上传。
 * @param {object} cred cos_credential
 * @param {ArrayBuffer|Uint8Array} data 文件二进制
 * @param {string} mime MIME 类型
 */
async function cosUpload(cred, data, mime) {
  const sig = await buildCosAuthorization(cred, "put", mime);
  const url = `https://${sig.host}${sig.pathname}`;
  const body = data instanceof Uint8Array ? data : new Uint8Array(data);

  const headers = {
    "Authorization": sig.authorization,
    "Content-Type": mime,
  };
  if (cred.token) headers["x-cos-security-token"] = cred.token;

  let resp;
  try {
    resp = await httpRequest("PUT", url, headers, body, 300000);
  } catch (e) {
    throw new Error("COS 上传失败：" + ((e && e.message) || String(e)));
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error("COS 上传失败：HTTP " + resp.status + " " + String(resp.response || "").slice(0, 300));
  }
}

/* ---------- MIME 映射（与 ima create_media 支持的类型对照） ---------- */
const EXT_TO_MIME = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  xmind: "application/x-xmind",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  m4a: "audio/x-m4a",
  wav: "audio/wav",
  html: "text/html",
  epub: "application/epub+zip",
  aac: "audio/aac",
};

function mimeForExt(ext) {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  return EXT_TO_MIME[e] || null;
}

if (typeof globalThis !== "undefined") {
  globalThis.cosUpload = cosUpload;
  globalThis.uploadMedia = uploadMedia;
  globalThis.mimeForExt = mimeForExt;
  globalThis.buildCosAuthorization = buildCosAuthorization;
  globalThis.CosUploader = { upload: uploadMedia, cosUpload, mimeForExt, buildCosAuthorization };
}
