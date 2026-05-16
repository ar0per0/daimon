import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import multer from 'multer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { getChatMemory, saveChatMemory, clearChatMemory, getProxyChatMemory, saveProxyChatMemory, clearProxyChatMemory, getLabelMap, saveLabelMap, clearLabelMap, getChatRecord, saveChatRecord } from './chat-store.js';
import { upsertDocument, replaceDocumentChunks, replaceChunkEmbeddings, resetVectorTable, getDocumentVectorizationResult, listDocumentResults, searchChunksByEmbedding, searchChunksLexical, deleteDocumentByFilename, deleteRagIndex } from './rag-store.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3010;
const DEFAULT_EXTERNAL_LLM_BASE_URL = process.env.EXTERNAL_LLM_BASE_URL || 'http://127.0.0.1:10531/v1';
const DEFAULT_EXTERNAL_LLM_MODEL = process.env.EXTERNAL_LLM_MODEL || 'gpt-5.4';
const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://192.168.1.154:11434';
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const DEFAULT_RAG_EMBED_BASE_URL = process.env.RAG_EMBED_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
const DEFAULT_RAG_EMBED_MODEL = process.env.RAG_EMBED_MODEL || 'nomic-embed-text';
const OPENAI_COMPAT_MODEL = process.env.DAIMON_OPENAI_MODEL || 'daimon';
const DEFAULT_OPENAI_COMPAT_API_KEY = String(process.env.DAIMON_OPENAI_API_KEY || '').trim();
const USE_OLLAMA_SANITIZER = String(process.env.USE_OLLAMA_SANITIZER || 'true').toLowerCase() !== 'false';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const appConfigPath = path.join(root, 'data', 'app-config.json');
const singlePassPromptPath = path.join(root, 'data', 'single-pass-ollama-prompt.txt');
const multiPassPersonaPromptPath = path.join(root, 'data', 'multi-pass-persona-prompt.txt');
const multiPassDireccionPromptPath = path.join(root, 'data', 'multi-pass-direccion-prompt.txt');
const multiPassReferenciaPromptPath = path.join(root, 'data', 'multi-pass-referencia-prompt.txt');
const regexRulesPath = path.join(root, 'data', 'regex-rules.json');
const ragUploadsDir = path.join(root, 'data', 'rag', 'uploads');
const openAiCompatDebugLogPath = '/tmp/daimon-openai-debug.log';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const CONFIG_SESSION_COOKIE = 'daimon_config_session';
const CONFIG_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const configSessions = new Map();

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use(express.static(path.join(root, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(root, 'public', 'index.html'));
});

app.get('/debug', (_req, res) => {
  res.sendFile(path.join(root, 'public', 'debug.html'));
});

app.get('/config', (_req, res) => {
  res.sendFile(path.join(root, 'public', 'config.html'));
});

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const entries = raw
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return [part, ''];
      return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
    });

  return Object.fromEntries(entries);
}

function pruneExpiredConfigSessions() {
  const now = Date.now();
  for (const [token, session] of configSessions.entries()) {
    if (!session?.expiresAt || session.expiresAt <= now) {
      configSessions.delete(token);
    }
  }
}

function createConfigSession() {
  pruneExpiredConfigSessions();
  const token = crypto.randomBytes(32).toString('hex');
  configSessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + CONFIG_SESSION_TTL_MS,
  });
  return token;
}

function clearConfigSession(token) {
  if (token) {
    configSessions.delete(token);
  }
}

function setConfigSessionCookie(res, token) {
  res.cookie(CONFIG_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    maxAge: CONFIG_SESSION_TTL_MS,
    path: '/',
  });
}

function clearConfigSessionCookie(res) {
  res.cookie(CONFIG_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    expires: new Date(0),
    path: '/',
  });
}

function requireConfigAuth(req, res, next) {
  pruneExpiredConfigSessions();
  const cookies = parseCookies(req);
  const token = cookies[CONFIG_SESSION_COOKIE];
  const session = token ? configSessions.get(token) : null;

  if (!token || !session) {
    clearConfigSessionCookie(res);
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  session.expiresAt = Date.now() + CONFIG_SESSION_TTL_MS;
  configSessions.set(token, session);
  setConfigSessionCookie(res, token);
  next();
}

function normalizeChatId(value) {
  const chatId = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{4,120}$/.test(chatId) ? chatId : '';
}

function sanitizeUploadFilename(value) {
  const base = path.basename(String(value || '').trim() || 'documento.txt');
  const normalized = base
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '');

  return normalized || `documento_${Date.now()}.txt`;
}

function normalizeRagLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function normalizeRagKey(value) {
  const ragKey = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{2,80}$/.test(ragKey) ? ragKey : '';
}

function normalizeRagDefinitions(rawRags) {
  const source = Array.isArray(rawRags) ? rawRags : [];
  const normalized = [];
  const seen = new Set();

  for (const item of source) {
    const key = normalizeRagKey(item?.key);
    const label = normalizeRagLabel(item?.label);
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    const maxFragmentsRaw = Number(item?.maxFragments);
    normalized.push({
      key,
      label,
      active: typeof item?.active === 'boolean' ? item.active : true,
      ragOnlyMode: typeof item?.ragOnlyMode === 'boolean' ? item.ragOnlyMode : true,
      maxFragments: Number.isFinite(maxFragmentsRaw)
        ? Math.max(1, Math.min(Math.round(maxFragmentsRaw), 8))
        : 4,
    });
  }

  return normalized;
}

function buildUniqueRagKey(label, existingRags = []) {
  const normalizedLabel = normalizeRagLabel(label) || 'rag';
  const base = normalizedLabel
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\s_-]+/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase() || 'rag';
  const existing = new Set(existingRags.map(item => item.key));
  let candidate = base;
  let counter = 2;
  while (!normalizeRagKey(candidate) || existing.has(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  return candidate;
}

function getRagUploadsDir(ragKey) {
  const safeRagKey = normalizeRagKey(ragKey);
  if (!safeRagKey) {
    throw new Error('RAG inválido');
  }
  return path.join(ragUploadsDir, safeRagKey);
}

async function ensureRagUploadsDir(ragKey) {
  await fs.mkdir(getRagUploadsDir(ragKey), { recursive: true });
}

async function listRagUploads(ragKey) {
  const safeRagKey = normalizeRagKey(ragKey);
  if (!safeRagKey) {
    throw new Error('RAG inválido');
  }
  const targetDir = getRagUploadsDir(safeRagKey);
  await ensureRagUploadsDir(safeRagKey);
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .map(async entry => {
      const absolutePath = path.join(targetDir, entry.name);
      const stats = await fs.stat(absolutePath);
      return {
        name: entry.name,
        storageName: `${safeRagKey}/${entry.name}`,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
      };
    }));

  return files.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function findRagDefinition(rags, ragKey) {
  const list = Array.isArray(rags) ? rags : [];
  const safeRagKey = normalizeRagKey(ragKey);
  if (safeRagKey) {
    const exact = list.find(item => item.key === safeRagKey);
    return exact || null;
  }
  return list[0] || null;
}

function getScopedChatSessionKey(req) {
  const chatId = normalizeChatId(req.get('x-chat-id') || req.query?.chatId || req.body?.chatId);

  if (!chatId) {
    return { chatId: '', scopedKey: '' };
  }

  return {
    chatId,
    scopedKey: chatId,
  };
}

function normalizeChatSecret(value) {
  const secret = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{24,256}$/.test(secret) ? secret : '';
}

function getRequestedChatAccess(req) {
  const rawAccess = String(req.get('x-chat-access') || req.query?.chatAccess || req.body?.chatAccess || '').trim().toLowerCase();
  const chatSecret = normalizeChatSecret(req.get('x-chat-secret') || req.query?.chatSecret || req.body?.chatSecret);
  const chatAccess = rawAccess === 'public' ? 'public' : 'private';
  return {
    chatAccess,
    chatSecret,
  };
}

function hashChatSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}

function buildChatAccessRecord(requestedAccess) {
  if (requestedAccess?.chatAccess === 'public') {
    return { public: true, secretHash: null };
  }

  if (!requestedAccess?.chatSecret) {
    return null;
  }

  return {
    public: false,
    secretHash: hashChatSecret(requestedAccess.chatSecret),
  };
}

function getChatAccessMode(chatRecord) {
  return chatRecord?.access?.public === true ? 'public' : 'private';
}

async function authorizeChat(req, options = {}) {
  const { scopedKey, chatId } = getScopedChatSessionKey(req);
  if (!scopedKey) {
    return { ok: false, status: 400, error: 'chatId inválido', chatId: '' };
  }

  let chatRecord = await getChatRecord(scopedKey);
  const requestedAccess = getRequestedChatAccess(req);
  const requestedAccessRecord = buildChatAccessRecord(requestedAccess);
  const allowCreate = options.allowCreate === true;
  const allowMissing = options.allowMissing === true;
  const allowBootstrap = options.allowBootstrap !== false;

  if (chatRecord.exists && chatRecord.access == null && allowBootstrap) {
    if (!requestedAccessRecord) {
      return {
        ok: false,
        status: 403,
        error: 'Este chat privado solo se puede abrir desde el navegador que lo creó.',
        code: 'CHAT_SECRET_REQUIRED',
        chatId,
        chatSessionKey: scopedKey,
      };
    }

    chatRecord = await saveChatRecord(scopedKey, { access: requestedAccessRecord });
  }

  if (!chatRecord.exists) {
    if (allowCreate) {
      if (!requestedAccessRecord) {
        return {
          ok: false,
          status: 403,
          error: 'No pude crear este chat privado porque falta su secreto local.',
          code: 'CHAT_SECRET_REQUIRED',
          chatId,
          chatSessionKey: scopedKey,
        };
      }

      chatRecord = await saveChatRecord(scopedKey, { access: requestedAccessRecord });
    } else if (allowMissing) {
      return {
        ok: true,
        chatId,
        chatSessionKey: scopedKey,
        chatRecord,
        requestedAccess,
        createdAccess: null,
      };
    }
  }

  if (chatRecord.exists) {
    if (chatRecord.access?.public === true) {
      return {
        ok: true,
        chatId,
        chatSessionKey: scopedKey,
        chatRecord,
        requestedAccess,
        createdAccess: chatRecord.access,
      };
    }

    if (!requestedAccess.chatSecret || !chatRecord.access?.secretHash || hashChatSecret(requestedAccess.chatSecret) !== chatRecord.access.secretHash) {
      return {
        ok: false,
        status: 403,
        error: 'Este chat privado solo se puede abrir desde el navegador que lo creó.',
        code: 'CHAT_ACCESS_DENIED',
        chatId,
        chatSessionKey: scopedKey,
      };
    }
  }

  return {
    ok: true,
    chatId,
    chatSessionKey: scopedKey,
    chatRecord,
    requestedAccess,
    createdAccess: chatRecord.access,
  };
}

