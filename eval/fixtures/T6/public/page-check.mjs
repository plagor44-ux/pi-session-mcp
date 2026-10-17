import assert from 'node:assert/strict';
import { formatPage } from './page.mjs';
assert.equal(formatPage(1), 'Page 1');
