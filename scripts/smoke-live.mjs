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
  await pages('reddit_search', { query: 'python', subreddits: 'learnpython', sort: 'new', limit: 2, format: 'compact' });
  await pages('reddit_trends', { subreddits: 'learnpython', listing: 'new', limit: 2, format: 'compact' });
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
  for (const [name, args] of [
    ['reddit_search', { query: 'python', subreddits: 'learnpython', sort: 'new', limit: 100 }],
    ['reddit_trends', { subreddits: 'all', listing: 'hot', order: 'reddit', limit: 100 }],
  ]) {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (...args) => { fetches++; return originalFetch(...args); };
    try {
      const full = await call(name, args);
      const compact = await call(name, { ...args, format: 'compact' });
      assert.equal(fetches, 1, `${name}: format-only change should reuse the cached listing`);
      assert.equal(full.details.format, 'full');
      assert.equal(compact.details.format, 'compact');
      assert.ok(full.details.posts.length > 0 && full.details.posts.length <= 100);
      assert.equal(new Set(full.details.posts.map((post) => post.id)).size, full.details.posts.length);
      assert.deepEqual(compact.details.posts.map((post) => post.id), full.details.posts.map((post) => post.id));
      assert.deepEqual(compact.details.cursors, full.details.cursors);
      assert.ok(compact.details.posts_shown >= full.details.posts_shown);
      for (const post of compact.details.posts) {
        for (const key of ['isSelf', 'stickied', 'isVideo']) assert.equal(typeof post[key], 'boolean');
        assert.equal(new URL(post.url).hostname, 'www.reddit.com');
        if (post.externalUrl) {
          const destination = new URL(post.externalUrl);
          assert.ok(['http:', 'https:'].includes(destination.protocol));
          assert.equal(post.isSelf, false);
          assert.ok(destination.hostname !== 'reddit.com' && !destination.hostname.endsWith('.reddit.com'));
          assert.equal(destination.username + destination.password, '');
        }
      }
      console.log(`${name}: ${full.details.posts.length} selected, ${full.details.posts_shown} full / ${compact.details.posts_shown} compact entries shown; format-only reuse made no extra HTTP request`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  await pages('reddit_user', { username: 'spez', sections: 'about,posts', limit: 2 }, 'after_posts');
  await pages('reddit_user', { username: 'spez', sections: 'comments', limit: 2 }, 'after_comments');
  const candidates = await call('reddit_search', { query: 'python', subreddits: 'learnpython', limit: 2 });
  assert.ok(candidates.details.posts.length > 0);
  await call('reddit_thread', { url_or_id: candidates.details.posts[0].id, top_comments: 2, comment_limit: 10 });
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
