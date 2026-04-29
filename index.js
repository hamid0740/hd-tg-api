// ==================== Configuration ====================

const BOT_TOKEN = "8600542524:AAGDPynD5GIpqp_EmBcUVzTJzSp6KZ2og6o";
const BALE_BOT_TOKEN = "708639453:2sxbPNULeBSPrBxcYDgF_eIqW6Vbw92V3Z8";
const BOT_WEBHOOK = "/endpoint";

// ── Local Bot API Server ────────────────────────────────────────────────────
// Run your local Telegram Bot API server (https://github.com/tdlib/telegram-bot-api)
// It removes the 20 MB download cap entirely.
// Example: "http://your-vps-ip:8081"  (no trailing slash)
// Set this once:
// - true  => use LOCAL_BOT_API for ALL Telegram requests (methods + file downloads)
// - false => use Telegram public API for ALL Telegram requests
const USE_LOCAL_BOT_API = true;
const LOCAL_BOT_API = "https://localhost:8085";
const TELEGRAM_PUBLIC_API = "https://api.telegram.org";
const TELEGRAM_API_BASE = USE_LOCAL_BOT_API ? LOCAL_BOT_API : TELEGRAM_PUBLIC_API;

// User Mapping: Telegram Sender → Bale Recipient
const USER_MAPPING = {
  "6154837875": "504669201",
};

const BALE_MAX_SIZE         = 20 * 1024 * 1024; // 20 MB – Bale doc/video/audio limit
const BALE_PHOTO_MAX_SIZE   = 10 * 1024 * 1024; // 10 MB – Bale photo limit (stricter)
const CHUNK_SIZE            = 15 * 1024 * 1024; // 15 MB – size of each zip part
const TELEGRAM_MAX_INPUT_SIZE = 20 * 1024 * 1024; // 210 MB hard limit for incoming Telegram files
let lastRenderWakeAt        = 0;

// ==================== Event Listener ====================

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event));
});

async function handleRequest(request, event) {
  const url = new URL(request.url);
  if (url.pathname === BOT_WEBHOOK)      return handleWebhook(request, event);
  if (url.pathname === '/registerWebhook') return registerWebhook(request);
  return new Response('Not Found', { status: 404 });
}

// ==================== Webhook Handlers ====================

async function handleWebhook(request, event) {
  const update = await request.json();
  if (update.message) {
    // Acknowledge webhook immediately; process update in the background
    // so long wake/retry flows do not block handling of new updates.
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(processMessage(update.message));
    } else {
      await processMessage(update.message);
    }
  }
  return new Response('OK');
}

async function registerWebhook(request) {
  const url = new URL(request.url);
  const webhookUrl = `${url.protocol}//${url.hostname}${BOT_WEBHOOK}`;
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl })
  });
  return new Response(await response.text(), { headers: { 'Content-Type': 'application/json' } });
}

// ==================== Message Processing ====================

async function processMessage(message) {
  const userId      = message.chat.id;
  const recipientId = "504669201";

  if (message.text && message.text === '/start') {
    await sendMessage(userId, message.message_id,
      '👋 Welcome!\n\nSend a file to forward to the recipient.\n\n📁 Files over 20 MB will be split into 15 MB zip parts.');
    return;
  }

  // Build sender info once, reuse across all handlers
  const sender = message.from || {};
  const senderInfo = {
    firstName: sender.first_name || '',
    lastName:  sender.last_name  || null,
    username:  sender.username   || null,
  };

  if (message.document) { await handleFileTransfer(userId, recipientId, message.document, message.caption, senderInfo); return; }
  if (message.photo)    { await handlePhotoTransfer(userId, recipientId, message.photo,    message.caption, senderInfo); return; }
  if (message.video)    { await handleVideoTransfer(userId, recipientId, message.video,    message.caption, senderInfo); return; }
  if (message.audio)    { await handleAudioTransfer(userId, recipientId, message.audio,    message.caption, senderInfo); return; }
  if (message.voice)    { await handleVoiceTransfer(userId, recipientId, message.voice,    message.caption, senderInfo); return; }

  await sendMessage(userId, message.message_id, '❌ Please send a file.');
}

