import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { RedashClient } from '../src/redash.ts';
import { registerRedashTools } from '../src/redash-tools.ts';

const config = { REDASH_BASE_URL: 'https://redash.example.com/org', REDASH_API_KEY: 'secret-key' };
const result = { query_result: { id: 42, retrieved_at: '2026-10-04T01:00:00Z', data: { columns: [{ name: 'n' }], rows: [{ n: 1 }, { n: 2 }] } } };
function setup(fetcher, email = 'yana22thx@gmail.com') {
  const tools = new Map();
  registerRedashTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } }, new RedashClient(config, fetcher), () => email);
  const invoke = (name, args) => {
    const tool = tools.get(name);
    return tool.handler(z.object(tool.definition.inputSchema).parse(args));
  };
  return { tools, invoke };
}
const decoded = (response) => JSON.parse(response.content[0].text);

test('registers six tools and denies every tool before an API call', async () => {
  const { tools } = setup(() => assert.fail('unauthorized API request'), 'other@gmail.com');
  assert.equal(tools.size, 6);
  for (const tool of tools.values()) {
    const response = await tool.handler({});
    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, 'Access denied.');
  }
});

test('search is paginated, encoded and excludes API keys and full SQL', async () => {
  const { invoke } = setup(async (url) => {
    assert.equal(url.pathname, '/org/api/queries');
    assert.equal(url.searchParams.get('q'), '売上 & revenue');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('page_size'), '10');
    return Response.json({ count: 1, results: [{ id: 1, name: 'Revenue', query: 'SELECT 1', api_key: 'leak' }] });
  });
  const data = decoded(await invoke('redash_search_queries', { search: '売上 & revenue', page: 2, page_size: 10 }));
  assert.equal(data.count, 1);
  assert.deepEqual(data.queries, [{ id: 1, name: 'Revenue' }]);
});

test('query details return SQL and parameter definitions but omit keys', async () => {
  const { invoke } = setup(async (url) => {
    assert.equal(url.pathname, '/org/api/queries/7');
    return Response.json({ id: 7, name: 'Revenue', query: 'SELECT {{day}}', api_key: 'leak', options: { parameters: [{ name: 'day', type: 'date' }], secret: 'leak' } });
  });
  const data = decoded(await invoke('redash_get_query', { query_id: 7 }));
  assert.equal(data.query, 'SELECT {{day}}');
  assert.equal(data.options.parameters[0].name, 'day');
  assert.ok(!JSON.stringify(data).includes('leak'));
});

test('query execution submits parameters and defaults to fresh execution', async () => {
  const { invoke, tools } = setup(async (url, options) => {
    assert.equal(url.pathname, '/org/api/queries/7/results');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { parameters: { day: '2026-10-04' }, max_age: 0 });
    return Response.json({ job: { id: 'job-1', status: 1, error: 'secret-key', query_result_id: null } });
  });
  const data = decoded(await invoke('redash_run_query', { query_id: 7, parameters: { day: '2026-10-04' } }));
  assert.equal(data.kind, 'job');
  assert.equal(data.status_name, 'pending');
  assert.ok(!JSON.stringify(data).includes('secret-key'));
  assert.equal(tools.get('redash_run_query').definition.annotations.readOnlyHint, false);
});

test('execution handles a cached result and limits returned rows', async () => {
  const { invoke } = setup(async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_age, 1800);
    return Response.json(result);
  });
  const data = decoded(await invoke('redash_run_query', { query_id: 7, max_age: 1800, max_rows: 1 }));
  assert.equal(data.kind, 'result');
  assert.equal(data.rows.length, 1);
  assert.equal(data.truncated, true);
});

test('job completion and result retrieval use their separate endpoints', async () => {
  const { invoke } = setup(async (url) => {
    if (url.pathname.endsWith('/jobs/job-1')) return Response.json({ job: { id: 'job-1', status: 3, query_result_id: 42 } });
    assert.equal(url.pathname, '/org/api/query_results/42.json');
    return Response.json(result);
  });
  const job = decoded(await invoke('redash_get_job', { job_id: 'job-1' }));
  assert.equal(job.status_name, 'success');
  const data = decoded(await invoke('redash_get_result', { query_result_id: job.query_result_id, max_rows: 1 }));
  assert.equal(data.query_result_id, 42);
  assert.equal(data.returned_rows, 1);
});

test('failed and cancelled jobs are reported without leaking upstream error text', async () => {
  for (const [status, name] of [[4, 'failure'], [5, 'cancelled']]) {
    const { invoke } = setup(async () => Response.json({ job: { id: 'job-1', status, error: 'secret-key' } }));
    const data = decoded(await invoke('redash_get_job', { job_id: 'job-1' }));
    assert.equal(data.status_name, name);
    assert.equal(data.error, undefined);
  }
});

test('invalid inputs cannot select arbitrary paths or exceed limits', () => {
  const { invoke } = setup(() => assert.fail('must not fetch'));
  for (const [name, args] of [
    ['redash_get_job', { job_id: '../queries' }],
    ['redash_get_query', { query_id: 1.5 }],
    ['redash_run_query', { query_id: 1, max_age: -1 }],
    ['redash_search_queries', { search: ' ', page_size: 1001 }],
    ['redash_get_result', { query_result_id: 1, max_rows: 1001 }],
  ]) assert.throws(() => invoke(name, args));
});

test('API errors become MCP error responses', async () => {
  const { invoke } = setup(async () => new Response('secret-key', { status: 403 }));
  const response = await invoke('redash_get_query', { query_id: 7 });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /HTTP 403/);
  assert.ok(!response.content[0].text.includes('secret-key'));
});
