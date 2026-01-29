/**
 * moltbot-memory-local
 * Privacy-first local memory plugin for Moltbot
 * 
 * Combines:
 * - SQLite for structured storage, timestamps, full-text search
 * - LanceDB + local embeddings for semantic similarity search
 * 
 * Zero cloud calls. Everything runs locally.
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: string;
  updatedAt: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
  score?: number; // relevance score from search
}

export type MemoryCategory = 
  | 'preference'
  | 'fact'
  | 'decision'
  | 'entity'
  | 'conversation'
  | 'other';

export interface MemoryStoreParams {
  text: string;
  category?: MemoryCategory;
  importance?: number;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRecallParams {
  query: string;
  limit?: number;
  category?: MemoryCategory;
  dateFrom?: string;
  dateTo?: string;
  filterNoise?: boolean;
  mode?: 'auto' | 'semantic' | 'structured'; // query mode
}

export interface MemoryForgetParams {
  memoryId?: string;
  query?: string;
}

export interface PluginConfig {
  dataDir?: string;
  maxMemories?: number;
  defaultImportance?: number;
  noisePatterns?: string[];
  embeddingModel?: string;
  enableEmbeddings?: boolean; // can disable if resources are tight
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<PluginConfig> = {
  dataDir: join(homedir(), '.moltbot', 'memory'),
  maxMemories: 10000,
  defaultImportance: 0.7,
  noisePatterns: [
    '^(ok|okay|yes|no|thanks|thank you|sure|got it|cool|nice|great)$',
    '^\\s*$',
  ],
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  enableEmbeddings: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Query Type Detection
// ─────────────────────────────────────────────────────────────────────────────

const TEMPORAL_PATTERNS = [
  /\b(yesterday|today|last\s+(week|month|year)|this\s+(week|month|year))\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b\d{1,2}[:\-]\d{2}\b/, // time patterns like 14:04 or 14-04
  /\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/, // date patterns
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\bwhen\s+did\b/i,
  /\b(at|on|during|before|after)\s+\d/i,
];

const EXACT_PATTERNS = [
  /^what\s+(is|are|was|were)\s+(my|the)\b/i, // "what is my X"
  /\bexact(ly)?\b/i,
  /\bid\s*[:=]/i, // looking for specific ID
];

function detectQueryType(query: string): 'semantic' | 'structured' {
  // Check for temporal patterns → structured
  for (const pattern of TEMPORAL_PATTERNS) {
    if (pattern.test(query)) return 'structured';
  }
  
  // Check for exact lookup patterns → structured
  for (const pattern of EXACT_PATTERNS) {
    if (pattern.test(query)) return 'structured';
  }
  
  // Default to semantic for fuzzy/conceptual queries
  return 'semantic';
}

// ─────────────────────────────────────────────────────────────────────────────
// Embeddings Manager (Lazy-loaded)
// ─────────────────────────────────────────────────────────────────────────────

let embeddingPipeline: any = null;
let lanceDb: any = null;
let lanceTable: any = null;

async function getEmbeddingPipeline(modelName: string) {
  if (!embeddingPipeline) {
    const { pipeline } = await import('@xenova/transformers');
    embeddingPipeline = await pipeline('feature-extraction', modelName);
  }
  return embeddingPipeline;
}

async function embed(text: string, modelName: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline(modelName);
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

async function initLanceDB(dataDir: string): Promise<void> {
  if (lanceDb) return;
  
  const lanceModule = await import('@lancedb/lancedb');
  const dbPath = join(dataDir, 'vectors');
  
  if (!existsSync(dbPath)) {
    mkdirSync(dbPath, { recursive: true });
  }
  
  lanceDb = await lanceModule.connect(dbPath);
  
  // Try to open existing table or create new
  const tables = await lanceDb.tableNames();
  if (tables.includes('memories')) {
    lanceTable = await lanceDb.openTable('memories');
  }
}

async function ensureLanceTable(dimensions: number): Promise<void> {
  if (lanceTable) return;
  
  // Create table with initial dummy record (LanceDB requires at least one)
  lanceTable = await lanceDb.createTable('memories', [{
    id: '__init__',
    vector: new Array(dimensions).fill(0),
    text: '',
  }]);
  
  // Delete the dummy
  await lanceTable.delete('id = "__init__"');
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Memory Plugin
// ─────────────────────────────────────────────────────────────────────────────

export class LocalMemoryPlugin {
  private db: SqlJsDatabase | null = null;
  private config: Required<PluginConfig>;
  private dirty = false;
  private initialized = false;
  private embeddingDimensions = 384; // MiniLM default

  constructor(config: PluginConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Ensure data directory exists
    if (!existsSync(this.config.dataDir)) {
      mkdirSync(this.config.dataDir, { recursive: true });
    }

    // Initialize SQLite
    const SQL = await initSqlJs();
    const sqlitePath = join(this.config.dataDir, 'memories.db');
    
    if (existsSync(sqlitePath)) {
      const buffer = readFileSync(sqlitePath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }
    this.initSqliteSchema();

    // Initialize LanceDB (if embeddings enabled)
    if (this.config.enableEmbeddings) {
      try {
        await initLanceDB(this.config.dataDir);
      } catch (err) {
        console.warn('LanceDB init failed, falling back to SQLite-only:', err);
        this.config.enableEmbeddings = false;
      }
    }

    this.initialized = true;
  }

  private initSqliteSchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        text_lower TEXT NOT NULL,
        category TEXT DEFAULT 'other',
        importance REAL DEFAULT 0.7,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_key TEXT,
        metadata TEXT,
        has_embedding INTEGER DEFAULT 0
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_text_lower ON memories(text_lower)`);
    
    this.save();
  }

  private save(): void {
    if (!this.db) return;
    const sqlitePath = join(this.config.dataDir, 'memories.db');
    const data = this.db.export();
    writeFileSync(sqlitePath, Buffer.from(data));
    this.dirty = false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Store a new memory (SQLite + optional vector)
   */
  async store(params: MemoryStoreParams): Promise<Memory> {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    const now = new Date().toISOString();
    const memory: Memory = {
      id: randomUUID(),
      text: params.text,
      category: params.category || 'other',
      importance: params.importance ?? this.config.defaultImportance,
      createdAt: now,
      updatedAt: now,
      sessionKey: params.sessionKey,
      metadata: params.metadata,
    };

    // Store in SQLite
    this.db.run(
      `INSERT INTO memories (id, text, text_lower, category, importance, created_at, updated_at, session_key, metadata, has_embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.id,
        memory.text,
        memory.text.toLowerCase(),
        memory.category,
        memory.importance,
        memory.createdAt,
        memory.updatedAt,
        memory.sessionKey || null,
        memory.metadata ? JSON.stringify(memory.metadata) : null,
        0,
      ]
    );

    // Store vector embedding (async, non-blocking)
    if (this.config.enableEmbeddings && lanceDb) {
      this.storeEmbedding(memory).catch(err => {
        console.warn('Failed to store embedding:', err);
      });
    }

    this.save();
    this.pruneOldMemories();

    return memory;
  }

  private async storeEmbedding(memory: Memory): Promise<void> {
    try {
      const vector = await embed(memory.text, this.config.embeddingModel);
      this.embeddingDimensions = vector.length;
      
      await ensureLanceTable(vector.length);
      
      await lanceTable.add([{
        id: memory.id,
        vector,
        text: memory.text,
      }]);

      // Mark as having embedding in SQLite
      this.db?.run('UPDATE memories SET has_embedding = 1 WHERE id = ?', [memory.id]);
      this.save();
    } catch (err) {
      console.warn('Embedding storage failed:', err);
    }
  }

  /**
   * Recall memories - auto-routes to structured or semantic search
   */
  async recall(params: MemoryRecallParams): Promise<Memory[]> {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    const limit = params.limit || 5;
    const mode = params.mode || 'auto';
    
    // Determine query type
    const queryType = mode === 'auto' ? detectQueryType(params.query) : mode;

    let results: Memory[] = [];

    if (queryType === 'structured' || !this.config.enableEmbeddings) {
      // Use SQLite full-text search
      results = this.structuredSearch(params, limit);
    } else {
      // Use semantic vector search + merge with structured
      results = await this.semanticSearch(params, limit);
    }

    // Apply noise filter
    if (params.filterNoise !== false) {
      const noiseRegexes = this.config.noisePatterns.map(p => new RegExp(p, 'i'));
      results = results.filter(m => !noiseRegexes.some(re => re.test(m.text)));
    }

    return results.slice(0, limit);
  }

  private structuredSearch(params: MemoryRecallParams, limit: number): Memory[] {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    // Text search
    if (params.query) {
      const words = params.query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      // Filter out common query words
      const searchWords = words.filter(w => !['what', 'did', 'when', 'where', 'how', 'the', 'is', 'are', 'was', 'were', 'my', 'you', 'last', 'this'].includes(w));
      if (searchWords.length > 0) {
        const likeConditions = searchWords.map(() => 'text_lower LIKE ?');
        conditions.push(`(${likeConditions.join(' OR ')})`);
        searchWords.forEach(word => values.push(`%${word}%`));
      }
    }

    // Category filter
    if (params.category) {
      conditions.push('category = ?');
      values.push(params.category);
    }

    // Date filters
    if (params.dateFrom) {
      conditions.push('created_at >= ?');
      values.push(params.dateFrom);
    }
    if (params.dateTo) {
      conditions.push('created_at <= ?');
      values.push(params.dateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT id, text, category, importance, created_at, updated_at, session_key, metadata
      FROM memories
      ${whereClause}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `;

    values.push(limit * 2);

    const stmt = this.db!.prepare(sql);
    stmt.bind(values);

    const rows: Memory[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      rows.push({
        id: row.id,
        text: row.text,
        category: row.category,
        importance: row.importance,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sessionKey: row.session_key || undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      });
    }
    stmt.free();

    return rows;
  }

  private async semanticSearch(params: MemoryRecallParams, limit: number): Promise<Memory[]> {
    if (!lanceTable) {
      return this.structuredSearch(params, limit);
    }

    try {
      const queryVector = await embed(params.query, this.config.embeddingModel);
      
      const searchResults = await lanceTable
        .search(queryVector)
        .limit(limit * 2)
        .toArray();

      // Get full memory data from SQLite for the matched IDs
      const ids = searchResults.map((r: any) => r.id);
      if (ids.length === 0) {
        return this.structuredSearch(params, limit);
      }

      const placeholders = ids.map(() => '?').join(',');
      const stmt = this.db!.prepare(`
        SELECT id, text, category, importance, created_at, updated_at, session_key, metadata
        FROM memories
        WHERE id IN (${placeholders})
      `);
      stmt.bind(ids);

      const memoryMap = new Map<string, Memory>();
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        memoryMap.set(row.id, {
          id: row.id,
          text: row.text,
          category: row.category,
          importance: row.importance,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          sessionKey: row.session_key || undefined,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        });
      }
      stmt.free();

      // Return in order of semantic relevance, with scores
      return searchResults
        .filter((r: any) => memoryMap.has(r.id))
        .map((r: any) => ({
          ...memoryMap.get(r.id)!,
          score: 1 - (r._distance || 0), // Convert distance to similarity
        }));

    } catch (err) {
      console.warn('Semantic search failed, falling back to structured:', err);
      return this.structuredSearch(params, limit);
    }
  }

  /**
   * Delete a memory (GDPR-compliant) - removes from both SQLite and vectors
   */
  async forget(params: MemoryForgetParams): Promise<{ deleted: number }> {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    let deleted = 0;
    let idsToDelete: string[] = [];

    if (params.memoryId) {
      idsToDelete = [params.memoryId];
    } else if (params.query) {
      const memories = await this.recall({ query: params.query, limit: 100, filterNoise: false });
      idsToDelete = memories.map(m => m.id);
    }

    if (idsToDelete.length > 0) {
      // Delete from SQLite
      const placeholders = idsToDelete.map(() => '?').join(',');
      this.db.run(`DELETE FROM memories WHERE id IN (${placeholders})`, idsToDelete);
      deleted = this.db.getRowsModified();

      // Delete from LanceDB
      if (lanceTable) {
        try {
          for (const id of idsToDelete) {
            await lanceTable.delete(`id = "${id}"`);
          }
        } catch (err) {
          console.warn('Failed to delete vectors:', err);
        }
      }

      this.save();
    }

    return { deleted };
  }

  /**
   * Get memory stats
   */
  stats(): { total: number; withEmbeddings: number; byCategory: Record<string, number> } {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM memories');
    totalStmt.step();
    const total = (totalStmt.getAsObject() as { count: number }).count;
    totalStmt.free();

    const embeddingsStmt = this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE has_embedding = 1');
    embeddingsStmt.step();
    const withEmbeddings = (embeddingsStmt.getAsObject() as { count: number }).count;
    embeddingsStmt.free();
    
    const categoryStmt = this.db.prepare(`
      SELECT category, COUNT(*) as count 
      FROM memories 
      GROUP BY category
    `);

    const byCategory: Record<string, number> = {};
    while (categoryStmt.step()) {
      const row = categoryStmt.getAsObject() as { category: string; count: number };
      byCategory[row.category] = row.count;
    }
    categoryStmt.free();

    return { total, withEmbeddings, byCategory };
  }

  /**
   * Close database connections
   */
  close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────────────────────────────────────

  private pruneOldMemories(): void {
    const { total } = this.stats();
    if (total > this.config.maxMemories) {
      const toDelete = total - this.config.maxMemories;
      
      // Get IDs to delete
      const stmt = this.db!.prepare(`
        SELECT id FROM memories 
        ORDER BY importance ASC, created_at ASC 
        LIMIT ?
      `);
      stmt.bind([toDelete]);
      
      const idsToDelete: string[] = [];
      while (stmt.step()) {
        idsToDelete.push((stmt.getAsObject() as { id: string }).id);
      }
      stmt.free();

      if (idsToDelete.length > 0) {
        // Delete from SQLite
        const placeholders = idsToDelete.map(() => '?').join(',');
        this.db!.run(`DELETE FROM memories WHERE id IN (${placeholders})`, idsToDelete);

        // Delete from LanceDB
        if (lanceTable) {
          for (const id of idsToDelete) {
            lanceTable.delete(`id = "${id}"`).catch(() => {});
          }
        }

        this.save();
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Moltbot Plugin Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface MoltbotPlugin {
  id: string;
  name: string;
  version: string;
  slot: 'memory';
  init: (config: PluginConfig) => Promise<void>;
  handlers: {
    memory_store: (params: MemoryStoreParams) => Promise<Memory>;
    memory_recall: (params: MemoryRecallParams) => Promise<Memory[]>;
    memory_forget: (params: MemoryForgetParams) => Promise<{ deleted: number }>;
  };
  shutdown: () => Promise<void>;
}

let pluginInstance: LocalMemoryPlugin | null = null;

/**
 * Moltbot Plugin Export
 */
export const plugin: MoltbotPlugin = {
  id: 'moltbot-memory-local',
  name: 'Local Memory (SQLite + Embeddings)',
  version: '0.1.0',
  slot: 'memory',

  async init(config: PluginConfig = {}): Promise<void> {
    pluginInstance = new LocalMemoryPlugin(config);
    await pluginInstance.init();
  },

  handlers: {
    async memory_store(params: MemoryStoreParams): Promise<Memory> {
      if (!pluginInstance) throw new Error('Plugin not initialized');
      return pluginInstance.store(params);
    },

    async memory_recall(params: MemoryRecallParams): Promise<Memory[]> {
      if (!pluginInstance) throw new Error('Plugin not initialized');
      return pluginInstance.recall(params);
    },

    async memory_forget(params: MemoryForgetParams): Promise<{ deleted: number }> {
      if (!pluginInstance) throw new Error('Plugin not initialized');
      return pluginInstance.forget(params);
    },
  },

  async shutdown(): Promise<void> {
    if (pluginInstance) {
      pluginInstance.close();
      pluginInstance = null;
    }
  },
};

export default plugin;
