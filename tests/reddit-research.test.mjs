import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTools, invoke, piDist } from './pi-harness.mjs';

const cache = mkdtempSync(join(tmpdir(), 'pi-reddit-mock-'));
process.env.PI_REDDIT_CACHE_DIR = cache;
process.env.PI_REDDIT_SQLITE_PATH = join(cache, 'reddit.sqlite');
process.env.PI_REDDIT_CONFIG_PATH = join(cache, 'no-config.json');
process.env.PI_REDDIT_COOKIE = 'synthetic-test-cookie';
process.env.PI_REDDIT_DELAY_MS = '250';
process.env.PI_REDDIT_SUBREDDIT_TTL_MS = '604800000';
process.env.PI_REDDIT_MAX_OUTPUT_CHARS = '2000';
process.env.PI_REDDIT_STATUS_FOOTER = 'false';
const originalFetch = globalThis.fetch;
let respond;
const requests = [];
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  requests.push(url);
  if (options.signal?.aborted) throw options.signal.reason;
  return respond(url, options);
};
after(() => { globalThis.fetch = originalFetch; rmSync(cache, { recursive: true, force: true }); });
const extension = await loadTools();
const listing = (children, after) => ({ kind: 'Listing', data: { children, after: after ?? null } });
const post = (id, subreddit = 'Alpha', score = 1, long = false) => ({ kind: 't3', data: {
  id, name: `t3_${id}`, subreddit, title: long ? 'large post '.repeat(120) : `source ${id}`,
  author: 'testuser', score, num_comments: 4, created_utc: 1700000000,
  permalink: `/r/${subreddit}/comments/${id}/source/`, selftext: 'body evidence '.repeat(long ? 100 : 3),
} });
const comment = (id, body = 'A useful fix: upgrade the configuration.', score = 1) => ({ kind: 't1', data: {
  id, name: `t1_${id}`, author: 'testuser', body, score, parent_id: 't3_abc123', subreddit: 'Alpha',
  permalink: `/r/Alpha/comments/abc123/source/${id}/`,
} });
const ok = (data) => Response.json(data);
const call = async (name, args) => {
  const result = await invoke(extension, name, args);
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.ok(result.content.every((item) => item.type === 'text'));
  assert.ok(result.content[0].text.length <= 2000);
  return result;
};
const text = (result) => result.content[0].text;

test('Pi loader registers nine tools and all prepared arguments validate', async () => {
  assert.equal(extension.tools.size, 9);
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const examples = {
    reddit_url_extract: { url_or_id: 't3_abc123' }, reddit_resolve_subreddits: { topic: 'test' },
    reddit_pack: { topic: 'test', subreddits: ['r/Alpha', 'Beta'] },
    reddit_search: { query: 'test', subreddits: ['Alpha'] }, reddit_thread: { url_or_id: 'abc123' },
    reddit_user: { username: 'u/testuser', sections: 'comments' },
    reddit_subreddits: { query: 'test' }, reddit_trends: { subreddits: 'Alpha,Beta' },
    reddit_subreddit_info: { names: ['r/Alpha', 'Beta'], include_rules: 'false' },
  };
  for (const [name, args] of Object.entries(examples)) {
    const tool = extension.tools.get(name).definition;
    validateToolArguments(tool, { type: 'toolCall', id: name, name, arguments: tool.prepareArguments(args) });
    validateToolArguments(tool, { type: 'toolCall', id: name, name, arguments: tool.prepareArguments({}) });
  }
});

test('reddit_user comments-only and default sections execute through the Pi agent loop', async () => {
  respond = (url) => url.pathname.endsWith('about.json')
    ? ok({ data: { name: 'testuser', id: 'abc', created_utc: 1700000000, link_karma: 5, subreddit: {} } })
    : url.pathname.endsWith('comments.json') ? ok(listing([comment('comm01', 'yes'), comment('comm02')], 't1_comm02'))
      : ok(listing([post('abc123')], 't3_abc123'));
  const before = requests.length;
  const only = await call('reddit_user', { username: 'u/testuser', sections: 'comments', limit: 2 });
  assert.equal(only.details.posts.length, 0);
  assert.equal(only.details.about, undefined);
  assert.equal(only.details.comments.length, 2);
  assert.deepEqual(requests.slice(before).map((url) => url.pathname), ['/user/testuser/comments.json']);
  assert.match(text(only), /after_comments=t1_comm02/);
  const defaults = await call('reddit_user', { username: 'testuser' });
  assert.equal(defaults.details.about.username, 'testuser');
  assert.equal(defaults.details.posts.length, 1);
});

