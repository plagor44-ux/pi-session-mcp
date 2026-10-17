// Generate structural JSON Schemas. The TypeScript contract also enforces cross-field bindings.
import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {taskSchema,runSchema,resultSchema,manifestSchema,budgetSchema,VERSION} from '../.profile-eval/eval/profiles/schemas.js';
for(const [name,schema] of Object.entries({task:taskSchema,run:runSchema,result:resultSchema,manifest:manifestSchema,budget:budgetSchema})){
  const output=JSON.stringify({...z.toJSONSchema(schema),$id:`urn:pi-profile-evaluation:${VERSION}:${name}`},null,2)+'\n';
  const path=new URL(`../eval/profiles/schemas/${name}.schema.json`,import.meta.url);
  if(process.argv.includes('--check')){
    if(await readFile(path,'utf8')!==output)throw new Error('schema_drift');
  }else await writeFile(path,output);
}
