import { getRecord } from '../services/records.js';
export async function handle(id: string) { const record = await getRecord(id); return record ? {status:200,body:record} : {status:404}; }
