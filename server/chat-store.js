import fs from 'fs/promises';
import path from 'path';

const dataDir = path.resolve(process.cwd(), 'data');
const chatsDir = path.join(dataDir, 'chats');

async function ensureDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function ensureChatsDir() {
  await ensureDir();
  await fs.mkdir(chatsDir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDir();
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

function normalizeChatFileId(chatId) {
  const value = String(chatId || '').trim();
  if (!/^[a-zA-Z0-9_-]{4,200}$/.test(value)) {
    throw new Error('chatId inválido');
  }
  return value;
}

function getChatFilePath(chatId) {
  return path.join(chatsDir, `${normalizeChatFileId(chatId)}.json`);
}

function buildEmptyChatRecord(chatId) {
  const now = new Date().toISOString();
  return {
    chatId,
    createdAt: now,
    updatedAt: now,
    history: [],
    proxyHistory: [],
    labelMap: {},
    access: null,
    settings: {},
  };
}

async function readChatRecord(chatId) {
  const safeChatId = normalizeChatFileId(chatId);
  const filePath = getChatFilePath(safeChatId);

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      exists: true,
      chatId: safeChatId,
      createdAt: parsed?.createdAt || new Date().toISOString(),
      updatedAt: parsed?.updatedAt || new Date().toISOString(),
      history: Array.isArray(parsed?.history) ? parsed.history : [],
      proxyHistory: Array.isArray(parsed?.proxyHistory) ? parsed.proxyHistory : [],
      labelMap: parsed?.labelMap && typeof parsed.labelMap === 'object' ? parsed.labelMap : {},
      access: parsed?.access && typeof parsed.access === 'object'
        ? {
            public: parsed.access.public === true,
            secretHash: typeof parsed.access.secretHash === 'string' && parsed.access.secretHash
              ? parsed.access.secretHash
              : null,
          }
        : null,
      settings: parsed?.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
    };
  } catch {
    return {
      exists: false,
      ...buildEmptyChatRecord(safeChatId),
    };
  }
}

async function writeChatRecord(chatId, record) {
  const safeChatId = normalizeChatFileId(chatId);
  const current = await readChatRecord(safeChatId);
  const next = {
    ...current,
    ...record,
    chatId: safeChatId,
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: Array.isArray(record?.history) ? record.history : current.history,
    proxyHistory: Array.isArray(record?.proxyHistory) ? record.proxyHistory : current.proxyHistory,
    labelMap: record?.labelMap && typeof record.labelMap === 'object' ? record.labelMap : current.labelMap,
    access: Object.prototype.hasOwnProperty.call(record || {}, 'access')
      ? (record?.access && typeof record.access === 'object'
          ? {
              public: record.access.public === true,
              secretHash: typeof record.access.secretHash === 'string' && record.access.secretHash
                ? record.access.secretHash
                : null,
            }
          : null)
      : current.access,
    settings: record?.settings && typeof record.settings === 'object' ? record.settings : current.settings,
  };

  await ensureChatsDir();
  await fs.writeFile(getChatFilePath(safeChatId), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function getChatMemory(chatId) {
  const chat = await readChatRecord(chatId);
  return Array.isArray(chat.history) ? chat.history : [];
}

export async function saveChatMemory(chatId, messages) {
  await writeChatRecord(chatId, { history: Array.isArray(messages) ? messages : [] });
}

export async function clearChatMemory(chatId) {
  const chat = await readChatRecord(chatId);
  await writeChatRecord(chatId, { history: [], proxyHistory: chat.proxyHistory || [], labelMap: chat.labelMap || {}, settings: chat.settings || {} });
}

export async function getProxyChatMemory(chatId) {
  const chat = await readChatRecord(chatId);
  return Array.isArray(chat.proxyHistory) ? chat.proxyHistory : [];
}

export async function saveProxyChatMemory(chatId, messages) {
  await writeChatRecord(chatId, { proxyHistory: Array.isArray(messages) ? messages : [] });
}

export async function clearProxyChatMemory(chatId) {
  const chat = await readChatRecord(chatId);
  await writeChatRecord(chatId, { history: chat.history || [], proxyHistory: [], labelMap: chat.labelMap || {}, settings: chat.settings || {} });
}

export async function getLabelMap(chatId) {
  const chat = await readChatRecord(chatId);
  return chat.labelMap && typeof chat.labelMap === 'object' ? chat.labelMap : {};
}

export async function saveLabelMap(chatId, labelMap) {
  await writeChatRecord(chatId, { labelMap: labelMap || {} });
}

export async function clearLabelMap(chatId) {
  const chat = await readChatRecord(chatId);
  await writeChatRecord(chatId, { history: chat.history || [], proxyHistory: chat.proxyHistory || [], labelMap: {}, settings: chat.settings || {} });
}

export async function getChatRecord(chatId) {
  return readChatRecord(chatId);
}

export async function saveChatRecord(chatId, record) {
  return writeChatRecord(chatId, record || {});
}
