import assert from 'node:assert/strict';
import { parseLimit } from './public/contract.mjs';
assert.equal(parseLimit(undefined), 20);
assert.equal(parseLimit('7'), 7);
assert.equal(parseLimit('invalid'), 20);
assert.equal(parseLimit('-2'), 20);