// ==================== Generic Transfer Core ====================

/**
 * Download a file from Telegram (via local Bot API server for any size),
 * then either send it directly or split it into 15 MB zip parts.
 *
 * @param {string}   senderId     – Telegram chat to report back to
 * @param {string}   recipientId  – Bale chat to deliver to
 * @param {string}   fileId       – Telegram file_id
 * @param {string}   fileName     – original filename from Telegram
 * @param {string}   baleMethod   – e.g. "sendDocument", "sendPhoto"
 * @param {string}   baleField    – form field name expected by Bale API
 * @param {number|null} fileSize  – known size (may be null for photos)
 * @param {string|null} caption   – original Telegram caption (if any)
 * @param {object}      senderInfo – { firstName, lastName, username }
 */
async function transferFile(senderId, recipientId, fileId, fileName, baleMethod, baleField, fileSize, caption, senderInfo, baleMaxSize = BALE_MAX_SIZE) {
  if (fileSize && fileSize > TELEGRAM_MAX_INPUT_SIZE) {
    await sendMessage(
      senderId,
      null,
      `❌ File is too large (${formatSize(fileSize)}).\nMaximum supported input size is ${formatSize(TELEGRAM_MAX_INPUT_SIZE)}.`
    );
    return;
  }

  if (USE_LOCAL_BOT_API) {
    const wasAwake = await isLocalApiAwake();
    if (!wasAwake) await sendMessage(senderId, null, '🛌 Waking Telegram local API (/healthz)…');
    await wakeRenderApi({ skipAwakeCheck: wasAwake });
  }

  // 1. Resolve the file path via standard Bot API (metadata only, tiny request)
  let file;
  try {
    file = await getFile(fileId);
  } catch (e) {
    await sendMessage(senderId, null, `❌ Failed to get file info from Telegram: ${e.message}`);
    return;
  }

  if (!file || !file.file_path) {
    await sendMessage(senderId, null, `❌ Telegram did not return a file path.\nRaw getFile result: \`${JSON.stringify(file)}\``);
    return;
  }

  const filePath = file.file_path;

  // TEMP DEBUG: expose file_id + resolved download URL to help diagnose 404 issues
  const debugDownloadUrl = buildTelegramDownloadUrl(filePath);
  await sendMessage(senderId, null,
    `🧪 TEMP DEBUG\nfile_id: \`${fileId}\`\nfile_path: \`${filePath}\`\ndownload_url: \`${debugDownloadUrl}\``);

  // Use the real filename from Telegram's file_path as fallback
  // e.g. "photos/file_123.jpg" → "file_123.jpg"
  const resolvedName = fileName || filePath.split('/').pop();

  const downloadMsgId = await sendMessage(senderId, null, `⏳ ${resolvedName} — Downloading…`);

  // 2. Download from the selected Telegram API endpoint
  let fileBuffer;
  try {
    fileBuffer = await downloadFile(filePath);
  } catch (e) {
    if (downloadMsgId) await deleteMessage(senderId, downloadMsgId);
    await sendMessage(senderId, null, `❌ Download failed: ${e.message}`);
    return;
  }

  const totalBytes = fileBuffer.byteLength;

  // 3. Decide: send as-is or split into zip parts
  if (totalBytes <= baleMaxSize) {
    // ── Direct send ──────────────────────────────────────────────────────────
    if (downloadMsgId) await deleteMessage(senderId, downloadMsgId);
    const sendingMsgId = await sendMessage(senderId, null, `⏳ ${resolvedName} — Sending to Bale…`);
    const baleCaption = buildBaleCaption(senderInfo, caption);
    const { ok, error } = await sendToBale(recipientId, baleMethod, baleField, new Blob([fileBuffer]), resolvedName, baleCaption);
    if (sendingMsgId) await deleteMessage(senderId, sendingMsgId);
    await sendMessage(senderId, null, ok
      ? `✅ ${resolvedName} sent successfully.`
      : `❌ Bale rejected the file: ${error}`);
  } else {
    // ── Split into 15 MB zip parts ───────────────────────────────────────────
    // Always send zips as documents regardless of original media type
    const baseName = resolvedName;
    const data     = new Uint8Array(fileBuffer);
    const parts    = splitBuffer(data, CHUNK_SIZE);
    const total    = parts.length;

    if (downloadMsgId) await deleteMessage(senderId, downloadMsgId);
    await sendMessage(senderId, null,
      `📦 File is ${formatSize(totalBytes)} — splitting into ${total} parts of up to 15 MB each…`);

    let sendingMsgId = null;
    for (let i = 0; i < parts.length; i++) {
      const partNum    = i + 1;
      const isLastPart = partNum === total;
      const partSuffix = String(partNum).padStart(3, '0'); // 001, 002, ...
      const zipName    = `${baseName}.zip.${partSuffix}`;
      const zipBytes   = buildZip(parts[i], resolvedName, partNum, total);
      const blob       = new Blob([zipBytes], { type: 'application/zip' });

      // Caption only on last part; no caption on intermediate parts
      const baleCaption = buildBaleCaption(senderInfo, isLastPart ? caption : null, partNum, total);

      if (sendingMsgId) await deleteMessage(senderId, sendingMsgId);
      sendingMsgId = await sendMessage(senderId, null, `⏳ ${resolvedName} — part ${partNum}/${total} — Sending to Bale…`);

      const { ok, error } = await sendToBale(recipientId, 'sendDocument', 'document', blob, zipName, baleCaption);
      if (!ok) {
        if (sendingMsgId) await deleteMessage(senderId, sendingMsgId);
        await sendMessage(senderId, null, `❌ ${resolvedName} — part ${partNum}/${total} failed: ${error}`);
        return;
      }
    }

    if (sendingMsgId) await deleteMessage(senderId, sendingMsgId);
    await sendMessage(senderId, null, `✅ ${resolvedName} — all ${total} parts sent successfully.`);
  }
}

