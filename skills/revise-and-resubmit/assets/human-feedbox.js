(()=>{
'use strict';
const source=window.RR_REVIEW;
const trigger=document.getElementById('feed-trigger'),dialog=document.getElementById('feed-dialog'),reaction=document.getElementById('feed-reaction'),status=document.getElementById('feed-status');
const saveButton=document.getElementById('feed-save')||document.getElementById('feed-copy');
if(!source||!saveButton||!dialog)return;
saveButton.id='feed-save';saveButton.textContent='保存';
document.getElementById('feed-preview')?.remove();trigger.textContent='指摘を書く';
let selected=null,active=null,session=null,requestId=null,saving=false;
const sessionReady=location.protocol==='file:' ? Promise.resolve(null) : fetch('/api/session',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error();return r.json();}).then(s=>session=s).catch(()=>null);
reaction.addEventListener('input',()=>{requestId=null;status.textContent='';});
function inspectSelection(){
 if(dialog.open)return;
 const sel=window.getSelection();
 if(!sel||sel.isCollapsed||!sel.rangeCount){trigger.hidden=true;return;}
 const range=sel.getRangeAt(0),elem=n=>n.nodeType===1?n:n.parentElement;
 const start=elem(range.startContainer)?.closest('.copy'),end=elem(range.endContainer)?.closest('.copy');
 if(!start||start!==end){trigger.hidden=true;return;}
 const quote=range.toString().trim();
 if(!quote){trigger.hidden=true;return;}
 selected={quote,paragraph:Number(start.id.slice(1))};
 const box=range.getBoundingClientRect();trigger.hidden=false;
 trigger.style.left=Math.max(8,Math.min(box.left,innerWidth-140))+'px';
 trigger.style.top=Math.max(8,Math.min(box.bottom+8,innerHeight-50))+'px';
}
document.addEventListener('pointerup',()=>setTimeout(inspectSelection,0));
document.addEventListener('keyup',inspectSelection);
document.addEventListener('selectionchange',()=>{if(!dialog.open&&window.getSelection()?.isCollapsed)trigger.hidden=true;});
window.addEventListener('scroll',()=>trigger.hidden=true,true);
trigger.addEventListener('pointerdown',e=>e.preventDefault());
trigger.addEventListener('click',async()=>{
 if(!selected)return;
 active={...selected};requestId=null;trigger.hidden=true;
 document.getElementById('feed-quote').textContent=active.quote;
 document.getElementById('feed-location').textContent='P'+active.paragraph;
 reaction.value='';status.textContent='';saveButton.textContent='保存';saveButton.disabled=true;
 dialog.showModal();reaction.focus();
 await sessionReady;
 if(session&&session.source_sha256===source.source_sha256)saveButton.disabled=false;
 else status.textContent='保存するには、プレビューサーバーのURLからこの画面を開いてください。';
});
document.getElementById('feed-close').onclick=()=>{if(!saving)dialog.close();};
dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
saveButton.onclick=async()=>{
 if(saving||!active||!session)return;
 if(!reaction.value.trim()){status.textContent='指摘事項を入力してください。';reaction.focus();return;}
 requestId=requestId||crypto.randomUUID();saving=true;saveButton.disabled=true;reaction.disabled=true;status.textContent='保存中…';
 try{
  const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token},body:JSON.stringify({...active,reaction:reaction.value.trim(),source_sha256:source.source_sha256,request_id:requestId})});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||'保存できませんでした。');}
  const result=await response.json();
  if(!result.comment)throw new Error('保存結果を確認できませんでした。');
  status.textContent='保存しました。';saveButton.textContent='保存済み';
  location.reload();
 }catch(error){status.textContent=error.message+' 入力を残しています。再度保存してください。';saveButton.disabled=false;}
 finally{saving=false;reaction.disabled=false;}
};
})();