for (const name of ['reddit_search', 'reddit_trends', 'reddit_subreddits', 'reddit_user', 'reddit_pack']) {
  test(`${name} keeps continuation instructions when the body is truncated`, async () => {
    respond = (url) => {
      if (url.pathname.startsWith('/comments/')) return ok([listing([post('abc123')]), listing([comment('comm03')])]);
      if (url.pathname.startsWith('/subreddits/')) return ok(listing(Array.from({ length: 25 }, (_, i) => ({ kind: 't5', data: {
        display_name: `Sub${i}`, title: 'community '.repeat(100), public_description: 'description '.repeat(100),
      } })), 't5_nextpage'));
      return ok(listing(Array.from({ length: 14 }, (_, i) => post(`page${i}`, 'Alpha', i, true)), 't3_nextpage'));
    };
    const args = name === 'reddit_user' ? { username: 'longuser', sections: 'posts', limit: 14 }
      : name === 'reddit_trends' ? { subreddits: 'LongSub', limit: 14 }
        : name === 'reddit_pack' ? { topic: 'longpack', depth: 'deep' }
          : { query: `long-${name}`, limit: 25 };
    const result = await call(name, args);
    assert.match(text(result), /truncated/);
    assert.match(text(result), name === 'reddit_user' ? /after_posts=t3_nextpage/ : /after=t[35]_nextpage/);
  });
}

for (const name of ['reddit_search', 'reddit_pack', 'reddit_trends']) {
  test(`${name} multi-subreddit cursors never advance past an unreturned post`, async () => {
    respond = (url) => {
      if (url.pathname.startsWith('/comments/')) return ok([listing([post('alpha1')]), listing([comment('com004')])]);
      const alpha = url.pathname.includes('/Alpha/');
      // Lowest-ranked item comes first in Beta: an end-of-listing cursor would skip it.
      const children = alpha ? [post('alpha1', 'Alpha', 100000), post('alpha2', 'Alpha', 99999)]
        : [post('beta01', 'Beta', 0), post('beta02', 'Beta', 99998)];
      return ok(listing(children, alpha ? 't3_alpha2' : 't3_beta02'));
    };
    const args = name === 'reddit_pack' ? { topic: 'multi-pack', subreddits: 'Alpha,Beta', max_posts: 1 }
      : name === 'reddit_search' ? { query: 'multi-search', subreddits: 'Alpha,Beta', limit: 1 }
        : { subreddits: 'Alpha,Beta', limit: 1 };
    const result = await call(name, args);
    assert.equal(result.details.posts.length, 1);
    assert.equal(result.details.cursors.per_subreddit.Alpha.after, 't3_alpha1');
    assert.equal(result.details.cursors.per_subreddit.Beta.after, undefined);
    assert.equal(result.details.cursors.per_subreddit.Beta.restart, true);
    assert.match(text(result), /Beta.*without after/);
  });
}

test('single listing pages use distinct URLs/cache keys and have no overlapping ids', async () => {
  respond = (url) => ok(url.searchParams.has('after')
    ? listing([post('second1')]) : listing([post('first01')], 't3_first01'));
  const first = await call('reddit_search', { query: 'cache-pagination', subreddits: 'PageSub', limit: 1 });
  const second = await call('reddit_search', { query: 'cache-pagination', subreddits: 'PageSub', limit: 1, after: first.details.cursors.after });
  assert.deepEqual(first.details.posts.map((p) => p.id), ['first01']);
  assert.deepEqual(second.details.posts.map((p) => p.id), ['second1']);
  const before = requests.length;
  await call('reddit_search', { query: 'cache-pagination', subreddits: 'PageSub', limit: 1 });
  assert.equal(requests.length, before, 'page one should now come from SQLite');
});

