import * as cheerio from 'cheerio';
import { XMLValidator } from 'fast-xml-parser';
import { gunzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { readLimited } from '../src/upstream.mjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const base=args.find(v=>/^https?:\/\//.test(v)) || process.env.PUBLIC_ORIGIN;
if(!base){console.error('Usage: npm run audit:seo -- https://your-domain.example --limit 30 [--maps 100] [--output report.json]');process.exit(2);}
const origin=new URL(base).origin;
const limit=Number(option('--limit','30')), maxMaps=Number(option('--maps','100'));
if(!Number.isInteger(limit)||limit<1||!Number.isInteger(maxMaps)||maxMaps<1)throw new Error('Invalid --limit or --maps');
const report={origin,checkedAt:new Date().toISOString(),sitemaps:[],pages:[],issues:[],warnings:[],pageLimit:limit,mapLimit:maxMaps};
const add=(level,url,message)=>report[level].push({url,message});
const get=url=>fetch(url,{redirect:'manual',signal:AbortSignal.timeout(25000),headers:{'user-agent':'PortableMirrorSeoAudit/1.0','accept':'text/html,application/xml;q=0.9,*/*;q=0.5'}});
const queue=[origin+'/sitemap.xml'], visited=new Set(), pages=new Set();
try {
  const r=await get(origin+'/robots.txt'), text=(await readLimited(r,1024*1024)).toString();
  if(r.status!==200)add('issues',origin+'/robots.txt','robots.txt is not HTTP 200');
  for(const match of text.matchAll(/^\s*Sitemap\s*:\s*(\S+)/gim)){
    const u=new URL(match[1]); if(u.origin!==origin)add('issues',origin+'/robots.txt','Sitemap points outside the deployed origin: '+u.href);else queue.push(u.href);
  }
  if(/^\s*Disallow:\s*\/\s*$/im.test(text))add('warnings',origin+'/robots.txt','Found Disallow: / in a robots group; review whether it blocks your intended crawlers');
} catch(e){add('issues',origin+'/robots.txt',e.message);}
while(queue.length&&visited.size<maxMaps){
  const url=queue.shift();if(visited.has(url))continue;visited.add(url);
  try{
    const r=await get(url);if(r.status!==200){add('issues',url,'Sitemap HTTP '+r.status);await r.body?.cancel();continue;}
    let bytes=await readLimited(r,50*1024*1024);
    if(bytes[0]===31&&bytes[1]===139)bytes=gunzipSync(bytes,{maxOutputLength:50*1024*1024});
    const text=bytes.toString('utf8'),valid=XMLValidator.validate(text);
    if(valid!==true)throw new Error('Sitemap XML is invalid');
    const $=cheerio.load(text,{xml:true}), root=$.root().children().first(), name=root[0]?.name?.split(':').at(-1);
    if(!['urlset','sitemapindex'].includes(name))throw new Error('Not a sitemap XML root');
    const entries=root.children().toArray();report.sitemaps.push({url,kind:name,entries:entries.length});
    if(entries.length>50000)add('issues',url,'Sitemap has more than 50,000 entries');
    const localSeen=new Set();
    for(const el of entries){
      const raw=$(el).children().filter((_,n)=>n.name?.split(':').at(-1)==='loc').first().text().trim();
      let u;try{u=new URL(raw);}catch{add('issues',url,'Invalid or relative loc: '+raw);continue;}
      if(u.origin!==origin){add('issues',url,'Foreign canonical/sitemap URL: '+u.href);continue;}
      if(localSeen.has(u.href))add('issues',url,'Duplicate loc: '+u.href);localSeen.add(u.href);
      if(name==='sitemapindex')queue.push(u.href);else pages.add(u.href);
    }
  }catch(e){add('issues',url,e.message);}
}
if(queue.some(u=>!visited.has(u)))add('warnings',origin,'Sitemap scan stopped at --maps limit; audit is partial');
if(!pages.size)add('issues',origin,'No page URLs found in sitemap');
for(const url of [...pages].slice(0,limit)){
  try{
    const r=await get(url), record={url,status:r.status};report.pages.push(record);
    if(r.status!==200){add('issues',url,'Sitemap page HTTP '+r.status+(r.headers.has('location')?' redirects to '+r.headers.get('location'):''));await r.body?.cancel();continue;}
    const text=(await readLimited(r,20*1024*1024)).toString('utf8'), $=cheerio.load(text);
    if(!(r.headers.get('content-type')||'').includes('text/html')){add('warnings',url,'Non-HTML sitemap page; inspect manually');continue;}
    const canonicals=$('link[rel~="canonical"]');record.canonical=canonicals.first().attr('href');
    if(canonicals.length!==1)add('issues',url,'Expected exactly one canonical element');
    if(record.canonical!==url)add('issues',url,'Canonical differs from sitemap URL: '+record.canonical);
    if(!record.canonical?.startsWith(origin+'/'))add('issues',url,'Canonical does not use the public origin');
    const link=r.headers.get('link');if(link&&record.canonical&&!link.includes('<'+record.canonical+'>'))add('issues',url,'HTTP Link canonical conflicts with HTML');
    if(/\b(noindex|none)\b/i.test(r.headers.get('x-robots-tag')||''))add('issues',url,'Sitemap URL has X-Robots-Tag noindex');
    $('meta[name]').each((_,el)=>{if(/^(robots|googlebot)$/i.test($(el).attr('name')||'')&&/\b(noindex|none)\b/i.test($(el).attr('content')||''))add('issues',url,'Sitemap URL has meta noindex');});
    record.title=$('head > title').text().trim();
    if(!record.title)add('warnings',url,'Missing title');
    if(!$('meta[name="description"]').attr('content'))add('warnings',url,'Missing meta description');
    const inspect=data=>{
      if(Array.isArray(data))return data.forEach(inspect);
      if(!data||typeof data!=='object')return;
      if([data['@type']].flat().includes('BreadcrumbList')){
        const items=data.itemListElement;
        if(!Array.isArray(items)||items.length<2)add('issues',url,'BreadcrumbList must have at least two items');
        else items.forEach((v,i)=>{
          if(v.position!==i+1||!(v.name||v.item?.name))add('issues',url,'Invalid breadcrumb name/position');
          const item=typeof v.item==='string'?v.item:v.item?.['@id']||v.item?.url;
          if(i<items.length-1&&!/^https?:\/\//.test(item||''))add('issues',url,'Missing/invalid breadcrumb item URL');
        });
      }
      Object.values(data).forEach(inspect);
    };
    $('script[type="application/ld+json"]').each((_,el)=>{try{inspect(JSON.parse($(el).text()));}catch(e){add('issues',url,'Unparseable JSON-LD: '+e.message);}});
  }catch(e){add('issues',url,e.message);}
}
report.totalSitemapPages=pages.size;
if(pages.size>limit)add('warnings',origin,`Only ${limit} of ${pages.size} sitemap pages checked; increase --limit for a full audit`);
report.passed=report.issues.length===0;
report.scope='HTTP, canonical, sitemap, robots and basic JSON-LD checks. Not a Google eligibility validator; no browser hydration or Google indexing check.';
const output=option('--output',null);if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=report.passed?0:1;
