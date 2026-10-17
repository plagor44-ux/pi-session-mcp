import { subtotal } from './price.mjs';
import { addTax } from './tax.mjs';
export function charge(items, taxRate) { return addTax(subtotal(items), taxRate); }