test('multi-subreddit safe boundaries can recover every hidden result when narrowed', async () => {
  const pages = {
    RecoverA: [post('recova1', 'RecoverA', 100), post('recova2', 'RecoverA', 10), post('recova3', 'RecoverA', 2)],
    RecoverB: [post('recovb1', 'RecoverB', 0), post('recovb2', 'RecoverB', 99999), post('recovb3', 'RecoverB', 5)],
  };
  respond = (url) => {
    const subreddit = url.pathname.split('/')[2];
    const children = pages[subreddit];
    const after = url.searchParams.get('after');
    const start = after ? children.findIndex((p) => p.data.name === after) + 1 : 0;
    const end = start + Number(url.searchParams.get('limit'));
    return ok(listing(children.slice(start, end), end < children.length ? children[Math.min(end, children.length) - 1].data.name : undefined));
  };
  const scope = await call('reddit_search', { query: 'recover-hidden', subreddits: 'RecoverA,RecoverB', limit: 2 });
  const found = new Set(scope.details.posts.map((p) => p.id));
  for (const [subreddit, cursor] of Object.entries(scope.details.cursors.per_subreddit)) {
    let after = cursor.after;
    if (!cursor.restart && !after) continue;
    for (let page = 0; page < 4; page++) {
      const next = await call('reddit_search', { query: 'recover-hidden', subreddits: subreddit, limit: 2, after });
      next.details.posts.forEach((p) => found.add(p.id));
      after = next.details.cursors.after;
      if (!after) break;
    }
  }
  assert.deepEqual([...found].sort(), Object.values(pages).flat().map((p) => p.data.id).sort());
});

test('multi-subreddit after is ignored and reported, including under truncation', async () => {
  respond = () => ok(listing([post('ignored1', 'IgnoreA', 1, true)], 't3_ignored1'));
  const before = requests.length;
  const result = await call('reddit_search', { query: 'ignored-after', subreddits: 'IgnoreA,IgnoreB', after: 't3_previous', limit: 1 });
  assert.equal(result.details.cursors.after_ignored, true);
  assert.ok(requests.slice(before).every((url) => !url.searchParams.has('after')));
  assert.match(text(result), /after was ignored/);
});

test('user cursors are independent, wrong-prefix cursors are reported, partial failures survive', async () => {
  respond = (url) => {
    if (url.pathname.endsWith('about.json')) return new Response('No such user', { status: 404 });
    if (url.pathname.endsWith('comments.json')) return ok(listing([comment('part001')], 't1_part001'));
    return ok(listing([post('part001')], 't3_part001'));
  };
  const before = requests.length;
  const result = await call('reddit_user', { username: 'partialuser', sections: 'about,posts,comments',
    after_posts: 't1_wrong', after_comments: 't1_valid' });
  assert.equal(result.details.posts.length, 1);
  assert.equal(result.details.comments.length, 1);
  assert.equal(result.details.errors.length, 2);
  assert.match(text(result), /expected a t3_/);
  const calls = requests.slice(before);
  assert.equal(calls.find((url) => url.pathname.endsWith('submitted.json')).searchParams.get('after'), null);
  assert.equal(calls.find((url) => url.pathname.endsWith('comments.json')).searchParams.get('after'), 't1_valid');
});

test('malformed usernames fail before network access and bound echoed input', async () => {
  const before = requests.length;
  const result = await invoke(extension, 'reddit_user', { username: 'x'.repeat(10000) });
  assert.equal(result.isError, true);
  assert.match(text(result), /10000 characters/);
  assert.ok(text(result).length < 200);
  assert.equal(requests.length, before);
});

