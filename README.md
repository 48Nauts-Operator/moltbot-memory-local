# moltbot-memory-local

> Privacy-first local memory plugin for Moltbot

**One plugin. Two search modes. Zero cloud calls.**

Combines SQLite (structured/temporal) + LanceDB (semantic/vector) into a single unified memory system. Everything runs locally on your machine.

## Why This Exists

Most AI memory plugins send your data to cloud APIs for embedding. Your "local" memory phones home before storing anything.

This plugin fixes that:
- **SQLite** for structured storage, timestamps, full-text search
- **LanceDB + local embeddings** for semantic similarity search
- **Smart routing** automatically picks the right backend
- **100% local** — no cloud calls, ever

## Installation

```bash
npm install moltbot-memory-local
```

## Configuration

```json
{
  "plugins": {
    "slots": {
      "memory": "moltbot-memory-local"
    },
    "entries": {
      "moltbot-memory-local": {
        "enabled": true,
        "config": {
          "dataDir": "~/.moltbot/memory",
          "maxMemories": 10000,
          "embeddingModel": "Xenova/all-MiniLM-L6-v2",
          "enableEmbeddings": true
        }
      }
    }
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dataDir` | string | `~/.moltbot/memory` | Data directory |
| `maxMemories` | number | `10000` | Max before pruning |
| `embeddingModel` | string | `Xenova/all-MiniLM-L6-v2` | Local embedding model |
| `enableEmbeddings` | boolean | `true` | Enable semantic search |
| `defaultImportance` | number | `0.7` | Default memory importance |

## How It Works

### Automatic Query Routing

The plugin detects query type and routes automatically:

```
"What did you do Thursday at 14:04?"  →  SQLite (temporal)
"Find conversations about dark mode"  →  Vector search (semantic)
"What is my email address?"           →  SQLite (exact lookup)
"Similar ideas to X"                  →  Vector search (semantic)
```

### Manual Mode Selection

Override automatic routing:

```typescript
// Force semantic search
await memory_recall({ query: "...", mode: "semantic" });

// Force structured search
await memory_recall({ query: "...", mode: "structured" });

// Let plugin decide (default)
await memory_recall({ query: "...", mode: "auto" });
```

## Usage

### Store

```typescript
await memory_store({
  text: "User prefers dark mode in all applications",
  category: "preference",  // preference|fact|decision|entity|conversation|other
  importance: 0.9          // 0-1, higher = kept longer
});
```

Memories are stored in both SQLite (full data) and LanceDB (vector for semantic search).

### Recall

```typescript
// Temporal query → routed to SQLite
const thursdayMemories = await memory_recall({
  query: "what happened last Thursday",
  limit: 5
});

// Semantic query → routed to vector search
const similarMemories = await memory_recall({
  query: "display and theme preferences",
  limit: 5
});

// With filters
const decisions = await memory_recall({
  query: "project architecture",
  category: "decision",
  dateFrom: "2025-01-01"
});
```

### Forget (GDPR)

```typescript
// By ID
await memory_forget({ memoryId: "uuid-here" });

// By query (deletes from both SQLite and vectors)
await memory_forget({ query: "sensitive information" });
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    moltbot-memory-local                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌──────────────────┐      ┌──────────────────┐           │
│   │     SQLite       │      │     LanceDB      │           │
│   │  ──────────────  │      │  ──────────────  │           │
│   │  Full text       │      │  Vector store    │           │
│   │  Timestamps      │      │  Local embeddings│           │
│   │  Metadata        │      │  Semantic search │           │
│   │  Categories      │      │                  │           │
│   └────────┬─────────┘      └────────┬─────────┘           │
│            │                         │                      │
│            └──────────┬──────────────┘                      │
│                       │                                     │
│              ┌────────▼────────┐                           │
│              │  Query Router   │                           │
│              │  ────────────── │                           │
│              │  "Thursday?" →  │ → SQLite                  │
│              │  "Similar?" →   │ → Vectors                 │
│              └─────────────────┘                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         ❌ No cloud     ✅ 100% Local     ✅ Your data
```

## Data Storage

```
~/.moltbot/memory/
├── memories.db      # SQLite database (structured data)
└── vectors/         # LanceDB vector store (embeddings)
```

## Embedding Models

Default: `Xenova/all-MiniLM-L6-v2` (384 dimensions, ~23MB)

Alternatives:
- `Xenova/e5-small-v2` — Better quality, similar size
- `Xenova/all-MiniLM-L12-v2` — More accurate, larger

Models download automatically on first use.

## Fallback Behavior

- If LanceDB fails → falls back to SQLite-only search
- If embeddings disabled → SQLite full-text search only
- If embedding fails for a memory → stored in SQLite, skipped in vectors

## License

MIT © Andre Wolke

## Links

- [Documentation](https://gist.github.com/48Nauts-Operator/6d2be91208de723ca26fcbbb29ccd4b5)
- [Moltbot](https://github.com/moltbot/moltbot)
- [21nauts](https://21nauts.com)
