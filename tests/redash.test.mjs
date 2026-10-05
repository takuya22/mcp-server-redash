import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRedashQueryResult } from '../src/redash.ts';
import { isAllowedEmail } from '../src/access-control.ts';

const config = { REDASH_BASE_URL: 'https://redash.example.com/org/', REDASH_API_KEY: 'test-secret' };
const data = { query_result: { id: 42, retrieved_at: '2026-10-04T00:00:00Z', data: { columns: [{ name: 'value' }], rows: [{ value: 1 }, { value: 2 }] } } };
const reply = (body = data) => Response.json(body);

test('reads cached JSON, preserves organization path, uses header auth, limits rows', async () => {
  const result = await getRedashQueryResult(config, 12, 1, async (url, options) => {
    assert.equal(String(url), 'https://redash.example.com/org/api/queries/12/results.json');
    assert.equal(options.headers.Authorization, 'Key test-secret');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, "GET");
    assert.ok(options.signal);
    return reply();
  });
  assert.equal(result.query_result_id, 42);
  assert.deepEqual(result.rows, [{ value: 1 }]);
  assert.equal(result.total_rows, 2);
  assert.equal(result.truncated, true);
});

test('validates configuration and inputs before making a request', async () => {
  const fetcher = () => assert.fail('must not fetch');
  await assert.rejects(getRedashQueryResult({}, 1, 100, fetcher), /Set REDASH/);
  await assert.rejects(getRedashQueryResult(config, -1, 100, fetcher), /Too small/);
  await assert.rejects(getRedashQueryResult(config, 1, 1001, fetcher), /Too big/);
  for (const url of ['file:///tmp', 'https://user:pass@example.com', 'https://example.com/?api_key=secret']) {
    await assert.rejects(getRedashQueryResult({ ...config, REDASH_BASE_URL: url }, 1, 100, fetcher), /HTTP\(S\)/);
  }
});

test('reports HTTP failures without exposing response bodies or credentials', async () => {
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(getRedashQueryResult(config, 1, 100, async () => new Response('test-secret', { status })), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes('test-secret'));
      return true;
    });
  }
});

test('handles network errors, invalid JSON and invalid response shape', async () => {
  await assert.rejects(getRedashQueryResult(config, 1, 100, async () => { throw new Error('test-secret'); }), /request failed/);
  await assert.rejects(getRedashQueryResult(config, 1, 100, async () => new Response('<html>')), /invalid JSON/);
  await assert.rejects(getRedashQueryResult(config, 1, 100, async () => reply({})), /unexpected/);
});

test('rejects responses above the byte limit', async () => {
  await assert.rejects(getRedashQueryResult(config, 1, 100, async () => new Response('x'.repeat(5 * 1024 * 1024 + 1))), /exceeds 5 MiB/);
});

test('only the permitted email passes access control', () => {
  assert.equal(isAllowedEmail('yana22thx@gmail.com'), true);
  for (const email of ['other@gmail.com', 'yana22thx@gmail.com.attacker.com', undefined, null]) {
    assert.equal(isAllowedEmail(email), false);
  }
});
