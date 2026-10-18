// Real Reddit HTTP, real Pi loader and tool loop, synthetic model stream. No LLM provider calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTools, invoke } from '../tests/pi-harness.mjs';

const cache = mkdtempSync(join(tmpdir(), 'pi-reddit-live-'));
process.env.PI_REDDIT_CACHE_DIR = cache;
process.env.PI_REDDIT_SQLITE_PATH = join(cache, 'reddit.sqlite');
process.env.PI_REDDIT_STATUS_FOOTER = 'false';
const extension = await loadTools();
const call = async (name, args) => {
  const result = await invoke(extension, name, args);
  if (result.isError) throw new Error(result.content.map((c) => c.text ?? '').join('\n'));
  if (result.details?.errors?.length) throw new Error(result.details.errors.join('; '));
  if (result.details?.expansion_stopped) throw new Error(result.details.expansion_stopped);
  console.log(`${name}: OK`);
  return result;
};
const pages = async (name, args, key = 'after') => {
  const first = await call(name, args);
  const cursor = key === 'after' ? first.details.cursors.after : first.details.cursors[key === 'after_posts' ? 'posts' : 'comments']?.after;
  if (!cursor) { console.log(`${name}: no next cursor; page-two check unavailable`); return; }
  const second = await call(name, { ...args, [key]: cursor });
  const items = key === 'after_comments' ? 'comments' : 'posts';
  const ids = new Set(first.details[items].map((p) => p.id));
  assert.ok(second.details[items].length > 0, `${name}: empty second page`);
  assert.ok(second.details[items].every((p) => !ids.has(p.id)), `${name}: overlapping page ids`);
  console.log(`${name}: page-two ids do not overlap page one`);
};
try {
  await call('reddit_url_extract', { url_or_id: 'https://www.reddit.com/user/spez/comments/' });
  await pages('reddit_search', { query: 'python', subreddits: 'learnpython', sort: 'new', limit: 2 });
  await pages('reddit_trends', { subreddits: 'learnpython', listing: 'new', limit: 2 });
  for (const mode of ['rising', 'controversial']) {
    const result = await call('reddit_trends', { subreddits: 'learnpython', listing: mode, time: 'week', limit: 2 });
    assert.equal(result.details.order, 'reddit');
    // An empty rising/controversial listing is valid; offline fixtures assert ordering.
  }
  for (const sub of ['all', 'popular']) {
    const result = await call('reddit_trends', { subreddits: sub, listing: 'hot', order: 'reddit', limit: 2 });
    assert.equal(result.details.order, 'reddit');
    assert.ok(result.details.posts.length > 0, `r/${sub}: no posts returned`);
  }
  await pages('reddit_user', { username: 'spez', sections: 'about,posts', limit: 2 }, 'after_posts');
  await pages('reddit_user', { username: 'spez', sections: 'comments', limit: 2 }, 'after_comments');
  const candidates = await call('reddit_search', { query: 'python', subreddits: 'learnpython', limit: 2 });
  assert.ok(candidates.details.posts.length > 0);
  await call('reddit_thread', { url_or_id: candidates.details.posts[0].id, top_comments: 2, comment_limit: 10 });
  const discussions = await call('reddit_trends', { subreddits: 'LocalLLaMA', listing: 'top', time: 'month', limit: 3, order: 'reddit' });
  const discussion = [...discussions.details.posts].sort((a, b) => b.numComments - a.numComments)[0];
  assert.ok(discussion, 'No discussion available for expansion smoke check');
  const threadArgs = { url_or_id: discussion.id, comment_limit: 5, top_comments: 40 };
  const initial = await call('reddit_thread', threadArgs);
  assert.ok(initial.details.more.hiddenIds > 0, 'No collapsed ids available; expansion smoke not exercised');
  const originalFetch = globalThis.fetch;
  let expansionHttp = 0;
  const batches = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/api/morechildren.json') {
      expansionHttp++;
      const ids = url.searchParams.get('children').split(',');
      assert.ok(ids.length <= 100, 'Expansion exceeded 100 ids per request');
      batches.push(ids.length);
    }
    return originalFetch(input, options);
  };
  let expanded;
  try {
    expanded = await call('reddit_thread', { ...threadArgs, expand_more: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(expansionHttp > 0 && expansionHttp <= 2);
  assert.equal(expanded.details.expansion.requests, expansionHttp);
  assert.ok(expanded.details.comments_fetched >= initial.details.comments_fetched);
  assert.equal(new Set(expanded.details.comments.map((c) => c.id)).size, expanded.details.comments.length);
  assert.ok(expanded.details.expansion.pending_ids.every((id) => !expanded.details.expansion.unresolved_ids.includes(id)));
  console.log(`thread expansion: ${initial.details.comments_fetched} -> ${expanded.details.comments_fetched} fetched comments; ${expansionHttp} HTTP requests; batch sizes ${batches.join(',')}; pending ${expanded.details.expansion.pending_ids.length}; unresolved ${expanded.details.expansion.unresolved_ids.length}; stubs ${expanded.details.more.stubs}`);
  const largeThread = await call('reddit_thread', { url_or_id: discussion.id, comment_limit: 500, top_comments: 2 });
  assert.ok(largeThread.details.comments_fetched > 0);
  console.log(`500-comment fetch: ${largeThread.details.comments_fetched} visible comments parsed`);
  const pack = await call('reddit_pack', { topic: 'python', subreddits: 'learnpython', depth: 'quick', max_posts: 2, comments_per_post: 2 });
  assert.ok(pack.details.posts.length > 0);
  assert.ok(pack.details.commented_post_count > 0);
  await call('reddit_subreddits', { query: 'python', limit: 2 });
  await call('reddit_resolve_subreddits', { topic: 'python', limit: 2, refresh: true });
  console.log('Live Reddit smoke checks passed.');
} catch (error) {
  console.error(`Live Reddit smoke blocked/failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(cache, { recursive: true, force: true });
}
