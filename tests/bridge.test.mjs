import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createBridge} from '../lib/bridge-service.mjs';
import {EVENT,canonical,signature,verifyIngress,verifyCallback,subscriptionExpiry,subscriptionId,callbackURL,readBody,signedPost} from '../lib/bridge-protocol.mjs';
const secret='whsec_'+Buffer.alloc(32,7).toString('base64'); // public, deterministic test fixture only; never deployed as a credential
function fixture(transport=null,env={}){
 const sql=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(x=>x.endsWith('.sql')))sql.exec(readFileSync('drizzle/'+f,'utf8'));
 const wrap=(query,args=[])=>({bind:(...a)=>wrap(query,a),first:async()=>sql.prepare(query).get(...args)||null,all:async()=>({results:sql.prepare(query).all(...args)}),run:async()=>{const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}};}});
 const db={prepare:q=>wrap(q),batch:async a=>{sql.exec('BEGIN');try{const r=[];for(const s of a)r.push(await s.run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};return {sql,db,bridge:createBridge({DB:db,BRIDGE_OWNER_ID:'alice',...env},transport)};
}
const msg=(id='grok_1',channel='main')=>({message_id:id,channel,text:'untrusted external content',origin:'grok',hop:0});
const params=(channel='main')=>({name:EVENT,arguments:{channel},delivery:{mode:'webhook',url:'https://receiver.example.com/events/callback',secret}});
const rpc=(method,p={},owner='alice')=>new Request('https://bridge.example/mcp',{method:'POST',headers:{'content-type':'application/json',...(owner?{'oai-authenticated-user-id':owner}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:p})});
test('MCP discovery advertises 2026-07-28 and events; protected calls reject missing identity',async()=>{
 const {bridge}=fixture();const d=await (await bridge.handle(rpc('server/discover',{},null))).json();assert.deepEqual(d.result.supportedVersions,['2026-07-28']);assert.ok(d.result.capabilities.events);const l=await(await bridge.handle(rpc('events/list'))).json();assert.equal(l.result.events[0].name,EVENT);const r=await(await bridge.handle(rpc('tools/call',{name:'bridge_status'},null))).json();assert.equal(r.error.data.reason,'unauthorized');
});
test('production subscribes fail closed without callback requests or secret persistence',async()=>{
 const {bridge,sql}=fixture();const r=await(await bridge.handle(rpc('events/subscribe',params()))).json();assert.equal(r.error.code,-32015);assert.equal(r.error.data.reason,'safe_transport_unavailable');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,0);
});
test('Standard Webhooks signatures cover exact bytes, timestamp and ID; stale or modified input rejected',async()=>{
 const t=String(Math.floor(Date.now()/1000)),body=JSON.stringify(msg()),id='grok_1';const sig=await signature(secret,id,t,body),headers=new Headers({'webhook-id':id,'webhook-timestamp':t,'webhook-signature':sig});assert.equal(await verifyIngress(secret,headers,body),id);await assert.rejects(verifyIngress(secret,headers,body+' '));await assert.rejects(verifyIngress(secret,headers,body,Date.now()+600000));assert.equal(sig,'v1,'+await (async()=>{const {createHmac}=await import('node:crypto');return createHmac('sha256',Buffer.alloc(32,7)).update(`${id}.${t}.${body}`).digest('base64');})());
});
test('callback blocks HTTP, loopback, credentials, local names; no unsafe fallback',async()=>{for(const url of ['http://example.com','https://127.0.0.1/x','https://[::1]/','https://localhost/','https://service.internal/','https://u:p@example.com/'])assert.throws(()=>callbackURL(url));await assert.rejects(verifyCallback(null,{id:'sub',callback:'https://example.com',secret}),e=>e.reason==='safe_transport_unavailable');});
test('idempotent subscriptions verify signed challenge, cache verification, rotate keys; owner isolated',async()=>{
 let calls=0;const transport={publicDestinationValidated:true,post:async(url,o)=>{calls++;assert.equal(o.redirect,'manual');const data=JSON.parse(o.body);assert.equal(await verifyIngress(secret,new Headers(o.headers),o.body),o.headers['webhook-id']);return Response.json({challenge:data.challenge});}};
 const {bridge,sql}=fixture(transport),p=params(),a=await bridge.subscribe('alice',p),b=await bridge.subscribe('alice',p);assert.equal(a.id,b.id);assert.equal(calls,1);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,1);assert.notEqual(await subscriptionId('bob',p),a.id);assert.equal(canonical({b:2,a:1}),canonical({a:1,b:2}));
 const u=await(await bridge.handle(rpc('events/unsubscribe',p))).json();assert.deepEqual(u.result,{});assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,0);const again=await(await bridge.handle(rpc('events/unsubscribe',p))).json();assert.deepEqual(again.result,{});
});
test('subscription expiry follows three UTC calendar years and clamps leap day',()=>{
 const cases=[
  ['2026-10-28T02:17:46.052Z','2029-10-28T02:17:46.052Z',1096],
  ['2028-03-01T12:34:56.789Z','2031-03-01T12:34:56.789Z',1095],
  ['2028-02-29T12:34:56.789Z','2031-02-28T12:34:56.789Z',1095],
  ['2097-03-01T12:34:56.789Z','2100-03-01T12:34:56.789Z',1095],
 ];
 for(const [start,expected,days] of cases){const now=Date.parse(start),expires=subscriptionExpiry(now);assert.equal(new Date(expires).toISOString(),expected);assert.equal(expires-now,days*86400000);assert.ok(Number.isSafeInteger(expires));}
});
test('subscriptions grant finite three-year default and null TTL, respect shorter TTL and cap longer TTL',async t=>{
 const now=Date.parse('2026-10-28T02:17:46.052Z'),anniversary=Date.parse('2029-10-28T02:17:46.052Z');t.mock.method(Date,'now',()=>now);
 const transport={publicDestinationValidated:true,post:async(url,o)=>Response.json({challenge:JSON.parse(o.body).challenge})};
 for(const [ttlMs,expected] of [[undefined,anniversary],[null,anniversary],[3600000,now+3600000],[Number.MAX_SAFE_INTEGER,anniversary]]){
  const {bridge,sql}=fixture(transport),p=params();if(ttlMs!==undefined)p.ttlMs=ttlMs;
  const r=await(await bridge.handle(rpc('events/subscribe',p))).json();assert.ok(r.result);assert.equal(Date.parse(r.result.refreshBefore),expected);assert.equal(r.result.cursor,null);
  const row=sql.prepare('SELECT expires_at,typeof(expires_at) AS storage_type,active FROM subscriptions').get();assert.equal(row.expires_at,expected);assert.equal(row.storage_type,'integer');assert.equal(row.active,1);
 }
});
test('subscription renewal keeps its identity and advances the three-year expiry',async t=>{
 let now=Date.parse('2026-10-28T02:17:46.052Z'),challenges=0;t.mock.method(Date,'now',()=>now);
 const transport={publicDestinationValidated:true,post:async(url,o)=>{challenges++;return Response.json({challenge:JSON.parse(o.body).challenge});}};
 const {bridge,sql}=fixture(transport),p=params(),first=await bridge.subscribe('alice',p);now=Date.parse('2027-10-28T02:17:46.052Z');
 const renewed=await bridge.subscribe('alice',p);assert.equal(renewed.id,first.id);assert.equal(renewed.refreshBefore,'2030-10-28T02:17:46.052Z');assert.ok(Date.parse(renewed.refreshBefore)>Date.parse(first.refreshBefore));assert.equal(challenges,2);
 const row=sql.prepare('SELECT count(*) AS n,max(expires_at) AS expires_at FROM subscriptions').get();assert.equal(row.n,1);assert.equal(row.expires_at,Date.parse(renewed.refreshBefore));
});
test('failed renewal verification and invalid TTL leave the existing subscription unchanged',async t=>{
 let now=Date.parse('2026-10-28T02:17:46.052Z'),valid=true,challenges=0;t.mock.method(Date,'now',()=>now);
 const transport={publicDestinationValidated:true,post:async(url,o)=>{challenges++;return Response.json({challenge:valid?JSON.parse(o.body).challenge:'wrong'});}};
 const {bridge,sql}=fixture(transport),p=params();await bridge.subscribe('alice',p);const before=sql.prepare('SELECT * FROM subscriptions').get();now+=300001;valid=false;
 await assert.rejects(bridge.subscribe('alice',p),e=>e.reason==='challenge_failed');assert.deepEqual(sql.prepare('SELECT * FROM subscriptions').get(),before);
 for(const ttlMs of [0,-1,NaN,Infinity,'3600000'])await assert.rejects(bridge.subscribe('alice',{...p,ttlMs}),e=>e.reason==='invalid_request');
 assert.equal(challenges,2);assert.deepEqual(sql.prepare('SELECT * FROM subscriptions').get(),before);
});
test('messages persist, duplicate safely, reject conflicts and loops; replies do not create new events',async()=>{
 const {bridge,sql}=fixture();await bridge.accept('alice',msg());const duplicate=await bridge.accept('alice',msg());assert.equal(duplicate.duplicate,true);await assert.rejects(bridge.accept('alice',{...msg(),text:'changed'}),e=>e.status===409);await assert.rejects(bridge.accept('alice',{...msg('reply'),origin:'dot',hop:1}),e=>e.reason==='loop_blocked');await assert.rejects(bridge.result('bob','grok_1'),e=>e.status===404);
 const r=await(await bridge.handle(rpc('tools/call',{name:'bridge_write_result',arguments:{message_id:'grok_1',text:'authorized reply'}}))).json();assert.ok(!r.result.isError);assert.equal((await bridge.result('alice','grok_1')).state,'answered');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,0);
});
test('channel filters, delivery IDs, bounded retries and stop on 410',async()=>{
 let status=200,seen=[];const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});seen.push({p,headers:o.headers});return new Response('',{status});}};const {bridge,sql}=fixture(transport);await bridge.subscribe('alice',params());await bridge.accept('alice',msg('filtered','other'));assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,0);await bridge.accept('alice',msg());status=503;await bridge.pump('alice');assert.equal(sql.prepare('SELECT state FROM deliveries').get().state,'pending');sql.exec('UPDATE deliveries SET next_at=0');status=410;await bridge.pump('alice');assert.equal(seen[0].p.eventId,seen[1].p.eventId);assert.equal(seen[0].p.eventId,seen[0].headers['webhook-id']);assert.equal(sql.prepare('SELECT state FROM deliveries').get().state,'failed');assert.equal(sql.prepare('SELECT active FROM subscriptions').get().active,0);
});
test('disabled public ingress, console CSRF, body limits and persistent rate limits',async()=>{
 const {bridge}=fixture();let r=await bridge.handle(new Request('https://bridge.example/api/bridge/ingress',{method:'POST'}));assert.equal(r.status,503);r=await bridge.handle(new Request('https://bridge.example/api/bridge/test',{method:'POST',headers:{'oai-authenticated-user-id':'alice','content-type':'application/json'},body:JSON.stringify(msg())}));assert.equal(r.status,403);await assert.rejects(readBody(new Request('https://example.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'x'.repeat(40000)})})),e=>e.status===413);for(let i=0;i<30;i++)await bridge.accept('limited',msg('rate_'+i));await assert.rejects(bridge.accept('limited',msg('rate_31')),e=>e.status===429);
});
test('callback failures use CallbackEndpointError categories and never activate subscriptions',async()=>{
 const cases=[
  {reason:'challenge_failed',response:()=>Response.json({challenge:'wrong'})},
  {reason:'challenge_failed',response:()=>new Response('not json')},
  {reason:'challenge_failed',response:()=>new Response('x'.repeat(40000))},
  {reason:'challenge_failed',response:()=>new Response(null,{status:403})},
  {reason:'redirect_blocked',response:()=>new Response(null,{status:302,headers:{location:'https://other.example/path'}})},
  {reason:'timeout',response:()=>{throw new DOMException('deadline','TimeoutError');}},
  {reason:'connection_failed',response:()=>{throw new TypeError('network detail must not leak');}}
 ];
 for(const c of cases){let n=0;const {bridge,sql}=fixture({publicDestinationValidated:true,post:async()=>{n++;return c.response();}});const r=await(await bridge.handle(rpc('events/subscribe',params()))).json();assert.equal(r.error.code,-32015,c.reason);assert.equal(r.error.data.reason,c.reason);assert.equal(n,1);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,0);assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(r).includes('network detail'));}
});
test('verification cache has a fixed bounded age across refresh and restart',async()=>{
 let n=0;const transport={publicDestinationValidated:true,post:async(url,o)=>{n++;return Response.json({challenge:JSON.parse(o.body).challenge});}};
 const {bridge,sql,db}=fixture(transport);await bridge.subscribe('alice',params());const previous=Date.now()-10000;sql.prepare('UPDATE subscriptions SET verified_at=?').run(previous);
 const restarted=createBridge({DB:db},transport);await restarted.subscribe('alice',params());assert.equal(n,1);assert.equal(sql.prepare('SELECT verified_at FROM subscriptions').get().verified_at,previous);
 sql.prepare('UPDATE subscriptions SET verified_at=?').run(Date.now()-300001);await restarted.subscribe('alice',params());assert.equal(n,2);
});
test('secret rotation keeps dual signatures across repeated refresh and expires the old key',async()=>{
 const nextSecret='whsec_'+Buffer.alloc(32,8).toString('base64');const transport={publicDestinationValidated:true,post:async(url,o)=>Response.json({challenge:JSON.parse(o.body).challenge})};const {bridge,sql}=fixture(transport);const p=params();await bridge.subscribe('alice',p);p.delivery.secret=nextSecret;await bridge.subscribe('alice',p);await bridge.subscribe('alice',p);
 let row=sql.prepare('SELECT * FROM subscriptions').get();assert.equal(row.old_secret,secret);assert.equal(row.secret,nextSecret);
 const captured={publicDestinationValidated:true,post:async(url,o)=>{const ts=o.headers['webhook-timestamp'];assert.equal(o.headers['webhook-signature'],[await signature(nextSecret,'e',ts,o.body),await signature(secret,'e',ts,o.body)].join(' '));return new Response(null,{status:200});}};await signedPost(captured,row,{eventId:'e'},'e');
 sql.prepare('UPDATE subscriptions SET rotation_until=?').run(Date.now()-1);await bridge.subscribe('alice',p);row=sql.prepare('SELECT * FROM subscriptions').get();assert.equal(row.old_secret,null);
});
test('expired subscriptions do not enqueue; unsubscribe stops existing outbox; bounded attempts survive crash recovery',async()=>{
 let deliveries=0;const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});deliveries++;return new Response(null,{status:503});}};
 const {bridge,sql,db}=fixture(transport);await bridge.subscribe('alice',params());sql.exec('UPDATE subscriptions SET expires_at=0');await bridge.accept('alice',msg('expired'));assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,0);
 await bridge.subscribe('alice',params());await bridge.accept('alice',msg('queued'));await bridge.handle(rpc('events/unsubscribe',params()));await bridge.pump('alice');assert.equal(deliveries,0);assert.equal(sql.prepare('SELECT state FROM deliveries').get().state,'stopped');
 await bridge.subscribe('alice',params());await bridge.accept('alice',msg('crashed'));sql.exec("UPDATE deliveries SET attempts=4,lease_until=0 WHERE state='pending'");await createBridge({DB:db},transport).pump('alice');assert.equal(deliveries,0);assert.equal(sql.prepare("SELECT reason FROM deliveries WHERE state='failed'").get().reason,'attempts_exhausted');
});
test('repeated transient deliveries stop after four attempts, 413 stops immediately, redirects never succeed',async()=>{
 for(const code of [503,413,302]){let n=0;const transport={publicDestinationValidated:true,post:async(url,o)=>{if(JSON.parse(o.body).type==='verification')return Response.json({challenge:JSON.parse(o.body).challenge});n++;return new Response(null,{status:code});}};const {bridge,sql}=fixture(transport);await bridge.subscribe('alice',params());await bridge.accept('alice',msg());for(let i=0;i<6;i++){sql.exec('UPDATE deliveries SET next_at=0');await bridge.pump('alice');}assert.equal(n,code===503?4:1);assert.equal(sql.prepare('SELECT state FROM deliveries').get().state,'failed');}
});
test('concurrent event pumps recheck backoff and attempt limits when claiming stale snapshots',async t=>{
 let now=Date.parse('2026-10-28T05:00:00Z'),sends=0;t.mock.method(Date,'now',()=>now);
 const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});sends++;return new Response(null,{status:503});}};
 const {bridge,sql,db}=fixture(transport);await bridge.subscribe('alice',params());await bridge.accept('alice',msg('concurrent_event'));
 const prepare=db.prepare,releases=[];let captured,holdReads=true;const allCaptured=new Promise(resolve=>{captured=resolve;});
 db.prepare=query=>{const statement=prepare(query);return {...statement,bind(...args){const bound=statement.bind(...args);if(!query.startsWith('SELECT d.*'))return bound;return {...bound,all:async()=>{const result=await bound.all();if(!holdReads)return result;return new Promise(resolve=>{releases.push(()=>resolve(result));if(releases.length===5)captured();});}};}};};
 const pumps=Array.from({length:5},()=>bridge.pump('alice'));await allCaptured;holdReads=false;
 for(let i=0;i<pumps.length;i++){releases[i]();await pumps[i];}
 let row=sql.prepare('SELECT state,attempts,next_at FROM deliveries').get();assert.equal(sends,1);assert.equal(row.attempts,1);assert.equal(row.state,'pending');assert.equal(row.next_at,now+2000);
 for(let i=0;i<3;i++){now=row.next_at+1;await bridge.pump('alice');row=sql.prepare('SELECT state,attempts,next_at FROM deliveries').get();}
 await bridge.pump('alice');assert.equal(sends,4);assert.equal(row.attempts,4);assert.equal(row.state,'failed');
});
test('an in-flight event response cannot revive an unsubscribed delivery after resubscribe',async()=>{
 let sends=0,signalStarted,finishResponse;const started=new Promise(resolve=>{signalStarted=resolve;}),response=new Promise(resolve=>{finishResponse=resolve;});
 const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});sends++;signalStarted();return response;}};
 const {bridge,sql}=fixture(transport),p=params();await bridge.subscribe('alice',p);await bridge.accept('alice',msg('cancelled_event'));
 const pumping=bridge.pump('alice');await started;const cancelled=await(await bridge.handle(rpc('events/unsubscribe',p))).json();assert.deepEqual(cancelled.result,{});
 assert.equal(sql.prepare('SELECT state FROM deliveries').get().state,'stopped');finishResponse(new Response(null,{status:503}));await pumping;
 let row=sql.prepare('SELECT state,reason,attempts FROM deliveries').get();assert.equal(row.state,'stopped');assert.equal(row.reason,'subscription_unsubscribed');assert.equal(row.attempts,1);
 await bridge.subscribe('alice',p);sql.exec('UPDATE deliveries SET next_at=0');await bridge.pump('alice');row=sql.prepare('SELECT state,reason FROM deliveries').get();assert.equal(sends,1);assert.equal(row.state,'stopped');assert.equal(row.reason,'subscription_unsubscribed');
});
test('HTTP 410 stops later events already selected in the same pump batch',async()=>{
 const activeAtSend=[];let sql;
 const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});activeAtSend.push(sql.prepare('SELECT active FROM subscriptions').get().active);return new Response(null,{status:410});}};
 const f=fixture(transport);sql=f.sql;await f.bridge.subscribe('alice',params());await f.bridge.accept('alice',msg('gone_event_1'));await f.bridge.accept('alice',msg('gone_event_2'));
 await f.bridge.pump('alice');assert.deepEqual(activeAtSend,[1]);assert.equal(sql.prepare('SELECT active FROM subscriptions').get().active,0);assert.equal(sql.prepare("SELECT count(*) AS n FROM deliveries WHERE state='failed' AND status=410").get().n,1);assert.equal(sql.prepare("SELECT count(*) AS n FROM deliveries WHERE state='stopped' AND reason='subscription_inactive'").get().n,1);
});
test('HTTP 410 completion rolls back subscription and pending changes if its transaction fails',async()=>{
 let sends=0;const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});sends++;return new Response(null,{status:410});}};
 const {bridge,sql,db}=fixture(transport);await bridge.subscribe('alice',params());await bridge.accept('alice',msg('rollback_410_1'));await bridge.accept('alice',msg('rollback_410_2'));
 const batch=db.batch;let beforeFailure;
 db.batch=statements=>batch(statements.length===3?[...statements.slice(0,2),{run:async()=>{beforeFailure={active:sql.prepare('SELECT active FROM subscriptions').get().active,stopped:sql.prepare("SELECT count(*) AS n FROM deliveries WHERE state='stopped'").get().n};throw new Error('injected_410_completion_failure');}}]:statements);
 await assert.rejects(bridge.pump('alice'),/injected_410_completion_failure/);assert.deepEqual(beforeFailure,{active:0,stopped:1});assert.equal(sends,1);
 assert.equal(sql.prepare('SELECT active FROM subscriptions').get().active,1);assert.equal(sql.prepare("SELECT count(*) AS n FROM deliveries WHERE state='pending'").get().n,2);assert.equal(sql.prepare('SELECT count(*) AS n FROM deliveries WHERE status=410').get().n,0);
});
test('a delayed HTTP 410 from an old claim cannot disable a newer successful claim',async t=>{
 let now=Date.parse('2026-10-28T05:00:00Z'),sends=0;t.mock.method(Date,'now',()=>now);
 const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});sends++;return new Response(null,{status:sends===1?410:200});}};
 const {bridge,sql,db}=fixture(transport);await bridge.subscribe('alice',params());await bridge.accept('alice',msg('old_410_claim'));
 const batch=db.batch;let signalWaiting,resumeBatch,hold=true;const waiting=new Promise(resolve=>{signalWaiting=resolve;}),resume=new Promise(resolve=>{resumeBatch=resolve;});
 db.batch=async statements=>{if(hold&&statements.length===3){hold=false;signalWaiting();await resume;}return batch(statements);};
 const firstPump=bridge.pump('alice');await waiting;now+=20001;await bridge.pump('alice');resumeBatch();await firstPump;
 const row=sql.prepare('SELECT state,status,attempts FROM deliveries').get();assert.equal(sends,2);assert.equal(row.state,'delivered');assert.equal(row.status,200);assert.equal(row.attempts,2);assert.equal(sql.prepare('SELECT active FROM subscriptions').get().active,1);
});
test('a delayed HTTP 410 cannot disable a renewed or replaced subscription with the same ID',async t=>{
 let now=Date.parse('2026-10-28T05:00:00Z');t.mock.method(Date,'now',()=>now);
 for(const mode of ['renew','replace']){
  let sends=0;const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});sends++;return new Response(null,{status:sends===1?410:200});}};
  const {bridge,sql,db}=fixture(transport),p=params(),original=await bridge.subscribe('alice',p);await bridge.accept('alice',msg('old_410_'+mode));
  const batch=db.batch;let signalWaiting,resumeBatch,hold=true;const waiting=new Promise(resolve=>{signalWaiting=resolve;}),resume=new Promise(resolve=>{resumeBatch=resolve;});
  db.batch=async statements=>{if(hold&&statements.length===3){hold=false;signalWaiting();await resume;}return batch(statements);};
  const firstPump=bridge.pump('alice');await waiting;if(mode==='replace')await bridge.handle(rpc('events/unsubscribe',p));now+=1000;
  const renewed=await bridge.subscribe('alice',p);assert.equal(renewed.id,original.id);await bridge.accept('alice',msg('fresh_410_'+mode));resumeBatch();await firstPump;
  assert.equal(sql.prepare('SELECT active FROM subscriptions').get().active,1);assert.equal(sql.prepare("SELECT count(*) AS n FROM deliveries WHERE state='pending'").get().n,1);
  await bridge.pump('alice');assert.equal(sends,2);assert.equal(sql.prepare('SELECT active FROM subscriptions').get().active,1);assert.equal(sql.prepare("SELECT count(*) AS n FROM deliveries WHERE state='delivered' AND status=200").get().n,1);
 }
});
test('a delayed HTTP 410 cannot disable same-millisecond fixture key rotations',async t=>{
 const now=Date.parse('2026-10-28T05:00:00Z');t.mock.method(Date,'now',()=>now);
 const fixtureKeys=[8,9,10].map(byte=>'whsec_'+Buffer.alloc(32,byte).toString('base64'));let currentFixtureKey=fixtureKeys[0],sends=0;
 const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});assert.ok(o.headers['webhook-signature'].split(' ').includes(await signature(currentFixtureKey,o.headers['webhook-id'],o.headers['webhook-timestamp'],o.body)));sends++;return new Response(null,{status:sends===1?410:200});}};
 const {bridge,sql,db}=fixture(transport),p=params(),rotated=key=>({...p,delivery:{...p.delivery,secret:key}});await bridge.subscribe('alice',p);const original=await bridge.subscribe('alice',rotated(currentFixtureKey));await bridge.accept('alice',msg('same_millisecond_old'));
 const before=sql.prepare('SELECT expires_at,verified_at,rotation_until FROM subscriptions').get();
 const batch=db.batch;let signalWaiting,resumeBatch,hold=true;const waiting=new Promise(resolve=>{signalWaiting=resolve;}),resume=new Promise(resolve=>{resumeBatch=resolve;});
 db.batch=async statements=>{if(hold&&statements.length===3){hold=false;signalWaiting();await resume;}return batch(statements);};
 const firstPump=bridge.pump('alice');await waiting;
 for(const key of fixtureKeys.slice(1)){currentFixtureKey=key;assert.equal((await bridge.subscribe('alice',rotated(key))).id,original.id);}
 assert.deepEqual(sql.prepare('SELECT expires_at,verified_at,rotation_until FROM subscriptions').get(),before);await bridge.accept('alice',msg('same_millisecond_fresh'));resumeBatch();await firstPump;
 assert.equal(sql.prepare('SELECT active FROM subscriptions').get().active,1);assert.equal(sql.prepare("SELECT count(*) AS n FROM deliveries WHERE state='pending'").get().n,1);
 await bridge.pump('alice');assert.equal(sends,2);assert.equal(sql.prepare('SELECT active FROM subscriptions').get().active,1);assert.equal(sql.prepare("SELECT count(*) AS n FROM deliveries WHERE state='delivered' AND status=200").get().n,1);
});
test('an expired event claim cannot overwrite a newer successful claim',async t=>{
 let now=Date.parse('2026-10-28T05:00:00Z'),sends=0;t.mock.method(Date,'now',()=>now);
 const transport={publicDestinationValidated:true,post:async(url,o)=>{const p=JSON.parse(o.body);if(p.type==='verification')return Response.json({challenge:p.challenge});sends++;return new Response(null,{status:sends===1?503:200});}};
 const {bridge,sql,db}=fixture(transport);await bridge.subscribe('alice',params());await bridge.accept('alice',msg('superseded_event'));
 const prepare=db.prepare;let signalWaiting,finishOldWrite,holdFirstWrite=true;const waiting=new Promise(resolve=>{signalWaiting=resolve;}),resume=new Promise(resolve=>{finishOldWrite=resolve;});
 db.prepare=query=>{const statement=prepare(query);return {...statement,bind(...args){const bound=statement.bind(...args);if(!query.startsWith('UPDATE deliveries SET state=?,status=?'))return bound;return {...bound,run:async()=>{if(holdFirstWrite){holdFirstWrite=false;signalWaiting();await resume;}return bound.run();}};}};};
 const firstPump=bridge.pump('alice');await waiting;now+=20001;await bridge.pump('alice');finishOldWrite();await firstPump;
 const row=sql.prepare('SELECT state,status,attempts,lease_until FROM deliveries').get();assert.equal(sends,2);assert.equal(row.state,'delivered');assert.equal(row.status,200);assert.equal(row.attempts,2);assert.equal(row.lease_until,0);
});
test('invalid RPC primitives are classified as InvalidRequest',async()=>{
 const {bridge}=fixture();for(const value of [null,[],42,'text']){const r=await(await bridge.handle(new Request('https://bridge.example/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}))).json();assert.equal(r.error.code,-32600);}
});
test('protocol logs distinguish a tool failure from a successful status query',async()=>{
 const {bridge,sql}=fixture();
 const failed=await(await bridge.handle(rpc('tools/call',{name:'bridge_get_result',arguments:{message_id:'missing_event'}}))).json();assert.equal(failed.result.isError,true);assert.equal(sql.prepare('SELECT outcome FROM protocol_log ORDER BY rowid DESC LIMIT 1').get().outcome,'not_found');
 const succeeded=await(await bridge.handle(rpc('tools/call',{name:'bridge_status'}))).json();assert.notEqual(succeeded.result.isError,true);assert.equal(sql.prepare('SELECT outcome FROM protocol_log ORDER BY rowid DESC LIMIT 1').get().outcome,'ok');
});
test('browser transport probes require identity and same-origin, never become an unauthenticated proxy',async()=>{
 const {bridge}=fixture();const req=(owner,origin)=>new Request('https://bridge.example/api/bridge/probe',{method:'POST',headers:{'content-type':'application/json',...(owner?{'oai-authenticated-user-id':owner}:{}),...(origin?{origin}:{})},body:'{}'});
 assert.equal((await bridge.handle(req(null,'https://bridge.example'))).status,401);assert.equal((await bridge.handle(req('alice','https://foreign.example'))).status,403);const r=await bridge.handle(req('alice','https://bridge.example'));assert.equal(r.status,200);const p=await r.json();assert.equal(p.reason,'safe_transport_unavailable');assert.deepEqual(p.probes,[]);
});

test('public-site admin API rejects anonymous and non-owner callers even with the MCP key',async()=>{
 const {bridge,sql}=fixture(null,{BRIDGE_MCP_AUTHORIZATION:'Bearer fixture_mcp_token_12345678901234567890'});
 for(const owner of [null,'bob'])for(const [method,path] of [['GET','status'],['GET','messages'],['POST','test'],['POST','probe'],['POST','pump']]){
  const request=new Request('https://bridge.example/api/bridge/'+path,{method,headers:{'content-type':'application/json',origin:'https://bridge.example','x-bridge-mcp-authorization':'Bearer fixture_mcp_token_12345678901234567890',...(owner?{'oai-authenticated-user-id':owner}:{})},...(method==='POST'?{body:JSON.stringify(msg())}:{})});
  const r=await bridge.handle(request);assert.equal(r.status,owner?403:401,path);
 }
 for(const table of ['messages','deliveries','subscriptions','rate_buckets','protocol_log'])assert.equal(sql.prepare('SELECT count(*) AS n FROM '+table).get().n,0,table);
 const ownerStatus=await bridge.handle(new Request('https://bridge.example/api/bridge/status',{headers:{'oai-authenticated-user-id':'alice'}}));assert.equal(ownerStatus.status,200);
 const unconfigured=fixture(null,{BRIDGE_OWNER_ID:undefined}).bridge;
 assert.equal((await unconfigured.handle(new Request('https://bridge.example/api/bridge/status',{headers:{'oai-authenticated-user-id':'alice'}}))).status,403);
});

test('admin MCP retains public schemas but protects data, writes, subscriptions and logging with exact owner',async()=>{
 const {bridge,sql}=fixture();
 for(const owner of [null,'bob']){
  for(const method of ['server/discover','tools/list','events/list'])assert.ok((await(await bridge.handle(rpc(method,{},owner))).json()).result);
  for(const [method,p] of [['tools/call',{name:'bridge_status'}],['tools/call',{name:'bridge_write_result',arguments:{message_id:'not-present',text:'forbidden'}}],['events/subscribe',params()],['events/unsubscribe',params()]]){
   const request=rpc(method,p,owner);request.headers.set('x-bridge-mcp-authorization','Bearer fixture_mcp_token_12345678901234567890');
   const r=await(await bridge.handle(request)).json();assert.equal(r.error.data.reason,'unauthorized',method);
  }
 }
 for(const table of ['messages','subscriptions','protocol_log','rate_buckets'])assert.equal(sql.prepare('SELECT count(*) AS n FROM '+table).get().n,0,table);
 const crossOrigin=rpc('tools/call',{name:'bridge_status'});crossOrigin.headers.set('origin','https://foreign.example');assert.equal((await bridge.handle(crossOrigin)).status,403);
 assert.ok((await(await bridge.handle(rpc('tools/call',{name:'bridge_status'}))).json()).result);
 const missingOwner=fixture(null,{BRIDGE_OWNER_ID:undefined}).bridge;
 assert.equal((await(await missingOwner.handle(rpc('tools/call',{name:'bridge_status'}))).json()).error.data.reason,'unauthorized');
});

test('admin pages gate before framework rendering; keys cannot create owner identity',async()=>{
 for(const pathname of ['/','/?_rsc=fixture','/admin','/admin/settings']){
  const {bridge}=fixture();
  for(const owner of [null,'bob','alice']){
   const response=await bridge.handle(new Request('https://bridge.example'+pathname,{headers:{'x-bridge-mcp-authorization':'Bearer fixture_mcp_token_12345678901234567890',...(owner?{'oai-authenticated-user-id':owner}:{})}}));
   if(owner==='alice'){assert.equal(response,null);continue;}
   assert.equal(response.status,owner?403:302);assert.match(response.headers.get('cache-control'),/no-store/);
   if(!owner)assert.equal(response.headers.get('location'),'/signin-with-chatgpt?return_to='+encodeURIComponent(pathname));
  }
 }
 const {bridge}=fixture(null,{BRIDGE_OWNER_ID:undefined});
 assert.equal((await bridge.handle(new Request('https://bridge.example/',{headers:{'oai-authenticated-user-id':'alice'}}))).status,403);
});
