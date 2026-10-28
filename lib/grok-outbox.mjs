import { callbackURL, digest } from './bridge-protocol.mjs';

// No endpoint or credential comes from a message or an MCP tool argument.
// Only the site owner's deployment configuration can enable this destination.
export function grokConfiguration(env, owner, transport) {
  const enabled = env.BRIDGE_GROK_ENABLED === 'true';
  const complete = !!(env.BRIDGE_OWNER_ID && env.BRIDGE_GROK_CHANNEL && env.BRIDGE_GROK_WEBHOOK_URL && env.BRIDGE_GROK_BEARER_KEY);
  let valid = false, url = '';
  try {
    url = callbackURL(env.BRIDGE_GROK_WEBHOOK_URL);
    valid = /^[A-Za-z0-9_-]{1,64}$/.test(env.BRIDGE_GROK_CHANNEL || '') && /^[\x21-\x7e]{1,4096}$/.test(env.BRIDGE_GROK_BEARER_KEY || '');
  } catch {}
  const authorized = owner === env.BRIDGE_OWNER_ID;
  const ready = enabled && complete && valid && authorized && !!transport?.publicDestinationValidated;
  return { enabled, configured: complete && valid, ready, url,
    reason: !enabled ? 'push_disabled' : !complete || !valid ? 'push_configuration_invalid' : !authorized ? 'owner_mismatch' : !transport?.publicDestinationValidated ? 'safe_transport_unavailable' : 'ready' };
}

