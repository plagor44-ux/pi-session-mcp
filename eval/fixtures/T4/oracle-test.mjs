import assert from 'node:assert/strict';
import { charge } from './public/src/checkout.mjs';
assert.equal(charge([{price:10},{price:5}], 0.1), 16.5);
assert.equal(charge([], 0.2), 0);
