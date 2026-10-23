import { rewriteText } from './urls.mjs';

// React Flight has newline-delimited JSON rows AND length-prefixed text/binary rows.
// Replacing a URL inside a T row requires updating its hexadecimal UTF-8 byte length.
export function rewriteFlight(input,c) {
  const data=Buffer.from(input), out=[];
  let offset=0;
  while(offset<data.length) {
    const colon=data.indexOf(0x3a,offset);
    if(colon<offset || colon-offset>32 || !/^[0-9a-f]*$/i.test(data.subarray(offset,colon).toString())) throw new Error('Unsupported Flight row header');
    const start=colon+1, tag=String.fromCharCode(data[start]);
    if('TAOoUSsLlGgMmV'.includes(tag)) {
      const comma=data.indexOf(0x2c,start+1);
      if(comma<0 || comma-start>16) throw new Error('Invalid Flight length');
      const raw=data.subarray(start+1,comma).toString();
      if(!/^[0-9a-f]+$/i.test(raw)) throw new Error('Invalid Flight length');
      const length=parseInt(raw,16), end=comma+1+length;
      if(end>data.length) throw new Error('Incomplete Flight row');
      const body=data.subarray(comma+1,end);
      if(tag==='T') {
        const changed=Buffer.from(rewriteText(body.toString('utf8'),c));
        out.push(data.subarray(offset,start+1),Buffer.from(changed.length.toString(16)+','),changed);
      } else out.push(data.subarray(offset,end));
      offset=end;
    } else {
      const newline=data.indexOf(0x0a,start);
      if(newline<0) throw new Error('Incomplete Flight JSON row');
      out.push(Buffer.from(rewriteText(data.subarray(offset,newline+1).toString('utf8'),c)));
      offset=newline+1;
    }
  }
  return Buffer.concat(out).toString('utf8');
}
export function rewriteInlineFlight($,c) {
  const chunks=[];
  $('script:not([src])').each((_,el)=>{
    const code=$(el).html() || '';
    const m=/^(\s*self\.__next_f\.push\()(\[[\s\S]*\])(\)\s*;?\s*)$/.exec(code);
    if(!m) return;
    try {
      const tuple=JSON.parse(m[2]);
      if(tuple[0]===1 && typeof tuple[1]==='string') chunks.push({el,tuple,prefix:m[1],suffix:m[3],length:tuple[1].length});
    } catch { /* JavaScript expressions are never evaluated. */ }
  });
  const handled=new Set(chunks.map(x=>x.el));
  if(!chunks.length) return handled;
  try {
    const changed=rewriteFlight(chunks.map(x=>x.tuple[1]).join(''),c);
    let offset=0;
    chunks.forEach((chunk,i)=>{
      const end=i===chunks.length-1 ? changed.length : Math.min(offset+chunk.length,changed.length);
      chunk.tuple[1]=changed.slice(offset,end); offset=end;
      // Safe in an HTML script context even if upstream text contains literal closing-script syntax.
      const json=JSON.stringify(chunk.tuple).replaceAll('<','\\u003c');
      $(chunk.el).text(chunk.prefix+json+chunk.suffix);
    });
  } catch(e) {
    console.warn(JSON.stringify({event:'flight_rewrite_skipped',message:e.message}));
    // Retain original intact data rather than return a malformed React stream.
  }
  return handled;
}