async function readAppConfig() {
  try {
    const raw = await fs.readFile(appConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    const rags = normalizeRagDefinitions(parsed?.rags);
    return {
      configPassword: typeof parsed?.configPassword === 'string' && parsed.configPassword
        ? parsed.configPassword
        : '1234',
      ollamaBaseUrl: typeof parsed?.ollamaBaseUrl === 'string' && parsed.ollamaBaseUrl
        ? parsed.ollamaBaseUrl
        : DEFAULT_OLLAMA_BASE_URL,
      ollamaModel: typeof parsed?.ollamaModel === 'string' && parsed.ollamaModel
        ? parsed.ollamaModel
        : DEFAULT_OLLAMA_MODEL,
      proxyBaseUrl: typeof parsed?.proxyBaseUrl === 'string' && parsed.proxyBaseUrl
        ? parsed.proxyBaseUrl
        : DEFAULT_EXTERNAL_LLM_BASE_URL,
      proxyModel: typeof parsed?.proxyModel === 'string' && parsed.proxyModel
        ? parsed.proxyModel
        : DEFAULT_EXTERNAL_LLM_MODEL,
      ragEmbedBaseUrl: typeof parsed?.ragEmbedBaseUrl === 'string' && parsed.ragEmbedBaseUrl
        ? parsed.ragEmbedBaseUrl
        : DEFAULT_RAG_EMBED_BASE_URL,
      ragEmbedModel: typeof parsed?.ragEmbedModel === 'string' && parsed.ragEmbedModel
        ? parsed.ragEmbedModel
        : DEFAULT_RAG_EMBED_MODEL,
      rags,
      documentsEnabled: typeof parsed?.documentsEnabled === 'boolean'
        ? parsed.documentsEnabled
        : true,
      publicChatEnabled: typeof parsed?.publicChatEnabled === 'boolean'
        ? parsed.publicChatEnabled
        : true,
      deepModeEnabled: typeof parsed?.deepModeEnabled === 'boolean'
        ? parsed.deepModeEnabled
        : true,
      openAiCompatEnabled: typeof parsed?.openAiCompatEnabled === 'boolean'
        ? parsed.openAiCompatEnabled
        : false,
      openAiCompatApiKey: typeof parsed?.openAiCompatApiKey === 'string'
        ? parsed.openAiCompatApiKey
        : DEFAULT_OPENAI_COMPAT_API_KEY,
      openAiCompatDebugLogEnabled: typeof parsed?.openAiCompatDebugLogEnabled === 'boolean'
        ? parsed.openAiCompatDebugLogEnabled
        : false,
      openAiCompatDeepModeEnabled: typeof parsed?.openAiCompatDeepModeEnabled === 'boolean'
        ? parsed.openAiCompatDeepModeEnabled
        : true,
      chatMode: typeof parsed?.chatMode === 'string' && ['masked-local-remote', 'direct-local', 'direct-remote'].includes(parsed.chatMode)
        ? parsed.chatMode
        : 'masked-local-remote',
    };
  } catch {
    const rags = [];
    return {
      configPassword: '1234',
      ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
      ollamaModel: DEFAULT_OLLAMA_MODEL,
      proxyBaseUrl: DEFAULT_EXTERNAL_LLM_BASE_URL,
      proxyModel: DEFAULT_EXTERNAL_LLM_MODEL,
      ragEmbedBaseUrl: DEFAULT_RAG_EMBED_BASE_URL,
      ragEmbedModel: DEFAULT_RAG_EMBED_MODEL,
      rags,
      documentsEnabled: true,
      publicChatEnabled: true,
      deepModeEnabled: true,
      openAiCompatEnabled: false,
      openAiCompatApiKey: DEFAULT_OPENAI_COMPAT_API_KEY,
      openAiCompatDebugLogEnabled: false,
      openAiCompatDeepModeEnabled: true,
      chatMode: 'masked-local-remote',
    };
  }
}

async function writeAppConfig(config) {
  const rags = normalizeRagDefinitions(config?.rags);
  const payload = {
    configPassword: typeof config?.configPassword === 'string' && config.configPassword
      ? config.configPassword
      : '1234',
    ollamaBaseUrl: typeof config?.ollamaBaseUrl === 'string' && config.ollamaBaseUrl
      ? config.ollamaBaseUrl
      : DEFAULT_OLLAMA_BASE_URL,
    ollamaModel: typeof config?.ollamaModel === 'string' && config.ollamaModel
      ? config.ollamaModel
      : DEFAULT_OLLAMA_MODEL,
    proxyBaseUrl: typeof config?.proxyBaseUrl === 'string' && config.proxyBaseUrl
      ? config.proxyBaseUrl
      : DEFAULT_EXTERNAL_LLM_BASE_URL,
    proxyModel: typeof config?.proxyModel === 'string' && config.proxyModel
      ? config.proxyModel
      : DEFAULT_EXTERNAL_LLM_MODEL,
    ragEmbedBaseUrl: typeof config?.ragEmbedBaseUrl === 'string' && config.ragEmbedBaseUrl
      ? config.ragEmbedBaseUrl
      : DEFAULT_RAG_EMBED_BASE_URL,
    ragEmbedModel: typeof config?.ragEmbedModel === 'string' && config.ragEmbedModel
      ? config.ragEmbedModel
      : DEFAULT_RAG_EMBED_MODEL,
    rags,
    documentsEnabled: typeof config?.documentsEnabled === 'boolean'
      ? config.documentsEnabled
      : true,
    publicChatEnabled: typeof config?.publicChatEnabled === 'boolean'
      ? config.publicChatEnabled
      : true,
    deepModeEnabled: typeof config?.deepModeEnabled === 'boolean'
      ? config.deepModeEnabled
      : true,
    openAiCompatEnabled: typeof config?.openAiCompatEnabled === 'boolean'
      ? config.openAiCompatEnabled
      : false,
    openAiCompatApiKey: typeof config?.openAiCompatApiKey === 'string'
      ? config.openAiCompatApiKey
      : DEFAULT_OPENAI_COMPAT_API_KEY,
    openAiCompatDebugLogEnabled: typeof config?.openAiCompatDebugLogEnabled === 'boolean'
      ? config.openAiCompatDebugLogEnabled
      : false,
    openAiCompatDeepModeEnabled: typeof config?.openAiCompatDeepModeEnabled === 'boolean'
      ? config.openAiCompatDeepModeEnabled
      : true,
    chatMode: typeof config?.chatMode === 'string' && ['masked-local-remote', 'direct-local', 'direct-remote'].includes(config.chatMode)
      ? config.chatMode
      : 'masked-local-remote',
  };

  await fs.mkdir(path.dirname(appConfigPath), { recursive: true });
  await fs.writeFile(appConfigPath, JSON.stringify(payload, null, 2));
}

async function getOllamaSettings() {
  const appConfig = await readAppConfig();
  return {
    baseUrl: appConfig.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    model: appConfig.ollamaModel || DEFAULT_OLLAMA_MODEL,
  };
}

async function getExternalLlmSettings() {
  const appConfig = await readAppConfig();
  return {
    baseUrl: appConfig.proxyBaseUrl || DEFAULT_EXTERNAL_LLM_BASE_URL,
    model: appConfig.proxyModel || DEFAULT_EXTERNAL_LLM_MODEL,
  };
}

async function getRagEmbedSettings() {
  const appConfig = await readAppConfig();
  return {
    baseUrl: appConfig.ragEmbedBaseUrl || DEFAULT_RAG_EMBED_BASE_URL,
    model: appConfig.ragEmbedModel || DEFAULT_RAG_EMBED_MODEL,
  };
}

async function getOpenAiCompatSettings() {
  const appConfig = await readAppConfig();
  return {
    enabled: appConfig.openAiCompatEnabled === true,
    apiKey: String(appConfig.openAiCompatApiKey || '').trim(),
    debugLogEnabled: appConfig.openAiCompatDebugLogEnabled === true,
    deepModeEnabled: appConfig.openAiCompatDeepModeEnabled !== false,
  };
}

function splitTextIntoChunks(text, options = {}) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [];

  const maxChars = Number(options.maxChars || 1200);
  const overlapChars = Number(options.overlapChars || 180);
  const paragraphs = source
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  const pushChunk = value => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    chunks.push(normalized);
  };

  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).trim().length <= maxChars) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }

    if (current) {
      pushChunk(current);
      const overlap = overlapChars > 0 ? current.slice(-overlapChars).trim() : '';
      current = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
      if (current.length <= maxChars) {
        continue;
      }
    } else if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    let start = 0;
    while (start < paragraph.length) {
      const end = Math.min(start + maxChars, paragraph.length);
      pushChunk(paragraph.slice(start, end));
      if (end >= paragraph.length) {
        current = '';
        break;
      }
      start = Math.max(end - overlapChars, start + 1);
    }
  }

  if (current) {
    pushChunk(current);
  }

  return chunks.map((chunk, index) => ({
    chunkIndex: index,
    text: chunk,
    charCount: chunk.length,
    tokenEstimate: Math.max(1, Math.round(chunk.length / 4)),
  }));
}

async function parseHttpBody(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const rawText = await response.text();

  if (!rawText) {
    return { data: null, rawText: '' };
  }

  if (contentType.includes('application/json')) {
    try {
      return { data: JSON.parse(rawText), rawText };
    } catch {
      return { data: null, rawText };
    }
  }

  try {
    return { data: JSON.parse(rawText), rawText };
  } catch {
    return { data: null, rawText };
  }
}

function buildUpstreamError(prefix, response, parsed) {
  const jsonError = parsed?.data?.error?.message || parsed?.data?.error;
  const textError = String(parsed?.rawText || '').trim();
  return jsonError || textError || `${prefix} ${response.status}`;
}

async function embedTextsWithOllama(texts) {
  const ragSettings = await getRagEmbedSettings();
  const baseUrl = String(ragSettings.baseUrl || '').replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ragSettings.model,
      input: texts,
      truncate: true,
    }),
  });

  const parsed = await parseHttpBody(res);
  const data = parsed.data;
  if (!res.ok) {
    throw new Error(buildUpstreamError('Ollama embeddings error', res, parsed));
  }

  const embeddings = Array.isArray(data?.embeddings) ? data.embeddings : [];
  if (!embeddings.length) {
    throw new Error('Ollama no devolvió embeddings');
  }

  return embeddings;
}

function buildRagContextBlock(results, options = {}) {
  const items = Array.isArray(results) ? results.filter(item => String(item?.text || '').trim()) : [];
  if (!items.length) return '';

  const intro = options.ragOnlyMode
    ? 'Responde únicamente usando la información contenida en este contexto recuperado de la base documental local. Si la respuesta no aparece aquí, indica de forma natural que no lo sabes. No menciones frases como "según el contexto" o "con la información proporcionada" salvo que el usuario lo pida.'
    : 'Usa el siguiente contexto recuperado de la base documental local solo si es relevante para responder al usuario.';

  return [
    '------RAG_CONTEXTO_LOCAL------',
    intro,
    ...items.map((item, index) => [
      `[fragmento ${index + 1}] documento: ${item.originalName || item.filename || 'documento'} · chunk: ${item.chunkIndex}`,
      String(item.text || '').trim(),
    ].join('\n')),
    '------FIN_RAG_CONTEXTO_LOCAL------',
  ].join('\n\n');
}

const RAG_QUERY_STOPWORDS = new Set([
  'a', 'al', 'algo', 'alguna', 'alguno', 'algunos', 'como', 'con', 'contra', 'cual', 'cuál', 'cuales', 'cuáles',
  'de', 'del', 'dime', 'donde', 'dónde', 'el', 'ella', 'ellas', 'ello', 'ellos', 'en', 'entre', 'es', 'esa', 'esas',
  'ese', 'eso', 'esos', 'esta', 'este', 'esto', 'estos', 'hay', 'la', 'las', 'lo', 'los', 'me', 'mi', 'mis', 'más',
  'no', 'nos', 'o', 'para', 'pero', 'por', 'que', 'qué', 'quien', 'quién', 'se', 'si', 'sí', 'sin', 'sobre', 'su',
  'sus', 'te', 'tu', 'tus', 'un', 'una', 'uno', 'unos', 'y'
]);

function extractRagQueryTerms(value) {
  return Array.from(new Set((String(value || '').match(/[\p{L}\p{N}_./@-]{3,}/gu) || [])
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !RAG_QUERY_STOPWORDS.has(token.toLowerCase()))))
    .slice(0, 16);
}

function normalizeChunkFingerprint(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9@._/\- ]+/g, '')
    .trim();
}

function scoreRagHeuristics(item, queryTerms, bestHybridScore = 0) {
  const text = String(item?.text || '');
  const lowerText = text.toLowerCase();
  const exactTerms = queryTerms.filter(term => lowerText.includes(term.toLowerCase()));
  const exactMatchCount = exactTerms.length;
  const coverageRatio = queryTerms.length ? exactMatchCount / queryTerms.length : 0;
  const hasStructuredFields = /(cliente|referencia|direccion|dirección|estado|correo|email|telefono|teléfono)\s*:/i.test(text);
  const longChunkPenalty = text.length > 900 && exactMatchCount === 0 ? 0.12 : text.length > 1400 ? 0.2 : 0;
  const genericPenalty = coverageRatio < 0.2 && !hasStructuredFields && text.length > 700 ? 0.14 : 0;
  const exactBonus = Math.min(0.42, exactMatchCount * 0.08);
  const coverageBonus = Math.min(0.30, coverageRatio * 0.28);
  const structuredBonus = hasStructuredFields && exactMatchCount > 0 ? 0.06 : 0;
  const sourceBonus = Array.isArray(item?.sources) && item.sources.length > 1 ? 0.06 : 0;
  const closenessBonus = bestHybridScore > 0 && Number(item?.hybridScore || 0) >= bestHybridScore * 0.85 ? 0.04 : 0;
  const heuristicAdjustment = exactBonus + coverageBonus + structuredBonus + sourceBonus + closenessBonus - longChunkPenalty - genericPenalty;

  return {
    exactMatchCount,
    exactTerms,
    coverageRatio,
    hasStructuredFields,
    heuristicAdjustment,
    finalScore: Number(item?.hybridScore || 0) + heuristicAdjustment,
  };
}

function evaluateRagConfidence(results, options = {}) {
  const items = Array.isArray(results) ? results.filter(Boolean) : [];
  const ragOnlyMode = Boolean(options.ragOnlyMode);
  const requestedLimit = Math.max(1, Math.min(Math.round(Number(options.requestedLimit || items.length || 1)), 8));

  if (!items.length) {
    return {
      level: 'low',
      useResults: [],
      reason: 'no-results',
      message: ragOnlyMode
        ? 'No encuentro información suficiente en la fuente privada seleccionada para responder a esa consulta.'
        : 'No encontré contexto suficientemente útil en la fuente privada para esta consulta.',
    };
  }

  const top1 = items[0];
  const top2 = items[1] || null;
  const top1Sources = Array.isArray(top1.sources) ? top1.sources : [];
  const top2Sources = Array.isArray(top2?.sources) ? top2.sources : [];
  const top1Hybrid = Number(top1.hybridScore || 0);
  const top2Hybrid = Number(top2?.hybridScore || 0);
  const top1Distance = Number.isFinite(Number(top1.distance)) ? Number(top1.distance) : null;
  const strongSharedTop = top1Sources.length >= 2;
  const secondShared = top2Sources.length >= 2;
  const goodHybridPair = top1Hybrid >= 0.58 && top2Hybrid >= 0.28;
  const goodTopDistance = top1Distance != null && top1Distance <= 0.95;

  if (strongSharedTop || secondShared || goodHybridPair || (top1Hybrid >= 0.72 && goodTopDistance)) {
    return {
      level: 'high',
      useResults: items.slice(0, requestedLimit),
      reason: strongSharedTop ? 'shared-top-hit' : goodHybridPair ? 'strong-pair' : 'good-top-hit',
      message: '',
    };
  }

  if (top1Hybrid >= 0.42 || (top1Hybrid >= 0.30 && top2Hybrid >= 0.22)) {
    return {
      level: 'medium',
      useResults: items.slice(0, Math.min(requestedLimit, 2)),
      reason: 'weak-but-usable',
      message: '',
    };
  }

  return {
    level: 'low',
    useResults: [],
    reason: 'low-confidence',
    message: ragOnlyMode
      ? 'No encuentro información suficiente en la fuente privada seleccionada para responder a esa consulta.'
      : 'El contexto recuperado parece demasiado débil y prefiero no usarlo para esta consulta.',
  };
}

async function retrieveRelevantRagChunks(query, limit = 4, options = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const ragKey = normalizeRagKey(options?.ragKey);
  if (!ragKey) {
    return [];
  }

  const embeddings = await embedTextsWithOllama([cleanQuery]);
  const embedding = Array.isArray(embeddings?.[0]) ? embeddings[0] : null;
  const safeLimit = Math.max(1, Math.min(Math.round(Number(limit || 4)), 8));

  const vectorResults = embedding?.length
    ? searchChunksByEmbedding(embedding, Math.max(safeLimit * 2, 6), { ragKey })
    : [];
  const lexicalResults = searchChunksLexical(cleanQuery, Math.max(safeLimit * 2, 6), { ragKey });
  const queryTerms = extractRagQueryTerms(cleanQuery);

  const fused = new Map();
  const addRanked = (items, source) => {
    items.forEach((item, index) => {
      const current = fused.get(item.id) || {
        ...item,
        sources: new Set(),
        hybridScore: 0,
      };
      current.sources.add(source);
      current.hybridScore += 1 / (index + 1 + 2);
      if (source === 'vector') {
        current.distance = item.distance;
      }
      if (source === 'lexical') {
        current.lexicalRank = item.lexicalRank;
      }
      fused.set(item.id, current);
    });
  };

  addRanked(vectorResults, 'vector');
  addRanked(lexicalResults, 'lexical');

  const withScores = [...fused.values()].map(item => ({
    ...item,
    sourceCount: item.sources.size,
    hybridScore: item.hybridScore + (item.sources.size > 1 ? 0.35 : 0),
    sources: [...item.sources],
  }));

  const bestHybridScore = withScores.reduce((max, item) => Math.max(max, Number(item.hybridScore || 0)), 0);
  const ranked = withScores
    .map(item => {
      const heuristic = scoreRagHeuristics(item, queryTerms, bestHybridScore);
      return {
        ...item,
        ...heuristic,
      };
    })
    .sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if (b.hybridScore !== a.hybridScore) return b.hybridScore - a.hybridScore;
      return (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY);
    });

  const deduped = [];
  const seenFingerprints = new Set();
  for (const item of ranked) {
    const fingerprint = normalizeChunkFingerprint(item.text);
    if (fingerprint && seenFingerprints.has(fingerprint)) continue;
    if (fingerprint) seenFingerprints.add(fingerprint);
    deduped.push(item);
  }

  return deduped.slice(0, safeLimit);
}