test('remaining tools, evidence packs, commands and default TUI rendering work on current Pi', async () => {
  respond = (url) => {
    if (url.pathname.startsWith('/comments/')) return ok([listing([post('smoke01')]), listing([comment('smokeco')])]);
    if (url.pathname.startsWith('/subreddits/')) return ok(listing([{ kind: 't5', data: { display_name: 'SmokeSub', title: 'smoke topic', subscribers: 42 } }]));
    return ok(listing([post('smoke01', 'SmokeSub')]));
  };
  const extracted = await call('reddit_url_extract', { url_or_id: 'https://www.reddit.com/user/testuser/m/example/' });
  assert.equal(extracted.details.multireddit, 'example');
  const thread = await call('reddit_thread', { url_or_id: 'smoke01', top_comments: 2 });
  assert.equal(thread.details.comments[0].parentId, 't3_abc123');
  const resolved = await call('reddit_resolve_subreddits', { topic: 'smoke topic', refresh: true });
  assert.equal(resolved.details.subreddits[0].subreddit, 'SmokeSub');
  const pack = await call('reddit_pack', { topic: 'smoke-pack', depth: 'quick' });
  assert.equal(pack.details.commented_post_count, 1);
  assert.ok(pack.details.evidence_items.some((item) => item.kind === 'comment'));
  assert.ok(Object.keys(pack.details.clusters).length > 0);

  const notifications = [];
  const ctx = { ui: { notify: (message, level) => notifications.push({ message, level }) } };
  const command = extension.commands.get('reddit');
  await command.handler('status', ctx);
  await command.handler('search smoke-command', ctx);
  await command.handler('search', ctx);
  await command.handler('unknown', ctx);
  assert.deepEqual(notifications.map((n) => n.level), ['info', 'info', 'warning', 'warning']);
  assert.match(notifications[0].message, /Cookies: set/);

  const { initTheme } = await import(pathToFileURL(join(piDist, 'modes/interactive/theme/theme.js')));
  const { ToolExecutionComponent } = await import(pathToFileURL(join(piDist, 'modes/interactive/components/tool-execution.js')));
  initTheme('dark', false);
  const component = new ToolExecutionComponent('reddit_pack', 'render-test', { topic: 'smoke-pack' }, {},
    extension.tools.get('reddit_pack').definition, { requestRender() {} }, process.cwd());
  component.updateResult(pack);
  assert.ok(component.render(100).length > 0);
  component.setExpanded(true);
  assert.match(component.render(100).join('\n'), /Reddit research pack/);
});

test('reddit_user respects cancellation instead of fetching remaining sections', async () => {
  const controller = new AbortController();
  respond = () => { controller.abort(new Error('cancelled-test')); throw controller.signal.reason; };
  const tool = extension.tools.get('reddit_user').definition;
  const before = requests.length;
  await assert.rejects(() => tool.execute('cancel-test', tool.prepareArguments({ username: 'canceluser', sections: 'about,posts,comments' }), controller.signal), /cancelled-test/);
  assert.equal(requests.length - before, 1);
});

for (const mode of ['rising', 'controversial']) {
  test(`${mode} defaults to Reddit order and only controversial sends the time window`, async () => {
    respond = () => ok(listing([post('native1', mode, 0), post('native2', mode, 100000)], 't3_native2'));
    const before = requests.length;
    const result = await call('reddit_trends', { subreddits: `Native${mode}`, listing: mode, time: 'month', limit: 2 });
    assert.deepEqual(result.details.posts.map((p) => p.id), ['native1', 'native2']);
    assert.equal(result.details.order, 'reddit');
    assert.equal(result.details.cursors.after, 't3_native2');
    const [url] = requests.slice(before);
    assert.equal(url.pathname, `/r/Native${mode}/${mode}.json`);
    assert.equal(url.searchParams.get('t'), mode === 'controversial' ? 'month' : null);
    const ranked = await call('reddit_trends', { subreddits: `Native${mode}`, listing: mode, time: 'month', limit: 2, order: 'ranked' });
    assert.deepEqual(ranked.details.posts.map((p) => p.id), ['native2', 'native1']);
    assert.equal(requests.length - before, 1, 'order changes reuse the same cached listing');
  });
}

for (const mode of ['hot', 'top', 'new']) {
  test(`${mode} keeps ranked defaults and supports explicit Reddit order`, async () => {
    respond = () => ok(listing([post('legacy1', 'Legacy', 0), post('legacy2', 'Legacy', 100000)]));
    const before = requests.length;
    const args = { subreddits: `Legacy${mode}`, listing: mode, time: 'day', limit: 2 };
    const ranked = await call('reddit_trends', args);
    assert.deepEqual(ranked.details.posts.map((p) => p.id), ['legacy2', 'legacy1']);
    assert.equal(ranked.details.order, 'ranked');
    assert.equal(requests[before].searchParams.get('t'), mode === 'top' ? 'day' : null);
    const native = await call('reddit_trends', { ...args, order: 'reddit' });
    assert.deepEqual(native.details.posts.map((p) => p.id), ['legacy1', 'legacy2']);
  });
}

