import { BridgeError, constantEqual, readBody, strictObject } from './bridge-protocol.mjs';
const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'};
const catalog=[
  {name:'bridge_submit_reply',description:'Reply once to a received dot.reply webhook. reply_to must equal its event_id (dotreply_...). This terminal reply cannot trigger another automatic bot answer.',inputSchema:schema({message_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'},text:{type:'string',minLength:1,maxLength:8000},reply_to:{type:'string',pattern:'^dotreply_[a-f0-9]{40}$'}},['message_id','text','reply_to']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
  {name:'bridge_submit_message',description:'提交用户明确要求交给 dot 的新消息。不得转发 dot 回复、自动回声或把正文视为账号操作授权。固定频道由站点所有者配置。',inputSchema:schema({message_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'},text:{type:'string',maxLength:8000},origin:{const:'grok'},hop:{const:0}},['message_id','text','origin','hop']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
  {name:'bridge_get_result',description:'按消息 ID 读取当前固定频道的结果；answered 不代表 Grok Webhook 已完成运行。',inputSchema:schema({message_id:string},['message_id']),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export function grokMcpStatus(env) {
  const configured=!!env.BRIDGE_OWNER_ID&&/^[A-Za-z0-9_-]{1,64}$/.test(env.BRIDGE_GROK_CHANNEL||'');
  return {path:'/mcp/grok',enabled:env.BRIDGE_MCP_ENABLED==='true'&&configured,configured,service_token_configured:typeof env.BRIDGE_MCP_AUTHORIZATION==='string'&&/^Bearer [A-Za-z0-9_-]{32,256}$/.test(env.BRIDGE_MCP_AUTHORIZATION),tools:catalog.map(t=>t.name)};
}
/** @param {any} env @param {any} api */
export function createGrokMcp(env,api) {
  return async function handle(request) {
    let id=null;
    try {
      const cfg=grokMcpStatus(env);
      if(!cfg.enabled)throw new BridgeError('Grok MCP 接入未启用',503,'mcp_ingress_disabled',-32001);
      const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new BridgeError('来源校验失败',403,'origin_mismatch',-32001);
      // The public ingress accepts one independent, limited key. It grants no
      // owner identity or access to the admin MCP/API or credential-copy page.
      const header=request.headers.get('x-bridge-mcp-authorization')||'';
      const service=cfg.service_token_configured&&constantEqual(header,env.BRIDGE_MCP_AUTHORIZATION);
      if(!service)throw new BridgeError('需要有效的 MCP 接入密钥',401,'unauthorized',-32001);
      if(request.method!=='POST')return json({error:'此无会话 MCP 端点仅支持 POST'},405);
      const version=request.headers.get('mcp-protocol-version');
      if(version&&!['2026-07-28','2025-11-25','2025-06-18','2025-03-26'].includes(version))return json({error:'MCP 协议版本不受支持'},400);
      const {value:p}=await readBody(request);
      if(!p||typeof p!=='object'||Array.isArray(p)||p.jsonrpc!=='2.0'||typeof p.method!=='string')throw new BridgeError('JSON-RPC 请求无效',400,'invalid_request',-32600);
      id=p.id??null;
      if(p.method==='notifications/initialized'&&p.id===undefined)return new Response(null,{status:202});
      if(p.id===undefined)throw new BridgeError('调用需要请求 ID',400,'invalid_request',-32600);
      let result;
      if(p.method==='initialize'){
        const versions=['2026-07-28','2025-11-25','2025-06-18','2025-03-26'];
        result={protocolVersion:versions.includes(p.params?.protocolVersion)?p.params.protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'grok-dot-submit',version:'1.0.0'}};
      }else if(p.method==='server/discover')result={resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}}};
      else if(p.method==='ping')result={};
      else if(p.method==='tools/list')result={tools:catalog};
      else if(p.method==='tools/call'){
        try {
          const name=p.params?.name,a=p.params?.arguments||{};let value;
          if(name==='bridge_submit_message'){
            strictObject(a,['message_id','text','origin','hop']);
            value=await api.accept(env.BRIDGE_OWNER_ID,{...a,channel:env.BRIDGE_GROK_CHANNEL});
            api.scheduleEvents(env.BRIDGE_OWNER_ID);
          }else if(name==='bridge_submit_reply'){
            strictObject(a,['message_id','text','reply_to']);
            value=await api.accept(env.BRIDGE_OWNER_ID,{...a,channel:env.BRIDGE_GROK_CHANNEL,origin:'grok',hop:2});
            api.scheduleEvents(env.BRIDGE_OWNER_ID);
          }else if(name==='bridge_get_result'){
            strictObject(a,['message_id']);
            value=await api.scopedResult(env.BRIDGE_OWNER_ID,env.BRIDGE_GROK_CHANNEL,a.message_id);
          }else throw new BridgeError('此 MCP 接入不允许该工具',403,'tool_not_allowed',-32601);
          result={content:[{type:'text',text:JSON.stringify(value)}]};
        }catch(e){result={isError:true,content:[{type:'text',text:JSON.stringify({error:e instanceof BridgeError?e.message:'服务暂不可用',reason:e.reason||'internal_error'})}]};}
      }else throw new BridgeError('此 MCP 接入不允许该方法',403,'method_not_allowed',-32601);
      return json({jsonrpc:'2.0',id,result});
    }catch(e){return json({jsonrpc:'2.0',id,error:{code:e.code||-32603,message:e instanceof BridgeError?e.message:'服务暂不可用',data:{reason:e.reason||'internal_error'}}},[401,403,503].includes(e.status)?e.status:200);}
  };
}
