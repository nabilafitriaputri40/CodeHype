import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createConfig } from '../src/config.mjs';
import { createMirror } from '../src/server.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const rawGet=(url,headers)=>new Promise((resolve,reject)=>{http.get(url,{headers},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));}).on('error',reject);});
const stop=s=>new Promise(r=>{s.closeAllConnections();s.close(r);});

test('real HTTP proxy: SEO, gzip, cache isolation, redirects, binary, errors and methods',async t=>{
  let source, hits=0, received;
  const upstream=http.createServer((req,res)=>{
    const u=new URL(req.url,source); received=req.headers;
    if(u.pathname==='/robots.txt') return res.end(`User-agent: *\nDisallow: /admin\nSitemap: ${source}/sitemap_index.xml\n`);
    if(u.pathname==='/sitemap.xml') {res.writeHead(404);return res.end('missing');}
    if(u.pathname==='/sitemap_index.xml'){res.setHeader('Content-Type','application/xml');return res.end(`<sitemapindex><sitemap><loc>${source}/maps/children.xml.gz</loc></sitemap></sitemapindex>`);}
    if(u.pathname==='/maps/children.xml.gz'){res.setHeader('Content-Type','application/gzip');return res.end(gzipSync(`<urlset><url><loc>${source}/page</loc></url></urlset>`));}
    if(u.pathname==='/redirect'){res.writeHead(308,{location:source+'/page'});return res.end();}
    if(u.pathname==='/loop'){res.writeHead(308,{location:source+'/loop'});return res.end();}
    if(u.pathname==='/missing'){res.writeHead(404,{'content-type':'text/html'});return res.end('<h1>Missing</h1>');}
    if(u.pathname==='/broken'){res.writeHead(503);return res.end('unavailable');}
    if(u.pathname==='/slow') return setTimeout(()=>{if(!res.destroyed)res.end('late')},500);
    if(u.pathname==='/large'){res.setHeader('Content-Type','text/html');return res.end('x'.repeat(200000));}
    if(u.pathname==='/binary'){res.setHeader('Content-Type','image/png');return res.end(Buffer.from([0,255,128,3]));}
    if(u.pathname==='/style.css'){res.setHeader('Content-Type','text/css');return res.end(`body{background:url(${source}/img.png)}`);}
    if(u.pathname==='/page'){
      hits++;
      res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','public,max-age=300');
      res.setHeader('Vary','RSC, Next-Router-State-Tree, Accept-Language');
      res.setHeader('Link',`<${source}/page>; rel="canonical"`);
      if(req.headers.cookie)res.setHeader('Set-Cookie','secret=1; HttpOnly');
      return res.end(`<head><link rel="canonical" href="${source}/page"></head><h1>Visit ${hits}</h1><a href="/other">Other</a>`);
    }
    if(u.pathname==='/echo'){let b='';req.on('data',x=>b+=x);req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({body:b,origin:req.headers.origin}));});return;}
    res.writeHead(404);res.end('missing');
  });
  source=await listen(upstream);
  const c=createConfig({PUBLIC_ORIGIN:'http://127.0.0.1:3000',UPSTREAM_ORIGIN:source,UPSTREAM_TIMEOUT_MS:'150',MAX_TEXT_BYTES:'100000',LOG_REQUESTS:'false'});
  const mirror=createMirror(c), publicUrl=await listen(mirror);c.publicOrigin=publicUrl;
  t.after(()=>Promise.all([stop(mirror),stop(upstream)]));
  await t.test('canonical and internal links are local; repeated GET may cache',async()=>{
    let r=await fetch(publicUrl+'/page');const body=await r.text();assert.equal(r.status,200);assert.match(body,new RegExp(publicUrl+'/other'));
    assert.equal(r.headers.get('link'),`<${publicUrl}/page>; rel="canonical"`);
    await (await fetch(publicUrl+'/page')).text();assert.equal(hits,1);
  });
  await t.test('cookie-bearing client bypasses cache and cookie forwarding defaults off',async()=>{
    await(await fetch(publicUrl+'/page',{headers:{cookie:'session=abc'}})).text();assert.equal(hits,2);assert.equal(received.cookie,undefined);
    await(await fetch(publicUrl+'/page',{headers:{rsc:'1','next-router-state-tree':'x'}})).text();assert.equal(hits,3);
  });
  await t.test('HEAD uses the same canonical and no body',async()=>{const r=await fetch(publicUrl+'/page',{method:'HEAD'});assert.equal(r.headers.get('link'),`<${publicUrl}/page>; rel="canonical"`);assert.equal(await r.text(),'');});
  await t.test('redirect rewrites location, status retained; loop rejected',async()=>{
    const r=await fetch(publicUrl+'/redirect',{redirect:'manual'});assert.equal(r.status,308);assert.equal(r.headers.get('location'),publicUrl+'/page');
    assert.equal((await fetch(publicUrl+'/loop',{redirect:'manual'})).status,502);
  });
  await t.test('404 stays 404 with noindex, source 503 stays 503',async()=>{
    let r=await fetch(publicUrl+'/missing');assert.equal(r.status,404);assert.match(r.headers.get('x-robots-tag'),/noindex/);assert.doesNotMatch(await r.text(),/rel="canonical"/);
    assert.equal((await fetch(publicUrl+'/broken')).status,503);
  });
  await t.test('source robots, alternate root, nested map and compressed map',async()=>{
    const robots=await(await fetch(publicUrl+'/robots.txt')).text();assert.match(robots,/Disallow: \/admin/);assert.match(robots,new RegExp(publicUrl+'/sitemap.xml'));
    let xml=await(await fetch(publicUrl+'/sitemap.xml')).text();assert.match(xml,/<sitemapindex/);assert.match(xml,/sitemap_index.xml/);
    xml=await(await fetch(publicUrl+'/sitemap_index.xml')).text();assert.match(xml,new RegExp(publicUrl+'/maps/children.xml.gz'));
    const r=await fetch(publicUrl+'/maps/children.xml.gz');assert.match(r.headers.get('content-type'),/xml/);assert.match(await r.text(),new RegExp(publicUrl+'/page'));
  });
  await t.test('binary response remains byte-identical and CSS URL is rewritten',async()=>{
    assert.deepEqual(Buffer.from(await(await fetch(publicUrl+'/binary')).arrayBuffer()),Buffer.from([0,255,128,3]));
    assert.match(await(await fetch(publicUrl+'/style.css')).text(),new RegExp(publicUrl+'/img.png'));
  });
  await t.test('read-only proxy, host redirect and host-independent health',async()=>{
    assert.equal((await fetch(publicUrl+'/echo',{method:'POST',body:'test'})).status,405);
    let r=await rawGet(publicUrl+'/page',{host:'alias.example'});assert.equal(r.status,308);assert.equal(r.headers.location,publicUrl+'/page');
    r=await rawGet(publicUrl+'/healthz',{host:'healthcheck.railway.app'});assert.equal(r.status,200);
  });
  await t.test('bounded text and upstream timeout return explicit server errors',async()=>{
    assert.equal((await fetch(publicUrl+'/large')).status,502);
    assert.equal((await fetch(publicUrl+'/slow')).status,504);
  });
  await t.test('explicitly enabled writes preserve request body and trusted origin',async()=>{
    c.allowWrite=true;
    const r=await fetch(publicUrl+'/echo',{method:'POST',body:'hello=world',headers:{origin:publicUrl,'content-type':'application/x-www-form-urlencoded'}});
    const x=await r.json();assert.equal(x.body,'hello=world');assert.equal(received.origin,source);assert.equal(x.origin,publicUrl);
    assert.equal((await fetch(publicUrl+'/echo',{method:'POST',body:'x',headers:{origin:'https://evil.example'}})).status,403);
  });
});

