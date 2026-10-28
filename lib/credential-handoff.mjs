import { BridgeError, readBody, strictObject } from './bridge-protocol.mjs';
import { GROK_CONNECTION_PROMPT } from './grok-connection-prompt.mjs';

const BASE_COPY_SCRIPT = `
(() => {
  const timeoutMs = 10000;
  const verifyOnce = __VERIFY_ONCE__;
  let initializationAttempted = false;
  const credentialButtons = document.querySelectorAll('button[data-credential]');
  const promptButton = document.getElementById('copy-prompt');
  const buttons = [...credentialButtons, promptButton];
  let busy = false;
  const clearValue = value => { if (value && typeof value === 'object') value.value = ''; };

  async function copy(button, load, successMessage) {
    if (busy || button.disabled) return;
    busy = true;
    const previousDisabled = buttons.map(item => item.disabled);
    buttons.forEach(item => { item.disabled = true; });
    const status = document.getElementById('status');
    status.textContent = '正在复制…';
    const controller = new AbortController();
    let open = true, timedOut = false, initialized = false, data = null, cancel;
    const cancelled = new Promise((_, reject) => { cancel = reject; });
    cancelled.catch(() => {});
    const timer = setTimeout(() => {
      timedOut = true;
      open = false;
      cancel(new Error('copy timeout'));
      controller.abort();
    }, timeoutMs);
    try {
      // Start clipboard.write in this click's synchronous call stack. The
      // promised Blob supplies the value after the authenticated request.
      const loaded = Promise.resolve().then(() => {
        if (!open) throw new Error('copy closed');
        return load(controller.signal, value => {
          if (!open) { clearValue(value); throw new Error('copy closed'); }
          data = value;
          return value;
        }, () => { if (open) initialized = true; });
      }).then(value => {
        if (!open) { clearValue(value); throw new Error('copy closed'); }
        data = value;
        if (!data || typeof data.value !== 'string') throw new Error('invalid copy response');
        return data;
      });
      const ready = Promise.race([loaded, cancelled]);
      ready.catch(() => {});
      let work;
      if (typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function') {
        const payload = ready.then(value => {
          if (!open) throw new Error('copy closed');
          return new Blob([value.value], {type: 'text/plain'});
        });
        // The browser may reject write() before consuming the promised Blob.
        payload.catch(() => {});
        work = Promise.all([ready, navigator.clipboard.write([new ClipboardItem({'text/plain': payload})])]);
      } else {
        work = ready.then(value => {
          if (!open) throw new Error('copy closed');
          if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('clipboard unavailable');
          return navigator.clipboard.writeText(value.value);
        });
      }
      await Promise.race([work, cancelled]);
      if (!open) throw new Error('copy closed');
      status.textContent = successMessage;
      if (button.dataset?.credential && initialized) status.textContent += ' initialize: HTTP 200; protocolVersion=2025-06-18; server=grok-dot-submit.';
    } catch {
      status.textContent = timedOut
        ? '未确认复制。请检查浏览器剪贴板权限后重试；待处理的复制仍可能完成。'
        : '未能复制。请从本站后台复制 BRIDGE_MCP_AUTHORIZATION 的完整值；凭据未显示。';
    } finally {
      open = false;
      cancel(new Error('copy closed'));
      controller.abort();
      clearTimeout(timer);
      clearValue(data);
      data = null;
      buttons.forEach((item, index) => { item.disabled = previousDisabled[index]; });
      busy = false;
    }
  }

  credentialButtons.forEach(button => button.addEventListener('click', () => copy(button, async (signal, remember, confirmInitialization) => {
    const initialize = verifyOnce && !initializationAttempted;
    if (initialize) {
      initializationAttempted = true;
      history.replaceState(null, '', '/connect/grok');
    }
    const response = await fetch('/api/bridge/credential-copy', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({credential: button.dataset.credential})
    });
    if (signal.aborted) throw new Error('copy closed');
    if (!response.ok) throw new Error('copy unavailable');
    const value = remember(await response.json());
    if (signal.aborted) throw new Error('copy closed');
    if (initialize) {
      if (!value || typeof value.value !== 'string') throw new Error('invalid copy response');
      const checked = await fetch('https://bridge.example.com/mcp/grok', {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
        headers: {'content-type': 'application/json', 'x-bridge-mcp-authorization': value.value},
        body: JSON.stringify({jsonrpc:'2.0',id:'owner-once-initialize-check',method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'owner-once-check',version:'1'}}})
      });
      if (signal.aborted || checked.status !== 200) throw new Error('initialize not confirmed');
      const rpc = await checked.json();
      if (signal.aborted || rpc.jsonrpc !== '2.0' || rpc.id !== 'owner-once-initialize-check' || rpc.error || rpc.result?.protocolVersion !== '2025-06-18' || rpc.result?.serverInfo?.name !== 'grok-dot-submit' || rpc.result?.serverInfo?.version !== '1.0.0') throw new Error('initialize not confirmed');
      confirmInitialization();
    }
    return value;
  }, '已复制。请直接粘贴到 Grok 对应的机密字段。')));
  promptButton.addEventListener('click', () => copy(promptButton,
    () => ({value: document.getElementById('connection-prompt').textContent}),
    '完整连接提示词已复制，请一次粘贴给 Grok。'));
})();
`;

