/**
 * moltbot-memory-sqlite
 * SQLite-based long-term memory plugin for Moltbot
 * 
 * Privacy-first, local-only memory storage with semantic search support.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';

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
}

export interface MemoryForgetParams {
  memoryId?: string;
  query?: string;
}

export interface PluginConfig {
  dbPath?: string;
  maxMemories?: number;
  defaultImportance?: number;
  noisePatterns?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<PluginConfig> = {
  dbPath: join(homedir(), '.moltbot', 'memory.db'),
  maxMemories: 10000,
  defaultImportance: 0.7,
  noisePatterns: [
    '^(ok|okay|yes|no|thanks|thank you|sure|got it|cool|nice|great)$',
    '^\\s*$',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// SQLite Memory Plugin
// ─────────────────────────────────────────────────────────────────────────────

export class SqliteMemoryPlugin {
  private db: Database.Database;
  private config: Required<PluginConfig>;

  constructor(config: PluginConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Ensure directory exists
    const dbDir = dirname(this.config.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(this.config.dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT DEFAULT 'other',
        importance REAL DEFAULT 0.7,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_key TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
      
      -- FTS5 for full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id,
        text,
        content='memories',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, id, text) VALUES('delete', old.id, old.text);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, id, text) VALUES('delete', old.id, old.text);
        INSERT INTO memories_fts(id, text) VALUES (new.id, new.text);
      END;
    `);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Store a new memory
   */
  store(params: MemoryStoreParams): Memory {
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

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, text, category, importance, created_at, updated_at, session_key, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      memory.id,
      memory.text,
      memory.category,
      memory.importance,
      memory.createdAt,
      memory.updatedAt,
      memory.sessionKey || null,
      memory.metadata ? JSON.stringify(memory.metadata) : null
    );

    // Enforce max memories limit
    this.pruneOldMemories();

    return memory;
  }

  /**
   * Recall memories matching a query
   */
  recall(params: MemoryRecallParams): Memory[] {
    const limit = params.limit || 5;
    const conditions: string[] = [];
    const values: unknown[] = [];

    // Full-text search
    if (params.query) {
      conditions.push(`m.id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?)`);
      // Escape special FTS5 characters and create search query
      const searchQuery = params.query
        .replace(/['"]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 1)
        .map(w => `"${w}"*`)
        .join(' OR ');
      values.push(searchQuery || params.query);
    }

    // Category filter
    if (params.category) {
      conditions.push('m.category = ?');
      values.push(params.category);
    }

    // Date filters
    if (params.dateFrom) {
      conditions.push('m.created_at >= ?');
      values.push(params.dateFrom);
    }
    if (params.dateTo) {
      conditions.push('m.created_at <= ?');
      values.push(params.dateTo);
    }

    // Noise filter
    if (params.filterNoise !== false) {
      for (const pattern of this.config.noisePatterns) {
        conditions.push(`m.text NOT REGEXP ?`);
        values.push(pattern);
      }
    }

    const whereClause = conditions.length > 0 
      ? `WHERE ${conditions.join(' AND ')}` 
      : '';

    // Note: SQLite doesn't have REGEXP by default, we'll filter in JS
    const stmt = this.db.prepare(`
      SELECT id, text, category, importance, created_at, updated_at, session_key, metadata
      FROM memories m
      ${conditions.length > 0 ? `WHERE ${conditions.filter(c => !c.includes('REGEXP')).join(' AND ')}` : ''}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `);

    const queryValues = values.filter((_, i) => !conditions[i]?.includes('REGEXP'));
    queryValues.push(limit * 2); // Fetch extra for noise filtering

    const rows = stmt.all(...queryValues) as Array<{
      id: string;
      text: string;
      category: MemoryCategory;
      importance: number;
      created_at: string;
      updated_at: string;
      session_key: string | null;
      metadata: string | null;
    }>;

    let memories = rows.map(row => ({
      id: row.id,
      text: row.text,
      category: row.category,
      importance: row.importance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sessionKey: row.session_key || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));

    // Apply noise filter in JS
    if (params.filterNoise !== false) {
      const noiseRegexes = this.config.noisePatterns.map(p => new RegExp(p, 'i'));
      memories = memories.filter(m => !noiseRegexes.some(re => re.test(m.text)));
    }

    return memories.slice(0, limit);
  }

  /**
   * Delete a memory (GDPR-compliant)
   */
  forget(params: MemoryForgetParams): { deleted: number } {
    let deleted = 0;

    if (params.memoryId) {
      const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
      const result = stmt.run(params.memoryId);
      deleted = result.changes;
    } else if (params.query) {
      // Find matching memories first
      const memories = this.recall({ query: params.query, limit: 100, filterNoise: false });
      if (memories.length > 0) {
        const placeholders = memories.map(() => '?').join(',');
        const stmt = this.db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`);
        const result = stmt.run(...memories.map(m => m.id));
        deleted = result.changes;
      }
    }

    return { deleted };
  }

  /**
   * Get memory stats
   */
  stats(): { total: number; byCategory: Record<MemoryCategory, number> } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    
    const byCategoryRows = this.db.prepare(`
      SELECT category, COUNT(*) as count 
      FROM memories 
      GROUP BY category
    `).all() as Array<{ category: MemoryCategory; count: number }>;

    const byCategory = Object.fromEntries(
      byCategoryRows.map(row => [row.category, row.count])
    ) as Record<MemoryCategory, number>;

    return { total, byCategory };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────────────────────────────────────

  private pruneOldMemories(): void {
    const stats = this.stats();
    if (stats.total > this.config.maxMemories) {
      const toDelete = stats.total - this.config.maxMemories;
      this.db.prepare(`
        DELETE FROM memories 
        WHERE id IN (
          SELECT id FROM memories 
          ORDER BY importance ASC, created_at ASC 
          LIMIT ?
        )
      `).run(toDelete);
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

let pluginInstance: SqliteMemoryPlugin | null = null;

/**
 * Moltbot Plugin Export
 */
export const plugin: MoltbotPlugin = {
  id: 'moltbot-memory-sqlite',
  name: 'SQLite Memory',
  version: '0.1.0',
  slot: 'memory',

  async init(config: PluginConfig = {}): Promise<void> {
    pluginInstance = new SqliteMemoryPlugin(config);
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
