// Hosting-account operator only. No Worker or MCP endpoint issues these codes.
import { randomBytes, createHash } from 'node:crypto';
const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index+1]]], []));
const { database, origin } = values;
const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
if (!database || !origin || !account || !token) throw Error('Provide --database ID --origin https://example.com and CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN.');
const site = new URL(origin);
if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/') throw Error('Use the HTTPS site origin.');
const api = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/query`;
async function query(sql, params=[]) {
 const response = await fetch(api,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sql,params})});
 const result=await response.json();
 if (!response.ok || !result.success || result.result.some(row=>!row.success)) throw Error('The hosting account could not issue a recovery link. Check the account, database and D1 permission.');
 return result.result;
}
const [owner] = await query('SELECT 1 FROM owner WHERE id = 1');
if (!owner.results.length) throw Error('This site has no owner yet; use setup.');
const code=randomBytes(24).toString('base64url'), hash=createHash('sha256').update(code).digest('base64url');
const created=new Date().toISOString(), expires=new Date(Date.now()+86400000).toISOString();
await query('DELETE FROM recovery_codes');
await query('INSERT INTO recovery_codes (code_hash,created_at,expires_at) VALUES (?,?,?)',[hash,created,expires]);
process.stdout.write(`${site.origin}/recover?code=${code}\n`);
process.stderr.write(`Works once until ${expires}. Give the link privately to the owner. Completing it replaces every owner passkey and ends all sessions.\n`);
