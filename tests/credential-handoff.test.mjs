import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {credentialHandoff} from '../lib/credential-handoff.mjs';
import {GROK_CONNECTION_PROMPT} from '../lib/grok-connection-prompt.mjs';

// Public deterministic fixtures only. No test retrieves or sends a credential.
const secrets={
  BRIDGE_SITE_SERVICE_TOKEN:'fixture_handoff_site_only_0123456789',
  BRIDGE_MCP_AUTHORIZATION:'Bearer fixture_handoff_mcp_only_9876543210',
  BRIDGE_GROK_BEARER_KEY:'fixture_unrelated_grok_secret',
  BRIDGE_INGRESS_SECRET:'fixture_unrelated_ingress_secret'
};
const origin='https://bridge.example';
const environment=overrides=>({BRIDGE_OWNER_ID:'owner-alice',BRIDGE_HANDOFF_EXPIRES_AT:String(Date.now()+60000),...secrets,...overrides});
function request(path='/api/bridge/credential-copy',{method='POST',owner='owner-alice',requestOrigin=origin,body={credential:'mcp'},headers={}}={}) {
  return new Request(origin+path,{
    method,
    headers:{'content-type':'application/json',...(owner===null?{}:{'oai-authenticated-user-id':owner}),...(requestOrigin===null?{}:{origin:requestOrigin}),...headers},
    ...(['GET','HEAD'].includes(method)?{}:{body:JSON.stringify(body)})
  });
}
function assertNoSecret(text) {
  for(const value of Object.values(secrets))assert.ok(!text.includes(value),'A fixture credential appeared in an unauthorized output');
}
function assertPrivateHeaders(response) {
  assert.equal(response.headers.get('cache-control'),'private, no-store, max-age=0');
  assert.equal(response.headers.get('pragma'),'no-cache');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('x-frame-options'),'DENY');
  assert.equal(response.headers.get('permissions-policy'),'clipboard-write=(self)');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
}

test('credential handoff requires exact owner identity; service or MCP bearer tokens do not authorize it',async()=>{
  const serviceHeaders={'oai-sites-authorization':'Bearer '+secrets.BRIDGE_SITE_SERVICE_TOKEN,'x-bridge-mcp-authorization':secrets.BRIDGE_MCP_AUTHORIZATION};
  for(const path of ['/connect/grok','/api/bridge/credential-copy']){
    for(const owner of [null,'other-owner','owner-alice-extra']){
      const response=await credentialHandoff(request(path,{method:path==='/connect/grok'?'GET':'POST',owner,headers:serviceHeaders}),environment());
      assert.equal(response.status,403);
      assertPrivateHeaders(response);
      const text=await response.text();assertNoSecret(text);
      assert.equal(JSON.parse(text).error,'owner_login_required');
    }
  }
  const absentOwner=await credentialHandoff(request(),environment({BRIDGE_OWNER_ID:undefined}));
  assert.equal(absentOwner.status,403);
  assertNoSecret(await absentOwner.text());
});

test('credential copy permits only same-origin POST; GET and other methods reveal no secret',async()=>{
  for(const requestOrigin of [null,'null','https://other.example','https://bridge.example.evil','http://bridge.example']){
    const response=await credentialHandoff(request(undefined,{requestOrigin}),environment());
    assert.equal(response.status,403);
    assert.equal((await response.json()).error,'origin_mismatch');
    assertPrivateHeaders(response);
  }
  for(const method of ['GET','HEAD','OPTIONS','PUT','DELETE']){
    const response=await credentialHandoff(request('/api/bridge/credential-copy?credential=site',{method}),environment());
    assert.equal(response.status,405);
    const text=await response.text();assertNoSecret(text);
    assert.equal(JSON.parse(text).error,'post_required');
    assertPrivateHeaders(response);
  }
  const pagePost=await credentialHandoff(request('/connect/grok'),environment());
  assert.equal(pagePost.status,405);
  assertNoSecret(await pagePost.text());
});

