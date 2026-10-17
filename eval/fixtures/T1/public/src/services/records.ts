import { recordStore } from '../data/record-store.js';
export function getRecord(id: string) { return recordStore.findById(id); }