async function vectorizeRagDocument({ ragKey, filename, originalName, content }) {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const charCount = content.length;
  const safeRagKey = normalizeRagKey(ragKey);
  if (!safeRagKey) {
    throw new Error('RAG inválido');
  }

  try {
    upsertDocument({
      filename,
      originalName,
      sizeBytes,
      charCount,
      status: 'processing',
      errorMessage: null,
      chunkCount: 0,
      embeddingDimensions: null,
    }, { ragKey: safeRagKey });

    const chunks = splitTextIntoChunks(content);
    if (!chunks.length) {
      throw new Error('No se pudieron generar chunks del documento');
    }

    const embeddings = await embedTextsWithOllama(chunks.map(chunk => chunk.text));
    const dimensions = Array.isArray(embeddings[0]) ? embeddings[0].length : 0;
    if (!dimensions) {
      throw new Error('Dimensiones de embedding inválidas');
    }

    const document = upsertDocument({
      filename,
      originalName,
      sizeBytes,
      charCount,
      status: 'processing',
      errorMessage: null,
      chunkCount: chunks.length,
      embeddingDimensions: dimensions,
    }, { ragKey: safeRagKey });

    const chunkRows = replaceDocumentChunks(document.id, chunks, { ragKey: safeRagKey });
    replaceChunkEmbeddings(chunkRows.map((chunkRow, index) => ({
      chunkId: chunkRow.id,
      embedding: embeddings[index],
    })), dimensions, { ragKey: safeRagKey });

    upsertDocument({
      filename,
      originalName,
      sizeBytes,
      charCount,
      status: 'ready',
      errorMessage: null,
      chunkCount: chunks.length,
      embeddingDimensions: dimensions,
    }, { ragKey: safeRagKey });

    return getDocumentVectorizationResult(filename, 5, { ragKey: safeRagKey });
  } catch (error) {
    upsertDocument({
      filename,
      originalName,
      sizeBytes,
      charCount,
      status: 'error',
      errorMessage: String(error?.message || error || 'Error vectorizando documento'),
      chunkCount: 0,
      embeddingDimensions: null,
    }, { ragKey: safeRagKey });
    throw error;
  }
}

async function revectorizeAllRagDocuments(options = {}) {
  const { resetVectors = false } = options;
  const appConfig = await readAppConfig();
  const ragKeys = [...new Set((appConfig.rags || []).map(item => item.key).filter(Boolean))];
  const fileGroups = await Promise.all(ragKeys.map(async ragKey => ({
    ragKey,
    files: await listRagUploads(ragKey),
  })));
  const files = fileGroups.flatMap(group => group.files.map(file => ({ ...file, ragKey: group.ragKey })));

  if (resetVectors) {
    for (const ragKey of ragKeys) {
      resetVectorTable({ ragKey });
    }
  }

  const results = [];
  for (const file of files) {
    const absolutePath = path.join(getRagUploadsDir(file.ragKey), file.name);
    const content = await fs.readFile(absolutePath, 'utf8');
    try {
      const vectorization = await vectorizeRagDocument({
        ragKey: file.ragKey,
        filename: file.name,
        originalName: file.name,
        content,
      });
      results.push({ ok: true, filename: file.name, vectorization, ragKey: file.ragKey });
    } catch (error) {
      results.push({ ok: false, filename: file.name, ragKey: file.ragKey, error: String(error?.message || error || 'Error revectorizando documento') });
    }
  }

  return {
    total: files.length,
    ok: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
  };
}

function deAnonymizeText(text, labelMap) {
  let output = String(text);
  const entries = Object.entries(labelMap || {}).sort((a, b) => b[0].length - a[0].length);
  for (const [label, value] of entries) {
    output = output.split(label).join(value);
  }
  return output;
}

function extractOpenAiTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        if (item.type === 'text') return String(item.text || '');
        if (item.type === 'input_text') return String(item.text || item.input_text || '');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.input_text === 'string') return content.input_text;
  }

  return '';
}

function normalizeOpenAiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map(item => ({
      role: ['system', 'user', 'assistant'].includes(String(item?.role || '')) ? String(item.role) : 'user',
      content: extractOpenAiTextContent(item?.content),
    }))
    .filter(item => String(item.content || '').trim());
}

function resolveOpenAiChatId(req) {
  return normalizeChatId(
    req.get('x-chat-id')
    || req.body?.chatId
    || req.body?.chat_id
    || req.body?.metadata?.conversation_id
    || req.body?.conversationId
    || ''
  );
}

function getRequestedOpenAiChatMode(req, appConfig) {
  const value = String(req.body?.chatMode || req.body?.chat_mode || '').trim();
  return ['masked-local-remote', 'direct-local', 'direct-remote'].includes(value)
    ? value
    : (appConfig.chatMode || 'masked-local-remote');
}

function getRequestedOpenAiSinglePass(req) {
  const raw = req.body?.singlePass ?? req.body?.single_pass;
  if (raw != null && raw !== '') {
    return raw === true || String(raw || '').toLowerCase() === 'true';
  }

  const configValue = req.openAiCompatDeepModeEnabled;
  return configValue === false;
}

function getRequestedOpenAiRag(req, appConfig) {
  const ragKey = String(req.body?.ragKey || req.body?.rag_key || '').trim();
  const explicitUseRag = req.body?.useRag ?? req.body?.use_rag;
  const useRag = explicitUseRag == null ? Boolean(ragKey) : (explicitUseRag === true || String(explicitUseRag).toLowerCase() === 'true');
  const rag = useRag ? findRagDefinition(appConfig.rags, ragKey) : null;
  return { useRag, ragKey, rag };
}

function buildOpenAiSessionKey(chatId) {
  return chatId ? `openai_${chatId}` : '';
}

function buildReplacementEntries(labelMap) {
  return Object.entries(labelMap || {}).sort((a, b) => b[1].length - a[1].length);
}

async function rebuildMaskedStateFromMessages(messages, options = {}) {
  const labelMap = {};
  const proxyHistory = [];
  const history = [];
  const singlePass = Boolean(options.singlePass);

  for (const message of messages) {
    const role = String(message?.role || 'user');
    const content = String(message?.content || '');
    if (!content.trim()) continue;

    if (role === 'user') {
      const sanitizeResult = await sanitizeWithOllama(content, labelMap, () => {}, { singlePass });
      const sanitizedContent = sanitizeResult.finalSanitized;
      const updatedLabelMap = sanitizeResult.updatedLabelMap || labelMap;
      Object.assign(labelMap, updatedLabelMap);
      proxyHistory.push({ role: 'user', content: sanitizedContent });
      history.push({ role: 'user', content, displayContent: content });
      continue;
    }

    if (role === 'assistant') {
      const sanitizedAssistant = replaceEntitiesDeterministically(content, buildReplacementEntries(labelMap));
      proxyHistory.push({ role: 'assistant', content: sanitizedAssistant });
      history.push({ role: 'assistant', content: sanitizedAssistant, displayContent: content });
      continue;
    }

    proxyHistory.push({ role: role === 'system' ? 'system' : 'user', content });
    history.push({ role: role === 'system' ? 'system' : 'user', content, displayContent: content });
  }

  return { history, proxyHistory, labelMap };
}

async function runDaimonPipeline({
  chatSessionKey = '',
  history = [],
  proxyHistory = [],
  labelMap = {},
  message,
  chatMode,
  useRag,
  rag,
  singlePass,
}) {
  const startedAt = Date.now();
  const ragOnlyMode = Boolean(rag?.ragOnlyMode);
  const ragMaxFragments = Math.max(1, Math.min(Math.round(Number(rag?.maxFragments || 4)), 8));
  const combinedMessage = String(message || '').trim();

  const ragStartedAt = Date.now();
  const rawRagResults = useRag && rag ? await retrieveRelevantRagChunks(combinedMessage, ragMaxFragments, { ragKey: rag.key }) : [];
  const ragConfidence = evaluateRagConfidence(rawRagResults, { ragOnlyMode, requestedLimit: ragMaxFragments });
  const ragResults = ragConfidence.useResults;
  const ragDurationMs = Date.now() - ragStartedAt;
  const ragContextBlock = buildRagContextBlock(ragResults, { ragOnlyMode });
  const messageWithRagContext = ragContextBlock ? `${combinedMessage}\n\n${ragContextBlock}` : combinedMessage;
  const historyWithUserMessage = [
    ...history,
    { role: 'user', content: messageWithRagContext, displayContent: combinedMessage },
  ].slice(-40);

  if (useRag && ragOnlyMode && ragConfidence.level === 'low') {
    const reply = ragConfidence.message || 'No encuentro información suficiente en la fuente privada seleccionada para responder a esa consulta.';
    const newHistory = [
      ...historyWithUserMessage,
      { role: 'assistant', content: reply, displayContent: reply, timings: { totalMs: Date.now() - startedAt, ragMs: ragDurationMs, ragConfidence: ragConfidence.level } },
    ].slice(-40);
    const newProxyHistory = [
      ...proxyHistory,
      { role: 'user', content: combinedMessage, debugOnly: true, debugKind: 'rag-fallback' },
      { role: 'assistant', content: reply, debugOnly: true, debugKind: 'rag-fallback' },
    ].slice(-40);

    if (chatSessionKey) {
      await saveChatMemory(chatSessionKey, newHistory);
      await saveProxyChatMemory(chatSessionKey, newProxyHistory);
      await saveChatRecord(chatSessionKey, { access: { public: true, secretHash: null }, settings: { chatMode, useRag, ragKey: rag?.key || null } });
    }

    return {
      reply,
      displayResponse: reply,
      history: newHistory,
      proxyHistory: newProxyHistory,
      labelMap,
      timings: { totalMs: Date.now() - startedAt, ragMs: ragDurationMs, ragConfidence: ragConfidence.level },
      ragConfidence: ragConfidence.level,
      ragKey: rag?.key || '',
      ragLabel: rag?.label || '',
    };
  }

  if (chatMode === 'direct-local' || chatMode === 'direct-remote') {
    const directHistory = history.slice(-20).map(item => ({ role: item.role, content: item.displayContent || item.content }));
    const directMessages = buildMessagesWithMemory(directHistory, messageWithRagContext, { useRag, ragOnlyMode });
    const isLocalDirect = chatMode === 'direct-local';
    const directStartedAt = Date.now();
    const reply = isLocalDirect
      ? await callOllamaChat(directMessages)
      : await callExternalLlm(directMessages);
    const directDurationMs = Date.now() - directStartedAt;
    const newHistory = [
      ...historyWithUserMessage,
      { role: 'assistant', content: reply, displayContent: reply, timings: { totalMs: Date.now() - startedAt, ragMs: ragDurationMs, localDirectMs: isLocalDirect ? directDurationMs : 0, remoteDirectMs: isLocalDirect ? 0 : directDurationMs } },
    ].slice(-40);

    if (chatSessionKey) {
      await saveChatMemory(chatSessionKey, newHistory);
      await saveProxyChatMemory(chatSessionKey, []);
      await saveLabelMap(chatSessionKey, {});
      await saveChatRecord(chatSessionKey, { access: { public: true, secretHash: null }, settings: { chatMode, useRag, ragKey: rag?.key || null } });
    }

    return {
      reply,
      displayResponse: reply,
      history: newHistory,
      proxyHistory: [],
      labelMap: {},
      timings: { totalMs: Date.now() - startedAt, ragMs: ragDurationMs, localDirectMs: isLocalDirect ? directDurationMs : 0, remoteDirectMs: isLocalDirect ? 0 : directDurationMs },
      ragConfidence: ragConfidence.level,
      ragKey: rag?.key || '',
      ragLabel: rag?.label || '',
    };
  }

  const sanitizeResult = await sanitizeWithOllama(messageWithRagContext, labelMap, () => {}, { singlePass });
  const sanitizedMessage = sanitizeResult.finalSanitized;
  const finalLabelMap = sanitizeResult.updatedLabelMap || labelMap;
  const messages = buildMessagesWithMemory(proxyHistory, sanitizedMessage, { useRag, ragOnlyMode });
  const proxyStartedAt = Date.now();
  const reply = await callExternalLlm(messages);
  const proxyDurationMs = Date.now() - proxyStartedAt;
  const displayResponse = deAnonymizeText(reply, finalLabelMap);
  const newHistory = [
    ...historyWithUserMessage,
    { role: 'assistant', content: reply, displayContent: displayResponse, timings: { totalMs: Date.now() - startedAt, ragMs: ragDurationMs, regexMs: sanitizeResult.timings?.regexMs || 0, ollamaStages: sanitizeResult.timings?.ollamaStages || [], proxyMs: proxyDurationMs } },
  ].slice(-40);
  const newProxyHistory = [
    ...proxyHistory,
    { role: 'user', content: sanitizedMessage },
    { role: 'assistant', content: reply },
  ].slice(-40);

  if (chatSessionKey) {
    await saveChatMemory(chatSessionKey, newHistory);
    await saveProxyChatMemory(chatSessionKey, newProxyHistory);
    await saveLabelMap(chatSessionKey, finalLabelMap);
    await saveChatRecord(chatSessionKey, { access: { public: true, secretHash: null }, settings: { chatMode, useRag, ragKey: rag?.key || null } });
  }

  return {
    reply,
    displayResponse,
    history: newHistory,
    proxyHistory: newProxyHistory,
    labelMap: finalLabelMap,
    sanitizedMessage,
    timings: { totalMs: Date.now() - startedAt, ragMs: ragDurationMs, regexMs: sanitizeResult.timings?.regexMs || 0, ollamaStages: sanitizeResult.timings?.ollamaStages || [], proxyMs: proxyDurationMs },
    ragConfidence: ragConfidence.level,
    ragKey: rag?.key || '',
    ragLabel: rag?.label || '',
  };
}

async function requireOpenAiCompatAuth(req, res) {
  const settings = await getOpenAiCompatSettings();
  if (!settings.enabled) {
    res.status(404).json({ error: { message: 'OpenAI-compatible API desactivada', type: 'invalid_request_error', code: 'openai_compat_disabled' } });
    return false;
  }

  if (!settings.apiKey) return true;
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token === settings.apiKey) return true;
  res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
  return false;
}

function buildOpenAiChatCompletionResponse({ model, content, finishReason = 'stop' }) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function sendOpenAiStreamResponse(res, { model, content }) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const writeChunk = payload => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  writeChunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  if (content) {
    writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
  }
  writeChunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function appendOpenAiCompatDebugLog(entry) {
  try {
    const settings = await getOpenAiCompatSettings();
    if (!settings.debugLogEnabled) return;
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
    await fs.appendFile(openAiCompatDebugLogPath, line, 'utf8');
  } catch (error) {
    console.error('No pude escribir el log temporal de OpenAI compat:', error?.message || error);
  }
}

