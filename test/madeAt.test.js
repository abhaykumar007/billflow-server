const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMadeAt } = require('../src/utils/validate');

const NOW = Date.parse('2026-11-01T12:00:00Z');

test('made-at: a real recent time is kept', () => {
  assert.equal(parseMadeAt('2026-11-01T10:30:00.000Z', NOW).toISOString(), '2026-11-01T10:30:00.000Z');
  assert.equal(parseMadeAt('2026-10-15T08:00:00Z', NOW).toISOString(), '2026-10-15T08:00:00.000Z');
});

test('made-at: a few minutes ahead (clock drift) is clamped to now, never in the future', () => {
  assert.equal(parseMadeAt('2026-11-01T12:03:00Z', NOW).getTime(), NOW);
});

test('made-at: future, too old, or not a date is ignored', () => {
  for (const bad of ['2026-11-01T13:00:00Z', '2027-01-01T00:00:00Z', '2026-05-01T00:00:00Z', '2020-01-01', 'yesterday', '', null, undefined, 12345, {}, ['2026-11-01'], 'x'.repeat(100)]) {
    assert.equal(parseMadeAt(bad, NOW), null, String(bad));
  }
});