// ==================== File-type Transfer Handlers ====================

async function handleFileTransfer(senderId, recipientId, doc, caption, senderInfo) {
  await transferFile(senderId, recipientId, doc.file_id,
    doc.file_name || 'file', 'sendDocument', 'document', doc.file_size, caption, senderInfo);
}

async function handlePhotoTransfer(senderId, recipientId, photos, caption, senderInfo) {
  const largest = photos[photos.length - 1];
  // Photos have no file_name — resolvedName inside transferFile will extract it from file_path
  // Bale's photo limit is 10 MB, stricter than documents
  await transferFile(senderId, recipientId, largest.file_id,
    null, 'sendPhoto', 'photo', largest.file_size ?? null, caption, senderInfo, BALE_PHOTO_MAX_SIZE);
}

async function handleVideoTransfer(senderId, recipientId, video, caption, senderInfo) {
  // Use sendVideo for direct sends (≤20MB), zip chunks will always override to sendDocument
  await transferFile(senderId, recipientId, video.file_id,
    video.file_name || null, 'sendVideo', 'video', video.file_size, caption, senderInfo);
}

async function handleAudioTransfer(senderId, recipientId, audio, caption, senderInfo) {
  // Use sendAudio for direct sends (≤20MB), zip chunks will always override to sendDocument
  await transferFile(senderId, recipientId, audio.file_id,
    audio.file_name || null, 'sendAudio', 'audio', audio.file_size, caption, senderInfo);
}

async function handleVoiceTransfer(senderId, recipientId, voice, caption, senderInfo) {
  // Use sendVoice for direct sends (≤20MB), zip chunks will always override to sendDocument
  await transferFile(senderId, recipientId, voice.file_id,
    null, 'sendVoice', 'voice', voice.file_size, caption, senderInfo);
}

// ==================== Caption Builder ====================

