# moltbot-memory-sqlite

> SQLite-based long-term memory plugin for Moltbot

A lightweight, local-first memory plugin that stores memories in SQLite. Supports full-text search, categories, importance scoring, and GDPR-compliant deletion.

## Why Local Memory?

Your AI's memory shouldn't phone home. This plugin keeps all memories on your machine:

- **Privacy**: No data leaves your system
- **Speed**: SQLite is fast, no network latency
- **Offline**: Works without internet
- **Control**: You own your data, delete anytime

## Installation

```bash
npm install moltbot-memory-sqlite
```

## Configuration

Add to your Moltbot config:

```json
{
  "plugins": {
    "slots": {
      "memory": "moltbot-memory-sqlite"
    },
    "entries": {
      "moltbot-memory-sqlite": {
        "enabled": true,
        "config": {
          "dbPath": "~/.moltbot/memory.db",
          "maxMemories": 10000,
          "defaultImportance": 0.7
        }
      }
    }
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | `~/.moltbot/memory.db` | Path to SQLite database |
| `maxMemories` | number | `10000` | Max memories before pruning |
| `defaultImportance` | number | `0.7` | Default importance (0-1) |
| `noisePatterns` | string[] | `[...]` | Regex patterns to filter noise |

## Usage

The plugin exposes three tool handlers:

### memory_store

Save a memory:

```typescript
await memory_store({
  text: "User prefers dark mode",
  category: "preference",  // preference|fact|decision|entity|conversation|other
  importance: 0.8          // 0-1, higher = more important
});
```

### memory_recall

Search memories:

```typescript
const memories = await memory_recall({
  query: "dark mode preferences",
  limit: 5,
  category: "preference",   // optional filter
  dateFrom: "2025-01-01",   // optional
  dateTo: "2025-12-31",     // optional
  filterNoise: true         // filter "ok", "thanks", etc.
});
```

### memory_forget

Delete memories (GDPR-compliant):

```typescript
// By ID
await memory_forget({ memoryId: "uuid-here" });

// By query (deletes all matches)
await memory_forget({ query: "sensitive information" });
```

## Direct Usage

You can also use the plugin directly:

```typescript
import { SqliteMemoryPlugin } from 'moltbot-memory-sqlite';

const memory = new SqliteMemoryPlugin({
  dbPath: './my-memories.db'
});

// Store
const mem = memory.store({ text: "Important fact", category: "fact" });

// Recall
const results = memory.recall({ query: "important" });

// Stats
const stats = memory.stats();
console.log(`Total memories: ${stats.total}`);

// Cleanup
memory.close();
```

## How It Works

1. **Storage**: Memories stored in SQLite with FTS5 for full-text search
2. **Search**: FTS5 provides fast, fuzzy text matching
3. **Ranking**: Results sorted by importance, then recency
4. **Pruning**: Old, low-importance memories auto-deleted when limit reached

## Database Schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT DEFAULT 'other',
  importance REAL DEFAULT 0.7,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  session_key TEXT,
  metadata TEXT
);
```

## License

MIT © Andre Wolke

## Links

- [Moltbot](https://github.com/moltbot/moltbot)
- [Blog Post: Your AI's Memory Shouldn't Phone Home](https://21nauts.com/blog/ai-memory-privacy)
