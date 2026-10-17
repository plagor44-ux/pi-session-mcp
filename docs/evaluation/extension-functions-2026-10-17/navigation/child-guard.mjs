// Child-only synthetic-fixture instrumentation; this is not OS containment.
import cp from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import {writeFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const scope=process.env.PI_AUDIT_SCOPE;
if(!scope||!isAbsolute(scope))throw Error('owned_fixture_scope_required');
const counters={network_attempts_denied:0,child_process_attempts_denied:0};
const persist=()=>writeFileSync(join(scope,'child-guard-'+process.pid+'.json'),JSON.stringify(counters),{mode:0o600});
function deny(kind){counters[kind]++;persist();throw Object.assign(Error('fixture_child_guard_denied'),{code:'FIXTURE_CHILD_GUARD_DENIED'});}
const network=()=>deny('network_attempts_denied');
globalThis.fetch=async()=>network();
if('WebSocket' in globalThis)globalThis.WebSocket=class{constructor(){network();}};
net.Socket.prototype.connect=network;
net.connect=net.createConnection=network;
tls.connect=network;
http.request=http.get=https.request=https.get=network;
for(const key of ['lookup','resolve','resolve4','resolve6','reverse']){
 dns[key]=network;if(dns.promises?.[key])dns.promises[key]=async()=>network();
}
for(const proto of [dns.Resolver.prototype,dns.promises?.Resolver?.prototype])if(proto)for(const key of ['resolve','resolve4','resolve6','reverse'])if(proto[key])proto[key]=network;
dgram.createSocket=network;
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=()=>deny('child_process_attempts_denied');
persist();syncBuiltinESMExports();