/**
 * Build the Bale caption, always under 1000 chars.
 *
 * For direct sends:
 *   from: Firstname [Lastname] [@username]
 *   [caption: ...]
 *
 * For zip parts:
 *   from: Firstname [Lastname] [@username]
 *   part: x/y
 *   [caption: ... (last part only)]
 *
 * @param {object}      senderInfo  – { firstName, lastName, username }
 * @param {string|null} caption     – original Telegram caption
 * @param {number|null} partNum     – current part number (null = not a zip)
 * @param {number|null} totalParts  – total parts (null = not a zip)
 */
function buildBaleCaption(senderInfo, caption, partNum = null, totalParts = null) {
  const LIMIT = 1000;

  // Line 1: from
  let fromLine = `from: ${senderInfo.firstName}`;
  if (senderInfo.lastName) fromLine += ` ${senderInfo.lastName}`;
  if (senderInfo.username) fromLine += ` [@‌${senderInfo.username}](https://t.me/${senderInfo.username})`;

  // Line 2 (zip only): part
  const partLine = partNum !== null ? `part: ${partNum}/${totalParts}` : null;

  // Assemble header (without caption)
  const headerParts = [fromLine];
  if (partLine) headerParts.push(partLine);
  const header = headerParts.join('\n');

  if (!caption) return header;

  // Add caption prefix and fit within limit
  const captionPrefix = '\n\n';
  const available = LIMIT - header.length - captionPrefix.length;

  if (available <= 0) return header; // header alone already near limit

  const trimmedCaption = caption.length <= available
    ? caption
    : caption.slice(0, available - 1) + '…';

  return header + captionPrefix + trimmedCaption;
}

// ==================== Bale Sender ====================

/**
 * Send one blob to a Bale chat.
 * Returns true on success, false on API-level failure.
 */
async function sendToBale(recipientId, method, fieldName, blob, fileName, caption) {
  const formData = new FormData();
  formData.append('chat_id', recipientId);
  formData.append(fieldName, new Blob([await blob.arrayBuffer()], { type: mimeType(fileName, method) }), fileName);
  if (caption) formData.append('caption', caption);
  if (method === 'sendVideo') formData.append('supports_streaming', 'true');

  try {
    const response = await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/${method}`, {
      method: 'POST',
      body: formData
    });
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return { ok: false, error: `Non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}` };
    }
    return {
      ok: result.ok === true,
      error: `${result.description || 'Unknown error'} | HTTP ${response.status} | body: ${text.slice(0, 600)}`
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function mimeType(fileName, method) {
  if (method === 'sendDocument') {
    // Bale can mis-handle image/video/audio MIME types when uploaded via sendDocument.
    // Force binary MIME so "document" uploads stay in document pipeline (important for large JPGs).
    return 'application/octet-stream';
  }
  if (method === 'sendPhoto') return 'image/jpeg';
  if (method === 'sendVideo') return 'video/mp4';
  if (method === 'sendAudio') return 'audio/mpeg';
  if (method === 'sendVoice') return 'audio/ogg';
  // For documents, infer from extension
  const ext = (fileName || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
    pdf: 'application/pdf',
    zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

// ==================== Telegram API Methods ====================

async function sendMessage(chatId, replyId, text) {
  const params = { chat_id: chatId, text };
  if (replyId) params.reply_to_message_id = replyId;
  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    const data = await response.json();
    return data?.result?.message_id || null;
  } catch (_) {
    return null;
  }
}

async function deleteMessage(chatId, messageId) {
  if (!messageId) return;
  await fetch(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

async function getFile(fileId) {
  const apiUrl = `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const data = await fetchJson(apiUrl);
  if (data?.ok) return data.result;
  throw new Error(`getFile error: ${JSON.stringify(data)}`);
}

async function downloadFileFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return response.arrayBuffer();
}

function buildTelegramDownloadUrl(filePath) {
  const normalizedPath = String(filePath || '');

  if (USE_LOCAL_BOT_API && normalizedPath.startsWith('/')) {
    return `${LOCAL_BOT_API}${normalizedPath}`;
  }

  const safeFilePath = normalizedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `${TELEGRAM_API_BASE}/file/bot${BOT_TOKEN}/${safeFilePath}`;
}