function buildMessagesWithMemory(history, message, options = {}) {
  const trimmedHistory = history
    .filter(item => !item?.debugOnly)
    .slice(-20)
    .map(item => ({
    role: item.role,
    content: item.content,
  }));

  const systemParts = [
    'Usa el historial de esta conversación como memoria local de esta ventana. Si el usuario pregunta quién es, qué dijo antes, que resumas el documento anterior o que te bases en un adjunto previo, respóndelo usando ese historial.',
    'Cuando en mensajes anteriores haya bloques como ------DOCUMENTO------, considera que ese texto forma parte del contexto disponible de la conversación hasta que el usuario cambie de tema o pida otra cosa.',
    'Las etiquetas como <telefono1>, <dni1>, <nie1>, <email1>, <iban1>, <matricula1>, <referencia1>, <direccion1>, <persona1>, <secret1> o <token1> sustituyen texto real que estaba presente en el mensaje original.',
    'Debes interpretar cada etiqueta como si el dato real siguiera ahí, para comprender el sentido completo de la frase y responder con normalidad.',
    'Por ejemplo, si el usuario pregunta por su DNI, su nombre, su dirección o una referencia previamente mencionada, responde usando el significado contextual de la etiqueta correspondiente, como si hubieras visto el dato real.',
    'No digas que no conoces el dato solo porque aparece una etiqueta, ni describas la etiqueta como si fuera el contenido original.',
    'No inventes, no expandas y no reconstruyas el valor oculto.',
    'Si necesitas citar ese dato en tu respuesta, conserva exactamente la misma etiqueta y no pongas texto inventado dentro de ella.',
  ];

  if (options.useRag && options.ragOnlyMode) {
    systemParts.push(
      'Si el mensaje incluye contexto RAG local, responde solo con la información que aparezca en ese contexto recuperado.',
      'Si la respuesta no está en ese contexto, di de forma natural que no lo sabes.',
      'No menciones frases como "según el contexto", "con la información proporcionada", "en el texto dado" o similares salvo que el usuario lo pida explícitamente.'
    );
  }

  return [
    {
      role: 'system',
      content: systemParts.join(' '),
    },
    ...trimmedHistory,
    {
      role: 'user',
      content: message,
    },
  ];
}

function nextLabel(labelMap, label) {
  const used = Object.keys(labelMap)
    .map(key => {
      const match = key.match(new RegExp(`^<${label}(\\d+)>$`));
      return match ? Number(match[1]) : 0;
    })
    .filter(Boolean);
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `<${label}${next}>`;
}

function replaceWithCounter(text, regex, label, labelMap, detectedItems = null, valueTransform = null) {
  return text.replace(regex, match => {
    const value = typeof valueTransform === 'function' ? valueTransform(match) : match;
    const existing = Object.entries(labelMap).find(([, currentValue]) => currentValue === value)?.[0];
    const replacement = existing || nextLabel(labelMap, label);

    if (Array.isArray(detectedItems) && !detectedItems.find(item => item.label === replacement && item.value === value)) {
      detectedItems.push({ label: replacement, value });
    }

    if (!existing) {
      labelMap[replacement] = value;
    }

    return match.replace(value, replacement);
  });
}

function replaceWithCounterGroup(text, regex, label, labelMap, groupIndex = 1, detectedItems = null) {
  return text.replace(regex, (...args) => {
    const match = args[0];
    const groups = args.slice(1, -2);
    const target = groups[groupIndex - 1];
    if (!target) return match;

    const existing = Object.entries(labelMap).find(([, value]) => value === target)?.[0];
    const replacement = existing || nextLabel(labelMap, label);

    if (Array.isArray(detectedItems) && !detectedItems.find(item => item.label === replacement && item.value === target)) {
      detectedItems.push({ label: replacement, value: target });
    }

    if (!existing) {
      labelMap[replacement] = target;
    }

    return match.replace(target, replacement);
  });
}

const CREDENTIAL_VALUE_STOPWORDS = new Set([
  'a', 'al', 'de', 'del', 'el', 'ella', 'ello', 'en', 'es', 'la', 'las', 'lo', 'los', 'no', 'o', 'para', 'pida',
  'por', 'que', 'qué', 'se', 'si', 'sí', 'su', 'sus', 'un', 'una', 'y'
]);

function isLikelyCredentialValue(value, options = {}) {
  const normalized = String(value || '').trim();
  const lower = normalized.toLowerCase();
  if (!normalized) return false;
  if (/^<[^>]+>$/.test(normalized)) return false;
  if (CREDENTIAL_VALUE_STOPWORDS.has(lower)) return false;
  if (normalized.length <= 2) return false;

  const allowPlainWords = options.allowPlainWords !== false;
  const hasCredentialShape = /[@._\-/:=]/.test(normalized) || /\d/.test(normalized) || /[A-Z]/.test(normalized);

  if (hasCredentialShape) return true;
  if (!allowPlainWords) return false;
  return normalized.length >= 4;
}

async function readRegexRules() {
  const fallbackRules = [
    { name: 'dni', pattern: '\\b\\d{8}[ -]?[A-HJ-NP-TV-Z]\\b', flags: 'gi', label: 'dni' },
    { name: 'nie', pattern: '\\b[XYZ]\\d{7}[ -]?[A-HJ-NP-TV-Z]\\b', flags: 'gi', label: 'nie' },
    { name: 'cif', pattern: '\\b[ABCDEFGHJNPQRSUVW][ -]?\\d{7}[0-9A-J]\\b', flags: 'gi', label: 'cif' },
    { name: 'email', pattern: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b', flags: 'gi', label: 'email' },
    { name: 'iban', pattern: '\\b[A-Z]{2}\\d{2}(?:\\s?[A-Z0-9]{4}){4,7}\\b', flags: 'gi', label: 'iban' },
    { name: 'telefono_movil', pattern: '\\b(?:\\+34\\s*)?(?:6\\d{2}|7[1-9]\\d)(?:[\\s-]?\\d{3}){2}\\b', flags: 'g', label: 'telefono' },
    { name: 'telefono_fijo', pattern: '\\b(?:\\+34\\s*)?(?:8\\d{2}|9\\d{2})(?:[\\s-]?\\d{3}){2}\\b', flags: 'g', label: 'telefono' },
    { name: 'pago_tarjeta', pattern: '\\b(?:\\d[ -]*?){13,19}\\b', flags: 'g', label: 'pago' },
    { name: 'pago_cvv', pattern: '\\b(?:cvv|cvc|cvn|security\\s*code)\\s*[:=]?\\s*\\d{3,4}\\b', flags: 'gi', label: 'pago' },
    { name: 'pago_caducidad', pattern: '\\b(?:caducidad|exp(?:iry|iration)?|valid\\s*thru)\\s*[:=]?\\s*(?:0[1-9]|1[0-2])\\s*[\\/\\-]\\s*(?:\\d{2}|\\d{4})\\b', flags: 'gi', label: 'pago' },
    { name: 'matricula', pattern: '\\b\\d{4}[ -]?[BCDFGHJKLMNPRSTVWXYZ]{3}\\b', flags: 'gi', label: 'matricula' },
    { name: 'token_sk', pattern: '\\bsk-[A-Za-z0-9_-]{12,}\\b', flags: 'g', label: 'token' },
    { name: 'token_ghp', pattern: '\\bghp_[A-Za-z0-9]{20,}\\b', flags: 'g', label: 'token' },
    { name: 'token_google', pattern: '\\bAIza[0-9A-Za-z\\-_]{20,}\\b', flags: 'g', label: 'token' },
    { name: 'token_jwt', pattern: '\\beyJ[A-Za-z0-9_=-]+\\.[A-Za-z0-9_=-]+\\.[A-Za-z0-9_=-]+\\b', flags: 'g', label: 'token' },
  ];

  try {
    const raw = await fs.readFile(regexRulesPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallbackRules;
  } catch {
    return fallbackRules;
  }
}

function validateRegexRules(rules) {
  if (!Array.isArray(rules) || !rules.length) {
    throw new Error('Debe haber al menos una regla regex');
  }

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') throw new Error('Regla regex inválida');
    if (!String(rule.name || '').trim()) throw new Error('Cada regla debe tener nombre');
    if (!String(rule.pattern || '').trim()) throw new Error(`La regla ${rule.name || '(sin nombre)'} no tiene patrón`);
    if (!String(rule.label || '').trim()) throw new Error(`La regla ${rule.name || '(sin nombre)'} no tiene etiqueta`);
    try {
      new RegExp(String(rule.pattern), String(rule.flags || ''));
    } catch (error) {
      throw new Error(`Regex inválida en ${rule.name || '(sin nombre)'}: ${error.message || error}`);
    }
  }
}

async function sanitizeStructuredDataWithRegex(text, labelMap) {
  let output = text;
  const detectedItems = [];
  const regexRules = await readRegexRules();

  for (const rule of regexRules) {
    const regex = new RegExp(String(rule.pattern), String(rule.flags || ''));
    output = replaceWithCounter(output, regex, String(rule.label), labelMap, detectedItems);
  }

  output = replaceWithCounter(
    output,
    /\b(?:pedido|orden|order|ref(?:erencia)?)\s*[:#-]\s*[A-Z0-9][A-Z0-9-]{3,}\b/gi,
    'referencia',
    labelMap,
    detectedItems,
    match => {
      const extracted = match.match(/[A-Z0-9][A-Z0-9-]{3,}\b$/i);
      return extracted ? extracted[0] : match;
    }
  );
  output = replaceWithCounterGroup(
    output,
    /\b(?:api[_-]?key|token|secret|password|passwd|contrase(?:n|ñ)a)\b(?:\s*[:=]\s*|\s+)(\S+)/gi,
    'secret',
    labelMap,
    1,
    detectedItems,
  );
  output = output.replace(/\b(?:usuario|user|login)\b(\s*[:=]\s*|\s+)(\S+)/gi, (match, separator, target) => {
    if (!isLikelyCredentialValue(target, { allowPlainWords: true })) {
      return match;
    }

    const existing = Object.entries(labelMap).find(([, value]) => value === target)?.[0];
    const replacement = existing || nextLabel(labelMap, 'secret');

    if (Array.isArray(detectedItems) && !detectedItems.find(item => item.label === replacement && item.value === target)) {
      detectedItems.push({ label: replacement, value: target });
    }

    if (!existing) {
      labelMap[replacement] = target;
    }

    return match.replace(target, replacement);
  });

  return { output, detectedItems, regexRules };
}

function parseOllamaEntityList(text) {
  const raw = String(text || '').trim();

  if (!raw) return [];

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      return items
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .filter((line, index, array) => array.indexOf(line) === index);
    } catch {
      // cae al parser por lineas
    }
  }

  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .map(line => line.replace(/^\d+[.)]\s*/, '').trim())
    .map(line => line.replace(/\s*\([^)]*\)\s*$/g, '').trim())
    .map(line => line.replace(/[.,;:]+$/g, '').trim())
    .filter(Boolean)
    .filter(line => !/^ninguno$/i.test(line))
    .filter(line => !/^ninguna$/i.test(line))
    .filter(line => !/^no hay/i.test(line))
    .filter(line => !/^los nombres/i.test(line))
    .filter(line => !/^las entidades/i.test(line))
    .filter(line => !/^son:?$/i.test(line))
    .filter(line => !/^ejemplos? /i.test(line))
    .filter(line => !/^ejemplo:?$/i.test(line))
    .filter(line => !/^validos:?$/i.test(line))
    .filter(line => !/^no validos:?$/i.test(line))
    .filter(line => !/^respuesta:?$/i.test(line))
    .filter(line => !/^salida:?$/i.test(line))
    .filter((line, index, array) => array.indexOf(line) === index);
}

function normalizeComparableChunk(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u0060\u00B4]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildComparableText(source) {
  const raw = String(source || '');
  const chars = [];
  const startOffsets = [];
  const endOffsets = [];
  let offset = 0;
  let previousWasSpace = false;

  for (const char of raw) {
    const start = offset;
    offset += char.length;

    const normalized = normalizeComparableChunk(char);
    for (const normalizedChar of normalized) {
      const isSpace = /\s/u.test(normalizedChar);
      if (isSpace) {
        if (previousWasSpace) continue;
        chars.push(' ');
        startOffsets.push(start);
        endOffsets.push(offset);
        previousWasSpace = true;
        continue;
      }

      chars.push(normalizedChar);
      startOffsets.push(start);
      endOffsets.push(offset);
      previousWasSpace = false;
    }
  }

  while (chars.length && chars[0] === ' ') {
    chars.shift();
    startOffsets.shift();
    endOffsets.shift();
  }

  while (chars.length && chars[chars.length - 1] === ' ') {
    chars.pop();
    startOffsets.pop();
    endOffsets.pop();
  }

  return {
    text: chars.join(''),
    startOffsets,
    endOffsets,
  };
}

function isComparableWordChar(char) {
  return /[\p{L}\p{N}_]/u.test(String(char || ''));
}

function findEntityMatches(text, value) {
  const comparableText = buildComparableText(text);
  const comparableValue = normalizeComparableChunk(value).trim();
  if (!comparableText.text || !comparableValue) return [];

  const matches = [];
  let searchFrom = 0;
  while (searchFrom <= comparableText.text.length) {
    const index = comparableText.text.indexOf(comparableValue, searchFrom);
    if (index === -1) break;

    const before = index > 0 ? comparableText.text[index - 1] : '';
    const afterIndex = index + comparableValue.length;
    const after = afterIndex < comparableText.text.length ? comparableText.text[afterIndex] : '';
    const hasBoundaryBefore = !before || !isComparableWordChar(before);
    const hasBoundaryAfter = !after || !isComparableWordChar(after);

    if (hasBoundaryBefore && hasBoundaryAfter) {
      matches.push({
        start: comparableText.startOffsets[index],
        end: comparableText.endOffsets[afterIndex - 1],
        comparableStart: index,
        comparableEnd: afterIndex,
      });
    }

    searchFrom = index + Math.max(1, comparableValue.length);
  }

  return matches;
}

function textContainsExactValue(text, value) {
  return findEntityMatches(text, value).length > 0;
}

function areComparableValuesEqual(left, right) {
  const normalizedLeft = normalizeComparableChunk(left).trim();
  const normalizedRight = normalizeComparableChunk(right).trim();
  return !!normalizedLeft && normalizedLeft === normalizedRight;
}