test('expired or invalid handoff windows are rejected server-side before any secret is read',async()=>{
  for(const expiry of [String(Date.now()-1),'0','-1','not-a-time','Infinity',undefined,String(Number.MAX_SAFE_INTEGER+1)]){
    const env=environment({BRIDGE_HANDOFF_EXPIRES_AT:expiry});
    for(const name of Object.keys(secrets))Object.defineProperty(env,name,{get(){throw new Error('Expired handoff must not read a secret');}});
    for(const path of ['/connect/grok','/api/bridge/credential-copy']){
      const response=await credentialHandoff(request(path,{method:path==='/connect/grok'?'GET':'POST'}),env);
      if(path==='/connect/grok'){assert.equal(response.status,200);const html=await response.text();assertNoSecret(html);assert.match(html,/data-credential="mcp" disabled/);assert.ok(html.includes('本次复制窗口已过期'));assert.ok(html.includes('网页窗口过期不影响后台复制'));assert.ok(!html.includes('请请求重新开启'));assert.ok(html.includes('id="copy-prompt"'));}
      else{assert.equal(response.status,410);assert.equal((await response.json()).error,'credential_handoff_expired');}
      assertPrivateHeaders(response);
    }
  }
});

test('a page opened while valid cannot copy after its server-side expiry',async()=>{
  const env=environment(),page=await credentialHandoff(request('/connect/grok',{method:'GET'}),env);
  assert.equal(page.status,200);
  env.BRIDGE_HANDOFF_EXPIRES_AT=String(Date.now()-1);
  const copied=await credentialHandoff(request(),env);
  assert.equal(copied.status,410);
  assertNoSecret(await copied.text());
});

test('handoff HTML and its inline client bundle never embed runtime secrets and use restrictive CSP',async()=>{
  const env=environment({BRIDGE_HANDOFF_EXPIRES_AT:String(Date.parse('2000-01-01T00:00:00.000Z'))});
  // Rendering the page needs no secret values, including for masked placeholders.
  for(const name of Object.keys(secrets))Object.defineProperty(env,name,{get(){throw new Error('Rendering must not read secrets');}});
  const response=await credentialHandoff(request('/connect/grok',{method:'GET'}),env);
  assert.equal(response.status,200);assertPrivateHeaders(response);
  const html=await response.text();assertNoSecret(html);assert.ok(html.includes('2000/01/01 08:00:00'));assert.ok(html.includes('北京时间 UTC+8'));assert.ok(html.includes('不会使已配置的连接凭据失效'));
  assert.match(response.headers.get('content-type'),/^text\/html/);
  assert.ok(!/<script\b[^>]*\bsrc=/i.test(html),'No externally loaded script may handle credentials');
  const nonce=response.headers.get('content-security-policy').match(/script-src 'nonce-([a-f0-9]+)'/)[1];
  assert.match(html,new RegExp('<script nonce="'+nonce+'">'));
  assert.match(html,new RegExp('<style nonce="'+nonce+'">'));
  const csp=response.headers.get('content-security-policy');
  for(const directive of ["default-src 'none'","connect-src 'self'","base-uri 'none'","frame-ancestors 'none'","form-action 'none'"])assert.ok(csp.includes(directive));
  assert.ok(!csp.includes('unsafe-inline'));assert.ok(!csp.includes('unsafe-eval'));
  const another=await credentialHandoff(request('/connect/grok',{method:'GET'}),env);
  assert.notEqual(another.headers.get('content-security-policy'),csp,'Each page response needs a fresh script nonce');
});

test('unknown credential names, malformed shapes and extra properties cannot select a secret',async()=>{
  for(const body of [{credential:'site'},{credential:'grok'},{credential:'BRIDGE_SITE_SERVICE_TOKEN'},{credential:'__proto__'},{credential:'site,mcp'},{credential:[]},{},null,[],{credential:'site',extra:true},{credential:'mcp',owner:'owner-alice'}]){
    const response=await credentialHandoff(request(undefined,{body}),environment());
    assert.ok([400,404].includes(response.status));
    const text=await response.text();assertNoSecret(text);
    assert.deepEqual(Object.keys(JSON.parse(text)),['error']);
    assertPrivateHeaders(response);
  }
  for(const value of [undefined,'','invalid\r\nheader',secrets.BRIDGE_MCP_AUTHORIZATION.slice(7),'Bearer '+secrets.BRIDGE_MCP_AUTHORIZATION,'bearer '+'a'.repeat(32),'Bearer '+'a'.repeat(31),'Bearer '+'a'.repeat(257),' '+secrets.BRIDGE_MCP_AUTHORIZATION,secrets.BRIDGE_MCP_AUTHORIZATION+' ',[secrets.BRIDGE_MCP_AUTHORIZATION],123]){
    const response=await credentialHandoff(request(),environment({BRIDGE_MCP_AUTHORIZATION:value}));
    assert.equal(response.status,404);assert.equal((await response.json()).error,'credential_unavailable');
  }
});