async function downloadFile(filePath) {
  const normalizedPath = String(filePath || '');

  // In `--local` mode, telegram-bot-api may return an absolute filesystem path
  // such as "/var/lib/telegram-bot-api/<token>/photos/file_3.jpg".
  // The local HTTP API usually serves files under `/file/bot<TOKEN>/<relative_path>`.
  if (USE_LOCAL_BOT_API && normalizedPath.startsWith('/')) {
    const attempts = [];

    // Attempt #1: some deployments expose absolute paths directly.
    attempts.push({
      label: 'local direct path',
      url: `${LOCAL_BOT_API}${normalizedPath}`
    });

    // Attempt #2: extract the path after "/<token>/" and fetch via /file route.
    const tokenMarker = `/${BOT_TOKEN}/`;
    const markerIndex = normalizedPath.indexOf(tokenMarker);
    if (markerIndex >= 0) {
      const relativePath = normalizedPath.slice(markerIndex + tokenMarker.length);
      const encodedRelativePath = relativePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      attempts.push({
        label: 'local file route (token-relative)',
        url: `${LOCAL_BOT_API}/file/bot${BOT_TOKEN}/${encodedRelativePath}`
      });
    }

    // Attempt #3: some `--local` deployments still expose file_path via /file/bot<TOKEN>/<full_path_without_leading_slash>.
    const fullPathWithoutSlash = normalizedPath.replace(/^\/+/, '');
    if (fullPathWithoutSlash) {
      const encodedFullPath = fullPathWithoutSlash
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      attempts.push({
        label: 'local file route (full-path)',
        url: `${LOCAL_BOT_API}/file/bot${BOT_TOKEN}/${encodedFullPath}`
      });
    }

    let lastError;
    for (const attempt of attempts) {
      try {
        return await downloadFileFromUrl(attempt.url);
      } catch (err) {
        lastError = `${attempt.label}: ${err.message}`;
      }
    }

    throw new Error(`Download failed from local API (${lastError || 'no attempts'})`);
  }

  const downloadUrl = buildTelegramDownloadUrl(normalizedPath);
  try {
    return await downloadFileFromUrl(downloadUrl);
  } catch (err) {
    throw new Error(`Download failed from selected Telegram API: ${err.message}`);
  }
}

async function wakeRenderApi({ skipAwakeCheck = false } = {}) {
  // Avoid repeating wake calls too frequently.
  if (Date.now() - lastRenderWakeAt < 30 * 1000) return;

  if (!skipAwakeCheck && await isLocalApiAwake()) {
    lastRenderWakeAt = Date.now();
    return;
  }

  try {
    await fetch(`${LOCAL_BOT_API}/healthz`);
  } catch (_) {
    // Ignored intentionally.
  }

  lastRenderWakeAt = Date.now();
}

async function isLocalApiAwake() {
  try {
    // Telegram Bot API returns JSON 404 "Not Found" for unknown methods when alive.
    const url = `${LOCAL_BOT_API}/bot${BOT_TOKEN}/__wakecheck__`;
    const response = await fetch(url);
    const text = await response.text();
    if (!text) return false;
    const data = JSON.parse(text);
    return data?.ok === false && data?.description === 'Not Found';
  } catch (_) {
    return false;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { ok: false, error_code: response.status, description: `Non-JSON response: ${text.slice(0, 300)}` };
  }
}

// ==================== ZIP Builder (no dependencies) ====================

/**
 * Build a minimal, valid ZIP archive containing a single file entry.
 * Uses STORE compression (no compression) so it's fast and works in Workers
 * without any native zlib binding.
 *
 * @param {Uint8Array} data      – raw bytes of the file to pack
 * @param {string}     fileName  – name to store inside the zip
 * @param {number}     partNum   – current part number (stored in zip comment)
 * @param {number}     totalParts
 * @returns {Uint8Array}
 */
