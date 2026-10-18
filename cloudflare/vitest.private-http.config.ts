import {readFileSync} from 'node:fs';
import {cloudflareTest,readD1Migrations} from '@cloudflare/vitest-pool-workers';
import {defineConfig} from 'vitest/config';
export default defineConfig(async()=>{
 if(!process.env.PORCHSITE_PARITY_OUTPUT)throw Error('Set an output directory for private HTTP parity');
 const names:string[]=JSON.parse(process.env.PORCHSITE_PARITY_LOOKS??'[]');
 return {plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'},miniflare:{bindings:{TEST_MIGRATIONS:await readD1Migrations('./migrations'),PARITY_CASES:JSON.stringify(names.map(name=>({name,theme:name,sample:JSON.parse(readFileSync(`../themes/${name}/sample.json`,'utf8'))}))),PARITY_NOW:process.env.NOW??'2026-10-15T15:30:00Z',PARITY_OUTPUT:process.env.PORCHSITE_PARITY_OUTPUT}}})],test:{include:['scripts/private-http-parity.worker.ts'],setupFiles:['./test/apply-migrations.ts'],maxWorkers:1,testTimeout:120000}};
});