test('native multi-subreddit ordering interleaves positions and preserves safe cursor boundaries', async () => {
  respond = (url) => {
    const sub = url.pathname.split('/')[2];
    const isAlpha = sub === 'NativeA';
    return ok(listing([post(isAlpha ? 'intera1' : 'interb1', sub, 0), post(isAlpha ? 'intera2' : 'interb2', sub, 100000)], isAlpha ? 't3_intera2' : 't3_interb2'));
  };
  const before = requests.length;
  const result = await call('reddit_trends', { subreddits: 'NativeA,NativeB', listing: 'rising', limit: 3, after: 't3_ignored' });
  assert.deepEqual(result.details.posts.map((p) => p.id), ['intera1', 'interb1', 'intera2']);
  assert.equal(result.details.cursors.after_ignored, true);
  assert.equal(result.details.cursors.per_subreddit.NativeA.after, 't3_intera2');
  assert.equal(result.details.cursors.per_subreddit.NativeB.after, 't3_interb1');
  assert.ok(requests.slice(before).every((url) => !url.searchParams.has('after')));
  assert.match(text(result), /after was ignored/);
  assert.match(text(result), /listing\/time\/order/);
});

test('native ordering handles uneven and empty subreddit listings', async () => {
  respond = (url) => ok(listing(url.pathname.includes('/EmptyNative/') ? []
    : [post('uneven1'), post('uneven2'), post('uneven3')]));
  const result = await call('reddit_trends', { subreddits: 'EmptyNative,UnevenNative', listing: 'new', order: 'reddit', limit: 5 });
  assert.deepEqual(result.details.posts.map((p) => p.id), ['uneven1', 'uneven2', 'uneven3']);
});

for (const sub of ['all', 'popular']) {
  test(`r/${sub} uses the existing trends listing path and cursor`, async () => {
    respond = (url) => ok(url.searchParams.has('after')
      ? listing([post('feed002', 'ActualCommunity')])
      : listing([post('feed001', 'ActualCommunity')], 't3_feed001'));
    const before = requests.length;
    const args = { subreddits: sub, listing: 'hot', order: 'reddit', limit: 1 };
    const first = await call('reddit_trends', args);
    const second = await call('reddit_trends', { ...args, after: first.details.cursors.after });
    assert.deepEqual(first.details.posts.map((p) => p.id), ['feed001']);
    assert.deepEqual(second.details.posts.map((p) => p.id), ['feed002']);
    assert.ok(requests.slice(before).every((url) => url.pathname === `/r/${sub}/hot.json`));
    assert.equal(requests[before + 1].searchParams.get('after'), 't3_feed001');
  });
}

test('trends preparation normalizes listing/order and defaults invalid values safely', () => {
  const tool = extension.tools.get('reddit_trends').definition;
  assert.equal(tool.prepareArguments({ listing: ' RISING ', order: ' REDDIT ' }).order, 'reddit');
  assert.equal(tool.prepareArguments({ listing: 'controversial', order: 'invalid' }).order, 'reddit');
  assert.equal(tool.prepareArguments({ listing: 'hot', order: 'invalid' }).order, 'ranked');
  assert.equal(tool.prepareArguments({ listing: 'best' }).listing, 'hot');
});

const subredditAbout = (name, overrides = {}) => ({ kind: 't5', data: {
  display_name: name, title: `Community ${name}`, public_description: 'Community summary', description: 'Community description',
  subscribers: 12345, created_utc: 1500000000, over18: false, subreddit_type: 'public', quarantine: false, lang: 'en', submission_type: 'any',
  ...overrides,
} });
const subredditRules = (count = 2) => ({ rules: Array.from({ length: count }, (_, i) => ({ short_name: `Rule ${i + 1}`, description: `Description of rule ${i + 1}` })) });