test('authorized owner POST returns the complete authorization unchanged without a second Bearer prefix',async()=>{
  for(const [credential,name] of [['mcp','BRIDGE_MCP_AUTHORIZATION']]){
    const env=environment();
    // Selecting one key must not read any other stored secret.
    for(const other of Object.keys(secrets).filter(key=>key!==name))Object.defineProperty(env,other,{get(){throw new Error('Unselected secret was read');}});
    const response=await credentialHandoff(request(undefined,{body:{credential}}),env);
    assert.equal(response.status,200);assertPrivateHeaders(response);
    assert.deepEqual(await response.json(),{value:secrets[name]});
  }
});

test('credential handoff never reads the retired token and does not fall back when the new value is missing',async()=>{
  for(const configured of [true,false]){
    const env=environment({BRIDGE_MCP_AUTHORIZATION:configured?secrets.BRIDGE_MCP_AUTHORIZATION:undefined});
    Object.defineProperty(env,'BRIDGE_MCP_TOKEN',{get(){throw new Error('Retired token must never be read');}});
    const response=await credentialHandoff(request(),env);
    assert.equal(response.status,configured?200:404);
    if(configured)assert.deepEqual(await response.json(),{value:secrets.BRIDGE_MCP_AUTHORIZATION});
    else assert.equal((await response.json()).error,'credential_unavailable');
    const page=await credentialHandoff(request('/connect/grok',{method:'GET'}),env);
    assert.equal(page.status,200);assertNoSecret(await page.text());
  }
});

test('single-key handoff retires the Site token selector and page button without reading its secret',async()=>{
 const env=environment();Object.defineProperty(env,'BRIDGE_SITE_SERVICE_TOKEN',{get(){throw new Error('Site service credential must never be read');}});
 const retired=await credentialHandoff(request(undefined,{body:{credential:'site'}}),env);assert.equal(retired.status,404);assertNoSecret(await retired.text());
 const page=await credentialHandoff(request('/connect/grok',{method:'GET'}),env);const html=await page.text();
 assert.equal((html.match(/data-credential="mcp"/g)||[]).length,1);assert.ok(!html.includes('data-credential="site"'));
 assert.ok(html.includes('https://bridge.example.com/mcp/grok'));assert.ok(!html.includes('grok-dot-events-bridge-20261028'));
 assert.ok(GROK_CONNECTION_PROMPT.includes('一个遮罩字段'));assert.ok(GROK_CONNECTION_PROMPT.includes('不需要 OAI-Sites-Authorization'));assert.ok(GROK_CONNECTION_PROMPT.includes('https://chatgpt.com/space/sites/YOUR_SITE_PROJECT_ID/settings'));assert.ok(GROK_CONNECTION_PROMPT.includes('旧 BRIDGE_MCP_TOKEN 和此前复制的旧值已停用'));assert.ok(GROK_CONNECTION_PROMPT.includes('复制窗口过期不影响后台复制'));assert.ok(html.includes('href="https://chatgpt.com/space/sites/YOUR_SITE_PROJECT_ID/settings"'));assert.ok(html.includes('<code>BRIDGE_MCP_AUTHORIZATION</code>'));assertNoSecret(html);
});