function isPlausibleDetectedValue(labelType, value) {
  const normalized = String(value || '').trim();
  const lower = normalized.toLowerCase();
  if (!normalized) return false;
  if (/^<[^>]+>$/.test(normalized)) return false;

  if (labelType === 'referencia') {
    if (/\.(pdf|docx?|xlsx?|pptx?|txt|md|json|csv)$/i.test(normalized)) return false;
    if (/^[a-záéíóúñç\s]+$/i.test(normalized)) return false;
    if (/^<[^>]+>$/.test(normalized)) return false;
    if (/[<>]/.test(normalized)) return false;
    if (/(?:api[_-]?key|token|secret|password|passwd|contrase(?:n|ñ)a|iban|correo|email|telefono|teléfono)/i.test(normalized)) return false;
    if (/^(pedido|referencia|referències|referencias|referencia de pedido|codigo|c[oó]digo|numero|n[uú]mero|p[oó]liza|poliza)$/i.test(lower)) return false;
    if (/^(pedido hasta|reflexi|pedido\d+|referencia\d+)$/i.test(lower)) return false;
    if (/^\d{1,5}$/.test(normalized)) return false;
    if (/^\d{6,}$/.test(normalized)) return true;
    if (!/[0-9]/.test(normalized)) return false;
    if (!/[A-Za-z]/.test(normalized) && !/[\-_/]/.test(normalized)) return false;
    if (normalized.length < 5) return false;
    return true;
  }

  if (labelType === 'direccion') {
    if (/^pag\.?\s*\d+$/i.test(normalized)) return false;
    if (/^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+\d{4}$/i.test(normalized)) return false;
    const hasStreetWord = /\b(calle|c\/|avda\.?|avenida|plaza|paseo|pg\.?|passatge|cami|camino|carretera|ronda|via|travessera|travesia)\b/i.test(normalized);
    const hasPostalShape = /\d/.test(normalized) && /[\p{L}]/u.test(normalized);
    return hasStreetWord || hasPostalShape;
  }

  if (labelType === 'persona') {
    if (/^(toyota|amazon|google|ikea|zara|mapfre|caixabank)$/i.test(lower)) return false;
    return true;
  }

  return true;
}

function mergeDetectedValuesIntoLabelMap(values, labelType, labelMap, sourceText) {
  const result = { ...labelMap };

  for (const rawValue of values) {
    const value = String(rawValue || '').trim();
    if (!value) continue;
    if (/^<[^>]+>$/.test(value)) continue;
    if (!textContainsExactValue(sourceText, value)) continue;
    if (!isPlausibleDetectedValue(labelType, value)) continue;

    const existing = Object.entries(result).find(([, currentValue]) => areComparableValuesEqual(currentValue, value))?.[0];
    if (existing) continue;

    const label = nextLabel(result, labelType);
    result[label] = value;
  }

  return result;
}

function buildReplacementMapForType(labelMap, labelType, sourceText = '') {
  return Object.entries(labelMap)
    .filter(([label]) => new RegExp(`^<${labelType}\\d+>$`).test(label))
    .filter(([, value]) => value && findEntityMatches(sourceText, value).length > 0)
    .sort((a, b) => b[1].length - a[1].length);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceEntitiesDeterministically(text, replacements) {
  const source = String(text);
  const candidates = [];

  for (const [label, value] of replacements) {
    if (!value) continue;
    const matches = findEntityMatches(source, value);
    for (const match of matches) {
      candidates.push({
        label,
        start: match.start,
        end: match.end,
        length: match.end - match.start,
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (b.length !== a.length) return b.length - a.length;
    return b.label.length - a.label.length;
  });

  const selected = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    selected.push(candidate);
    cursor = candidate.end;
  }

  if (!selected.length) return source;

  let output = '';
  let lastIndex = 0;
  for (const candidate of selected) {
    output += source.slice(lastIndex, candidate.start);
    output += candidate.label;
    lastIndex = candidate.end;
  }
  output += source.slice(lastIndex);
  return output;
}

async function callOllama(prompt) {
  const ollamaSettings = await getOllamaSettings();
  const res = await fetch(`${ollamaSettings.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaSettings.model,
      prompt,
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0 },
    }),
  });

  const parsed = await parseHttpBody(res);
  const data = parsed.data;
  if (!res.ok) {
    throw new Error(buildUpstreamError('Ollama error', res, parsed));
  }

  return String(data?.response || '').trim();
}

async function callOllamaChat(messages) {
  const ollamaSettings = await getOllamaSettings();
  const res = await fetch(`${ollamaSettings.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaSettings.model,
      messages,
      stream: false,
      options: { temperature: 0.3 },
    }),
  });

  const parsed = await parseHttpBody(res);
  const data = parsed.data;
  if (!res.ok) {
    throw new Error(buildUpstreamError('Ollama chat error', res, parsed));
  }

  return String(data?.message?.content || '').trim();
}

async function readPromptFile(filePath, fallbackLines) {
  try {
    const prompt = await fs.readFile(filePath, 'utf8');
    return String(prompt || '').trim();
  } catch {
    return fallbackLines.join('\n');
  }
}

async function getOllamaStageConfig() {
  return {
    persona: {
      labelType: 'persona',
      prompt: await readPromptFile(multiPassPersonaPromptPath, [
        'extrae solo nombres de persona del texto.',
        'responde solo con json valido: {"items":["..."]}',
        'esta prohibido resumir, explicar, comentar o reformular el texto.',
        'cualquier salida fuera del json es un error.',
        'si no cumples exactamente el formato json pedido, responde exactamente {"items":[]}.',
        'copia literal exacta del texto, sin cambios.',
        'incluye nombres de persona en contextos como cliente, usuario, empleada, empleado, autor o contacto.',
        'no incluyas pronombres como yo o jo.',
        'no incluyas empresas, marcas ni conceptos.',
        'si dudas, no lo incluyas.',
        'si no hay personas, responde exactamente {"items":[]}',
      ]),
    },
    direccion: {
      labelType: 'direccion',
      prompt: await readPromptFile(multiPassDireccionPromptPath, [
        'extrae solo direcciones postales del texto.',
        'responde solo con json valido: {"items":["..."]}',
        'esta prohibido resumir, explicar, comentar o reformular el texto.',
        'cualquier salida fuera del json es un error.',
        'si no cumples exactamente el formato json pedido, responde exactamente {"items":[]}.',
        'copia literal exacta del texto, sin cambios.',
        'solo incluye calle, avenida, plaza, paseo o similar con numero.',
        'no incluyas fechas, paginas, frases ni lugares sin numero.',
        'si dudas, no lo incluyas.',
        'si no hay direcciones, responde exactamente {"items":[]}',
      ]),
    },
    referencia: {
      labelType: 'referencia',
      prompt: await readPromptFile(multiPassReferenciaPromptPath, [
        'extrae solo referencias o codigos sensibles del texto.',
        'responde solo con json valido: {"items":["..."]}',
        'esta prohibido resumir, explicar, comentar o reformular el texto.',
        'cualquier salida fuera del json es un error.',
        'si no cumples exactamente el formato json pedido, responde exactamente {"items":[]}.',
        'copia literal exacta del texto, sin cambios.',
        'solo incluye valores completos que parezcan referencias, codigos internos, identificadores operativos o localizadores sensibles, por ejemplo AX-993817 o PED-2026-88.',
        'tambien puedes incluir identificadores numericos puros si son suficientemente largos y por contexto parecen datos sensibles o referencias, por ejemplo 12611594.',
        'si aparece un numero entero aislado de 6 o mas digitos, considera que probablemente es una referencia o identificador sensible, salvo que claramente sea un importe, una fecha, una pagina o un porcentaje.',
        'no incluyas palabras genericas como referencia, pedido, codigo, numero, poliza ni etiquetas ya anonimizadas como <referencia1>, <iban1>, <dni1>, <persona1>, <secret1> o similares.',
        'no incluyas porcentajes, fechas, importes, salarios, cantidades triviales, paginas, titulos, frases ni nombres de archivo.',
        'puedes incluir otros identificadores sensibles si por el contexto parecen referencias, codigos internos, localizadores o identificadores operativos relevantes.',
        'no devuelvas placeholders, nombres de etiquetas ni valores ya anonimizados aunque aparezcan en el texto transformado.',
        'si el texto no parece claramente una referencia o codigo sensible, no lo incluyas.',
        'si dudas, no lo incluyas.',
        'si no hay referencias o codigos sensibles, responde exactamente {"items":[]}',
      ]),
    },
  };
}

async function detectEntitiesWithOllama({ text, stage }) {
  const stageConfig = await getOllamaStageConfig();
  const config = stageConfig[stage];
  const prompt = [String(config?.prompt || '').trim(), '', 'texto:', text].join('\n');
  const rawResponse = await callOllama(prompt);
  const values = parseOllamaEntityList(rawResponse);

  return {
    rawResponse,
    values,
    labelType: config.labelType,
    prompt,
  };
}

