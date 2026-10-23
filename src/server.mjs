import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createConfig, pathIsNoindex } from './config.mjs';
import { upstreamUrl, rewriteText, rewriteUrl } from './urls.mjs';
import { transformHtml, transformSitemap } from './seo.mjs';
import { requestHeaders, responseHeaders, readLimited } from './upstream.mjs';
import { ByteCache } from './cache.mjs';
import { Sitemaps } from './sitemaps.mjs';
import { rewriteFlight } from './flight.mjs';

function send(req,res,value) {
  res.writeHead(value.status, { ...value.headers, 'content-length': value.body.length });
  res.end(req.method === 'HEAD' ? undefined : value.body);
}
function plain(req,res,status,message,headers={}) {
  send(req,res,{status,body:Buffer.from(message+'\n'),headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-robots-tag':'noindex, follow',...headers}});
}
async function requestBody(req,max) {
  let size=0; const parts=[];
  for await (const chunk of req) {
    size+=chunk.length;
    if (size>max) throw Object.assign(new Error('Request too large'),{status:413});
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
function canonicalHost(req,c) {
  if ((req.headers.host || '').toLowerCase() !== new URL(c.publicOrigin).host.toLowerCase()) return false;
  const proto = c.trustProxy ? req.headers['x-forwarded-proto']?.split(',')[0].trim() : undefined;
  return !c.forceHttps || (proto || (req.socket.encrypted ? 'https':'http')) === 'https';
}
function cacheAllowed(req,response,c) {
  const vary = (response.headers.get('vary') || '').toLowerCase().split(',').map(x=>x.trim());
  const supported = new Set(['','accept','accept-language','accept-encoding','rsc','next-router-state-tree','next-router-prefetch','next-router-segment-prefetch','next-url']);
  return c.cacheTtl>0 && req.method==='GET' && !req.headers.cookie && !req.headers.authorization && !req.headers.rsc && !req.headers['next-router-state-tree'] && !req.headers['next-router-prefetch'] && !req.headers['next-router-segment-prefetch'] && !req.headers['next-url'] && !req.url.includes('_rsc=') && response.status===200 && !(response.headers.get('content-type') || '').includes('text/x-component') && !response.headers.has('set-cookie') && !/private|no-store|no-cache/i.test(response.headers.get('cache-control') || '') && !vary.some(v=>!supported.has(v));
}
export function createMirror(c) {
  const cache = new ByteCache(c.cacheBytes), sitemaps = new Sitemaps(c);
  const server = http.createServer({maxHeaderSize:32768},async (req,res) => {
    const began=Date.now(), requestId=crypto.randomUUID();
    res.setHeader('x-request-id',requestId);
    res.on('finish',()=> { if(c.logRequests) console.log(JSON.stringify({event:'request',id:requestId,method:req.method,path:(req.url||'').split('?')[0],status:res.statusCode,ms:Date.now()-began})); });
    let timer; const abort = new AbortController();
    const disconnect=()=> { if(!res.writableEnded) abort.abort(); };
    res.on('close',disconnect);
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\r\n]/.test(req.url)) return plain(req,res,400,'Invalid request target');
      const u = new URL(c.publicOrigin + req.url);
      // Healthchecks must work without canonical host/protocol enforcement or upstream access.
      if (u.pathname === '/healthz') return plain(req,res,200,'ok');
      if (!['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE'].includes(req.method)) return plain(req,res,405,'Method not allowed',{allow:'GET, HEAD, OPTIONS'});
      if (!canonicalHost(req,c)) return plain(req,res,308,'Canonical origin',{location:c.publicOrigin+u.pathname+u.search});
      const custom = c.redirects[u.pathname];
      if (custom && ['GET','HEAD'].includes(req.method)) {
        const target = typeof custom === 'string' ? custom : custom.to;
        const code = typeof custom === 'string' ? 301 : custom.status || 301;
        if (!target?.startsWith('/') || target.startsWith('//') || /[\\\r\n]/.test(target) || ![301,302,307,308].includes(code)) throw new Error('Invalid configured redirect');
        const dest = new URL(c.publicOrigin+target);
        if(!dest.search) dest.search=u.search;
        if(dest.href===u.href) throw new Error('Configured redirect loop');
        return plain(req,res,code,'Redirect',{location:dest.href});
      }
      const verify = c.verificationFiles[u.pathname];
      if(verify !== undefined && ['GET','HEAD'].includes(req.method)) return plain(req,res,200,String(verify));
      if(u.pathname==='/robots.txt' && ['GET','HEAD'].includes(req.method)) {
        const body = Buffer.from(await sitemaps.robotsText());
        return send(req,res,{status:200,body,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'public, max-age=300'}});
      }
      // Discover child maps on cold starts before deciding whether an arbitrary .xml route is a map.
      if (/\.(xml|gz)$/.test(u.pathname) && !sitemaps.isSitemap(u.pathname+u.search)) await sitemaps.discover();
      if(sitemaps.isSitemap(u.pathname+u.search) && ['GET','HEAD'].includes(req.method)) return send(req,res,await sitemaps.get(u.pathname+u.search));
      if(req.method==='OPTIONS') return plain(req,res,200,'',{allow:c.allowWrite?'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS':'GET, HEAD, OPTIONS'});
      if(!['GET','HEAD'].includes(req.method) && !c.allowWrite) return plain(req,res,405,'Write proxy disabled; see ALLOW_WRITE_METHODS in README',{allow:'GET, HEAD, OPTIONS'});
      if(!['GET','HEAD'].includes(req.method) && req.headers.origin && req.headers.origin!==c.publicOrigin) return plain(req,res,403,'Unexpected request origin');
      const isData = !!req.headers.rsc || ['next-router-state-tree','next-router-prefetch','next-router-segment-prefetch','next-url'].some(k=>req.headers[k]!==undefined) || u.searchParams.has('_rsc');
      const key = req.url + '\n' + (req.headers['accept-language'] || '') + '\n' + (req.headers.accept || '');
      const canLookup = req.method==='GET' && !req.headers.cookie && !req.headers.authorization && !isData && !req.headers['next-router-prefetch'] && !req.headers['next-url'];
      const hit = canLookup && cache.get(key);
      if(hit) return send(req,res,hit);
      const headers = requestHeaders(req,c);
      // Fetch GET for HEAD so HTML canonical/noindex headers match GET exactly.
      const method = req.method==='HEAD'?'GET':req.method;
      const body = !['GET','HEAD'].includes(method) ? await requestBody(req,c.maxBodyBytes) : undefined;
      timer=setTimeout(()=>abort.abort(new DOMException('Upstream timed out','TimeoutError')),c.timeout);
      timer.unref();
      const response = await fetch(upstreamUrl(req.url,c),{method,headers,body,redirect:'manual',signal:abort.signal});
      const out = responseHeaders(response,c);
      if([301,302,303,307,308].includes(response.status) && response.headers.has('location')) {
        const location = rewriteUrl(response.headers.get('location'),c.upstreamOrigin+req.url,c);
        out.location=location;
        out['cache-control']='no-store';
        await response.body?.cancel();
        if(new URL(location,u).href===u.href) return plain(req,res,502,'Upstream redirect loop');
        return send(req,res,{status:response.status,headers:out,body:Buffer.alloc(0)});
      }
      const type = (response.headers.get('content-type')||'application/octet-stream').toLowerCase();
      if(!c.enableIndexing || response.status>=400 || pathIsNoindex(u.pathname,c) || isData || type.includes('text/x-component')) out['x-robots-tag']='noindex, follow';
      if(response.status===304) { await response.body?.cancel(); return plain(req,res,502,'Unexpected upstream 304 without a conditional request'); }
      if([204,205].includes(response.status)) { await response.body?.cancel(); return send(req,res,{status:response.status,headers:out,body:Buffer.alloc(0)}); }
      const textual = /text\/(html|css|plain|x-component)|(?:application|text)\/(?:[^;]*\+)?(?:json|javascript|xml)|image\/svg\+xml/.test(type) && !type.includes('event-stream');
      if(textual) {
        let text = (await readLimited(response,c.maxTextBytes)).toString('utf8');
        if(type.includes('text/html') && !isData) {
          const result = transformHtml(text,u,response.status,c);
          text=result.html;
          out['content-type']='text/html; charset=utf-8';
          if(result.noindex) out['x-robots-tag']='noindex, follow';
          if(!result.noindex && !/\b(noindex|none)\b/i.test(out['x-robots-tag']||'')) out.link=`<${result.canonical}>; rel="canonical"`;
          if(result.stats.invalidJsonLdRemoved || result.stats.breadcrumbsRemoved) console.warn(JSON.stringify({event:'schema_cleaned',path:u.pathname,...result.stats}));
        } else if (type.includes('text/x-component')) {
          try { text = rewriteFlight(text,c); } catch(e) { console.warn(JSON.stringify({event:'flight_rewrite_skipped',message:e.message})); }
        } else if (/xml/.test(type) && /<(?:\w+:)?(?:urlset|sitemapindex)\b/.test(text)) {
          await sitemaps.probe.validate(text,c.upstreamOrigin+req.url);
          text=transformSitemap(text,c.upstreamOrigin+req.url,c,{register:sitemaps.register,resolvePage:sitemaps.probe.resolve}).xml;
        } else text=rewriteText(text,c);
        delete out.etag; delete out['last-modified']; delete out['content-md5']; delete out.digest; delete out['content-digest']; delete out['repr-digest']; delete out['content-range']; delete out['accept-ranges'];
        const transformed = Buffer.from(text);
        out.etag='W/"'+createHash('sha256').update(transformed).digest('hex').slice(0,32)+'"';
        // Never let a source CDN TTL hide changes to canonical/schema/editorial configuration.
        delete out['cdn-cache-control']; delete out['vercel-cdn-cache-control']; delete out['surrogate-control']; delete out.age;
        if(type.includes('html') || isData || type.includes('json')) out['cache-control']='private, no-store';
        const value={status:response.status,headers:out,body:transformed};
        if(!isData && cacheAllowed(req,response,c)) cache.set(key,value,c.cacheTtl);
        return send(req,res,value);
      }
      // Binary assets/range responses and SSE are streamed without buffering or text mutation.
      if(req.method==='HEAD') { await response.body?.cancel(); return send(req,res,{status:response.status,headers:out,body:Buffer.alloc(0)}); }
      res.writeHead(response.status,out);
      if(response.body) await pipeline(Readable.fromWeb(response.body),res); else res.end();
    } catch(error) {
      console.error(JSON.stringify({event:'proxy_error',id:requestId,message:error.message}));
      if(!res.headersSent && !res.destroyed) plain(req,res,error.status || (abort.signal.reason?.name==='TimeoutError' ? 504 : 502),error.status===413?'Request too large':'Upstream temporarily unavailable');
      else if(!res.destroyed) res.destroy();
    } finally { clearTimeout(timer); res.off('close',disconnect); }
  });
  server.requestTimeout=30000; server.headersTimeout=15000; server.keepAliveTimeout=5000;
  server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'));
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const c=createConfig(), server=createMirror(c);
  server.listen(c.port,c.host,()=>console.log(JSON.stringify({event:'listening',port:c.port,publicOrigin:c.publicOrigin,upstream:c.upstreamOrigin,indexing:c.enableIndexing,canonicalMode:c.canonicalMode})));
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{
    server.close(()=>process.exit(0)); setTimeout(()=>process.exit(1),10000).unref();
  });
}
