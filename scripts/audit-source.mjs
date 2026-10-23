import * as cheerio from 'cheerio';
import { createConfig } from '../src/config.mjs';
import { readLimited } from '../src/upstream.mjs';
const c=createConfig({...process.env,NODE_ENV:'development'});
const result={origin:c.upstreamOrigin,pages:[]};
for(const path of ['/','/robots.txt','/sitemap.xml']){
  try{
    const r=await fetch(c.upstreamOrigin+path,{redirect:'manual',signal:AbortSignal.timeout(c.timeout)});
    const text=(await readLimited(r,c.maxTextBytes)).toString('utf8');
    const row={path,status:r.status,type:r.headers.get('content-type'),location:r.headers.get('location')};
    if(path==='/'){
      const $=cheerio.load(text);row.canonical=$('link[rel~="canonical"]').attr('href');row.title=$('head > title').text();
      row.nextjs=text.includes('__next_f')||text.includes('/_next/');
    }
    if(path==='/robots.txt')row.sitemaps=[...text.matchAll(/^Sitemap:\s*(\S+)/gim)].map(m=>m[1]);
    if(path==='/sitemap.xml')row.urlCount=(text.match(/<url>/g)||[]).length;
    result.pages.push(row);
  }catch(e){result.pages.push({path,error:e.message});}
}
console.log(JSON.stringify(result,null,2));
