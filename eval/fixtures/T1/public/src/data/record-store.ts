const rows = new Map<string, {id:string}>();
export const recordStore = { findById(id:string) { return rows.get(id) ?? null; } };
