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
  const info = await call('reddit_subreddit_info', { names: 'python,LocalLLaMA' });
  assert.equal(info.details.subreddits.length, 2);
  for (const item of info.details.subreddits) {
    assert.equal(item.about.display_name.toLowerCase(), item.name.toLowerCase());
    assert.equal(typeof item.about.subscribers, 'number');
    assert.ok(Array.isArray(item.rules) && item.rules.length <= 10);
    assert.equal(item.about.accounts_active, undefined);
    assert.equal(item.about.active_user_count, undefined);
  }
  const originalFetch = globalThis.fetch;
  const metadataPaths = [];
  globalThis.fetch = async (input, options) => {
    metadataPaths.push(new URL(input).pathname);
    return originalFetch(input, options);
  };
  try {
    const metadataOnly = await call('reddit_subreddit_info', { names: 'programming', include_rules: false });
    assert.ok(metadataOnly.details.subreddits[0].about);
    assert.equal(metadataOnly.details.subreddits[0].rules, undefined);
    assert.deepEqual(metadataPaths.splice(0), ['/r/programming/about.json']);
    const missingName = `pi_missing_${Date.now().toString(36)}`;
    const mixed = await invoke(extension, 'reddit_subreddit_info', { names: `${missingName},lounge,learnpython` });
    assert.equal(mixed.isError, false);
    const [missing, lounge, valid] = mixed.details.subreddits;
    assert.equal(missing.about, undefined);
    // Reddit may redirect a nonexistent community to an HTTP-200 listing, not a 404.
    assert.equal(missing.errors.length, 1);
    assert.match(missing.errors[0], /^about: (?:not found|restricted: .+|Malformed subreddit about response or mismatched community name\.)$/);
    assert.ok(valid.about, 'valid community after missing/restricted lookups was blocked');
    assert.deepEqual(valid.errors, []);
    assert.ok(metadataPaths.includes('/r/learnpython/about.json'), 'successful sibling must reach an uncached endpoint');
    if (lounge.errors.some((error) => error.includes('restricted:'))) console.log('Restricted-community denial reported without blocking uncached sibling metadata.');
    else if (lounge.about && !lounge.errors.length) console.log('r/lounge is readable for this account; restricted-denial behavior is covered offline.');
    else throw new Error(`Unexpected lounge lookup failure: ${lounge.errors.join('; ')}`);
    console.log(`subreddit info: ${info.details.subreddits.length} public communities; rules ${info.details.subreddits.map((item) => item.rules.length).join(',')}; metadata-only 1 HTTP request; partial errors isolated`);
  } finally {
    globalThis.fetch = originalFetch;
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
