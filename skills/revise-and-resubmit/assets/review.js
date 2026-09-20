(()=>{
'use strict';
const data=window.RR_REVIEW;
if(!data){document.getElementById('manuscript').textContent='レビューデータを読み込めませんでした。';return;}
document.getElementById('review-title').textContent=data.title;
// Fixed, decorative vector artwork; reviewer names provide accessible labels.
const reviewerArtwork={"mind-tail": "<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M22 27 15 20 10 29 13 44 21 40M42 27 49 20 54 29 51 44 43 40M22 25Q32 18 42 25L44 43Q42 53 32 53Q22 53 20 43Z\"/><path d=\"m29 39 3 3 3-3Z M32 42v4m-5 0q5 5 10 0\"/><circle cx=\"26\" cy=\"33\" r=\"1\" fill=\"currentColor\"/><circle cx=\"38\" cy=\"33\" r=\"1\" fill=\"currentColor\"/></g>", "paper-plot": "<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m17 28-1-10 11 5h10l11-5-1 10v13q-1 13-15 14Q18 54 17 41Z\"/><circle cx=\"25\" cy=\"34\" r=\"8\"/><circle cx=\"39\" cy=\"34\" r=\"8\"/><path d=\"m29 44 3 4 3-4\"/><circle cx=\"25\" cy=\"34\" r=\"1.5\" fill=\"currentColor\"/><circle cx=\"39\" cy=\"34\" r=\"1.5\" fill=\"currentColor\"/></g>", "slob-police": "<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 26Q19 15 32 15Q45 15 44 26L54 23L50 36L45 38L44 46Q41 55 32 55Q23 55 20 46L19 38L14 36L10 23Z\"/><path d=\"M20 29l9 4m6 0 9-4M25 35h2m10 0h2M30 35l-3 7h10l-3-7M23 46q9 5 18 0M24 46l2-5 3 7m6 0 3-7 2 5M28 20h8\"/></g>", "human-feedbox": "<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M24 43v7l-11 6m26-13v7l12 6M22 29q-2-13 10-13t12 13v8q-1 11-12 12-10-2-10-12Z M22 29q11-1 15-7l7 7M24 50l8 7 7-7\"/><path d=\"M28 37h0m9 0h0m-8 6h6\"/></g>"};
function addReviewerIcon(node,role){
 const artwork=reviewerArtwork[role];if(!artwork)return;
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.setAttribute('viewBox','6 10 52 50');svg.setAttribute('class','reviewer-icon');
 svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
 svg.innerHTML=artwork;node.prepend(svg);
}
const labels={human:'本人の感想',hypothesis:'構造上の仮説',stop:'離脱',observation:'理解の観察'};
// Add persisted human selections to the existing redline without editing HTML attributes.
function markQuote(body,quote){
 if(!quote)return;
 const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),nodes=[];
 let node,offset=0;
 while((node=walker.nextNode())){nodes.push({node,start:offset,end:offset+node.length});offset+=node.length;}
 const text=nodes.map(x=>x.node.data).join(''),start=text.indexOf(quote);
 if(start<0)return;
 const end=start+quote.length;
 for(const part of nodes.reverse()){
  if(part.end<=start||part.start>=end||part.node.parentElement.closest('mark'))continue;
  const from=Math.max(0,start-part.start),to=Math.min(part.node.length,end-part.start);
  const range=document.createRange();range.setStart(part.node,from);range.setEnd(part.node,to);
  const mark=document.createElement('mark');range.surroundContents(mark);
 }
}
for(const p of data.paragraphs){
 const row=document.createElement('section');row.className='row';
 const copy=document.createElement('div');copy.className='copy';copy.id='p'+p.number;
 const num=document.createElement('small');num.textContent='P'+p.number;copy.append(num);
 const body=document.createElement('p');body.innerHTML=p.html;for(const c of data.comments.filter(c=>c.paragraph===p.number))markQuote(body,c.quote);copy.append(body);row.append(copy);
 const aside=document.createElement('aside');
 for(const c of data.comments.filter(c=>c.paragraph===p.number)){
  const note=document.createElement('article');note.className='note';note.dataset.role=c.role;
  const label=document.createElement('div');label.className='label';label.textContent=c.role==='human-feedbox'?c.role:c.id+' · '+c.role;addReviewerIcon(label,c.role);
  if(c.status && c.status!=='観察'){
   const check=document.createElement('input');check.type='checkbox';check.className='review-check';
   check.setAttribute('aria-label',(c.role==='human-feedbox'?c.role:c.id+' '+c.role)+'の指摘を確認済みにする');
   const key='rr-checked:'+data.source_sha256+':'+location.pathname+':'+c.id;
   try{check.checked=localStorage.getItem(key)==='true';}catch(_){}
   const update=()=>note.classList.toggle('review-checked',check.checked);
   update();check.addEventListener('change',()=>{update();try{localStorage.setItem(key,String(check.checked));}catch(_){}});
   label.append(check);
  }
  const msg=document.createElement('p');msg.textContent=c.comment;msg.style.whiteSpace='pre-line';
  const kind=document.createElement('small');kind.textContent=labels[c.kind]||c.kind;if(c.kind==='stop')kind.className='reader-exit';
  note.append(label);
  if(c.quote){const quote=document.createElement('blockquote');quote.className='note-quote';quote.textContent=c.quote;note.append(quote);}
  note.append(msg);if(c.kind==='stop')note.append(kind);aside.append(note);
 }
 row.append(aside);document.getElementById('manuscript').append(row);
}
const present=new Set(data.comments.map(c=>c.role));
const roles=['all',...['mind-tail','paper-plot','slob-police'].filter(r=>present.has(r)),...[...present].filter(r=>!['mind-tail','paper-plot','slob-police','human-feedbox'].includes(r)),...(present.has('human-feedbox')?['human-feedbox']:[])];
for(const role of roles){
 const b=document.createElement('button');b.dataset.filter=role;b.textContent=role==='all'?'すべて':role;b.classList.toggle('active',role==='all');b.setAttribute('aria-pressed',role==='all');addReviewerIcon(b,role);
 b.onclick=()=>{document.querySelectorAll('#role-filters button').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',x===b)});document.querySelectorAll('.note').forEach(n=>n.classList.toggle('hidden',role!=='all'&&n.dataset.role!==role))};document.getElementById('role-filters').append(b);
}
})();
