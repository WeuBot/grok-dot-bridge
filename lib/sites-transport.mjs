import { BridgeError, callbackURL } from './bridge-protocol.mjs';

// Same runtime assertion used by Cloudflare's workers-oauth-provider for
// fetching untrusted HTTPS CIMD/JWKS URLs. This is NOT a config/env assertion.
// https://github.com/cloudflare/workers-oauth-provider/blob/main/src/oauth-provider.ts
// The strict flag removes the same-zone private-origin exception. The platform
// proxy filters DNS addresses and only connects via its public Internet route.
export function transportPolicy() {
  const strict = globalThis.Cloudflare?.compatibilityFlags?.global_fetch_strictly_public === true;
  return { mode: strict ? 'cloudflare_strict_public' : 'unavailable', runtime_strict_public: strict, same_zone_origin_bypass: strict ? false : null, redirects: 'rejected', tls_hostname: 'original_https_url', source: 'Cloudflare.compatibilityFlags.global_fetch_strictly_public' };
}

export function createSitesTransport() {
  return {
    get publicDestinationValidated() { return transportPolicy().runtime_strict_public; },
    get policy() { return transportPolicy(); },
    async post(target, options) {
      if (!transportPolicy().runtime_strict_public) throw new BridgeError('托管运行时未确认严格公网出站，拒绝回调', 503, 'safe_transport_unavailable', -32015);
      const url = callbackURL(target);
      // No resolver, Host override, cf routing overrides or service binding.
      // The ORIGINAL HTTPS URL drives public routing, SNI and hostname checks.
      return globalThis.fetch(url, { method: 'POST', headers: options.headers, body: options.body, redirect: 'manual', cache: 'no-store', signal: options.signal });
    }
  };
}

// Authenticated diagnostic tool only. Fixed URLs and methods; no forwarded
// credentials, user-selected targets, application payloads or signing secrets.
export async function probeSitesTransport() {
  const policy=transportPolicy();
  if(!policy.runtime_strict_public) return { policy, probes:[], reason:'safe_transport_unavailable' };
  const targets=[
    {name:'public_https',url:'https://www.cloudflare.com/',expected:'2xx'},
    {name:'dns_loopback_ipv4',url:'https://probe.127-0-0-1.sslip.io/',expected:'network_or_proxy_rejection'},
    {name:'dns_loopback_ipv6',url:'https://--1.sslip.io/',expected:'network_or_proxy_rejection'},
    {name:'tls_wrong_hostname',url:'https://wrong.host.badssl.com/',expected:'tls_or_proxy_rejection'},
    {name:'tls_expired',url:'https://expired.badssl.com/',expected:'tls_or_proxy_rejection'},
    {name:'redirect_no_follow',url:'https://cloudflare.com/',expected:'3xx_without_follow'}
  ];
  const probes=await Promise.all(targets.map(async t=>{
    try {
      const r=await globalThis.fetch(t.url,{method:'HEAD',redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(5000)});
      const output={name:t.name,expected:t.expected,status:r.status,redirected:r.redirected}; await r.body?.cancel(); return output;
    } catch(e) { return {name:t.name,expected:t.expected,status:null,error:e?.name==='TimeoutError'||e?.name==='AbortError'?'timeout':'network_rejected'}; }
  }));
  return {policy,probes,notice:'这些探测验证当前生产路径；DNS 重绑定安全保证来自严格公网代理的连接层策略，而非一次 DNS 预检。超时不是拒绝证明。'};
}