test('subreddit info exposes bounded metadata/rules and caches both for seven days', async () => {
  respond = (url) => ok(url.pathname.endsWith('/rules.json')
    ? { rules: Array.from({ length: 15 }, () => ({ short_name: 'R'.repeat(200), description: 'D'.repeat(1000) })) }
    : subredditAbout('InfoFull', { title: 'T'.repeat(1000), public_description: 'P'.repeat(1000), description: 'D'.repeat(3000), accounts_active: 20, active_user_count: 42 }));
  const before = requests.length;
  const result = await call('reddit_subreddit_info', { names: 'r/InfoFull' });
  assert.deepEqual(requests.slice(before).map((url) => url.pathname), ['/r/InfoFull/about.json', '/r/InfoFull/about/rules.json']);
  assert.equal(result.details.include_rules, true);
  assert.deepEqual(result.details.errors, []);
  const item = result.details.subreddits[0];
  assert.equal(item.about.display_name, 'InfoFull');
  assert.equal(item.about.subscribers, 12345);
  assert.equal(item.about.created_utc, 1500000000);
  assert.ok(item.about.age);
  assert.equal(item.about.over18, false);
  assert.equal(item.about.quarantine, false);
  assert.equal(item.about.subreddit_type, 'public');
  assert.equal(item.about.lang, 'en');
  assert.equal(item.about.submission_type, 'any');
  assert.ok(item.about.title.length <= 162);
  assert.ok(item.about.public_description.length <= 362);
  assert.ok(item.about.description.length <= 602);
  assert.equal(item.about.accounts_active, undefined);
  assert.equal(item.about.active_user_count, undefined);
  assert.equal(item.rules.length, 10);
  assert.equal(item.rules_total, 15);
  assert.ok(item.rules.every((rule) => rule.short_name.length <= 102 && rule.description.length <= 302));
  assert.match(text(result), /request fewer names or pass include_rules=false/);
  await call('reddit_subreddit_info', { names: 'InfoFull' });
  assert.equal(requests.length - before, 2, 'second call reuses both raw cached endpoints');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(cache, 'reddit.sqlite'));
  try {
    const rows = db.prepare("SELECT expires_at - saved_at AS ttl FROM requests WHERE url LIKE '%/r/InfoFull/%'").all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.ttl === 604800000));
  } finally { db.close(); }
});

test('metadata-only calls skip rules, preserve zero/false, and can reuse about cache when rules are later requested', async () => {
  respond = (url) => ok(url.pathname.endsWith('/rules.json') ? subredditRules(0) : subredditAbout('InfoCache', { subscribers: 0, created_utc: undefined }));
  const before = requests.length;
  const first = await call('reddit_subreddit_info', { names: ['r/InfoCache', 'INFOCACHE'], include_rules: 'false' });
  assert.equal(first.details.subreddits.length, 1);
  assert.equal(first.details.include_rules, false);
  assert.equal(first.details.subreddits[0].rules, undefined);
  assert.equal(first.details.subreddits[0].about.subscribers, 0);
  assert.equal(first.details.subreddits[0].about.over18, false);
  assert.equal(first.details.subreddits[0].about.age, undefined);
  assert.match(text(first), /subscribers 0; age unknown/);
  assert.match(text(first), /NSFW no/);
  assert.equal(requests.length - before, 1);
  const second = await call('reddit_subreddit_info', { names: 'InfoCache' });
  assert.equal(requests.length - before, 2, 'only the new rules URL is fetched');
  assert.deepEqual(second.details.subreddits[0].rules, []);
  assert.equal(second.details.subreddits[0].rules_total, 0);
});

test('optional malformed fields stay unknown, alternate NSFW key is accepted, and online counts are omitted', async () => {
  respond = () => ok(subredditAbout('InfoUnknown', {
    title: {}, public_description: [], description: 123, subscribers: 'not a count', created_utc: -1,
    over18: null, over_18: true, quarantine: 'false', lang: {}, submission_type: [], subreddit_type: null, accounts_active: 7,
  }));
  const result = await call('reddit_subreddit_info', { names: 'InfoUnknown', include_rules: false });
  const about = result.details.subreddits[0].about;
  for (const key of ['title', 'public_description', 'description', 'subscribers', 'created_utc', 'age', 'quarantine', 'lang', 'submission_type', 'subreddit_type', 'accounts_active']) assert.equal(about[key], undefined, key);
  assert.equal(about.over18, true);
  assert.match(text(result), /subscribers unknown; age unknown/);
  assert.match(text(result), /NSFW yes; quarantined unknown/);
});