function buildZip(data, fileName, partNum, totalParts) {
  const enc      = new TextEncoder();
  const nameBytes = enc.encode(fileName);
  const comment   = enc.encode(`Part ${partNum} of ${totalParts}`);
  const crc       = crc32(data);
  const now       = dosDateTime();

  // Local file header
  const lfh = new ArrayBuffer(30 + nameBytes.length);
  const lfhView = new DataView(lfh);
  lfhView.setUint32(0,  0x04034b50, true); // signature
  lfhView.setUint16(4,  20,         true); // version needed
  lfhView.setUint16(6,  0,          true); // flags
  lfhView.setUint16(8,  0,          true); // STORE
  lfhView.setUint16(10, now.time,   true);
  lfhView.setUint16(12, now.date,   true);
  lfhView.setUint32(14, crc,        true);
  lfhView.setUint32(18, data.length, true); // compressed size = uncompressed (STORE)
  lfhView.setUint32(22, data.length, true);
  lfhView.setUint16(26, nameBytes.length, true);
  lfhView.setUint16(28, 0,          true); // extra field length
  new Uint8Array(lfh, 30).set(nameBytes);

  const localOffset = 0;

  // Central directory header
  const cdh = new ArrayBuffer(46 + nameBytes.length);
  const cdhView = new DataView(cdh);
  cdhView.setUint32(0,  0x02014b50, true);
  cdhView.setUint16(4,  20,         true); // version made by
  cdhView.setUint16(6,  20,         true); // version needed
  cdhView.setUint16(8,  0,          true); // flags
  cdhView.setUint16(10, 0,          true); // STORE
  cdhView.setUint16(12, now.time,   true);
  cdhView.setUint16(14, now.date,   true);
  cdhView.setUint32(16, crc,        true);
  cdhView.setUint32(20, data.length, true);
  cdhView.setUint32(24, data.length, true);
  cdhView.setUint16(28, nameBytes.length, true);
  cdhView.setUint16(30, 0,          true); // extra
  cdhView.setUint16(32, 0,          true); // per-file comment length (not used)
  cdhView.setUint16(34, 0,          true); // disk start
  cdhView.setUint16(36, 0,          true); // internal attrs
  cdhView.setUint32(38, 0,          true); // external attrs
  cdhView.setUint32(42, localOffset, true);
  new Uint8Array(cdh, 46).set(nameBytes);

  const cdOffset = lfh.byteLength + data.length;
  const cdSize   = cdh.byteLength;

  // End of central directory
  const eocd = new ArrayBuffer(22 + comment.length);
  const eocdView = new DataView(eocd);
  eocdView.setUint32(0,  0x06054b50, true);
  eocdView.setUint16(4,  0,          true); // disk number
  eocdView.setUint16(6,  0,          true); // disk with CD
  eocdView.setUint16(8,  1,          true); // entries on disk
  eocdView.setUint16(10, 1,          true); // total entries
  eocdView.setUint32(12, cdSize,     true);
  eocdView.setUint32(16, cdOffset,   true);
  eocdView.setUint16(20, comment.length, true);
  new Uint8Array(eocd, 22).set(comment);

  // Concatenate all parts
  const total = new Uint8Array(lfh.byteLength + data.length + cdh.byteLength + eocd.byteLength);
  let offset = 0;
  total.set(new Uint8Array(lfh), offset); offset += lfh.byteLength;
  total.set(data,                offset); offset += data.length;
  total.set(new Uint8Array(cdh), offset); offset += cdh.byteLength;
  total.set(new Uint8Array(eocd),offset);

  return total;
}

/** Split a Uint8Array into chunks of at most `chunkSize` bytes */
function splitBuffer(data, chunkSize) {
  const parts = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    parts.push(data.slice(offset, offset + chunkSize));
  }
  return parts;
}

/** CRC-32 implementation (no external deps) */
function crc32(data) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());

  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Current date/time in MS-DOS packed format for ZIP headers */
function dosDateTime() {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// ==================== Utility Functions ====================

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