test('client waits for explicit click, copies only the selection and never displays or persists its value',async()=>{
  const page=await credentialHandoff(request('/connect/grok',{method:'GET'}),environment());
  const html=await page.text(),script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const handlers=[],status={textContent:''},calls=[],copies=[],values=[];
  let copyPrompt;const promptButton={disabled:false,addEventListener(event,handler){copyPrompt=handler;}};
  const buttons=['mcp'].map(credential=>({dataset:{credential},disabled:false,addEventListener(event,handler){assert.equal(event,'click');handlers.push(handler);}}));
  const forbidden=()=>{throw new Error('No local persistence or logging is permitted');};
  const context={
    AbortController, setTimeout, clearTimeout,
    document:{querySelectorAll:selector=>{assert.equal(selector,'button[data-credential]');return buttons;},getElementById:id=>id==='copy-prompt'?promptButton:id==='connection-prompt'?{textContent:GROK_CONNECTION_PROMPT}:status},
    navigator:{clipboard:{writeText:async value=>{copies.push(value);}}},
    fetch:async(path,options)=>{
      calls.push({path,options});
      const selected=JSON.parse(options.body).credential;
      const data={value:selected==='site'?'Bearer '+secrets.BRIDGE_SITE_SERVICE_TOKEN:secrets.BRIDGE_MCP_AUTHORIZATION};
      values.push(data);return {ok:true,json:async()=>data};
    },
    console:{log:forbidden,error:forbidden,warn:forbidden},
    localStorage:{setItem:forbidden},sessionStorage:{setItem:forbidden},indexedDB:{open:forbidden}
  };
  vm.runInNewContext(script,context);
  assert.equal(calls.length,0);assert.equal(copies.length,0);
  for(let i=0;i<handlers.length;i++){
    await handlers[i]();
    assert.equal(calls[i].path,'/api/bridge/credential-copy');
    assert.equal(calls[i].options.method,'POST');
    assert.equal(calls[i].options.credentials,'same-origin');
    assert.equal(calls[i].options.cache,'no-store');
    assert.deepEqual(JSON.parse(calls[i].options.body),{credential:'mcp'});
    assert.equal(copies[i],secrets.BRIDGE_MCP_AUTHORIZATION);
    assert.equal(values[i].value,'');
    assertNoSecret(status.textContent);
    assert.equal(buttons[i].disabled,false);
  }
  assert.match(html,/id="copy-prompt"/);
  assert.ok(html.includes('grok-roundtrip-example-001'));
  assert.ok(html.includes('grok-reply-example-001'));
  const fetches=calls.length;await copyPrompt();
  assert.equal(calls.length,fetches,'Prompt copying never retrieves a credential');
  assert.equal(copies.at(-1),GROK_CONNECTION_PROMPT);assertNoSecret(copies.at(-1));
  assert.equal(promptButton.disabled,false);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flushClient=()=>new Promise(resolve=>setImmediate(resolve));

async function copyClient(options={}) {
  const page=await credentialHandoff(options.verify?new Request('https://bridge.example.com/connect/grok?verify=once',{headers:{'oai-authenticated-user-id':'owner-alice'}}):request('/connect/grok',{method:'GET'}),environment());
  const html=await page.text(),script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  let keyClick,promptClick,timerId=0;
  const timers=new Map(),deadlines=[],requests=[],copies=[],writes=[],historyChanges=[];
  const data={value:secrets.BRIDGE_MCP_AUTHORIZATION},status={textContent:''};
  const key={dataset:{credential:'mcp'},disabled:!!options.keyDisabled,addEventListener:(_,fn)=>{keyClick=fn;}};
  const prompt={disabled:false,addEventListener:(_,fn)=>{promptClick=fn;}};
  const forbidden=()=>{throw new Error('No credential display, storage or logging');};
  const clipboard=options.clipboard??{
    writeText:async value=>{copies.push(value);},
    write:async items=>{writes.push(items);copies.push(await (await items[0].values['text/plain']).text());}
  };
  const context={
    AbortController,Blob,
    history:{replaceState:(state,title,path)=>historyChanges.push(path)},
    ClipboardItem:options.modern?class {constructor(values){this.values=values;}}:undefined,
    setTimeout:(fn,ms)=>{deadlines.push(ms);timers.set(++timerId,fn);return timerId;},
    clearTimeout:id=>timers.delete(id),
    document:{querySelectorAll:()=>[key],getElementById:id=>id==='status'?status:id==='copy-prompt'?prompt:{textContent:GROK_CONNECTION_PROMPT}},
    navigator:{clipboard},
    fetch:(path,init)=>{requests.push({path,init});return options.fetch?options.fetch(path,init):path==='https://bridge.example.com/mcp/grok'?Promise.resolve({status:200,json:async()=>({jsonrpc:'2.0',id:'owner-once-initialize-check',result:{protocolVersion:'2025-06-18',serverInfo:{name:'grok-dot-submit',version:'1.0.0'}}})}):Promise.resolve({ok:true,json:options.json??(async()=>data)});},
    console:{log:forbidden,error:forbidden,warn:forbidden},
    localStorage:{setItem:forbidden},sessionStorage:{setItem:forbidden},indexedDB:{open:forbidden}
  };
  vm.runInNewContext(script,context);
  return {key,prompt,status,data,requests,copies,writes,timers,deadlines,historyChanges,start:()=>keyClick(),startPrompt:()=>promptClick(),expire:()=>{for(const fn of [...timers.values()])fn();}};
}

test('explicit verification sends one initialize only to the authorized endpoint without cookies or redirects',async()=>{
  const client=await copyClient({verify:true,modern:true});
  assert.equal(client.requests.length,0);
  await client.start();
  const checks=client.requests.filter(r=>r.path==='https://bridge.example.com/mcp/grok');
  assert.equal(checks.length,1);
  const {init}=checks[0];
  assert.equal(init.method,'POST');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
  assert.deepEqual(Object.keys(init.headers).sort(),['content-type','x-bridge-mcp-authorization']);
  assert.equal(init.headers['x-bridge-mcp-authorization'],secrets.BRIDGE_MCP_AUTHORIZATION);
  assert.equal(JSON.parse(init.body).method,'initialize');assertNoSecret(init.body);
  assert.deepEqual(client.historyChanges,['/connect/grok']);
  assert.equal(client.data.value,'');assertNoSecret(client.status.textContent);
  assert.ok(client.status.textContent.includes('initialize: HTTP 200; protocolVersion=2025-06-18'));
  client.data.value=secrets.BRIDGE_MCP_AUTHORIZATION;
  await client.start();
  assert.equal(client.requests.filter(r=>r.path==='https://bridge.example.com/mcp/grok').length,1,'The page must not retry initialization');
});

test('initialize confirmation belongs only to the credential copy that performed it',async()=>{
  for(const modern of [false,true]){
    const client=await copyClient({verify:true,modern});
    await client.start();
    assert.ok(client.status.textContent.includes('initialize: HTTP 200'));
    const nextAuthorization='Bearer fixture_handoff_second_01234567890123456789';
    client.data.value=nextAuthorization;
    await client.start();
    assert.equal(client.requests.filter(r=>r.path==='https://bridge.example.com/mcp/grok').length,1);
    assert.equal(client.requests.filter(r=>r.path==='/api/bridge/credential-copy').length,2);
    assert.deepEqual(client.copies,[secrets.BRIDGE_MCP_AUTHORIZATION,nextAuthorization]);
    assert.equal(client.status.textContent,'已复制。请直接粘贴到 Grok 对应的机密字段。');
    assert.equal(client.data.value,'');
    assertNoSecret(client.status.textContent);
    assert.ok(!client.status.textContent.includes(nextAuthorization));
  }
});

test('a failed clipboard write cannot carry its initialize confirmation into a later copy',async()=>{
  let writes=0;
  const client=await copyClient({verify:true,clipboard:{writeText:async()=>{
    if(++writes===1)throw new Error('fixture clipboard failure');
  }}});
  await client.start();
  assert.ok(client.status.textContent.startsWith('未能复制'));
  client.data.value='Bearer fixture_handoff_second_01234567890123456789';
  await client.start();
  assert.equal(client.requests.filter(r=>r.path==='https://bridge.example.com/mcp/grok').length,1);
  assert.equal(writes,2);
  assert.equal(client.status.textContent,'已复制。请直接粘贴到 Grok 对应的机密字段。');
  assert.equal(client.data.value,'');
});

test('failed or stalled initialize clears the fixture, sends no tools, and cannot be retried in the same page',async()=>{
  for(const stage of ['http','rpc','fetch','json']){
    const waiting=deferred(),fixture={value:secrets.BRIDGE_MCP_AUTHORIZATION};
    const client=await copyClient({verify:true,modern:true,fetch:async(path)=>{
      if(path==='/api/bridge/credential-copy')return {ok:true,json:async()=>fixture};
      if(stage==='fetch')return waiting.promise;
      if(stage==='http')return {status:401,json:async()=>{throw new Error('denied response should not be displayed');}};
      return {status:200,json:()=>stage==='json'?waiting.promise:Promise.resolve({jsonrpc:'2.0',id:'owner-once-initialize-check',error:{message:'private detail'}})};
    }});
    const work=client.start();await flushClient();
    if(stage==='fetch'||stage==='json'){client.expire();await work;assert.ok(client.status.textContent.startsWith('未确认复制'));}
    else await work;
    assert.equal(fixture.value,'');assert.equal(client.copies.length,0);assertNoSecret(client.status.textContent);
    assert.ok(!client.status.textContent.includes('private detail'));assert.equal(client.key.disabled,false);
    const status=client.status.textContent;
    waiting.resolve(stage==='fetch'?{status:200,json:async()=>({})}:{});await flushClient();
    assert.equal(client.status.textContent,status);assert.equal(client.copies.length,0);
    fixture.value=secrets.BRIDGE_MCP_AUTHORIZATION;await client.start();
    assert.equal(client.requests.filter(r=>r.path==='https://bridge.example.com/mcp/grok').length,1);
  }
});

test('modern clipboard write starts synchronously in the click before the credential fetch',async()=>{
  const client=await copyClient({modern:true});
  const work=client.start();
  assert.equal(client.writes.length,1);
  assert.equal(client.requests.length,0,'Clipboard write must start before any asynchronous credential retrieval');
  await work;
  assert.deepEqual(client.copies,[secrets.BRIDGE_MCP_AUTHORIZATION]);
  assert.equal(client.data.value,'');
  assert.equal(client.key.disabled,false);assert.equal(client.prompt.disabled,false);
  assert.deepEqual(client.deadlines,[10000]);assert.equal(client.timers.size,0);
  assert.ok(client.status.textContent.startsWith('已复制'));assertNoSecret(client.status.textContent);
});

test('one deadline bounds stalled fetch, JSON and fallback clipboard; late work cannot report success',async()=>{
  for(const stage of ['fetch','json','clipboard']){
    const waiting=deferred();let jsonReads=0,clipboardCalls=0;
    const client=await copyClient({
      ...(stage==='fetch'?{fetch:()=>waiting.promise}:{}),
      ...(stage==='json'?{json:()=>waiting.promise}:{}),
      clipboard:{writeText:()=>{clipboardCalls++;return stage==='clipboard'?waiting.promise:Promise.resolve();}}
    });
    const work=client.start();await flushClient();
    assert.equal(client.key.disabled,true,stage);assert.deepEqual(client.deadlines,[10000]);
    client.expire();await work;
    assert.ok(client.status.textContent.startsWith('未确认复制'),stage);
    assert.equal(client.key.disabled,false);assert.equal(client.prompt.disabled,false);assert.equal(client.timers.size,0);
    assert.equal(client.requests[0].init.signal.aborted,true);
    const statusAfterTimeout=client.status.textContent;
    const lateData={value:secrets.BRIDGE_MCP_AUTHORIZATION};
    if(stage==='fetch')waiting.resolve({ok:true,json:async()=>{jsonReads++;return lateData;}});
    else if(stage==='json')waiting.resolve(lateData);
    else waiting.resolve();
    await flushClient();
    assert.equal(client.status.textContent,statusAfterTimeout);
    assert.equal(clipboardCalls,stage==='clipboard'?1:0,'A timeout must never start a later clipboard write');
    if(stage==='fetch')assert.equal(jsonReads,0,'Do not read a body returned after cancellation');
    if(stage==='json')assert.equal(lateData.value,'','Clear JSON that arrives after the outer finally');
    if(stage==='clipboard')assert.equal(client.data.value,'');
    assertNoSecret(client.status.textContent);
  }
});

test('a modern clipboard timeout stays unconfirmed after a late successful write',async()=>{
  const waiting=deferred();let payload,writes=0;
  const client=await copyClient({modern:true,clipboard:{write:items=>{writes++;payload=items[0].values['text/plain'];return waiting.promise;}}});
  const work=client.start();await flushClient();
  assert.equal(await (await payload).text(),secrets.BRIDGE_MCP_AUTHORIZATION);
  client.expire();await work;
  assert.ok(client.status.textContent.startsWith('未确认复制'));assert.equal(client.data.value,'');
  const afterTimeout=client.status.textContent;waiting.resolve();await flushClient();
  assert.equal(client.status.textContent,afterTimeout);assert.equal(writes,1);assert.equal(client.key.disabled,false);
});

test('early modern write failures cancel the request and reject the promised payload without fallback',async()=>{
  for(const failure of ['throw','reject']){
    const waiting=deferred();let payload,fallbacks=0,jsonReads=0;
    const client=await copyClient({modern:true,fetch:()=>waiting.promise,clipboard:{
      write:items=>{payload=items[0].values['text/plain'];if(failure==='throw')throw new Error('fixture clipboard error');return Promise.reject(new Error('fixture clipboard error'));},
      writeText:()=>{fallbacks++;return Promise.resolve();}
    }});
    await client.start();
    await assert.rejects(payload);assert.equal(fallbacks,0);assert.equal(client.key.disabled,false);assert.equal(client.timers.size,0);
    for(const request of client.requests)assert.equal(request.init.signal.aborted,true);
    waiting.resolve({ok:true,json:async()=>{jsonReads++;return {value:secrets.BRIDGE_MCP_AUTHORIZATION};}});
    await flushClient();assert.equal(jsonReads,0);assert.ok(client.status.textContent.startsWith('未能复制'));assertNoSecret(client.status.textContent);
  }
});

test('failed network or JSON rejects the modern clipboard payload without exposing values',async()=>{
  for(const failure of ['network','http','json','shape']){
    const client=await copyClient({modern:true,
      ...(failure==='network'?{fetch:()=>Promise.reject(new Error('fixture network detail'))}:{}),
      ...(failure==='http'?{fetch:async()=>({ok:false,json:()=>{throw new Error('Do not read denied response');}})}:{}),
      ...(failure==='json'?{json:()=>Promise.reject(new Error('fixture JSON detail'))}:{}),
      ...(failure==='shape'?{json:async()=>({value:null})}:{})
    });
    await client.start();
    assert.equal(client.copies.length,0);assert.equal(client.key.disabled,false);assert.equal(client.timers.size,0);
    assert.ok(client.status.textContent.startsWith('未能复制'));assertNoSecret(client.status.textContent);
    assert.ok(!client.status.textContent.includes('fixture'));
  }
});

test('fallback clipboard denial or missing API clears the fetched fixture and restores controls',async()=>{
  for(const clipboard of [{writeText:()=>Promise.reject(new Error('fixture denied'))},{}]){
    const client=await copyClient({clipboard});await client.start();
    assert.equal(client.data.value,'');assert.equal(client.key.disabled,false);assert.equal(client.prompt.disabled,false);
    assert.ok(client.status.textContent.startsWith('未能复制'));assertNoSecret(client.status.textContent);assert.equal(client.timers.size,0);
  }
});

test('pending copies cannot overlap and prompt copying preserves an expired credential button',async()=>{
  const waiting=deferred();const client=await copyClient({fetch:()=>waiting.promise});
  const work=client.start();await flushClient();await client.startPrompt();
  assert.equal(client.requests.length,1);assert.equal(client.copies.length,0);assert.equal(client.deadlines.length,1);
  client.expire();await work;
  const expired=await copyClient({keyDisabled:true});await expired.startPrompt();
  assert.deepEqual(expired.copies,[GROK_CONNECTION_PROMPT]);assert.equal(expired.requests.length,0);
  assert.equal(expired.key.disabled,true);assert.equal(expired.prompt.disabled,false);
});