test('404/restricted communities and rules failures retain successful siblings and do not start a resource-denial cooldown', async () => {
  respond = (url) => {
    const name = url.pathname.split('/')[2];
    if (url.pathname === '/search.json') return ok(listing([post('infoend')]));
    if (name === 'MissingInfo') return new Response('', { status: 404 });
    if (name === 'PrivateInfo') return Response.json({ reason: 'gold_only' }, { status: 403 });
    if (name === 'InfoPartial' && url.pathname.endsWith('/rules.json')) return new Response('Synthetic unavailable rules', { status: 503 });
    return ok(url.pathname.endsWith('/rules.json') ? subredditRules() : subredditAbout(name));
  };
  const before = requests.length;
  const result = await call('reddit_subreddit_info', { names: 'MissingInfo, PrivateInfo, InfoPartial, InfoGood' });
  const [missing, restricted, partial, good] = result.details.subreddits;
  assert.deepEqual(missing.errors, ['about: not found']);
  assert.deepEqual(restricted.errors, ['about: restricted: gold_only']);
  assert.equal(missing.about, undefined);
  assert.equal(restricted.about, undefined);
  assert.equal(partial.about.display_name, 'InfoPartial');
  assert.equal(partial.rules, undefined);
  assert.match(partial.errors[0], /^rules: Reddit JSON HTTP 503/);
  assert.equal(good.rules.length, 2);
  assert.deepEqual(good.errors, []);
  assert.equal(requests.length - before, 6, 'failed about lookups do not trigger rules requests');
  assert.match(text(result), /fetch errors:/);
  assert.match(text(result), /restricted: gold_only/);
  await call('reddit_search', { query: 'uncached-info-followup' });
  assert.equal(requests.length - before, 7, 'next uncached URL reaches HTTP rather than a global cooldown');
});

for (const [name, payload] of [['BadNull', null], ['BadData', { data: [] }], ['BadListing', listing([])], ['BadMismatch', subredditAbout('DifferentCommunity')]]) {
  test(`malformed about response ${name} is reported per community, not returned as healthy metadata`, async () => {
    respond = () => ok(payload);
    const before = requests.length;
    const result = await call('reddit_subreddit_info', { names: name });
    assert.equal(result.details.subreddits[0].about, undefined);
    assert.match(result.details.errors[0], /Malformed subreddit about response/);
    assert.equal(requests.length - before, 1, 'rules are not fetched for malformed about data');
  });
}

test('malformed rules preserve metadata; invalid rule entries/fields are filtered safely', async () => {
  respond = (url) => {
    const name = url.pathname.split('/')[2];
    if (!url.pathname.endsWith('/rules.json')) return ok(subredditAbout(name));
    return ok(name === 'BadRules' ? { rules: {} } : { rules: [null, 'bad', [], { description: 'no name' }, { short_name: 'One', description: {} }, { short_name: 'Two', description: 'valid' }] });
  };
  const result = await call('reddit_subreddit_info', { names: 'BadRules,FilterRules' });
  assert.ok(result.details.subreddits[0].about);
  assert.equal(result.details.subreddits[0].rules, undefined);
  assert.match(result.details.subreddits[0].errors[0], /Malformed subreddit rules/);
  assert.deepEqual(result.details.subreddits[1].rules, [{ short_name: 'One', description: undefined }, { short_name: 'Two', description: 'valid' }]);
  assert.equal(result.details.subreddits[1].rules_total, 6);
});

test('subreddit name validation rejects unsafe/over-limit inputs before any HTTP and bounds echoed input', async () => {
  const before = requests.length;
  for (const names of ['', 'A,B,C,D,E,F', 'a/b', 'https://www.reddit.com/r/python/', '../private', 'alpha?x=1', 'x'.repeat(10000)]) {
    const result = await invoke(extension, 'reddit_subreddit_info', { names });
    assert.equal(result.isError, true, names.slice(0, 30));
    assert.ok(text(result).length < 240);
  }
  assert.equal(requests.length, before);
});

test('five distinct communities plus case-insensitive duplicates use at most ten endpoints', async () => {
  respond = (url) => ok(url.pathname.endsWith('/rules.json') ? subredditRules() : subredditAbout(url.pathname.split('/')[2]));
  const before = requests.length;
  const result = await call('reddit_subreddit_info', { names: 'FiveA,FiveB,FiveC,FiveD,FiveE,r/fivea' });
  assert.equal(result.details.subreddits.length, 5);
  assert.equal(requests.length - before, 10);
});

test('all community errors remain in details and a bounded error summary survives truncated metadata output', async () => {
  respond = (url) => ok(url.pathname.endsWith('/rules.json')
    ? { wrong_shape: true }
    : subredditAbout(url.pathname.split('/')[2], { title: 'long '.repeat(300), description: 'description '.repeat(300) }));
  const result = await call('reddit_subreddit_info', { names: 'TruncA,TruncB,TruncC,TruncD,TruncE' });
  assert.equal(result.details.errors.length, 5);
  assert.match(text(result), /truncated/);
  for (const name of ['TruncA', 'TruncB', 'TruncC', 'TruncD', 'TruncE']) assert.match(text(result), new RegExp(`r/${name} rules:`));
  assert.match(text(result), /Full errors are in details.subreddits/);
  assert.doesNotMatch(text(result), /Additional pagination instructions/);
});

