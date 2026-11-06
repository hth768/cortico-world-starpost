// Human message interactions. Forward cards load their full record only on explicit open.
(() => {
  let current='', quote=null, selected=new Set(), toolbar=null, quoteBar=null;
  const ctxKey=c=>`${state.account?.humanId}:${c.mode}:${c.kind}:${c.target}`;
  const request=c=>({kind:c.kind,target:c.target});
  const apiAction=(c,name)=>c.mode==='owner'?`owner.${name}`:c.mode==='readonly'?`message.${name}`:`social.message.${name}`;
  function enter(c){const key=ctxKey(c);if(current!==key){current=key;quote=null;selected.clear();toolbar?.remove();quoteBar?.remove();toolbar=null;quoteBar=null;}}
  function reply(c){enter(c);return quote?.id;}
  function clearReply(c){if(current!==ctxKey(c))return;quote=null;quoteBar?.remove();quoteBar=null;}
  function bind(c,composer){enter(c);c.composer=composer;c.key=current;paintQuote(c);}
  function paintQuote(c){quoteBar?.remove();if(!quote||!c.composer?.isConnected)return;quoteBar=el('div','message-quote-draft');quoteBar.append(el('span','',`引用 ${quote.senderNickname||quote.address||'消息'}：${quote.text|| (quote.forward?'[聊天记录]':'[图片]')}`),button('取消引用',()=>clearReply(c)));c.composer.before(quoteBar);}
  function menu(c,m){
    document.querySelectorAll('.message-menu').forEach(node=>node.remove());
    if(!c.detached)enter(c);const overlay=el('div','dialog message-menu'),box=el('div','dialog-card'),grid=el('div','message-actions');
    const action=(label,fn)=>grid.append(button(label,()=>{overlay.remove();Promise.resolve(fn()).catch(e=>notify(e.message))}));
    box.append(el('h2','','消息操作'));action('复制',()=>copy(m));
    if(c.mode!=='readonly'&&!m.recalled){
      action('引用',()=>{quote=m;paintQuote(c);c.composer?.querySelector('textarea')?.focus()});
      const mine=c.mode==='owner'?m.direction==='human':m.sender===state.account.humanId;
      if(mine&&Date.now()-Date.parse(m.at)<=120000)action('撤回',async()=>{if(!confirm('撤回这条消息？'))return;await rpc(apiAction(c,'recall'),{...request(c),messageId:m.id});if(quote?.id===m.id)clearReply(c);await c.refresh()});
      action('转发',()=>forward(c,[m.id]));action('多选',()=>{selected.add(m.id);selection(c)});
    }
    if(m.image&&!m.recalled)action('保存表情',async()=>{await saveSticker(m.image);notify('已保存到表情包栏')});
    if(!c.detached&&!m.recalled&&m.sender&&m.sender!==state.account?.humanId)action('举报',()=>SafetyUI.report(m.sender,{type:'message',id:m.id,...request(c),...(c.mode==='readonly'?{viewerBotId:state.botId}:{})}));
    box.append(grid,button('取消',()=>overlay.remove()));overlay.append(box);mountDialog(overlay);
  }
  async function copy(m){
    if(m.image&&navigator.clipboard?.write&&window.ClipboardItem){
      const blob=await(await fetch(`data:${m.image.mime};base64,${m.image.base64}`)).blob(),bitmap=await createImageBitmap(blob);
      try{if(bitmap.width*bitmap.height>40000000)throw Error('图片尺寸过大，无法复制');const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);const png=await new Promise(r=>canvas.toBlob(r,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':png,...(m.text?{'text/plain':new Blob([m.text],{type:'text/plain'})}:{})})]);}finally{bitmap.close()}
    }else await navigator.clipboard.writeText((m.text||'')+(m.emoji||'')+(m.forward?`\n[聊天记录 · ${m.forward.count} 条]\n${m.forward.preview.join('\n')}`:m.image?'[图片]':''));
    notify('已复制');
  }
  function selection(c){
    toolbar?.remove();const log=c.log;if(!log?.isConnected)return;
    if(selected.size){toolbar=el('div','message-selection');toolbar.append(el('strong','',`已选 ${selected.size}/20 条`),button('合并转发',()=>forward(c,[...selected])),button('取消',()=>{selected.clear();selection(c)}));log.before(toolbar)}
    for(const row of log.querySelectorAll('[data-message-id]')){row.classList.toggle('message-selected',selected.has(row.dataset.messageId));const checkbox=row.querySelector('.message-checkbox');if(checkbox){checkbox.hidden=!selected.size;checkbox.checked=selected.has(row.dataset.messageId)}}
  }
  function toggle(c,id){if(selected.has(id))selected.delete(id);else if(selected.size<20)selected.add(id);else notify('最多选择 20 条消息');selection(c)}
  function attach(row,bubble,m,c){
    if(!c.detached)enter(c);row.dataset.messageId=m.id;
    if(m.quote){const q=el('div','message-quote',`${m.quote.senderNickname||m.quote.sender}：${m.quote.text|| (m.quote.hasImage?'[图片]':'')}`);q.prepend(accountBadge(m.quote.senderTitle,m.quote.senderTitleStyle));bubble.prepend(q)}
    if(m.forward&&!m.recalled){const card=el('button','forward-card');card.type='button';card.append(el('strong','',`聊天记录 · ${m.forward.count} 条`));for(const line of m.forward.preview||[])card.append(el('span','',line));card.append(el('small','','查看完整聊天记录 →'));card.onclick=e=>{e.stopPropagation();if(selected.size&&c.mode!=='readonly')toggle(c,m.id);else void open(c,m).catch(e=>notify(e.message))};bubble.append(card)}
    if(m.recalled){row.classList.add('message-recalled');if(selected.delete(m.id))selection(c);}
    if(c.mode!=='readonly'&&!m.recalled){const check=el('input','message-checkbox');check.type='checkbox';check.setAttribute('aria-label','选择这条消息');check.hidden=!selected.size;check.checked=selected.has(m.id);check.onchange=()=>toggle(c,m.id);row.prepend(check)}
    bubble.tabIndex=0;bubble.setAttribute('aria-label','消息，长按打开操作菜单');
    bubble.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();menu(c,m)},true);
    bubble.onkeydown=e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){e.preventDefault();menu(c,m)}};
    let timer,start,pressed=false;
    bubble.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;pressed=false;start=[e.clientX,e.clientY];avatarGestureUntil=Date.now()+2000;timer=setTimeout(()=>{pressed=true;menu(c,m)},550)});
    const stop=()=>clearTimeout(timer);bubble.addEventListener('pointermove',e=>{if(start&&Math.hypot(e.clientX-start[0],e.clientY-start[1])>10)stop()});bubble.addEventListener('pointerup',stop);bubble.addEventListener('pointercancel',stop);bubble.addEventListener('pointerleave',stop);
    bubble.addEventListener('click',e=>{if(pressed){e.preventDefault();e.stopPropagation();pressed=false}else if(selected.size&&c.mode!=='readonly'){e.preventDefault();e.stopPropagation();toggle(c,m.id)}},true);
    if(quote?.id===m.id&&m.recalled)clearReply(c);
    row.classList.toggle('message-selected',selected.has(m.id));
  }
  async function open(c,m){
    const data=await rpc(apiAction(c,'read'),{...request(c),messageId:m.id});
    const overlay=el('div','dialog forward-dialog'),box=el('div','dialog-card');box.append(el('h2','','完整聊天记录'),el('p','muted','这是转发时保存的记录，保留原作者和发送时间。'));
    if(data.message.recalled)box.append(el('p','','该记录已撤回'));
    for(const record of data.items||[]){const card=el('article','forward-entry');card.append(accountBadge(record.senderTitle,record.senderTitleStyle),el('small','',`${record.senderNickname||record.sender} · ${record.sender} · ${date(record.at)}`),el('p','',`${record.text||''}${record.emoji||''}`));const image=picture(record.image,false);if(image)card.append(image);attach(card,card,{...record,id:record.sourceMessageId},{...c,mode:'readonly',detached:true});box.append(card)}
    box.append(button('关闭',()=>overlay.remove()));overlay.append(box);mountDialog(overlay);
  }
  async function forward(c,ids){
    const key=ctxKey(c),contacts=await rpc('social.overview');
    if(key!==current)throw Error('会话已切换，请重新选择');
    const overlay=el('div','dialog'),box=el('div','dialog-card');box.append(el('h2','',`转发聊天记录 · ${ids.length} 条`),el('p','muted','选择接收对象。点击发送一张可展开的聊天记录卡片。'));let busy=false;
    const targets=[...(contacts.friendProfiles||[]).map(p=>({kind:'private',target:p.botId,label:p.remark||p.nickname||p.botId})),...(contacts.groups||[]).map(g=>({kind:'group',target:g.id,label:`群聊 · ${g.name}`})),...(state.botId?[{kind:'owner',target:state.botId,label:'我的 bot · 专属频道'}]:[])];
    for(const dest of targets)box.append(button(dest.label,async()=>{if(busy)return;busy=true;for(const b of box.querySelectorAll('button'))b.disabled=true;try{if(dest.kind==='owner'&&!state.address){const address=prompt('桌宠对你的称呼');if(!address)throw Error('未设置称呼，尚未发送');state.address=(await rpc('owner.address',{address})).address}await rpc(dest.kind==='owner'?'owner.send':'social.message.send',{kind:dest.kind,target:dest.target,text:'',forward:{source:request(c),messageIds:ids}});selected.clear();selection(c);overlay.remove();notify('聊天记录已转发');await c.refresh()}catch(e){notify(e.message)}finally{busy=false;for(const b of box.querySelectorAll('button'))b.disabled=false}}));
    if(!targets.length)box.append(el('p','muted','暂无可转发的好友、群聊或已绑定 bot'));
    box.append(button('取消',()=>overlay.remove()));overlay.append(box);mountDialog(overlay);
  }
  async function normalize(file){
    if(file.size>10*1024*1024||!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw Error('请选择 10 MB 以内的 PNG、JPEG、WebP 或 GIF');
    let blob=file;
    if(file.type!=='image/gif'){
      const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
      try{if(bitmap.width*bitmap.height>40000000)throw Error('请选择 4000 万像素以内的图片');const ratio=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);for(const q of [.85,.7,.5]){blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',q));if(blob&&blob.size<=1048576)break}}finally{bitmap.close()}
    }
    if(!blob||blob.size>1048576)throw Error('发送图片不能超过 1 MiB，请缩小图片；GIF 保留原动画');
    const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(blob)});return {mime:blob.type,base64};
  }
  function pick(send){const input=el('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/gif';input.hidden=true;document.body.append(input);input.oncancel=()=>input.remove();input.onchange=async()=>{const file=input.files[0];input.remove();if(!file)return;try{const image=await normalize(file),overlay=el('div','dialog'),box=el('div','dialog-card');box.append(el('h2','','发送图片'),picture(image));let busy=false;const b=button('发送图片',async()=>{if(busy)return;busy=true;b.disabled=true;try{await send(image);overlay.remove()}catch(e){notify(e.message)}finally{busy=false;b.disabled=false}},'primary');box.append(b,button('取消',()=>overlay.remove()));overlay.append(box);mountDialog(overlay)}catch(e){notify(e.message)}};input.click()}
  window.ChatActions={attach,bind,reply,clearReply,pick,normalize};
})();
