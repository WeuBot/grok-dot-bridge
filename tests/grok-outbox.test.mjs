import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createBridge} from '../lib/bridge-service.mjs';
import {grokConfiguration} from '../lib/grok-outbox.mjs';
import {grokMcpStatus} from '../lib/grok-mcp.mjs';
const config={BRIDGE_MCP_AUTHORIZATION:'Bearer fixture_mcp_token_12345678901234567890',BRIDGE_GROK_ENABLED:'true',BRIDGE_OWNER_ID:'alice',BRIDGE_GROK_CHANNEL:'main',BRIDGE_GROK_WEBHOOK_URL:'https://grok-fixture.example.com/routine',BRIDGE_GROK_BEARER_KEY:'fixture-only-not-a-real-key'};
// All sends are injected fake responses. No test makes an external request.
function fixture(post=async()=>new Response(null,{status:200}),overrides={},lifecycle={}) {
  const sql=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+f,'utf8'));
  const wrap=(q,a=[])=>({bind:(...v)=>wrap(q,v),first:async()=>sql.prepare(q).get(...a)||null,all:async()=>({results:sql.prepare(q).all(...a)}),run:async()=>({meta:{changes:Number(sql.prepare(q).run(...a).changes)}})});
  let transaction=Promise.resolve();
  const db={prepare:q=>wrap(q),batch:statements=>{const work=transaction.then(async()=>{sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}});transaction=work.catch(()=>{});return work;}};
  const env={DB:db,...config,...overrides},calls=[];
  const transport={publicDestinationValidated:true,post:async(url,options)=>{calls.push({url,options});return post(url,options);}};
  return {sql,db,env,transport,calls,bridge:createBridge(env,transport,lifecycle)};
}
const msg=(id='input_001',channel='main')=>({message_id:id,channel,text:'original user input',origin:'grok',hop:0});
async function write(bridge,text='dot reply',id='input_001',owner='alice') {
  return (await(await bridge.handle(new Request('https://bridge.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':owner},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bridge_write_result',arguments:{message_id:id,text}}})}))).json()).result;
}
const row=sql=>sql.prepare('SELECT * FROM grok_outbox').get();
test('reply and outbox are atomic; 200 accepts a run without claiming completion',async()=>{
  const f=fixture();await f.bridge.accept('alice',msg());const r=await write(f.bridge);assert.ok(!r.isError);assert.equal(row(f.sql).state,'pending');assert.equal(f.calls.length,0);
  await f.bridge.grok.pump('alice');assert.equal(row(f.sql).state,'accepted');assert.equal(row(f.sql).attempts,1);assert.equal(row(f.sql).status,200);assert.ok(row(f.sql).accepted_at);
  const {url,options}=f.calls[0],body=JSON.parse(options.body);assert.equal(url,config.BRIDGE_GROK_WEBHOOK_URL);assert.equal(options.headers.authorization,'Bearer '+config.BRIDGE_GROK_BEARER_KEY);assert.equal(options.redirect,'manual');assert.equal(options.headers['idempotency-key'],body.event_id);assert.equal(body.reply_to,'input_001');assert.equal(body.origin,'dot');assert.equal(body.hop,1);assert.equal(body.channel,'main');assert.equal(body.text,'dot reply');assert.ok(body.message_id.startsWith('dotreply_'));assert.equal(body.event_id,body.message_id);
  const s=await f.bridge.status('alice');assert.equal(s.grok_push.completion,'not_reported');assert.ok(!JSON.stringify(s).includes(config.BRIDGE_GROK_WEBHOOK_URL));assert.ok(!JSON.stringify(s).includes(config.BRIDGE_GROK_BEARER_KEY));assert.equal((await f.bridge.result('alice','input_001')).state,'answered');
});
test('default off, wrong owner/channel and unsafe transport cannot send or leak configuration',async()=>{
  for(const overrides of [{BRIDGE_GROK_ENABLED:undefined},{BRIDGE_OWNER_ID:'bob'},{BRIDGE_GROK_CHANNEL:'other'},{BRIDGE_GROK_WEBHOOK_URL:'http://unsafe.example/'},{BRIDGE_GROK_BEARER_KEY:'bad\r\nheader'}]){const f=fixture(undefined,overrides);await f.bridge.accept('alice',msg());await write(f.bridge);await f.bridge.grok.pump('alice');assert.equal(f.calls.length,0);assert.equal(row(f.sql),undefined);}
  const f=fixture();f.transport.publicDestinationValidated=false;await f.bridge.accept('alice',msg());await write(f.bridge);assert.equal(row(f.sql).state,'pending');assert.equal((await f.bridge.grok.pump('alice')).reason,'safe_transport_unavailable');assert.equal(f.calls.length,0);assert.equal(row(f.sql).attempts,0);
});
test('identical and concurrent replies enqueue once; changed reply conflicts; old answers never backfill',async()=>{
  const f=fixture();await f.bridge.accept('alice',msg());const results=await Promise.all([write(f.bridge),write(f.bridge)]);assert.ok(results.every(r=>!r.isError));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grok_outbox').get().n,1);assert.equal((await write(f.bridge,'different')).isError,true);
  await Promise.all([f.bridge.grok.pump('alice'),f.bridge.grok.pump('alice')]);assert.equal(f.calls.length,1);await write(f.bridge);await f.bridge.grok.pump('alice');assert.equal(f.calls.length,1);
  const old=fixture(undefined,{BRIDGE_GROK_ENABLED:'false'});await old.bridge.accept('alice',msg());await write(old.bridge);old.env.BRIDGE_GROK_ENABLED='true';await write(old.bridge);assert.equal(row(old.sql),undefined);assert.equal(old.calls.length,0);
});
test('a failed result update rolls back its outbox insert',async()=>{
  const f=fixture();await f.bridge.accept('alice',msg());f.sql.exec("CREATE TRIGGER fail_result BEFORE UPDATE OF result ON messages BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");assert.equal((await write(f.bridge)).isError,true);assert.equal(row(f.sql),undefined);assert.equal((await f.bridge.result('alice','input_001')).state,'pending');
});
test('only HTTP 200 is accepted; 202, permanent failures and redirects are terminal',async()=>{
  for(const code of [201,202,204,302,307,400,401,403,404,410,413]){const f=fixture(async()=>new Response(null,{status:code,headers:{location:'https://other.example/'}}));await f.bridge.accept('alice',msg());await write(f.bridge);await f.bridge.grok.pump('alice');await f.bridge.grok.pump('alice');assert.equal(f.calls.length,1);assert.equal(row(f.sql).state,'failed',String(code));assert.equal(row(f.sql).accepted_at,null);}
});
test('confirmed retryable HTTP failures stop after four sends with stable payload and correlation',async()=>{
  for(const code of [408,429,500,503]){const f=fixture(async()=>new Response(null,{status:code}));await f.bridge.accept('alice',msg());await write(f.bridge);for(let i=0;i<6;i++){f.sql.exec('UPDATE grok_outbox SET next_at=0');await f.bridge.grok.pump('alice');}assert.equal(f.calls.length,4);assert.equal(new Set(f.calls.map(x=>x.options.body)).size,1);assert.equal(row(f.sql).state,'failed');assert.equal(row(f.sql).attempts,4);}
});
test('network errors and timeouts stop as uncertain, suppress details and never auto-resend',async()=>{
  for(const error of [new TypeError('private network diagnostic '+config.BRIDGE_GROK_BEARER_KEY),new DOMException('timeout','TimeoutError')]){const f=fixture(async()=>{throw error;});await f.bridge.accept('alice',msg());await write(f.bridge);await f.bridge.grok.pump('alice');await write(f.bridge);await f.bridge.grok.pump('alice');assert.equal(f.calls.length,1);assert.equal(row(f.sql).state,'uncertain');assert.equal(row(f.sql).reason,'connection_outcome_unknown');assert.ok(!JSON.stringify(await f.bridge.status('alice')).includes('private network diagnostic'));}
});
test('interrupted sends survive restart as uncertain and an old claim cannot overwrite recovery',async()=>{
  let finish;const delayed=new Promise(r=>{finish=r;});const f=fixture(async()=>delayed);await f.bridge.accept('alice',msg());await write(f.bridge);const send=f.bridge.grok.pump('alice');
  while(row(f.sql)?.state!=='sending')await new Promise(r=>setImmediate(r));
  f.sql.exec('UPDATE grok_outbox SET lease_until=0');await createBridge(f.env,f.transport).grok.pump('alice');assert.equal(row(f.sql).state,'uncertain');finish(new Response(null,{status:200}));const returned=await send;assert.equal(returned.processed[0].state,'uncertain');assert.equal(row(f.sql).state,'uncertain');assert.equal(row(f.sql).accepted_at,null);assert.equal(f.calls.length,1);
});
test('fixed destination changes, disabled push and stale replies stop without outbound calls',async()=>{
  for(const mutate of [f=>{f.env.BRIDGE_GROK_WEBHOOK_URL='https://changed.example.com/webhook';},f=>{f.env.BRIDGE_GROK_CHANNEL='changed';},f=>{f.env.BRIDGE_GROK_ENABLED='false';},f=>{f.sql.exec('UPDATE grok_outbox SET created_at=0');}]){const f=fixture();await f.bridge.accept('alice',msg());await write(f.bridge);mutate(f);await f.bridge.grok.pump('alice');assert.equal(row(f.sql).state,'stopped');assert.equal(f.calls.length,0);}
});
test('reply origin, reserved IDs and exact reflected replies cannot become new inbound events',async()=>{
  const f=fixture();await f.bridge.accept('alice',msg());await write(f.bridge);for(const input of [{...msg('other'),text:'dot reply'},{...msg('dotreply_abc')},{...msg('other'),origin:'dot',hop:1},{...msg('other'),callback:'https://other.example.com'}])await assert.rejects(f.bridge.accept('alice',input));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM messages').get().n,1);
});
test('waitUntil starts push after persisted reply, without waiting for Grok completion',async()=>{
  const pending=[];let finish;const delayed=new Promise(r=>{finish=r;});const f=fixture(async()=>delayed,{}, {waitUntil:p=>pending.push(p)});await f.bridge.accept('alice',msg());const r=await write(f.bridge);assert.ok(!r.isError);assert.equal(pending.length,1);assert.equal((await f.bridge.result('alice','input_001')).state,'answered');finish(new Response(null,{status:200}));await Promise.all(pending);assert.equal(row(f.sql).state,'accepted');assert.equal(f.calls.length,1);
});

test('idempotent result rewrites never schedule or send another pending reply',async()=>{
  const f=fixture(),pending=[];
  for(const id of ['message_A','message_B']){await f.bridge.accept('alice',msg(id));assert.ok(!(await write(f.bridge,'reply '+id,id)).isError);}
  const bridge=createBridge(f.env,f.transport,{waitUntil:work=>pending.push(work)});
  assert.ok(!(await write(bridge,'reply message_B','message_B')).isError);
  assert.equal(pending.length,0);assert.equal(f.calls.length,0);
  assert.deepEqual(f.sql.prepare('SELECT external_id,state,attempts FROM grok_outbox ORDER BY external_id').all().map(record=>({...record})),[
    {external_id:'message_A',state:'pending',attempts:0},{external_id:'message_B',state:'pending',attempts:0}
  ]);
  assert.equal((await write(bridge,'changed reply','message_B')).isError,true);
  assert.equal(pending.length,0);assert.equal(f.calls.length,0);
});

test('new results only progress their message; the explicit retry tool progresses the owner queue',async()=>{
  const f=fixture(),pending=[];
  for(const id of ['message_A','interrupted_C']){await f.bridge.accept('alice',msg(id));assert.ok(!(await write(f.bridge,'reply '+id,id)).isError);}
  f.sql.prepare("UPDATE grok_outbox SET state='sending',attempts=1,lease_until=0 WHERE external_id=?").run('interrupted_C');
  await f.bridge.accept('alice',msg('message_B'));
  const bridge=createBridge(f.env,f.transport,{waitUntil:work=>pending.push(work)});
  assert.ok(!(await write(bridge,'reply message_B','message_B')).isError);
  assert.equal(pending.length,1);await Promise.all(pending);
  assert.deepEqual(f.calls.map(call=>JSON.parse(call.options.body).reply_to),['message_B']);
  assert.ok(f.calls.every(call=>call.url===config.BRIDGE_GROK_WEBHOOK_URL));
  assert.equal(f.sql.prepare('SELECT state FROM grok_outbox WHERE external_id=?').get('message_A').state,'pending');
  assert.equal(f.sql.prepare('SELECT attempts FROM grok_outbox WHERE external_id=?').get('message_A').attempts,0);
  assert.equal(f.sql.prepare('SELECT state FROM grok_outbox WHERE external_id=?').get('interrupted_C').state,'sending');
  const rpc=async(method,params={})=>(await(await bridge.handle(new Request('https://bridge.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'alice'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}))).json());
  const catalog=await rpc('tools/list');
  assert.equal(catalog.result.tools.find(tool=>tool.name==='bridge_retry_deliveries').annotations.idempotentHint,false);
  assert.equal(catalog.result.tools.find(tool=>tool.name==='bridge_write_result').annotations.idempotentHint,true);
  assert.ok(!(await rpc('tools/call',{name:'bridge_retry_deliveries'})).result.isError);
  assert.deepEqual(f.calls.map(call=>JSON.parse(call.options.body).reply_to),['message_B','message_A']);
  assert.equal(f.sql.prepare('SELECT state FROM grok_outbox WHERE external_id=?').get('interrupted_C').state,'uncertain');
});

test('concurrent identical new results schedule one scoped background task and one send',async()=>{
  const f=fixture(),pending=[];
  await f.bridge.accept('alice',msg('old_A'));await write(f.bridge,'old reply','old_A');
  await f.bridge.accept('alice',msg('new_B'));
  const bridge=createBridge(f.env,f.transport,{waitUntil:work=>pending.push(work)});
  const results=await Promise.all([write(bridge,'new reply','new_B'),write(bridge,'new reply','new_B')]);
  assert.ok(results.every(result=>!result.isError));assert.equal(pending.length,1);await Promise.all(pending);
  assert.deepEqual(f.calls.map(call=>JSON.parse(call.options.body).reply_to),['new_B']);
  assert.equal(f.sql.prepare('SELECT attempts FROM grok_outbox WHERE external_id=?').get('old_A').attempts,0);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grok_outbox WHERE external_id=?').get('new_B').n,1);
});

test('a missing or invalid message scope never falls back to another pending message',async()=>{
  const f=fixture();await f.bridge.accept('alice',msg());await write(f.bridge);
  await f.bridge.grok.background('alice','missing_message');assert.equal(f.calls.length,0);
  for(const scope of [null,{},'', 'invalid scope'])await assert.rejects(f.bridge.grok.pump('alice',scope));
  assert.equal(row(f.sql).state,'pending');assert.equal(row(f.sql).attempts,0);assert.equal(f.calls.length,0);
});

test('a terminal reply received during a retryable failure stops the matching outbox permanently',async()=>{
  let receipt;
  const f=fixture(async()=>{
    receipt=await f.bridge.accept('alice',{message_id:'terminal_during_send',channel:'main',text:'terminal fixture acknowledgement',origin:'grok',hop:2,reply_to:row(f.sql).id});
    return new Response(null,{status:503});
  });
  await f.bridge.accept('alice',msg());await write(f.bridge);const sent=await f.bridge.grok.pump('alice','input_001');
  assert.equal(receipt.state,'reply_received');assert.equal(sent.processed[0].state,'stopped');
  assert.equal(row(f.sql).state,'stopped');assert.equal(row(f.sql).reason,'terminal_reply_received');
  assert.equal(row(f.sql).status,503);assert.equal(row(f.sql).accepted_at,null);
  f.sql.exec('UPDATE grok_outbox SET next_at=0');await f.bridge.grok.background('alice','input_001');await f.bridge.grok.pump('alice');
  assert.equal(f.calls.length,1);assert.equal(row(f.sql).attempts,1);
  assert.equal((await f.bridge.result('alice','input_001')).grok_reply.message_id,'terminal_during_send');
});

test('retry backoff starts after a slow failure response rather than before its network delay',async()=>{
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  try {
    const f=fixture(async()=>{now+=1500;return new Response(null,{status:503});});
    await f.bridge.accept('alice',msg());await write(f.bridge);await f.bridge.grok.pump('alice','input_001');
    assert.equal(row(f.sql).state,'pending');assert.equal(row(f.sql).next_at,now+1000);
    await f.bridge.grok.pump('alice','input_001');assert.equal(f.calls.length,1);
    now=row(f.sql).next_at;await f.bridge.grok.pump('alice','input_001');assert.equal(f.calls.length,2);
    assert.equal(row(f.sql).next_at,now+2000);
  } finally {Date.now=originalNow;}
});
test('fixed configuration accepts no HTTP/private literal/credential URL',()=>{
  for(const url of ['http://example.com','https://127.0.0.1','https://[::1]/','https://localhost/','https://u:p@example.com/','https://example.com:8443','https://example.com/#fragment'])assert.equal(grokConfiguration({...config,BRIDGE_GROK_WEBHOOK_URL:url},'alice',{publicDestinationValidated:true}).ready,false);
});
test('stale concurrent snapshot cannot bypass backoff or the attempts bound',async()=>{
  const f=fixture(async()=>new Response(null,{status:429}));await f.bridge.accept('alice',msg());await write(f.bridge);
  const original=f.db.prepare;let release,reads=0;const bothRead=new Promise(r=>{release=r;});
  f.db.prepare=q=>{const wrap=s=>({bind:(...a)=>wrap(s.bind(...a)),first:()=>s.first(),run:()=>s.run(),all:async()=>{const rows=await s.all();if(q.startsWith('SELECT * FROM grok_outbox WHERE')){reads++;if(reads===2)release();await bothRead;}return rows;}});return wrap(original(q));};
  await Promise.all([f.bridge.grok.pump('alice'),f.bridge.grok.pump('alice')]);assert.equal(reads,2);assert.equal(f.calls.length,1);assert.equal(row(f.sql).attempts,1);assert.equal(row(f.sql).state,'pending');assert.ok(row(f.sql).next_at>Date.now());
});
test('Retry-After is respected; waits beyond reply lifetime stop',async()=>{
  for(const seconds of [60,3600]){const f=fixture(async()=>new Response(null,{status:429,headers:{'retry-after':String(seconds)}}));await f.bridge.accept('alice',msg());await write(f.bridge);const before=Date.now();await f.bridge.grok.pump('alice');assert.ok(row(f.sql).next_at>=before+seconds*1000);assert.equal(row(f.sql).state,seconds===60?'pending':'stopped');await f.bridge.grok.pump('alice');assert.equal(f.calls.length,1);}
});
const mcpReq=(method,params={},headers={},notification=false)=>new Request('https://bridge.example/mcp/grok',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:1}),method,params})});
test('public Grok ingress needs exactly one valid independent key, never owner identity or a Site token',async()=>{
 const f=fixture(undefined,{BRIDGE_MCP_ENABLED:'true'}),key=f.env.BRIDGE_MCP_AUTHORIZATION;
 for(const headers of [{},{'oai-authenticated-user-id':'alice'},{'oai-sites-authorization':'Bearer fixture-site-token'},{'authorization':key},{'x-bridge-mcp-authorization':'Bearer wrong'},{'x-bridge-mcp-authorization':'Bearer '+key},{'x-bridge-mcp-authorization':key+', '+key}]){
  const r=await f.bridge.handle(mcpReq('tools/list',{},headers));assert.equal(r.status,401);assert.ok(!(await r.text()).includes(key));
 }
 const header={'x-bridge-mcp-authorization':key};assert.equal((await f.bridge.handle(mcpReq('tools/list',{},header))).status,200);
 assert.equal((await f.bridge.handle(mcpReq('tools/list',{}, {...header,origin:'https://foreign.example'}))).status,403);
  for(const token of [undefined,'short','fixture token with spaces that cannot be accepted',key.slice(7),'Bearer '+key,'bearer '+'a'.repeat(32),'Bearer '+'a'.repeat(31),'Bearer '+'a'.repeat(257),' '+key,key+' ',[key],123]){
  f.env.BRIDGE_MCP_AUTHORIZATION=token;assert.equal((await f.bridge.handle(mcpReq('tools/list',{},header))).status,401);
 }
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM messages').get().n,0);assert.equal(f.calls.length,0);
});
test('MCP accepts the exact complete authorization at both length limits and never reads the retired token',async()=>{
  const f=fixture(undefined,{BRIDGE_MCP_ENABLED:'true'});
  Object.defineProperty(f.env,'BRIDGE_MCP_TOKEN',{get(){throw new Error('Retired token must never be read');}});
  for(const key of ['a'.repeat(32),'A_-'.repeat(85)+'B']){
    const authorization='Bearer '+key;f.env.BRIDGE_MCP_AUTHORIZATION=authorization;
    const status=grokMcpStatus(f.env);assert.equal(status.service_token_configured,true);assert.ok(!JSON.stringify(status).includes(key));
    const result=await(await f.bridge.handle(mcpReq('initialize',{protocolVersion:'2025-06-18'},{'x-bridge-mcp-authorization':authorization}))).json();
    assert.equal(result.result.protocolVersion,'2025-06-18');
    assert.equal((await f.bridge.handle(mcpReq('initialize',{}, {'x-bridge-mcp-authorization':'Bearer '+authorization}))).status,401);
    assert.equal((await f.bridge.handle(mcpReq('initialize',{}, {'x-bridge-mcp-authorization':config.BRIDGE_MCP_AUTHORIZATION}))).status,401);
  }
  f.env.BRIDGE_MCP_AUTHORIZATION=undefined;
  assert.equal(grokMcpStatus(f.env).service_token_configured,false);
  assert.equal((await f.bridge.handle(mcpReq('initialize',{}, {'x-bridge-mcp-authorization':config.BRIDGE_MCP_AUTHORIZATION}))).status,401);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM messages').get().n,0);assert.equal(f.calls.length,0);
});
test('limited Grok MCP defaults closed and requires the independent key even for the owner',async()=>{
  const f=fixture();assert.equal((await f.bridge.handle(mcpReq('tools/list'))).status,503);f.env.BRIDGE_MCP_ENABLED='true';
  assert.equal((await f.bridge.handle(mcpReq('tools/list'))).status,401);assert.equal((await f.bridge.handle(mcpReq('tools/list',{}, {'oai-authenticated-user-id':'bob'}))).status,401);
  assert.equal((await f.bridge.handle(mcpReq('tools/list',{}, {'oai-authenticated-user-id':'alice','origin':'https://evil.example'}))).status,403);
  f.env.BRIDGE_MCP_AUTHORIZATION='Bearer fixture_mcp_token_12345678901234567890';const h={'x-bridge-mcp-authorization':f.env.BRIDGE_MCP_AUTHORIZATION};
  const r=await(await f.bridge.handle(mcpReq('tools/list',{},h))).json();assert.deepEqual(r.result.tools.map(t=>t.name),['bridge_submit_reply','bridge_submit_message','bridge_get_result']);
  for(const method of ['events/subscribe','events/unsubscribe'])assert.equal((await(await f.bridge.handle(mcpReq(method,{},h))).json()).error.data.reason,'method_not_allowed');
  for(const name of ['bridge_write_result','bridge_status','bridge_retry_deliveries'])assert.equal((await(await f.bridge.handle(mcpReq('tools/call',{name,arguments:{}},h))).json()).result.isError,true);
});
test('Grok MCP initialize, notification, scoped submit/dedupe and result query use production persistence',async()=>{
  const pending=[],f=fixture(undefined,{}, {waitUntil:p=>pending.push(p)});f.env.BRIDGE_MCP_ENABLED='true';const h={'x-bridge-mcp-authorization':f.env.BRIDGE_MCP_AUTHORIZATION};
  const init=await(await f.bridge.handle(mcpReq('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}},h))).json();assert.equal(init.result.protocolVersion,'2025-06-18');
  assert.equal((await f.bridge.handle(mcpReq('notifications/initialized',{},h,true))).status,202);
  const args={message_id:'mcp_message_001',text:'user explicitly requested this',origin:'grok',hop:0};
  const call=async(name,arguments_)=>((await(await f.bridge.handle(mcpReq('tools/call',{name,arguments:arguments_},h))).json()).result);
  assert.ok(!(await call('bridge_submit_message',args)).isError);const dup=await call('bridge_submit_message',args);assert.equal(JSON.parse(dup.content[0].text).duplicate,true);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM messages').get().n,1);assert.equal(f.sql.prepare('SELECT channel FROM messages').get().channel,'main');
  assert.equal((await call('bridge_submit_message',{...args,message_id:'other',channel:'forbidden'})).isError,true);await f.bridge.accept('alice',msg('outside','other'));assert.equal((await call('bridge_get_result',{message_id:'outside'})).isError,true);
  assert.equal(JSON.parse((await call('bridge_get_result',{message_id:'mcp_message_001'})).content[0].text).state,'pending');await Promise.all(pending);assert.equal(f.calls.length,0);
});
test('Grok MCP rejects invalid IDs before SQL and rate-limits missing-message lookups',async()=>{
  const f=fixture(undefined,{BRIDGE_MCP_ENABLED:'true'}),h={'x-bridge-mcp-authorization':f.env.BRIDGE_MCP_AUTHORIZATION};
  const query=async id=>{const r=await(await f.bridge.handle(mcpReq('tools/call',{name:'bridge_get_result',arguments:{message_id:id}},h))).json();return JSON.parse(r.result.content[0].text);};
  assert.equal((await query({unexpected:'object'})).reason,'invalid_request');
  for(let i=0;i<30;i++)assert.equal((await query('missing_'+i)).reason,'not_found');assert.equal((await query('missing_31')).reason,'rate_limited');
});
test('owner single-call ceiling prevents retries even for known transient HTTP failures',async()=>{
  for(const setting of ['1','0','999','invalid']){const f=fixture(async()=>new Response(null,{status:503}),{BRIDGE_GROK_MAX_ATTEMPTS:setting});await f.bridge.accept('alice',msg());await write(f.bridge);await f.bridge.grok.background('alice');f.sql.exec('UPDATE grok_outbox SET next_at=0');await createBridge(f.env,f.transport).grok.pump('alice');assert.equal(f.calls.length,1);assert.equal(row(f.sql).state,'failed');assert.equal((await f.bridge.status('alice')).grok_push.max_attempts,1);}
});

async function limitedToolCall(f,name,arguments_,owner='alice') {
  const response=await f.bridge.handle(mcpReq('tools/call',{name,arguments:arguments_},{'x-bridge-mcp-authorization':f.env.BRIDGE_MCP_AUTHORIZATION}));
  assert.equal(response.status,200);
  const rpc=await response.json();
  assert.ok(rpc.result,JSON.stringify(rpc));
  return {isError:rpc.result.isError===true,value:JSON.parse(rpc.result.content[0].text)};
}
async function prepareReplyTarget(f,{send=true}={}) {
  await f.bridge.accept('alice',msg());
  assert.ok(!(await write(f.bridge)).isError);
  if(send)await f.bridge.grok.pump('alice');
  return row(f.sql).id;
}
const terminalReply=(replyTo,id='grok_reply_001',text='Grok terminal response')=>({message_id:id,text,reply_to:replyTo});

test('terminal replies require a sent event in the authenticated fixed owner and channel',async()=>{
  for(const scenario of ['unknown','pending','zero_attempts','wrong_owner','wrong_channel']){
    const f=fixture(undefined,{BRIDGE_MCP_ENABLED:'true'});
    let target=await prepareReplyTarget(f,{send:scenario!=='pending'}),owner='alice';
    if(scenario==='unknown')target='dotreply_'+'f'.repeat(40);
    if(scenario==='zero_attempts')f.sql.exec('UPDATE grok_outbox SET attempts=0');
    if(scenario==='wrong_owner'){f.env.BRIDGE_OWNER_ID='bob';owner='bob';}
    if(scenario==='wrong_channel')f.env.BRIDGE_GROK_CHANNEL='other';
    const before=f.calls.length;
    const reply=await limitedToolCall(f,'bridge_submit_reply',terminalReply(target),owner);
    assert.equal(reply.isError,true,scenario);
    assert.equal(reply.value.reason,'invalid_reply_target',scenario);
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM messages').get().n,1,scenario);
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM deliveries').get().n,0,scenario);
    assert.equal(f.calls.length,before,scenario);
  }
  const f=fixture(undefined,{BRIDGE_MCP_ENABLED:'true'}),target=await prepareReplyTarget(f);
  assert.equal((await f.bridge.handle(mcpReq('tools/call',{name:'bridge_submit_reply',arguments:terminalReply(target)},{'oai-authenticated-user-id':'bob'}))).status,401);
  for(const extra of [{channel:'other'},{owner:'bob'},{origin:'grok'},{hop:0}]){
    const reply=await limitedToolCall(f,'bridge_submit_reply',{...terminalReply(target),...extra});
    assert.equal(reply.isError,true);
    assert.equal(reply.value.reason,'invalid_request');
  }
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM messages').get().n,1);
});

test('terminal reply retry is idempotent; altered content or a second message ID conflicts',async()=>{
  const f=fixture(undefined,{BRIDGE_MCP_ENABLED:'true'}),target=await prepareReplyTarget(f),input=terminalReply(target);
  const first=await limitedToolCall(f,'bridge_submit_reply',input);
  assert.equal(first.isError,false);
  assert.equal(first.value.duplicate,false);
  f.bridge=createBridge(f.env,f.transport);
  const duplicate=await limitedToolCall(f,'bridge_submit_reply',input);
  assert.equal(duplicate.isError,false);
  assert.equal(duplicate.value.state,'reply_received');
  assert.equal(duplicate.value.receipt_id,first.value.receipt_id);
  assert.equal(duplicate.value.duplicate,true);
  const changed=await limitedToolCall(f,'bridge_submit_reply',{...input,text:'Changed response'});
  assert.equal(changed.isError,true);
  assert.equal(changed.value.reason,'idempotency_conflict');
  const second=await limitedToolCall(f,'bridge_submit_reply',{...input,message_id:'grok_reply_002'});
  assert.equal(second.isError,true);
  assert.equal(second.value.reason,'reply_conflict');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM messages WHERE reply_to=?').get(target).n,1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grok_outbox').get().n,1);
  assert.equal(f.calls.length,1);
});

test('first terminal reply receipt and its retry both report reply_received and correlation',async()=>{
  const f=fixture(undefined,{BRIDGE_MCP_ENABLED:'true'}),target=await prepareReplyTarget(f),input=terminalReply(target);
  const first=await limitedToolCall(f,'bridge_submit_reply',input);
  const retried=await limitedToolCall(f,'bridge_submit_reply',input);
  for(const receipt of [first,retried]){
    assert.equal(receipt.isError,false);
    assert.equal(receipt.value.state,'reply_received');
    assert.equal(receipt.value.reply_to,target);
  }
});

test('concurrent distinct terminal reply IDs commit exactly one response for an event',async()=>{
  const f=fixture(undefined,{BRIDGE_MCP_ENABLED:'true'}),target=await prepareReplyTarget(f);
  // Make both callers observe the empty precheck, exercising the DB uniqueness
  // constraint and transaction instead of relying on request timing.
  const original=f.db.prepare;let release,reads=0;
  const bothRead=new Promise(resolve=>{release=resolve;});
  f.db.prepare=query=>{
    const wrap=statement=>({
      bind:(...args)=>wrap(statement.bind(...args)),
      first:async()=>{
        const result=await statement.first();
        if(query==='SELECT id FROM messages WHERE owner=? AND reply_to=?'){
          reads++;if(reads===2)release();await bothRead;
        }
        return result;
      },
      all:()=>statement.all(),run:()=>statement.run()
    });
    return wrap(original(query));
  };
  const results=await Promise.all([
    limitedToolCall(f,'bridge_submit_reply',terminalReply(target,'grok_race_a','Response A')),
    limitedToolCall(f,'bridge_submit_reply',terminalReply(target,'grok_race_b','Response B'))
  ]);
  assert.equal(reads,2);
  assert.equal(results.filter(r=>!r.isError).length,1);
  assert.equal(results.find(r=>r.isError).value.reason,'reply_conflict');
  const committed=f.sql.prepare('SELECT external_id,body FROM messages WHERE reply_to=?').all(target);
  assert.equal(committed.length,1);
  assert.equal(committed[0].external_id,results.find(r=>!r.isError).value.message_id);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM messages').get().n,2);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grok_outbox').get().n,1);
  assert.equal(f.calls.length,1);
});

test('terminal hop-2 reply emits one persisted event and cannot enqueue another automatic answer',async()=>{
  const f=fixture(async(url,options)=>{
    const body=JSON.parse(options.body);
    return body.type==='verification'?Response.json({challenge:body.challenge}):new Response(null,{status:200});
  },{BRIDGE_MCP_ENABLED:'true'});
  const target=await prepareReplyTarget(f);
  const callback='https://events-fixture.example.com/callback';
  const fixtureSecret='whsec_'+Buffer.alloc(32,19).toString('base64');
  const subscription=await f.bridge.subscribe('alice',{name:'grok.message.received',arguments:{channel:'main'},delivery:{mode:'webhook',url:callback,secret:fixtureSecret}});
  const input=terminalReply(target),reply=await limitedToolCall(f,'bridge_submit_reply',input);
  assert.equal(reply.isError,false);
  const stored=f.sql.prepare('SELECT * FROM messages WHERE external_id=?').get(input.message_id);
  assert.equal(stored.reply_to,target);
  assert.equal(stored.result,null);
  assert.deepEqual(JSON.parse(stored.body),{...input,channel:'main',origin:'grok',hop:2});
  const queued=f.sql.prepare('SELECT * FROM deliveries WHERE message_id=?').all(stored.id);
  assert.equal(queued.length,1);
  assert.equal(queued[0].subscription_id,subscription.id);
  assert.equal(queued[0].state,'pending');
  await f.bridge.pump('alice');
  const emitted=f.calls.filter(c=>c.url===callback&&JSON.parse(c.options.body).type!=='verification');
  assert.equal(emitted.length,1);
  const event=JSON.parse(emitted[0].options.body);
  assert.equal(event.name,'grok.message.received');
  assert.equal(event.eventId,queued[0].id);
  assert.deepEqual(event.data,{...input,channel:'main',origin:'grok',hop:2});
  const denied=await write(f.bridge,'Attempted automatic next answer',input.message_id);
  assert.equal(denied.isError,true);
  assert.equal(JSON.parse(denied.content[0].text).reason,'terminal_reply');
  await f.bridge.grok.pump('alice');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grok_outbox').get().n,1);
  assert.equal(f.calls.filter(c=>c.url===config.BRIDGE_GROK_WEBHOOK_URL).length,1);
  const duplicate=await limitedToolCall(f,'bridge_submit_reply',input);
  assert.equal(duplicate.value.duplicate,true);
  await f.bridge.pump('alice');
  assert.equal(f.calls.filter(c=>c.url===callback&&JSON.parse(c.options.body).type!=='verification').length,1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM deliveries').get().n,1);
  const originalResult=await limitedToolCall(f,'bridge_get_result',{message_id:'input_001'});
  assert.equal(originalResult.isError,false);
  assert.equal(originalResult.value.state,'answered');
  assert.equal(originalResult.value.result,'dot reply');
  assert.deepEqual(originalResult.value.grok_reply,{message_id:input.message_id,text:input.text,received_at:stored.created_at});
  const terminalResult=await limitedToolCall(f,'bridge_get_result',{message_id:input.message_id});
  assert.equal(terminalResult.isError,false);
  assert.equal(terminalResult.value.state,'reply_received');
  assert.equal(terminalResult.value.reply_to,target);
  assert.equal(terminalResult.value.result,null);
});