test('subreddit info cancellation stops before rules and remaining community lookups', async () => {
  const controller = new AbortController();
  respond = (url) => {
    controller.abort(new Error('Synthetic info cancellation.'));
    return ok(subredditAbout(url.pathname.split('/')[2]));
  };
  const tool = extension.tools.get('reddit_subreddit_info').definition;
  const before = requests.length;
  await assert.rejects(tool.execute('cancel-info', tool.prepareArguments({ names: 'CancelInfo,LaterInfo' }), controller.signal, undefined, {}), /Synthetic info cancellation/);
  assert.equal(requests.length - before, 1);
  const aborted = new AbortController();
  aborted.abort(new Error('Already cancelled.'));
  await assert.rejects(tool.execute('cancel-info-early', tool.prepareArguments({ names: 'NeverInfo' }), aborted.signal, undefined, {}), /Already cancelled/);
  assert.equal(requests.length - before, 1);
});

test('403 resource denials do not block unrelated uncached requests; block/rate-limit behavior is preserved', async (t) => {
  // All requests below are synthetic. A controlled clock expires each case's cooldown
  // without waiting five real minutes or letting one case contaminate the next.
  let now = Date.now() + 600000;
  t.mock.method(Date, 'now', () => now);
  let caseId = 0;
  const runCase = async (name, status, body, headers = {}, denial = false, refresh = false) => {
    now += 600000;
    const key = `status-case-${caseId++}`;
    const previousCookie = process.env.PI_REDDIT_COOKIE;
    const before = requests.length;
    respond = (url) => {
      now += 251;
      if (url.searchParams.get('q') === key) {
        if (refresh) process.env.PI_REDDIT_COOKIE = 'synthetic-refreshed-cookie';
        return new Response(body, { status, headers });
      }
      return ok(listing([post('after01')]));
    };
    try {
      const rejected = await invoke(extension, 'reddit_search', { query: key });
      assert.equal(rejected.isError, true, name);
      assert.match(text(rejected), denial ? /Reddit denied access:/ : refresh ? /cookie refreshed/ : /cooldown started/, name);
      if (denial) assert.doesNotMatch(text(rejected), /cookie may be expired|cooldown started/, name);
      const next = await invoke(extension, 'reddit_search', { query: `${key}-uncached` });
      assert.equal(next.isError, !denial && !refresh, name);
      assert.equal(requests.length - before, denial || refresh ? 2 : 1, `${name}: actual fetch count, not a cached success`);
      if (!denial && !refresh) {
        assert.match(text(next), /cooling down/, name);
        const seconds = Number(headers['retry-after']) > 0 ? Number(headers['retry-after']) : 300;
        now += seconds * 1000 + 1;
        const recovered = await call('reddit_search', { query: `${key}-uncached` });
        assert.equal(recovered.details.posts.length, 1);
        assert.equal(requests.length - before, 2, `${name}: network resumes after cooldown`);
      }
    } finally {
      process.env.PI_REDDIT_COOKIE = previousCookie;
    }
  };
  for (const reason of ['gold_only', 'private', 'banned', 'quarantined', 'unknown_resource_reason']) {
    await runCase(reason, 403, JSON.stringify({ reason }), {}, true);
  }
  await runCase('JSON reason with changed cookie', 403, '{"reason":"private"}', {}, true, true);
  for (const [name, body] of Object.entries({ html: '<html>blocked</html>', empty: '', malformed: '{bad', no_reason: '{}', numeric: '{"reason":42}', blank: '{"reason":"  "}', null: 'null' })) {
    await runCase(name, 403, body);
  }
  await runCase('403 Retry-After', 403, '<html>blocked</html>', { 'retry-after': '17' });
  await runCase('invalid Retry-After', 403, '', { 'retry-after': 'invalid' });
  await runCase('429 reason still rate limited', 429, '{"reason":"private"}', { 'retry-after': '30' });
  await runCase('cookie refreshed', 403, '<html>blocked</html>', {}, false, true);
});