async function extractTextFromUploadedFile(file) {
  if (!file) {
    return { ok: true, text: '', meta: null };
  }

  const originalName = file.originalname || 'documento';
  const ext = path.extname(originalName).toLowerCase();
  const mime = file.mimetype || 'application/octet-stream';

  if (['.txt', '.md', '.json', '.csv', '.log'].includes(ext) || mime.startsWith('text/')) {
    return {
      ok: true,
      text: Buffer.from(file.buffer).toString('utf8'),
      meta: { name: originalName, mime, ext, method: 'text-direct' },
    };
  }

  if (ext === '.pdf' || mime === 'application/pdf') {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daimon-'));
    const inputPath = path.join(tempDir, 'input.pdf');
    const outputPath = path.join(tempDir, 'output.txt');

    try {
      await fs.writeFile(inputPath, file.buffer);
      await execFileAsync('pdftotext', [inputPath, outputPath]);
      const text = await fs.readFile(outputPath, 'utf8');
      return {
        ok: true,
        text,
        meta: { name: originalName, mime, ext, method: 'pdftotext' },
      };
    } catch (error) {
      return {
        ok: false,
        text: '',
        meta: { name: originalName, mime, ext, method: 'pdftotext' },
        error: `No pude extraer el texto del PDF: ${error.message || error}`,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    ok: false,
    text: '',
    meta: { name: originalName, mime, ext, method: 'unsupported' },
    error: 'Tipo de documento no soportado todavía. Usa txt, md, json, csv o pdf.',
  };
}

function buildUserMessageWithDocument(message, documentText, documentMeta) {
  const baseMessage = String(message || '').trim();
  const cleanDoc = String(documentText || '').trim();

  if (!cleanDoc) {
    return baseMessage;
  }

  return [
    '------TEXTO_USUARIO------',
    baseMessage,
    '',
    '------DOCUMENTO------',
    `nombre: ${documentMeta?.name || 'documento'}`,
    cleanDoc,
  ].join('\n');
}

async function readSinglePassPromptTemplate() {
  try {
    const prompt = await fs.readFile(singlePassPromptPath, 'utf8');
    return String(prompt || '').trim();
  } catch {
    return [
      'extrae entidades del texto y devuelve solo json valido con este formato exacto:',
      '{"persona":["..."],"direccion":["..."],"referencia":["..."]}',
      'esta prohibido resumir, explicar, comentar o reformular el texto.',
      'cualquier salida fuera del json es un error.',
      'si no cumples exactamente el formato json pedido, responde exactamente {"persona":[],"direccion":[],"referencia":[]}.',
      'copia literal exacta del texto, sin cambios.',
      'persona: solo nombres de persona reales y concretos, no empresas, marcas, cargos, conceptos ni frases.',
      'direccion: solo direcciones postales concretas, no fechas, lugares vagos, paises, ciudades sueltas ni frases.',
      'referencia: solo codigos, localizadores, identificadores internos o referencias sensibles cortas y concretas.',
      'referencia tambien puede ser un numero entero aislado de 6 o mas digitos si por contexto parece un identificador sensible, por ejemplo 12611594.',
      'referencia no puede ser una frase larga ni una oracion descriptiva.',
      'referencia debe ser un valor concreto y reutilizable, por ejemplo un codigo, localizador, identificador corto o identificador numerico sensible.',
      'no incluyas importes, salarios, porcentajes, fechas, frases sobre pagos, frases contractuales, descripciones largas, cantidades triviales ni texto narrativo.',
      'no incluyas placeholders, etiquetas ya anonimizadas o valores como <iban1>, <dni1>, <persona1>, <secret1> o similares.',
      'no devuelvas nombres de etiquetas ni trozos de texto que contengan etiquetas anonimizadas.',
      'si no hay valores para una categoria, devuelve un array vacio en esa categoria.',
    ].join('\n');
  }
}

async function buildSinglePassOllamaPrompt(text) {
  const template = await readSinglePassPromptTemplate();
  return [
    template,
    '',
    'texto:',
    text,
  ].join('\n');
}

function parseSinglePassOllamaResponse(rawResponse) {
  let parsed = { persona: [], direccion: [], referencia: [] };
  try {
    const json = JSON.parse(rawResponse);
    parsed = {
      persona: Array.isArray(json?.persona) ? json.persona : [],
      direccion: Array.isArray(json?.direccion) ? json.direccion : [],
      referencia: Array.isArray(json?.referencia) ? json.referencia : [],
    };
  } catch {
    parsed = { persona: [], direccion: [], referencia: [] };
  }
  return parsed;
}

async function sanitizeWithOllamaSinglePass(regexSanitized, labelMap, onProgress, regexDurationMs) {
  let currentText = regexSanitized;
  let currentLabelMap = { ...labelMap };
  const rawResponses = [];
  const debugStages = [];
  const ollamaStages = [];
  const stageConfig = await getOllamaStageConfig();
  const stageStartedAt = Date.now();
  const prompt = await buildSinglePassOllamaPrompt(currentText);
  const rawResponse = await callOllama(prompt);
  const parsed = parseSinglePassOllamaResponse(rawResponse);

  for (const stage of ['persona', 'direccion', 'referencia']) {
    const labelType = stageConfig[stage].labelType;
    const detectedValues = parsed[stage] || [];
    const nextLabelMap = mergeDetectedValuesIntoLabelMap(detectedValues, labelType, currentLabelMap, currentText);
    const replacements = buildReplacementMapForType(nextLabelMap, labelType, currentText);

    const textBefore = currentText;
    const replacedText = replaceEntitiesDeterministically(currentText, replacements);
    currentText = replacedText;
    currentLabelMap = nextLabelMap;

    const debugStage = {
      stage,
      detectedRaw: rawResponse || 'NINGUNO',
      detectedValues,
      labelType,
      replacements: replacements.map(([label, value]) => ({ label, value })),
      textBefore,
      textAfter: replacedText,
      labelMapAfter: currentLabelMap,
      durationMs: 0,
    };

    rawResponses.push(
      `### ${stage}:deteccion\n${JSON.stringify(detectedValues)}\n\n### ${stage}:reemplazo\n${replacements.map(([label, value]) => `${label} = ${value}`).join('\n') || 'SIN_REEMPLAZOS'}`
    );
    debugStages.push(debugStage);
  }

  const stageDurationMs = Date.now() - stageStartedAt;
  ollamaStages.push({ stage: 'single-pass', durationMs: stageDurationMs });

  onProgress?.({
    type: 'ollama-stage',
    stage: 'single-pass',
    title: 'Ollama · único paso',
    text: currentText,
    rawResponse: rawResponse || 'NINGUNO',
    prompt,
    replacements: [],
    debugStage: null,
    labelMap: currentLabelMap,
    durationMs: stageDurationMs,
  });

  return {
    regexSanitized,
    finalSanitized: currentText,
    ollamaResponse: rawResponses.join('\n\n'),
    ollamaDisplayText: currentText,
    updatedLabelMap: currentLabelMap,
    debugStages,
    timings: {
      regexMs: regexDurationMs,
      ollamaStages,
    },
  };
}

async function sanitizeWithOllamaMultiPass(regexSanitized, labelMap, onProgress, regexDurationMs) {
  let currentText = regexSanitized;
  let currentLabelMap = { ...labelMap };
  const rawResponses = [];
  const debugStages = [];
  const ollamaStages = [];

  for (const stage of ['persona', 'direccion', 'referencia']) {
    const stageStartedAt = Date.now();
    const detected = await detectEntitiesWithOllama({ text: currentText, stage });
    const nextLabelMap = mergeDetectedValuesIntoLabelMap(detected.values, detected.labelType, currentLabelMap, currentText);
    const replacements = buildReplacementMapForType(nextLabelMap, detected.labelType, currentText);

    const textBefore = currentText;
    const replacedText = replaceEntitiesDeterministically(currentText, replacements);
    const stageDurationMs = Date.now() - stageStartedAt;

    currentText = replacedText;
    currentLabelMap = nextLabelMap;
    rawResponses.push(
      `### ${stage}:deteccion\n${detected.rawResponse || 'NINGUNO'}\n\n### ${stage}:reemplazo\n${replacements.map(([label, value]) => `${label} = ${value}`).join('\n') || 'SIN_REEMPLAZOS'}`
    );

    const debugStage = {
      stage,
      detectedRaw: detected.rawResponse || 'NINGUNO',
      detectedValues: detected.values,
      labelType: detected.labelType,
      replacements: replacements.map(([label, value]) => ({ label, value })),
      textBefore,
      textAfter: replacedText,
      labelMapAfter: currentLabelMap,
      durationMs: stageDurationMs,
    };

    debugStages.push(debugStage);
    ollamaStages.push({ stage, durationMs: stageDurationMs });

    onProgress?.({
      type: 'ollama-stage',
      stage,
      title: `Ollama · ${stage}`,
      text: replacedText,
      rawResponse: detected.rawResponse || 'NINGUNO',
      prompt: detected.prompt,
      replacements: debugStage.replacements,
      debugStage,
      labelMap: currentLabelMap,
      durationMs: stageDurationMs,
    });
  }

  return {
    regexSanitized,
    finalSanitized: currentText,
    ollamaResponse: rawResponses.join('\n\n'),
    ollamaDisplayText: currentText,
    updatedLabelMap: currentLabelMap,
    debugStages,
    timings: {
      regexMs: regexDurationMs,
      ollamaStages,
    },
  };
}

async function sanitizeWithOllama(message, labelMap, onProgress, options = {}) {
  const regexStartedAt = Date.now();
  const regexResult = await sanitizeStructuredDataWithRegex(message, labelMap);
  const regexSanitized = regexResult.output;
  const regexDurationMs = Date.now() - regexStartedAt;

  onProgress?.({
    type: 'regex',
    title: 'Texto tras regex',
    text: regexSanitized,
    detectedItems: regexResult.detectedItems,
    detectedText: regexResult.detectedItems.length
      ? regexResult.detectedItems.map(item => `${item.label}: ${item.value}`).join('\n')
      : 'Sin coincidencias detectadas por regex.',
    durationMs: regexDurationMs,
  });

  if (!USE_OLLAMA_SANITIZER) {
    return {
      regexSanitized,
      finalSanitized: regexSanitized,
      ollamaResponse: regexSanitized,
      ollamaDisplayText: regexSanitized,
      updatedLabelMap: labelMap,
      debugStages: [],
      timings: {
        regexMs: regexDurationMs,
        ollamaStages: [],
      },
    };
  }

  if (options.singlePass) {
    return sanitizeWithOllamaSinglePass(regexSanitized, labelMap, onProgress, regexDurationMs);
  }

  return sanitizeWithOllamaMultiPass(regexSanitized, labelMap, onProgress, regexDurationMs);
}

async function callExternalLlm(messages) {
  const proxySettings = await getExternalLlmSettings();
  const res = await fetch(`${proxySettings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: proxySettings.model,
      messages,
    }),
  });

  const parsed = await parseHttpBody(res);
  const data = parsed.data;
  if (!res.ok) {
    throw new Error(buildUpstreamError('Proxy error', res, parsed));
  }

  return data?.choices?.[0]?.message?.content?.trim() || JSON.stringify(data, null, 2);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', async (_req, res) => {
  const appConfig = await readAppConfig();
  res.json({
    proxyBaseUrl: appConfig.proxyBaseUrl,
    proxyModel: appConfig.proxyModel,
    ollamaBaseUrl: appConfig.ollamaBaseUrl,
    ollamaModel: appConfig.ollamaModel,
    ragEmbedBaseUrl: appConfig.ragEmbedBaseUrl,
    ragEmbedModel: appConfig.ragEmbedModel,
    rags: appConfig.rags || [],
    useOllamaSanitizer: USE_OLLAMA_SANITIZER,
    maxUploadMb: MAX_UPLOAD_MB,
    documentsEnabled: appConfig.documentsEnabled,
    publicChatEnabled: appConfig.publicChatEnabled,
    deepModeEnabled: appConfig.deepModeEnabled,
    openAiCompatEnabled: appConfig.openAiCompatEnabled,
    openAiCompatDebugLogEnabled: appConfig.openAiCompatDebugLogEnabled,
    openAiCompatDeepModeEnabled: appConfig.openAiCompatDeepModeEnabled,
    chatMode: appConfig.chatMode,
  });
});

app.get('/api/proxy-health', async (_req, res) => {
  try {
    const proxySettings = await getExternalLlmSettings();
    const upstream = await fetch(`${proxySettings.baseUrl}/models`);
    const parsed = await parseHttpBody(upstream);
    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: buildUpstreamError('Proxy health error', upstream, parsed), data: parsed.data, raw: parsed.rawText || null });
    }
    res.json({ ok: true, data: parsed.data ?? parsed.rawText });
  } catch (error) {
    res.status(502).json({ ok: false, error: String(error.message || error) });
  }
});

app.get('/api/ollama-health', async (_req, res) => {
  try {
    const ollamaSettings = await getOllamaSettings();
    const upstream = await fetch(`${ollamaSettings.baseUrl}/api/tags`);
    const parsed = await parseHttpBody(upstream);
    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: buildUpstreamError('Ollama health error', upstream, parsed), data: parsed.data, raw: parsed.rawText || null });
    }
    res.json({ ok: true, data: parsed.data ?? parsed.rawText });
  } catch (error) {
    res.status(502).json({ ok: false, error: String(error.message || error) });
  }
});

app.get('/api/rag-embed-health', async (req, res) => {
  try {
    const ragEmbedSettings = await getRagEmbedSettings();
    const requestedBaseUrl = String(req.query?.baseUrl || '').trim();
    const baseUrl = (requestedBaseUrl || ragEmbedSettings.baseUrl || '').replace(/\/$/, '');
    const upstream = await fetch(`${baseUrl}/api/tags`);
    const parsed = await parseHttpBody(upstream);
    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: buildUpstreamError('Ollama embeddings health error', upstream, parsed), data: parsed.data, raw: parsed.rawText || null, testedBaseUrl: baseUrl });
    }
    res.json({ ok: true, data: parsed.data ?? parsed.rawText, testedBaseUrl: baseUrl });
  } catch (error) {
    res.status(502).json({ ok: false, error: String(error.message || error) });
  }
});

app.post('/api/config-auth/verify', async (req, res) => {
  const password = String(req.body?.password || '');
  const appConfig = await readAppConfig();

  if (password !== appConfig.configPassword) {
    clearConfigSessionCookie(res);
    return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
  }

  const token = createConfigSession();
  setConfigSessionCookie(res, token);
  res.json({ ok: true });
});

app.get('/api/config-auth/status', requireConfigAuth, (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/config-auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  clearConfigSession(cookies[CONFIG_SESSION_COOKIE]);
  clearConfigSessionCookie(res);
  res.json({ ok: true });
});

app.use('/api/config-data', requireConfigAuth);

app.get('/api/config-data', async (req, res) => {

  const appConfig = await readAppConfig();
  const singlePassPrompt = await readSinglePassPromptTemplate();
  const multiPassConfig = await getOllamaStageConfig();
  const regexRules = await readRegexRules();
  const rags = await Promise.all((appConfig.rags || []).map(async rag => ({
    ...rag,
    files: await listRagUploads(rag.key),
    documents: listDocumentResults(3, { ragKey: rag.key }),
  })));
  res.json({
    ok: true,
    config: {
      ollamaBaseUrl: appConfig.ollamaBaseUrl,
      ollamaModel: appConfig.ollamaModel,
      proxyBaseUrl: appConfig.proxyBaseUrl,
      proxyModel: appConfig.proxyModel,
      ragEmbedBaseUrl: appConfig.ragEmbedBaseUrl,
      ragEmbedModel: appConfig.ragEmbedModel,
      rags,
      documentsEnabled: appConfig.documentsEnabled,
      publicChatEnabled: appConfig.publicChatEnabled,
      deepModeEnabled: appConfig.deepModeEnabled,
      openAiCompatEnabled: appConfig.openAiCompatEnabled,
      openAiCompatApiKey: appConfig.openAiCompatApiKey || '',
      openAiCompatDebugLogEnabled: appConfig.openAiCompatDebugLogEnabled,
      openAiCompatDeepModeEnabled: appConfig.openAiCompatDeepModeEnabled,
      chatMode: appConfig.chatMode,
      singlePassPrompt,
      multiPassPersonaPrompt: multiPassConfig.persona?.prompt || '',
      multiPassDireccionPrompt: multiPassConfig.direccion?.prompt || '',
      multiPassReferenciaPrompt: multiPassConfig.referencia?.prompt || '',
      regexRules,
    },
  });
});

app.post('/api/config-data/password', async (req, res) => {

  const nextPassword = String(req.body?.password || '').trim();
  if (!nextPassword) {
    return res.status(400).json({ ok: false, error: 'La nueva contraseña no puede estar vacía' });
  }

  const appConfig = await readAppConfig();
  await writeAppConfig({
    ...appConfig,
    configPassword: nextPassword,
  });

  res.json({ ok: true });
});

app.post('/api/config-data/ollama', async (req, res) => {

  const ollamaBaseUrl = String(req.body?.ollamaBaseUrl || '').trim();
  const ollamaModel = String(req.body?.ollamaModel || '').trim();

  if (!ollamaBaseUrl || !ollamaModel) {
    return res.status(400).json({ ok: false, error: 'La URL y el modelo de Ollama son obligatorios' });
  }

  const appConfig = await readAppConfig();
  await writeAppConfig({
    ...appConfig,
    ollamaBaseUrl,
    ollamaModel,
  });

  res.json({ ok: true });
});

app.post('/api/config-data/proxy', async (req, res) => {

  const proxyBaseUrl = String(req.body?.proxyBaseUrl || '').trim();
  const proxyModel = String(req.body?.proxyModel || '').trim();

  if (!proxyBaseUrl || !proxyModel) {
    return res.status(400).json({ ok: false, error: 'La URL y el modelo del proxy externo son obligatorios' });
  }

  const appConfig = await readAppConfig();
  await writeAppConfig({
    ...appConfig,
    proxyBaseUrl,
    proxyModel,
  });

  res.json({ ok: true });
});

app.post('/api/config-data/rag-embed', async (req, res) => {

  const ragEmbedBaseUrl = String(req.body?.ragEmbedBaseUrl || '').trim();
  const ragEmbedModel = String(req.body?.ragEmbedModel || '').trim();

  if (!ragEmbedBaseUrl || !ragEmbedModel) {
    return res.status(400).json({ ok: false, error: 'La URL y el modelo de embeddings son obligatorios' });
  }

  const appConfig = await readAppConfig();
  const previousModel = String(appConfig.ragEmbedModel || '').trim();
  const modelChanged = previousModel && previousModel !== ragEmbedModel;

  await writeAppConfig({
    ...appConfig,
    ragEmbedBaseUrl,
    ragEmbedModel,
    rags: appConfig.rags,
  });

  let revectorization = null;
  if (modelChanged) {
    revectorization = await revectorizeAllRagDocuments({ resetVectors: true });
  }

  res.json({ ok: true, modelChanged, revectorization });
});


app.post('/api/config-data/single-pass-prompt', async (req, res) => {

  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ ok: false, error: 'El prompt no puede estar vacío' });
  }

  await fs.mkdir(path.dirname(singlePassPromptPath), { recursive: true });
  await fs.writeFile(singlePassPromptPath, `${prompt}\n`);
  res.json({ ok: true });
});

app.post('/api/config-data/regex-rules', async (req, res) => {
  const rules = req.body?.rules;

  try {
    validateRegexRules(rules);
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error.message || error) });
  }

  await fs.mkdir(path.dirname(regexRulesPath), { recursive: true });
  await fs.writeFile(regexRulesPath, `${JSON.stringify(rules, null, 2)}\n`);
  res.json({ ok: true });
});

app.post('/api/config-data/multi-pass-prompts', async (req, res) => {

  const personaPrompt = String(req.body?.personaPrompt || '').trim();
  const direccionPrompt = String(req.body?.direccionPrompt || '').trim();
  const referenciaPrompt = String(req.body?.referenciaPrompt || '').trim();

  if (!personaPrompt || !direccionPrompt || !referenciaPrompt) {
    return res.status(400).json({ ok: false, error: 'Ningún prompt multi-pass puede estar vacío' });
  }

  await fs.mkdir(path.dirname(multiPassPersonaPromptPath), { recursive: true });
  await fs.writeFile(multiPassPersonaPromptPath, `${personaPrompt}\n`);
  await fs.writeFile(multiPassDireccionPromptPath, `${direccionPrompt}\n`);
  await fs.writeFile(multiPassReferenciaPromptPath, `${referenciaPrompt}\n`);
  res.json({ ok: true });
});

app.post('/api/config-data/documents', async (req, res) => {

  const documentsEnabled = Boolean(req.body?.documentsEnabled);
  const publicChatEnabled = Boolean(req.body?.publicChatEnabled);
  const deepModeEnabled = Boolean(req.body?.deepModeEnabled);
  const allowedChatModes = new Set(['masked-local-remote', 'direct-local', 'direct-remote']);
  const chatMode = allowedChatModes.has(String(req.body?.chatMode || ''))
    ? String(req.body.chatMode)
    : 'masked-local-remote';
  const appConfig = await readAppConfig();
  await writeAppConfig({
    ...appConfig,
    documentsEnabled,
    publicChatEnabled,
    deepModeEnabled,
    chatMode,
    rags: appConfig.rags,
  });

  res.json({ ok: true });
});

app.post('/api/config-data/openai-compat', async (req, res) => {
  const openAiCompatEnabled = Boolean(req.body?.openAiCompatEnabled);
  const openAiCompatApiKey = String(req.body?.openAiCompatApiKey || '').trim();
  const openAiCompatDebugLogEnabled = Boolean(req.body?.openAiCompatDebugLogEnabled);
  const openAiCompatDeepModeEnabled = Boolean(req.body?.openAiCompatDeepModeEnabled);

  const appConfig = await readAppConfig();
  await writeAppConfig({
    ...appConfig,
    openAiCompatEnabled,
    openAiCompatApiKey,
    openAiCompatDebugLogEnabled,
    openAiCompatDeepModeEnabled,
    rags: appConfig.rags,
  });

  res.json({ ok: true });
});

app.post('/api/config-data/rags', async (req, res) => {
  const label = normalizeRagLabel(req.body?.label);
  if (!label) {
    return res.status(400).json({ ok: false, error: 'Escribe un nombre para el RAG' });
  }

  const appConfig = await readAppConfig();
  const nextRag = {
    key: buildUniqueRagKey(label, appConfig.rags || []),
    label,
    active: true,
    ragOnlyMode: true,
    maxFragments: 4,
  };

  await ensureRagUploadsDir(nextRag.key);
  await writeAppConfig({
    ...appConfig,
    rags: [...(appConfig.rags || []), nextRag],
  });

  res.json({ ok: true, rag: nextRag });
});

app.post('/api/config-data/rags/:ragKey', async (req, res) => {
  const ragKey = normalizeRagKey(req.params?.ragKey);
  if (!ragKey) {
    return res.status(400).json({ ok: false, error: 'RAG inválido' });
  }

  const appConfig = await readAppConfig();
  const current = findRagDefinition(appConfig.rags, ragKey);
  if (!current || current.key !== ragKey) {
    return res.status(404).json({ ok: false, error: 'No encontré ese RAG' });
  }

  const nextRags = (appConfig.rags || []).map(item => item.key === ragKey
    ? {
      ...item,
      active: typeof req.body?.active === 'boolean' ? req.body.active : item.active,
      ragOnlyMode: typeof req.body?.ragOnlyMode === 'boolean' ? req.body.ragOnlyMode : item.ragOnlyMode,
      maxFragments: Number.isFinite(Number(req.body?.maxFragments))
        ? Math.max(1, Math.min(Math.round(Number(req.body.maxFragments)), 8))
        : item.maxFragments,
    }
    : item);

  await writeAppConfig({
    ...appConfig,
    rags: nextRags,
  });

  res.json({ ok: true, rag: nextRags.find(item => item.key === ragKey) });
});

app.delete('/api/config-data/rags/:ragKey', async (req, res) => {
  const ragKey = normalizeRagKey(req.params?.ragKey);
  if (!ragKey) {
    return res.status(400).json({ ok: false, error: 'RAG inválido' });
  }

  const appConfig = await readAppConfig();
  const current = findRagDefinition(appConfig.rags, ragKey);
  if (!current || current.key !== ragKey) {
    return res.status(404).json({ ok: false, error: 'No encontré ese RAG' });
  }

  try {
    const nextRags = (appConfig.rags || []).filter(item => item.key !== ragKey);
    await writeAppConfig({
      ...appConfig,
      rags: nextRags,
    });

    await fs.rm(getRagUploadsDir(ragKey), { recursive: true, force: true });
    deleteRagIndex(ragKey);

    res.json({
      ok: true,
      deletedRagKey: ragKey,
      rags: nextRags,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error || 'No pude eliminar el RAG') });
  }
});

app.get('/api/config-data/rag/files', async (req, res) => {
  const ragKey = normalizeRagKey(req.query?.ragKey);
  if (!ragKey) {
    return res.status(400).json({ ok: false, error: 'RAG inválido' });
  }
  const files = await listRagUploads(ragKey);
  res.json({ ok: true, files, documents: listDocumentResults(3, { ragKey }) });
});

app.post('/api/config-data/rag/revectorize-all', async (_req, res) => {
  try {
    const revectorization = await revectorizeAllRagDocuments({ resetVectors: true });
    res.json({ ok: true, revectorization });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error || 'No pude revectorizar los documentos') });
  }
});

app.post('/api/config-data/rag/upload', upload.single('ragFile'), async (req, res) => {
  const ragKey = normalizeRagKey(req.body?.ragKey || req.query?.ragKey) || '';
  const appConfig = await readAppConfig();
  const rag = findRagDefinition(appConfig.rags, ragKey);
  if (!rag || rag.key !== ragKey) {
    return res.status(400).json({ ok: false, error: 'Selecciona un RAG válido' });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se ha recibido ningún archivo' });
    }

    const originalName = String(req.file.originalname || '').trim();
    if (!originalName.toLowerCase().endsWith('.txt')) {
      return res.status(400).json({ ok: false, error: 'Solo se permiten archivos .txt' });
    }

    const content = String(req.file.buffer?.toString('utf8') || '');
    if (!content.trim()) {
      return res.status(400).json({ ok: false, error: 'El archivo .txt está vacío' });
    }

    const safeName = sanitizeUploadFilename(originalName);
    const finalName = safeName.toLowerCase().endsWith('.txt') ? safeName : `${safeName}.txt`;

    await ensureRagUploadsDir(rag.key);
    await fs.writeFile(path.join(getRagUploadsDir(rag.key), finalName), content, 'utf8');

    const vectorization = await vectorizeRagDocument({
      ragKey: rag.key,
      filename: finalName,
      originalName,
      content,
    });

    res.json({
      ok: true,
      file: {
        name: finalName,
        size: Buffer.byteLength(content, 'utf8'),
      },
      vectorization,
      files: await listRagUploads(rag.key),
      documents: listDocumentResults(3, { ragKey: rag.key }),
      rag,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error?.message || error || 'No pude vectorizar el documento'),
      files: await listRagUploads(rag.key),
      documents: listDocumentResults(3, { ragKey: rag.key }),
    });
  }
});

app.delete('/api/config-data/rag/files/:ragKey/:filename', async (req, res) => {
  const ragKey = normalizeRagKey(req.params?.ragKey) || '';
  const filename = sanitizeUploadFilename(req.params?.filename || '');
  const appConfig = await readAppConfig();
  const rag = findRagDefinition(appConfig.rags, ragKey);

  if (!rag || rag.key !== ragKey) {
    return res.status(400).json({ ok: false, error: 'Selecciona un RAG válido' });
  }

  if (!filename || !filename.toLowerCase().endsWith('.txt')) {
    return res.status(400).json({ ok: false, error: 'Documento inválido' });
  }

  const absolutePath = path.join(getRagUploadsDir(rag.key), filename);

  try {
    await fs.unlink(absolutePath).catch(error => {
      if (error?.code !== 'ENOENT') throw error;
    });

    deleteDocumentByFilename(filename, { ragKey: rag.key });

    res.json({
      ok: true,
      deletedFile: filename,
      files: await listRagUploads(rag.key),
      documents: listDocumentResults(3, { ragKey: rag.key }),
      rag,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error?.message || error || 'No pude eliminar el documento'),
      files: await listRagUploads(rag.key),
      documents: listDocumentResults(3, { ragKey: rag.key }),
    });
  }
});

app.get('/api/history', async (req, res) => {
  const auth = await authorizeChat(req, { allowMissing: true });
  if (!auth.ok) {
    return res.status(auth.status || 403).json({ ok: false, error: auth.error || 'Acceso denegado', code: auth.code || 'CHAT_ACCESS_DENIED', chatId: auth.chatId || '' });
  }

  const { chatSessionKey: scopedKey, chatId } = auth;
  const history = scopedKey && auth.chatRecord?.exists ? await getChatMemory(scopedKey) : [];
  const proxyHistory = scopedKey && auth.chatRecord?.exists ? await getProxyChatMemory(scopedKey) : [];
  const labelMap = scopedKey && auth.chatRecord?.exists ? await getLabelMap(scopedKey) : {};
  const appConfig = await readAppConfig();
  const chatRecord = auth.chatRecord || null;
  const chatMode = scopedKey
    ? (chatRecord?.exists ? (chatRecord?.settings?.chatMode || appConfig.chatMode || 'masked-local-remote') : (appConfig.chatMode || 'masked-local-remote'))
    : (appConfig.chatMode || 'masked-local-remote');
  const useRag = Boolean(chatRecord?.settings?.useRag);
  const requestedRagKey = useRag ? String(chatRecord?.settings?.ragKey || '').trim() : '';
  const rag = useRag ? findRagDefinition(appConfig.rags, requestedRagKey) : null;
  const ragMissing = Boolean(useRag && requestedRagKey && !rag);
  res.json({
    ok: true,
    chatId,
    chatAccess: getChatAccessMode(chatRecord),
    chatMode,
    useRag,
    ragKey: rag?.key || requestedRagKey || '',
    ragLabel: rag?.label || (ragMissing ? `Fuente eliminada (${requestedRagKey})` : ''),
    ragMissing,
    history,
    proxyHistory,
    labelMap,
  });
});

app.post('/api/history/clear', async (req, res) => {
  const auth = await authorizeChat(req, { allowMissing: true });
  if (!auth.ok) {
    return res.status(auth.status || 403).json({ ok: false, error: auth.error || 'Acceso denegado', code: auth.code || 'CHAT_ACCESS_DENIED', chatId: auth.chatId || '' });
  }

  const { chatSessionKey: scopedKey, chatId } = auth;
  if (scopedKey) {
    await clearChatMemory(scopedKey);
    await clearProxyChatMemory(scopedKey);
    await clearLabelMap(scopedKey);
  }
  res.json({ ok: true, chatId, chatAccess: getChatAccessMode(auth.chatRecord) });
});

app.post('/api/chat/settings', async (req, res) => {
  const auth = await authorizeChat(req, { allowCreate: true });
  if (!auth.ok) {
    return res.status(auth.status || 403).json({ ok: false, error: auth.error || 'Acceso denegado', code: auth.code || 'CHAT_ACCESS_DENIED', chatId: auth.chatId || '' });
  }

  const { chatSessionKey: scopedKey, chatId, requestedAccess } = auth;
  const chatRecord = await getChatRecord(scopedKey);
  const appConfig = await readAppConfig();
  const requestedChatAccess = String(req.body?.chatAccess || '').trim().toLowerCase();
  if (requestedChatAccess === 'public' && appConfig.publicChatEnabled === false) {
    return res.status(400).json({ ok: false, error: 'La opción de chat público está desactivada en la configuración.' });
  }
  const nextAccess = requestedChatAccess === 'public'
    ? { public: true, secretHash: null }
    : (chatRecord.access || buildChatAccessRecord(requestedAccess));
  const nextChatMode = typeof req.body?.chatMode === 'string' && ['masked-local-remote', 'direct-local', 'direct-remote'].includes(req.body.chatMode)
    ? req.body.chatMode
    : (chatRecord?.settings?.chatMode || appConfig.chatMode || 'masked-local-remote');
  const useRag = Boolean(req.body?.useRag);
  const rag = useRag ? findRagDefinition(appConfig.rags, req.body?.ragKey || chatRecord?.settings?.ragKey) : null;
  if (useRag && !rag) {
    return res.status(400).json({ ok: false, error: 'No encontré el RAG seleccionado' });
  }

  const saved = await saveChatRecord(scopedKey, {
    access: nextAccess,
    settings: {
      ...(chatRecord?.settings || {}),
      chatMode: nextChatMode,
      useRag,
      ragKey: useRag ? rag.key : null,
    },
  });

  res.json({ ok: true, chatId, chatAccess: getChatAccessMode(saved), settings: saved.settings || {}, rag: useRag ? rag : null });
});

app.post('/api/chat', upload.single('document'), async (req, res) => {
  const startedAt = Date.now();
  const rawBodyMessage = req.body?.message;
  const rawQueryMessage = req.query?.message;
  const rawBodySinglePass = req.body?.singlePass;
  const rawQuerySinglePass = req.query?.singlePass;
  const singlePass = String(rawBodySinglePass || rawQuerySinglePass || '').toLowerCase() === 'true';
  const message = String(rawBodyMessage || rawQueryMessage || '').trim();

  const sendEvent = payload => {
    res.write(`${JSON.stringify(payload)}\n`);
  };

  if (!message) {
    return res.status(400).json({
      error: 'Falta message',
      debugRequest: {
        hasFile: !!req.file,
        bodyKeys: Object.keys(req.body || {}),
        queryKeys: Object.keys(req.query || {}),
        contentType: req.headers['content-type'] || null,
      },
    });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const appConfig = await readAppConfig();
  const requestedChatAccess = getRequestedChatAccess(req);
  if (requestedChatAccess.chatAccess === 'public' && appConfig.publicChatEnabled === false) {
    sendEvent({
      type: 'error',
      error: 'La opción de chat público está desactivada en la configuración.',
      code: 'PUBLIC_CHAT_DISABLED',
      lockChat: false,
    });
    return res.end();
  }

  const auth = await authorizeChat(req, { allowCreate: true });

  if (!auth.ok) {
    sendEvent({
      type: 'error',
      error: auth.error || 'No pude identificar este chat. Recarga la página e inténtalo otra vez.',
      code: auth.code || 'CHAT_SCOPE_MISSING',
      lockChat: false,
    });
    return res.end();
  }

  const { chatSessionKey, chatId } = auth;

  const history = await getChatMemory(chatSessionKey);
  const proxyHistory = await getProxyChatMemory(chatSessionKey);
  const labelMap = await getLabelMap(chatSessionKey);
  const chatRecord = await getChatRecord(chatSessionKey);
  const initialChatMode = appConfig.chatMode || 'masked-local-remote';
  const chatMode = chatRecord?.exists
    ? (chatRecord?.settings?.chatMode || initialChatMode)
    : initialChatMode;
  const useRag = Boolean(chatRecord?.settings?.useRag);
  const requestedRagKey = useRag ? String(chatRecord?.settings?.ragKey || '').trim() : '';
  const rag = useRag ? findRagDefinition(appConfig.rags, requestedRagKey) : null;
  const ragOnlyMode = Boolean(rag?.ragOnlyMode);
  const ragMaxFragments = Math.max(1, Math.min(Math.round(Number(rag?.maxFragments || 4)), 8));

  if (useRag && requestedRagKey && !rag) {
    sendEvent({
      type: 'error',
      error: `Este chat sigue vinculado a una fuente privada eliminada "${requestedRagKey}". Puedes consultar el historial, pero no enviar mensajes nuevos en este chat.`,
      code: 'RAG_MISSING',
      lockChat: true,
      useRag,
      ragKey: requestedRagKey,
      ragLabel: `Fuente eliminada (${requestedRagKey})`,
      ragMissing: true,
    });
    return res.end();
  }

  if (!chatRecord?.exists) {
    await saveChatRecord(chatSessionKey, {
      access: buildChatAccessRecord(auth.requestedAccess),
      settings: {
        ...(chatRecord?.settings || {}),
        chatMode,
        useRag,
        ragKey: rag?.key || null,
      },
    });
  }

  sendEvent({ type: 'start', startedAt, message: 'Inicio del pipeline', chatId, chatAccess: getChatAccessMode(chatRecord), chatMode, useRag, ragKey: rag?.key || '', ragLabel: rag?.label || '' });

  const extractionStartedAt = Date.now();
  const extractedDocument = await extractTextFromUploadedFile(req.file);
  const extractionDurationMs = Date.now() - extractionStartedAt;

  if (!extractedDocument.ok) {
    sendEvent({
      type: 'error',
      error: extractedDocument.error || 'No pude procesar el documento adjunto.',
      durationMs: extractionDurationMs,
    });
    return res.end();
  }

  sendEvent({
    type: 'document',
    title: 'Extracción de documento',
    attached: !!req.file,
    name: extractedDocument.meta?.name || null,
    method: extractedDocument.meta?.method || null,
    chars: extractedDocument.text?.length || 0,
    durationMs: extractionDurationMs,
    text: extractedDocument.text || '',
  });

  const combinedMessage = buildUserMessageWithDocument(message, extractedDocument.text, extractedDocument.meta);
  const ragStartedAt = Date.now();
  const rawRagResults = useRag && rag ? await retrieveRelevantRagChunks(combinedMessage, ragMaxFragments, { ragKey: rag.key }) : [];
  const ragConfidence = evaluateRagConfidence(rawRagResults, { ragOnlyMode, requestedLimit: ragMaxFragments });
  const ragResults = ragConfidence.useResults;
  const ragDurationMs = Date.now() - ragStartedAt;
  const ragContextBlock = buildRagContextBlock(ragResults, { ragOnlyMode });
  const messageWithRagContext = ragContextBlock ? `${combinedMessage}\n\n${ragContextBlock}` : combinedMessage;
  const userDisplayContent = extractedDocument.text
    ? `${message}\n\n[Documento adjunto: ${extractedDocument.meta?.name || 'documento'}]`
    : message;
  const historyWithUserMessage = [
    ...history,
    { role: 'user', content: messageWithRagContext, displayContent: userDisplayContent },
  ].slice(-40);

  await saveChatMemory(chatSessionKey, historyWithUserMessage);

  if (useRag) {
    sendEvent({
      type: 'rag-context',
      title: 'Contexto RAG recuperado',
      count: ragResults.length,
      rawCount: rawRagResults.length,
      durationMs: ragDurationMs,
      confidenceLevel: ragConfidence.level,
      confidenceReason: ragConfidence.reason,
      fallbackMessage: ragConfidence.message || '',
      chunks: ragResults.map(item => ({
        document: item.originalName || item.filename,
        chunkIndex: item.chunkIndex,
        distance: item.distance,
        lexicalRank: item.lexicalRank,
        hybridScore: item.hybridScore,
        finalScore: item.finalScore,
        heuristicAdjustment: item.heuristicAdjustment,
        exactMatchCount: item.exactMatchCount,
        exactTerms: item.exactTerms,
        coverageRatio: item.coverageRatio,
        sources: item.sources,
        text: item.text,
      })),
    });
  }

  if (useRag && ragOnlyMode && ragConfidence.level === 'low') {
    const fallbackReply = ragConfidence.message || 'No encuentro información suficiente en la fuente privada seleccionada para responder a esa consulta.';
    const assistantTimings = {
      totalMs: Date.now() - startedAt,
      extractionMs: extractionDurationMs,
      regexMs: 0,
      ollamaStages: [],
      proxyMs: 0,
      ragMs: ragDurationMs,
      ragConfidence: ragConfidence.level,
    };

    const newHistory = [
      ...historyWithUserMessage,
      { role: 'assistant', content: fallbackReply, displayContent: fallbackReply, timings: assistantTimings },
    ].slice(-40);

    const newProxyHistory = [
      ...proxyHistory,
      { role: 'user', content: combinedMessage, debugOnly: true, debugKind: 'rag-fallback' },
      { role: 'assistant', content: fallbackReply, debugOnly: true, debugKind: 'rag-fallback' },
    ].slice(-40);

    await saveChatMemory(chatSessionKey, newHistory);
    await saveProxyChatMemory(chatSessionKey, newProxyHistory);
    await saveChatRecord(chatSessionKey, {
      settings: {
        ...(chatRecord?.settings || {}),
        chatMode,
        useRag,
        ragKey: rag?.key || null,
      },
    });

    sendEvent({
      type: 'complete',
      reply: fallbackReply,
      displayResponse: fallbackReply,
      chatAccess: getChatAccessMode(chatRecord),
      history: newHistory,
      proxyHistory: newProxyHistory,
      regexSanitized: '',
      ollamaResponse: '',
      ollamaDisplayText: '',
      proxyResponse: '',
      sanitizedMessage: '',
      labelMap,
      debugStages: [],
      extractedDocument: {
        attached: !!req.file,
        name: extractedDocument.meta?.name || null,
        method: extractedDocument.meta?.method || null,
        chars: extractedDocument.text?.length || 0,
      },
      timings: assistantTimings,
      chatMode,
      useRag,
      ragKey: rag?.key || '',
      ragLabel: rag?.label || '',
      ragConfidence: ragConfidence.level,
      ragFallbackApplied: true,
    });

    return res.end();
  }

  try {
    if (chatMode === 'direct-local' || chatMode === 'direct-remote') {
      const directHistory = history.slice(-20).map(item => ({ role: item.role, content: item.displayContent || item.content }));
      const directMessages = buildMessagesWithMemory(directHistory, messageWithRagContext, { useRag, ragOnlyMode });

      const isLocalDirect = chatMode === 'direct-local';

      sendEvent({
        type: isLocalDirect ? 'local-direct-start' : 'remote-direct-start',
        title: isLocalDirect ? 'Enviando a Ollama' : 'Enviando al LLM Externo',
        text: messageWithRagContext,
      });

      const directStartedAt = Date.now();
      const reply = isLocalDirect
        ? await callOllamaChat(directMessages)
        : await callExternalLlm(directMessages);
      const directDurationMs = Date.now() - directStartedAt;

      sendEvent({
        type: isLocalDirect ? 'local-direct-done' : 'remote-direct-done',
        title: isLocalDirect ? 'Respuesta de Ollama' : 'Respuesta del LLM Externo',
        text: reply,
        durationMs: directDurationMs,
      });
      const assistantTimings = {
        totalMs: Date.now() - startedAt,
        extractionMs: extractionDurationMs,
        regexMs: 0,
        ollamaStages: [],
        proxyMs: isLocalDirect ? 0 : directDurationMs,
        localDirectMs: isLocalDirect ? directDurationMs : 0,
        remoteDirectMs: isLocalDirect ? 0 : directDurationMs,
      };
      const newHistory = [
        ...historyWithUserMessage,
        { role: 'assistant', content: reply, displayContent: reply, timings: assistantTimings },
      ].slice(-40);

      await saveChatMemory(chatSessionKey, newHistory);
      await saveProxyChatMemory(chatSessionKey, []);
      await saveLabelMap(chatSessionKey, {});
      await saveChatRecord(chatSessionKey, {
        settings: {
          ...(chatRecord?.settings || {}),
          chatMode,
          useRag,
          ragKey: rag?.key || null,
        },
      });

      sendEvent({
        type: 'complete',
        reply,
        displayResponse: reply,
        chatAccess: getChatAccessMode(chatRecord),
        history: newHistory,
        labelMap: {},
        debugStages: [],
        extractedDocument: {
          attached: !!req.file,
          name: extractedDocument.meta?.name || null,
          method: extractedDocument.meta?.method || null,
          chars: extractedDocument.text?.length || 0,
        },
        timings: assistantTimings,
        chatMode,
        useRag,
        ragKey: rag?.key || '',
        ragLabel: rag?.label || '',
      });

      return res.end();
    }

    const sanitizeResult = await sanitizeWithOllama(messageWithRagContext, labelMap, progress => {
      sendEvent(progress);
    }, { singlePass });

    const sanitizedMessage = sanitizeResult.finalSanitized;
    const finalLabelMap = sanitizeResult.updatedLabelMap || labelMap;
    const proxyStartedAt = Date.now();
    const messages = buildMessagesWithMemory(proxyHistory, sanitizedMessage, { useRag, ragOnlyMode });

    sendEvent({
      type: 'proxy-start',
      title: 'Enviando al proxy online',
      text: sanitizedMessage,
      prompt: JSON.stringify({
        model: (await getExternalLlmSettings()).model,
        messages,
      }, null, 2),
    });

    const reply = await callExternalLlm(messages);
    const proxyDurationMs = Date.now() - proxyStartedAt;

    const localRebuildStartedAt = Date.now();
    const displayResponse = deAnonymizeText(reply, finalLabelMap);
    const localRebuildDurationMs = Date.now() - localRebuildStartedAt;

    sendEvent({
      type: 'proxy-done',
      title: 'Respuesta final del proxy',
      text: reply,
      displayResponse,
      durationMs: proxyDurationMs,
      localRebuildDurationMs,
    });

    const assistantTimings = {
      totalMs: Date.now() - startedAt,
      extractionMs: extractionDurationMs,
      regexMs: sanitizeResult.timings?.regexMs || 0,
      ollamaStages: sanitizeResult.timings?.ollamaStages || [],
      proxyMs: proxyDurationMs,
    };

    const newHistory = [
      ...historyWithUserMessage,
      { role: 'assistant', content: reply, displayContent: displayResponse, timings: assistantTimings },
    ].slice(-40);

    const newProxyHistory = [
      ...proxyHistory,
      { role: 'user', content: sanitizedMessage },
      { role: 'assistant', content: reply },
    ].slice(-40);

    await saveChatMemory(chatSessionKey, newHistory);
    await saveProxyChatMemory(chatSessionKey, newProxyHistory);
    await saveLabelMap(chatSessionKey, finalLabelMap);
    await saveChatRecord(chatSessionKey, {
      settings: {
        ...(chatRecord?.settings || {}),
        chatMode,
        useRag,
        ragKey: rag?.key || null,
      },
    });

    sendEvent({
      type: 'complete',
      reply,
      displayResponse,
      chatAccess: getChatAccessMode(chatRecord),
      history: newHistory,
      proxyHistory: newProxyHistory,
      regexSanitized: sanitizeResult.regexSanitized,
      ollamaResponse: sanitizeResult.ollamaResponse,
      ollamaDisplayText: sanitizeResult.ollamaDisplayText || sanitizeResult.ollamaResponse,
      proxyResponse: reply,
      sanitizedMessage,
      labelMap: finalLabelMap,
      debugStages: sanitizeResult.debugStages || [],
      extractedDocument: {
        attached: !!req.file,
        name: extractedDocument.meta?.name || null,
        method: extractedDocument.meta?.method || null,
        chars: extractedDocument.text?.length || 0,
      },
      timings: assistantTimings,
      chatMode,
      useRag,
      ragKey: rag?.key || '',
      ragLabel: rag?.label || '',
    });

    return res.end();
  } catch (error) {
    const messageText = String(error?.message || error || 'Error desconocido');
    const limitReached = /usage limit has been reached/i.test(messageText);
    sendEvent({
      type: 'error',
      error: limitReached
        ? 'No pude obtener respuesta del proxy porque el servicio remoto ha alcanzado su límite de uso. No depende de la memoria de esta ventana. Prueba más tarde o revisa la cuenta o el servicio del proxy.'
        : `No pude hablar con el proxy local: ${messageText}`,
      code: limitReached ? 'PROXY_USAGE_LIMIT' : 'PROXY_ERROR',
      lockChat: false,
    });
    return res.end();
  }
});

app.get('/v1/models', async (req, res) => {
  if (!await requireOpenAiCompatAuth(req, res)) return;

  res.json({
    object: 'list',
    data: [
      {
        id: OPENAI_COMPAT_MODEL,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'daimon',
      },
    ],
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  if (!await requireOpenAiCompatAuth(req, res)) return;

  try {
    const openAiCompatSettings = await getOpenAiCompatSettings();
    req.openAiCompatDeepModeEnabled = openAiCompatSettings.deepModeEnabled;

    await appendOpenAiCompatDebugLog({
      path: '/v1/chat/completions',
      method: req.method,
      headers: {
        authorization: req.get('authorization') || '',
        'content-type': req.get('content-type') || '',
        'x-forwarded-for': req.get('x-forwarded-for') || '',
        'x-real-ip': req.get('x-real-ip') || '',
        'user-agent': req.get('user-agent') || '',
        'x-chat-id': req.get('x-chat-id') || '',
      },
      body: req.body ?? null,
    });

    const normalizedMessages = normalizeOpenAiMessages(req.body?.messages);
    if (!normalizedMessages.length) {
      return res.status(400).json({ error: { message: 'messages es obligatorio', type: 'invalid_request_error', code: 'messages_required' } });
    }

    const userMessages = normalizedMessages.filter(item => item.role === 'user');
    const latestUserMessage = userMessages[userMessages.length - 1]?.content || '';
    if (!latestUserMessage.trim()) {
      return res.status(400).json({ error: { message: 'Necesito al menos un mensaje de usuario con texto', type: 'invalid_request_error', code: 'user_message_required' } });
    }

    const priorMessages = normalizedMessages.slice(0, normalizedMessages.lastIndexOf(userMessages[userMessages.length - 1]));
    const appConfig = await readAppConfig();
    const chatMode = getRequestedOpenAiChatMode(req, appConfig);
    const singlePass = getRequestedOpenAiSinglePass(req);
    const { useRag, ragKey, rag } = getRequestedOpenAiRag(req, appConfig);

    if (useRag && ragKey && !rag) {
      return res.status(400).json({ error: { message: `No encontré el RAG seleccionado: ${ragKey}`, type: 'invalid_request_error', code: 'rag_not_found' } });
    }

    const requestedChatId = resolveOpenAiChatId(req);
    const chatSessionKey = buildOpenAiSessionKey(requestedChatId);
    let history = [];
    let proxyHistory = [];
    let labelMap = {};

    if (chatSessionKey) {
      history = await getChatMemory(chatSessionKey);
      proxyHistory = await getProxyChatMemory(chatSessionKey);
      labelMap = await getLabelMap(chatSessionKey);
    } else if (chatMode === 'masked-local-remote') {
      const rebuilt = await rebuildMaskedStateFromMessages(priorMessages, { singlePass });
      history = rebuilt.history;
      proxyHistory = rebuilt.proxyHistory;
      labelMap = rebuilt.labelMap;
    } else {
      history = priorMessages.map(item => ({ role: item.role, content: item.content, displayContent: item.content }));
    }

    const result = await runDaimonPipeline({
      chatSessionKey,
      history,
      proxyHistory,
      labelMap,
      message: latestUserMessage,
      chatMode,
      useRag,
      rag,
      singlePass,
    });

    const model = String(req.body?.model || OPENAI_COMPAT_MODEL || 'daimon');
    const content = String(result.displayResponse || result.reply || '');
    if (req.body?.stream === true) {
      return sendOpenAiStreamResponse(res, { model, content });
    }

    return res.json(buildOpenAiChatCompletionResponse({ model, content }));
  } catch (error) {
    const message = String(error?.message || error || 'Error desconocido');
    return res.status(500).json({ error: { message, type: 'server_error', code: 'daimon_openai_error' } });
  }
});

async function startServer() {
  app.listen(PORT, () => {
    console.log(`Daimon listening on http://localhost:${PORT}`);
  });
}

startServer();