test('sitemap probes resolve source canonical aliases and exclude known 404/noindex',async t=>{
  const {SitemapProbe}=await import('../src/sitemap-probe.mjs');
  const {transformSitemap}=await import('../src/seo.mjs');
  let source;
  const upstream=http.createServer((req,res)=>{
    if(req.url==='/gone'){res.writeHead(404);return res.end();}
    if(req.url==='/redirect'){res.writeHead(301,{location:'/current'});return res.end();}
    res.setHeader('Content-Type','text/html');
    if(req.url==='/private')return res.end('<meta name="robots" content="noindex">');
    res.end(`<link rel="canonical" href="${source}/current"><title>Current</title>`);
  });
  source=await listen(upstream);t.after(()=>stop(upstream));
  const c=createConfig({PUBLIC_ORIGIN:'https://mirror.example',UPSTREAM_ORIGIN:source});
  const probe=new SitemapProbe(c);
  const xml='<urlset>'+['/alias','/current','/gone','/private','/redirect'].map(p=>`<url><loc>${source+p}</loc></url>`).join('')+'</urlset>';
  const progress=await probe.validate(xml,source);
  assert.equal(progress.checked,5);
  const r=transformSitemap(xml,source,c,{resolvePage:probe.resolve});
  assert.equal(r.entries,1);assert.match(r.xml,/https:\/\/mirror.example\/current/);assert.doesNotMatch(r.xml,/gone|private|alias|redirect/);
});
