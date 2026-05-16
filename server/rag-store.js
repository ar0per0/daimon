import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const dataDir = path.resolve(process.cwd(), 'data');
const ragDir = path.join(dataDir, 'rag');
const dbCache = new Map();
const embeddingDimensionsCache = new Map();
const LEXICAL_STOPWORDS = new Set([
  'a', 'al', 'algo', 'alguna', 'alguno', 'algunos', 'ante', 'como', 'con', 'contra', 'cual', 'cuál', 'cuales', 'cuáles',
  'de', 'del', 'donde', 'dónde', 'el', 'ella', 'ellas', 'ello', 'ellos', 'en', 'entre', 'era', 'erais', 'eran', 'eras',
  'eres', 'es', 'esa', 'esas', 'ese', 'eso', 'esos', 'esta', 'estaba', 'estado', 'estais', 'estamos', 'estan', 'estar',
  'estas', 'este', 'esto', 'estos', 'fue', 'fueron', 'ha', 'han', 'hasta', 'hay', 'la', 'las', 'le', 'les', 'lo', 'los',
  'me', 'mi', 'mis', 'más', 'muy', 'no', 'nos', 'o', 'para', 'pero', 'por', 'porque', 'que', 'qué', 'quien', 'quién',
  'se', 'si', 'sí', 'sin', 'sobre', 'su', 'sus', 'te', 'tiene', 'tu', 'tus', 'un', 'una', 'uno', 'unos', 'y', 'ya'
]);

function normalizeRagKey(value) {
  const ragKey = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{2,80}$/.test(ragKey) ? ragKey : '';
}

function getRagBaseDir(ragKey) {
  const safeRagKey = normalizeRagKey(ragKey);
  if (!safeRagKey) {
    throw new Error('RAG inválido');
  }
  return path.join(ragDir, safeRagKey);
}

function getRagDbPath(ragKey) {
  return path.join(getRagBaseDir(ragKey), 'rag.db');
}

function ensureRagDir(ragKey) {
  fs.mkdirSync(getRagBaseDir(ragKey), { recursive: true });
}