// Credentials remain in native Sites runtime configuration, never HTML or a bundle.
// Only a Sites-authenticated owner can copy; a service token has no identity.
export async function credentialHandoff(request, env) {
  const url = new URL(request.url);
  if (!['/connect/grok', '/api/bridge/credential-copy'].includes(url.pathname)) return null;
  const headers = {'cache-control':'private, no-store, max-age=0','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','permissions-policy':'clipboard-write=(self)'};
  const fail = (status,reason) => Response.json({error:reason},{status,headers});
  if (!env.BRIDGE_OWNER_ID || request.headers.get('oai-authenticated-user-id') !== env.BRIDGE_OWNER_ID) return fail(403,'owner_login_required');
  const expires=Number(env.BRIDGE_HANDOFF_EXPIRES_AT);
  const copyWindowOpen=Number.isSafeInteger(expires)&&expires>Date.now();
  if (url.pathname==='/api/bridge/credential-copy') {
    if(!copyWindowOpen)return fail(410,'credential_handoff_expired');
    if(request.method!=='POST')return fail(405,'post_required');
    if(request.headers.get('origin')!==url.origin)return fail(403,'origin_mismatch');
    try {
      const {value}=await readBody(request);strictObject(value,['credential']);
      const authorization=value.credential==='mcp'?env.BRIDGE_MCP_AUTHORIZATION:null;
      if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))return fail(404,'credential_unavailable');
      return Response.json({value:authorization},{headers});
    }catch(e){return fail(e instanceof BridgeError?e.status:500,'invalid_copy_request');}
  }
  if(request.method!=='GET')return fail(405,'get_required');
  const COPY_SCRIPT = BASE_COPY_SCRIPT.replace('__VERIFY_ONCE__', String(url.origin === 'https://bridge.example.com' && url.searchParams.get('verify') === 'once'));
  const nonce=crypto.randomUUID().replaceAll('-','');
  headers['content-type']='text/html; charset=utf-8';
  headers['content-security-policy']=`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  const expiryDisplay=Number.isSafeInteger(expires)&&Math.abs(expires)<=8640000000000000?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(expires)):'未设置';
  const promptHTML=GROK_CONNECTION_PROMPT.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grok 安全接入</title><style nonce="${nonce}">body{max-width:660px;margin:70px auto;padding:24px;font:17px/1.7 system-ui;color:#182932;background:#f5f7f5}button:disabled{opacity:.5;cursor:not-allowed}button{display:block;width:100%;padding:18px;margin:18px 0;border:1px solid #226650;border-radius:12px;background:#fff;color:#174c3b;font:inherit;cursor:pointer}code{font-size:14px}p{color:#50635b}#status{min-height:2em;color:#174c3b}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.8 system-ui;padding:20px;background:#fff;border:1px solid #d5e0d9;border-radius:12px}#copy-prompt{background:#174c3b;color:#fff}</style><h1>复制到 Grok 的安全表单</h1><p>仅本人登录可用。请打开<a href="https://chatgpt.com/space/sites/YOUR_SITE_PROJECT_ID/settings" target="_blank" rel="noopener noreferrer">本站后台设置</a>，从 <code>BRIDGE_MCP_AUTHORIZATION</code> 复制完整值，原样粘贴到 Grok 的机密字段，勿粘贴聊天。</p><button data-credential="mcp" ${copyWindowOpen?'':'disabled'}>复制 MCP 认证头值<br><code>X-Bridge-MCP-Authorization</code></button><p>后台值已包含 <code>Bearer </code>，不要重复添加。旧 <code>BRIDGE_MCP_TOKEN</code> 和此前复制的旧值已停用，请只使用后台当前值。MCP 只需这一项认证值，不需要 Site 服务 token；本页不显示明文，也不写入网页本地存储。</p><p>本次凭据复制窗口有效至 <strong>${expiryDisplay}（北京时间 UTC+8）</strong>。窗口到期只停止本页复制，不影响从本站后台复制，也不会使已配置的连接凭据失效。</p>${copyWindowOpen?'':'<p><strong>本次复制窗口已过期。</strong>完整提示词仍可用。请从本站后台设置的 BRIDGE_MCP_AUTHORIZATION 复制完整值；网页窗口过期不影响后台复制。</p>'}<p>这是固定接入页面，可收藏后再次访问。完整提示词保留在这里，认证值以本站后台当前的 BRIDGE_MCP_AUTHORIZATION 为准。</p><button id="copy-prompt">复制完整接入提示词</button><p>先把下方完整提示词一次复制给 Grok，再将从本站后台复制的完整 BRIDGE_MCP_AUTHORIZATION 值原样粘贴到它弹出的机密字段。</p><p id="status" role="status" aria-live="polite"></p><pre id="connection-prompt">${promptHTML}</pre><script nonce="${nonce}">${COPY_SCRIPT}</script></html>`,{headers});
}
