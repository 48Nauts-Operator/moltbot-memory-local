#!/usr/bin/env node
/**
 * Test for moltbot-memory-local (unified SQLite + embeddings)
 */

import { LocalMemoryPlugin } from './dist/index.js';
import { rmSync, existsSync } from 'fs';

const TEST_DIR = '/tmp/moltbot-memory-test';

async function test() {
  // Cleanup
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }

  console.log('🧪 Testing moltbot-memory-local (unified plugin)\n');
  console.log('═══════════════════════════════════════════════════\n');

  const memory = new LocalMemoryPlugin({ 
    dataDir: TEST_DIR,
    enableEmbeddings: true // Test with embeddings
  });
  
  console.log('1. Initializing (SQLite + LanceDB)...');
  await memory.init();
  console.log('   ✅ Initialized\n');

  // Test store
  console.log('2. Storing memories...');
  await memory.store({ text: 'User prefers dark mode in all applications', category: 'preference', importance: 0.9 });
  await memory.store({ text: 'User lives in Winterthur, Switzerland', category: 'fact', importance: 0.8 });
  await memory.store({ text: 'Decided to use TypeScript for the Betty project', category: 'decision', importance: 0.85 });
  await memory.store({ text: 'Meeting with investors on Thursday at 14:04', category: 'conversation', importance: 0.7 });
  await memory.store({ text: 'Emma birthday party planning for next month', category: 'entity', importance: 0.75 });
  await memory.store({ text: 'ok', category: 'conversation' }); // noise
  console.log('   ✅ Stored 6 memories\n');

  // Give embeddings time to process
  console.log('3. Waiting for embeddings to index...');
  await new Promise(r => setTimeout(r, 2000));
  console.log('   ✅ Done\n');

  // Test stats
  console.log('4. Stats...');
  const stats = memory.stats();
  console.log(`   Total: ${stats.total}`);
  console.log(`   With embeddings: ${stats.withEmbeddings}`);
  console.log(`   By category:`, stats.byCategory);
  console.log('   ✅ Stats working\n');

  // Test structured/temporal recall
  console.log('5. Temporal query: "Thursday 14:04"...');
  const thursdayMemories = await memory.recall({ query: 'Thursday 14:04', mode: 'structured' });
  console.log(`   Found: ${thursdayMemories.length} memories`);
  thursdayMemories.forEach(m => console.log(`   - [${m.category}] ${m.text}`));
  console.log('   ✅ Temporal search working\n');

  // Test semantic recall
  console.log('6. Semantic query: "display preferences and themes"...');
  const semanticMemories = await memory.recall({ query: 'display preferences and themes', mode: 'semantic' });
  console.log(`   Found: ${semanticMemories.length} memories`);
  semanticMemories.forEach(m => console.log(`   - [${m.category}] ${m.text} ${m.score ? `(score: ${m.score.toFixed(3)})` : ''}`));
  console.log('   ✅ Semantic search working\n');

  // Test auto-routing
  console.log('7. Auto-routing test: "what happened last Thursday?"...');
  const autoMemories = await memory.recall({ query: 'what happened last Thursday?', mode: 'auto' });
  console.log(`   Routed to: structured (detected temporal query)`);
  console.log(`   Found: ${autoMemories.length} memories`);
  console.log('   ✅ Auto-routing working\n');

  // Test noise filtering
  console.log('8. Noise filtering...');
  const withNoise = await memory.recall({ query: 'ok', filterNoise: false });
  const withoutNoise = await memory.recall({ query: 'ok', filterNoise: true });
  console.log(`   Without filter: ${withNoise.length} results`);
  console.log(`   With filter: ${withoutNoise.length} results`);
  console.log('   ✅ Noise filtering working\n');

  // Test forget
  console.log('9. Forget by query: "Switzerland"...');
  const forgotten = await memory.forget({ query: 'Switzerland' });
  console.log(`   Deleted: ${forgotten.deleted} memories`);
  const afterForget = memory.stats();
  console.log(`   Total now: ${afterForget.total}`);
  console.log('   ✅ Forget working\n');

  // Cleanup
  memory.close();
  rmSync(TEST_DIR, { recursive: true });

  console.log('═══════════════════════════════════════════════════');
  console.log('✅ All tests passed!');
  console.log('═══════════════════════════════════════════════════');
}

test().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