function getDb(ragKey) {
  const safeRagKey = normalizeRagKey(ragKey);
  if (!safeRagKey) {
    throw new Error('RAG inválido');
  }
  if (dbCache.has(safeRagKey)) return dbCache.get(safeRagKey);

  ensureRagDir(safeRagKey);
  const db = new Database(getRagDbPath(safeRagKey));
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedding_dimensions INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      char_count INTEGER NOT NULL DEFAULT 0,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (document_id) REFERENCES rag_documents(id) ON DELETE CASCADE,
      UNIQUE(document_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_rag_chunks_document_id ON rag_chunks(document_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
      text,
      content='rag_chunks',
      content_rowid='id',
      tokenize = "unicode61 remove_diacritics 2 tokenchars '-_./@'"
    );

    CREATE TRIGGER IF NOT EXISTS rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
      INSERT INTO rag_chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
      INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS rag_chunks_au AFTER UPDATE ON rag_chunks BEGIN
      INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO rag_chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  const ftsRow = db.prepare("SELECT count(*) AS total FROM rag_chunks_fts").get();
  const chunkRow = db.prepare('SELECT count(*) AS total FROM rag_chunks').get();
  if (Number(ftsRow?.total || 0) !== Number(chunkRow?.total || 0)) {
    db.exec("INSERT INTO rag_chunks_fts(rag_chunks_fts) VALUES('rebuild')");
  }

  dbCache.set(safeRagKey, db);
  return db;
}

function buildLexicalMatchQuery(value) {
  const source = String(value || '').trim();
  if (!source) return '';

  const tokens = Array.from(new Set((source.match(/[\p{L}\p{N}_./@-]{3,}/gu) || [])
    .map(token => token.trim())
    .filter(token => !LEXICAL_STOPWORDS.has(token.toLowerCase()))
    .filter(Boolean)))
    .slice(0, 12);

  if (!tokens.length) return '';
  if (tokens.length === 1) {
    return `"${tokens[0].replace(/"/g, '""')}"`;
  }

  return tokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

function ensureVectorTable(dimensions, options = {}) {
  const safeDimensions = Number(dimensions || 0);
  if (!safeDimensions) throw new Error('Dimensiones de embedding inválidas');

  const safeRagKey = normalizeRagKey(options.ragKey);
  if (!safeRagKey) throw new Error('RAG inválido');
  const database = getDb(safeRagKey);
  const cachedDimensions = embeddingDimensionsCache.get(safeRagKey);
  if (cachedDimensions && cachedDimensions !== safeDimensions) {
    throw new Error(`La base vectorial ya usa ${cachedDimensions} dimensiones y no coincide con ${safeDimensions}`);
  }

  const current = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rag_chunk_vec'").get();
  if (!current) {
    database.exec(`CREATE VIRTUAL TABLE rag_chunk_vec USING vec0(chunk_id integer primary key, embedding float[${safeDimensions}])`);
    embeddingDimensionsCache.set(safeRagKey, safeDimensions);
    return;
  }

  const sql = String(current.sql || '');
  const match = sql.match(/embedding\s+float\[(\d+)\]/i);
  const existingDimensions = match ? Number(match[1]) : null;
  if (existingDimensions && existingDimensions !== safeDimensions) {
    throw new Error(`La tabla vectorial existente usa ${existingDimensions} dimensiones y no coincide con ${safeDimensions}`);
  }
  embeddingDimensionsCache.set(safeRagKey, existingDimensions || safeDimensions);
}

function upsertDocument({ filename, originalName, sizeBytes, charCount, status, errorMessage = null, chunkCount = 0, embeddingDimensions: dims = null }, options = {}) {
  const database = getDb(options.ragKey);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO rag_documents (
      filename, original_name, size_bytes, char_count, chunk_count, embedding_dimensions, status, error_message, created_at, updated_at
    ) VALUES (
      @filename, @originalName, @sizeBytes, @charCount, @chunkCount, @embeddingDimensions, @status, @errorMessage, @now, @now
    )
    ON CONFLICT(filename) DO UPDATE SET
      original_name = excluded.original_name,
      size_bytes = excluded.size_bytes,
      char_count = excluded.char_count,
      chunk_count = excluded.chunk_count,
      embedding_dimensions = excluded.embedding_dimensions,
      status = excluded.status,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
  `).run({ filename, originalName, sizeBytes, charCount, chunkCount, embeddingDimensions: dims, status, errorMessage, now });

  return database.prepare('SELECT * FROM rag_documents WHERE filename = ?').get(filename);
}

function replaceDocumentChunks(documentId, chunks, options = {}) {
  const database = getDb(options.ragKey);
  const hasVectorTable = !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rag_chunk_vec'").get();
  const deleteVectors = hasVectorTable
    ? database.prepare('DELETE FROM rag_chunk_vec WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE document_id = ?)')
    : null;
  const deleteChunks = database.prepare('DELETE FROM rag_chunks WHERE document_id = ?');
  const insertChunk = database.prepare(`
    INSERT INTO rag_chunks (document_id, chunk_index, text, char_count, token_estimate)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = database.transaction(() => {
    if (deleteVectors) deleteVectors.run(documentId);
    deleteChunks.run(documentId);
    const chunkRows = [];
    for (const chunk of chunks) {
      const info = insertChunk.run(documentId, chunk.chunkIndex, chunk.text, chunk.charCount, chunk.tokenEstimate);
      chunkRows.push({ id: Number(info.lastInsertRowid), ...chunk });
    }
    return chunkRows;
  });

  return tx();
}

function replaceChunkEmbeddings(chunkEmbeddings, dimensions, options = {}) {
  ensureVectorTable(dimensions, options);
  const database = getDb(options.ragKey);
  const insertVector = database.prepare('INSERT OR REPLACE INTO rag_chunk_vec (chunk_id, embedding) VALUES (?, ?)');
  const tx = database.transaction(() => {
    for (const item of chunkEmbeddings) {
      insertVector.run(BigInt(item.chunkId), new Float32Array(item.embedding));
    }
  });
  tx();
}

function resetVectorTable(options = {}) {
  const safeRagKey = normalizeRagKey(options.ragKey);
  if (!safeRagKey) throw new Error('RAG inválido');
  const database = getDb(safeRagKey);
  const hasVectorTable = !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rag_chunk_vec'").get();
  if (hasVectorTable) {
    database.exec('DROP TABLE rag_chunk_vec');
  }
  embeddingDimensionsCache.delete(safeRagKey);
}

function getDocumentVectorizationResult(filename, previewLimit = 3, options = {}) {
  const database = getDb(options.ragKey);
  const document = database.prepare('SELECT * FROM rag_documents WHERE filename = ?').get(filename);
  if (!document) return null;

  const hasVectorTable = !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rag_chunk_vec'").get();
  const chunks = hasVectorTable
    ? database.prepare(`
        SELECT c.id, c.chunk_index, c.text, c.char_count, c.token_estimate,
               vec_to_json(v.embedding) AS embedding_json
        FROM rag_chunks c
        LEFT JOIN rag_chunk_vec v ON v.chunk_id = c.id
        WHERE c.document_id = ?
        ORDER BY c.chunk_index ASC
        LIMIT ?
      `).all(document.id, previewLimit)
    : database.prepare(`
        SELECT c.id, c.chunk_index, c.text, c.char_count, c.token_estimate,
               NULL AS embedding_json
        FROM rag_chunks c
        WHERE c.document_id = ?
        ORDER BY c.chunk_index ASC
        LIMIT ?
      `).all(document.id, previewLimit);

  const preview = chunks.map(chunk => {
    let embeddingPreview = [];
    try {
      const parsed = JSON.parse(chunk.embedding_json || '[]');
      embeddingPreview = Array.isArray(parsed) ? parsed.slice(0, 8) : [];
    } catch {
      embeddingPreview = [];
    }

    return {
      id: chunk.id,
      chunkIndex: chunk.chunk_index,
      charCount: chunk.char_count,
      tokenEstimate: chunk.token_estimate,
      textPreview: String(chunk.text || '').slice(0, 280),
      embeddingPreview,
    };
  });

  return {
    filename: document.filename,
    originalName: document.original_name,
    status: document.status,
    errorMessage: document.error_message,
    sizeBytes: document.size_bytes,
    charCount: document.char_count,
    chunkCount: document.chunk_count,
    embeddingDimensions: document.embedding_dimensions,
    updatedAt: document.updated_at,
    preview,
  };
}

function listDocumentResults(previewLimit = 2, options = {}) {
  const database = getDb(options.ragKey);
  const docs = database.prepare('SELECT filename FROM rag_documents ORDER BY updated_at DESC').all();
  return docs.map(doc => getDocumentVectorizationResult(doc.filename, previewLimit, options)).filter(Boolean);
}

function searchChunksByEmbedding(embedding, limit = 4, options = {}) {
  const database = getDb(options.ragKey);
  const hasVectorTable = !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rag_chunk_vec'").get();
  if (!hasVectorTable) return [];

  const safeLimit = Math.max(1, Math.min(Number(limit || 4), 12));
  const rows = database.prepare(`
    SELECT
      c.id,
      c.chunk_index,
      c.text,
      c.char_count,
      c.token_estimate,
      d.filename,
      d.original_name,
      distance
    FROM rag_chunk_vec v
    JOIN rag_chunks c ON c.id = v.chunk_id
    JOIN rag_documents d ON d.id = c.document_id
    WHERE v.embedding MATCH ?
      AND v.k = ?
      AND d.status = 'ready'
    ORDER BY distance ASC
  `).all(new Float32Array(embedding), safeLimit);

  return rows.map(row => ({
    id: row.id,
    chunkIndex: row.chunk_index,
    text: row.text,
    charCount: row.char_count,
    tokenEstimate: row.token_estimate,
    filename: row.filename,
    originalName: row.original_name,
    distance: row.distance,
  }));
}

function searchChunksLexical(query, limit = 4, options = {}) {
  const database = getDb(options.ragKey);
  const matchQuery = buildLexicalMatchQuery(query);
  if (!matchQuery) return [];

  const safeLimit = Math.max(1, Math.min(Number(limit || 4), 20));
  const rows = database.prepare(`
    SELECT
      c.id,
      c.chunk_index,
      c.text,
      c.char_count,
      c.token_estimate,
      d.filename,
      d.original_name,
      bm25(rag_chunks_fts, 10.0, 1.0) AS lexical_rank
    FROM rag_chunks_fts
    JOIN rag_chunks c ON c.id = rag_chunks_fts.rowid
    JOIN rag_documents d ON d.id = c.document_id
    WHERE rag_chunks_fts MATCH ?
      AND d.status = 'ready'
    ORDER BY lexical_rank ASC, c.id ASC
    LIMIT ?
  `).all(matchQuery, safeLimit);

  return rows.map(row => ({
    id: row.id,
    chunkIndex: row.chunk_index,
    text: row.text,
    charCount: row.char_count,
    tokenEstimate: row.token_estimate,
    filename: row.filename,
    originalName: row.original_name,
    lexicalRank: row.lexical_rank,
  }));
}

function deleteDocumentByFilename(filename, options = {}) {
  const database = getDb(options.ragKey);
  const document = database.prepare('SELECT id FROM rag_documents WHERE filename = ?').get(filename);
  if (!document?.id) {
    return { deleted: false };
  }

  const hasVectorTable = !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rag_chunk_vec'").get();
  const deleteVectors = hasVectorTable
    ? database.prepare('DELETE FROM rag_chunk_vec WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE document_id = ?)')
    : null;
  const deleteDocument = database.prepare('DELETE FROM rag_documents WHERE id = ?');

  const tx = database.transaction(() => {
    if (deleteVectors) deleteVectors.run(document.id);
    deleteDocument.run(document.id);
  });

  tx();
  return { deleted: true };
}

function deleteRagIndex(ragKey) {
  const safeRagKey = normalizeRagKey(ragKey);
  if (!safeRagKey) {
    throw new Error('RAG inválido');
  }
  const database = dbCache.get(safeRagKey);

  if (database) {
    try {
      database.close();
    } catch {
    }
    dbCache.delete(safeRagKey);
  }

  embeddingDimensionsCache.delete(safeRagKey);
  fs.rmSync(getRagBaseDir(safeRagKey), { recursive: true, force: true });
  return { deleted: true, ragKey: safeRagKey };
}

export {
  getDb,
  getRagDbPath,
  upsertDocument,
  replaceDocumentChunks,
  replaceChunkEmbeddings,
  resetVectorTable,
  getDocumentVectorizationResult,
  listDocumentResults,
  searchChunksByEmbedding,
  searchChunksLexical,
  deleteDocumentByFilename,
  deleteRagIndex,
};