/** @param {any} env @param {any} transport @param {any} db */
export function createGrokOutbox(env, transport, db) {
  // Owners may tighten (never increase) the four-attempt ceiling, e.g. for an
  // explicitly authorized single-call connectivity test. Invalid values fail safe.
  const maxAttempts=env.BRIDGE_GROK_MAX_ATTEMPTS===undefined?4:/^[1-4]$/.test(env.BRIDGE_GROK_MAX_ATTEMPTS)?Number(env.BRIDGE_GROK_MAX_ATTEMPTS):1;
  const stmt=(sql,...args)=>db.prepare(sql).bind(...args);
  const run=(sql,...args)=>stmt(sql,...args).run();
  const all=async(sql,...args)=>(await stmt(sql,...args).all()).results;
  const fingerprint=cfg=>digest(cfg.url+'\n'+env.BRIDGE_GROK_CHANNEL);
  const terminalReplyExists='EXISTS (SELECT 1 FROM messages WHERE messages.owner=grok_outbox.owner AND messages.reply_to=grok_outbox.id)';
  function messageScope(externalId) {
    if(externalId===undefined)return {clause:'',args:[]};
    if(typeof externalId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(externalId))throw new TypeError('Invalid outbox message scope');
    return {clause:' AND external_id=?',args:[externalId]};
  }
  function status(owner) {
    const {enabled,configured,ready,reason}=grokConfiguration(env,owner,transport);
    return {enabled,configured,ready,reason,max_attempts:maxAttempts,completion:'not_reported',retry_policy:'bounded_http_failures_ambiguous_stops'};
  }
  async function enqueueStatement(owner,message,text,now) {
    const cfg=grokConfiguration(env,owner,transport);
    // Configuration can be approved before transport is ready: keep the outbox,
    // but delivery still fails closed. Disabled configurations never backfill.
    if(!cfg.enabled || !cfg.configured || owner!==env.BRIDGE_OWNER_ID || message.channel!==env.BRIDGE_GROK_CHANNEL) return null;
    const id='dotreply_'+(await digest(owner+':'+message.external_id)).slice(0,40);
    const body=JSON.stringify({event_id:id,type:'dot.reply',message_id:id,reply_to:message.external_id,channel:message.channel,origin:'dot',hop:1,text,created_at:new Date(now).toISOString()});
    return stmt("INSERT OR IGNORE INTO grok_outbox (id,owner,external_id,channel,destination_hash,body,state,attempts,next_at,lease_until,created_at) SELECT ?,?,?,?,?,?,'pending',0,?,0,? FROM messages WHERE owner=? AND external_id=? AND result IS NULL",id,owner,message.external_id,message.channel,await fingerprint(cfg),body,now,now,owner,message.external_id);
  }
  async function list(owner) {
    return all('SELECT id,external_id,channel,state,attempts,status,reason,next_at,accepted_at FROM grok_outbox WHERE owner=? ORDER BY created_at DESC LIMIT 30',owner);
  }
  /** @param {string} owner @param {string} [externalId] */
  async function pump(owner,externalId) {
    const now=Date.now(),cfg=grokConfiguration(env,owner,transport),scope=messageScope(externalId);
    // A process may die after Grok accepted the call but before D1 is updated.
    // Grok's documented endpoint has no guaranteed idempotency API: do NOT resend.
    await run(`UPDATE grok_outbox SET state='uncertain',reason='interrupted_delivery',lease_until=0,claim_token=NULL WHERE owner=?${scope.clause} AND state='sending' AND lease_until<=?`,owner,...scope.args,now);
    if(!cfg.ready) {
      if(!cfg.enabled) await run(`UPDATE grok_outbox SET state='stopped',reason='push_disabled' WHERE owner=?${scope.clause} AND state='pending'`,owner,...scope.args);
      return {processed:[],reason:cfg.reason};
    }
    await run(`UPDATE grok_outbox SET state='stopped',reason='terminal_reply_received' WHERE owner=?${scope.clause} AND state='pending' AND ${terminalReplyExists}`,owner,...scope.args);
    await run(`UPDATE grok_outbox SET state='failed',reason='attempts_exhausted' WHERE owner=?${scope.clause} AND state='pending' AND attempts>=?`,owner,...scope.args,maxAttempts);
    await run(`UPDATE grok_outbox SET state='stopped',reason='reply_expired' WHERE owner=?${scope.clause} AND state='pending' AND created_at<?`,owner,...scope.args,now-600000);
    const due=await all(`SELECT * FROM grok_outbox WHERE owner=?${scope.clause} AND state='pending' AND attempts<? AND next_at<=? ORDER BY next_at,id LIMIT 1`,owner,...scope.args,maxAttempts,now);
    const processed=[];
    for(const d of due) {
      if(d.channel!==env.BRIDGE_GROK_CHANNEL || d.destination_hash!==await fingerprint(cfg)) {
        await run("UPDATE grok_outbox SET state='stopped',reason='destination_changed' WHERE id=? AND state='pending'",d.id);
        continue;
      }
      const token=crypto.randomUUID();
      const claim=await run(`UPDATE grok_outbox SET state='sending',attempts=attempts+1,lease_until=?,claim_token=? WHERE id=? AND state='pending' AND attempts=? AND next_at<=? AND created_at>=? AND NOT ${terminalReplyExists}`,Date.now()+10000,token,d.id,d.attempts,Date.now(),Date.now()-600000);
      if(!claim.meta.changes) continue;
      let code=0,state='uncertain',reason='connection_outcome_unknown',nextAt=Date.now()+1000*2**d.attempts;
      try {
        // Strictly-public transport enforces the original HTTPS host and manual
        // redirects. Never forward a Bearer credential to a redirect target.
        const r=await transport.post(cfg.url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(4000),headers:{'content-type':'application/json','authorization':'Bearer '+env.BRIDGE_GROK_BEARER_KEY,'idempotency-key':d.id},body:d.body});
        code=r.status;
        if(r.redirected || code>=300 && code<400){state='failed';reason='redirect_blocked';}
        else if(code===200){state='accepted';reason='grok_run_started_completion_unconfirmed';}
        else {
          const retry=[408,429].includes(code)||code>=500&&code<=599;state=retry&&d.attempts+1<maxAttempts?'pending':'failed';reason='http_'+code;
          nextAt=Date.now()+1000*2**d.attempts;
          const header=r.headers.get('retry-after');
          const retryAt=header && /^\d+$/.test(header)?Date.now()+Number(header)*1000:header?Date.parse(header):NaN;
          if(Number.isFinite(retryAt)) nextAt=Math.max(nextAt,retryAt);
          if(state==='pending' && nextAt>d.created_at+600000){state='stopped';reason='retry_after_exceeds_expiry';}
        }
        // Never persist response bodies, which can echo credentials or prompts.
        await r.body?.cancel().catch(()=>{});
      } catch(e) {
        if(['unsafe_callback','safe_transport_unavailable'].includes(e?.reason)){state='failed';reason=e.reason;}
        // Network errors and timeouts cannot prove whether a Bot run started.
      }
      const saved=await run(`UPDATE grok_outbox SET state=CASE WHEN ?='pending' AND ${terminalReplyExists} THEN 'stopped' ELSE ? END,status=?,reason=CASE WHEN ?='pending' AND ${terminalReplyExists} THEN 'terminal_reply_received' ELSE ? END,next_at=?,lease_until=0,claim_token=NULL,accepted_at=? WHERE id=? AND state='sending' AND claim_token=?`,state,state,code,state,reason,nextAt,state==='accepted'?Date.now():null,d.id,token);
      const persisted=saved.meta.changes&&state!=='pending'?{state,status:code}:await stmt('SELECT state,status FROM grok_outbox WHERE id=?',d.id).first();
      processed.push({id:d.id,state:persisted?.state||'uncertain',status:persisted?.status??0});
    }
    return {processed};
  }
  /** @param {string} owner @param {string} [externalId] */
  async function background(owner,externalId) {
    // Within Workers' 30-second post-response waitUntil allowance. Pending rows
    // survive interruption and can be progressed by the controlled retry tool.
    const deadline=Date.now()+24000,scope=messageScope(externalId);
    for(let i=0;i<maxAttempts && Date.now()<deadline;i++) {
      const result=await pump(owner,externalId);
      if(result.reason) break;
      const row=await stmt(`SELECT MIN(next_at) AS next_at FROM grok_outbox WHERE owner=?${scope.clause} AND state='pending' AND attempts<?`,owner,...scope.args,maxAttempts).first();
      if(row?.next_at==null || row.next_at+4500>deadline) break;
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,row.next_at-Date.now())));
    }
  }
  return {status,enqueueStatement,list,pump,background};
}
