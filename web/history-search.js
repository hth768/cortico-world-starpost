// Search stays in a dialog so closing it preserves the chat draft and scroll position.
function openHistorySearch(conversation, title, mode='social') {
  const identity=state.account?.humanId, botId=state.botId;
  const prefix=mode==='owner'?'owner':mode==='readonly'?'history':'social.history';
  const source={kind:conversation.kind,target:conversation.target,...(mode==='social'?{}:{viewerBotId:botId})};
  const overlay=el('div','dialog'),box=el('section','dialog-card history-search');
  const header=el('div','chat-heading'),heading=el('h2','','查找聊天记录');
  const back=button('←',backToSearch);back.setAttribute('aria-label','返回搜索结果');back.dataset.historyAction='true';back.hidden=true;
  add(header,back,heading,button('关闭',()=>overlay.remove()));
  const form=el('form','history-search-form'),query=field('关键词'),start=field('开始日期','date'),end=field('结束日期','date');
  query.input.maxLength=100;query.input.placeholder='输入聊过的内容';
  const dates=el('details'),datesTitle=el('summary','','按日期筛选（北京时间）'),range=el('div','history-date-range');
  add(range,start.wrap,end.wrap);add(dates,datesTitle,range);
  const submit=button('搜索',()=>{});submit.type='submit';
  add(form,query.wrap,dates,submit,el('small','muted','搜索本会话保留的文字；点击结果查看上下文。'));
  const status=el('p','muted'),results=el('div','history-search-results'),context=el('div','history-search-context');
  status.setAttribute('role','status');context.hidden=true;
  add(box,header,el('small','muted',title),form,status,results,context);overlay.append(box);mountDialog(overlay);
  let busy=false,filters={},next=null,total=0,contextAnchor='';
  function backToSearch(){context.hidden=true;back.hidden=true;form.hidden=results.hidden=false;heading.textContent='查找聊天记录';status.textContent=`已找到 ${total} 条`;clear(context);}
  const valid=()=>overlay.isConnected&&state.account?.humanId===identity&&(mode==='social'||state.botId===botId);
  function loading(value){busy=value;submit.disabled=value;box.setAttribute('aria-busy',String(value));for(const b of box.querySelectorAll('[data-history-action]'))b.disabled=value;}
  function action(text,fn){const b=button(text,fn);b.dataset.historyAction='true';return b;}
  async function search(more=false){
    if(busy)return;
    const selected=more?filters:{query:query.input.value.trim(),startDate:start.input.value,endDate:end.input.value};
    loading(true);status.textContent='正在搜索…';
    try {
      const page=await rpc(`${prefix}.search`,{...source,...selected,...(more?{before:next}:{})});
      if(!valid())return;
      if(!more){clear(results);total=0;}else results.querySelector('.history-search-more')?.remove();
      filters=selected;next=page.nextBefore;
      for(const m of page.messages){
        const row=action('',()=>openContext(m.id));row.className='history-search-result';
        add(row,titled(el('strong','',m.senderNickname||m.sender||'消息'),m.senderTitle,m.senderTitleStyle),el('small','muted',fullDate(m.at)),el('span','history-search-preview',(m.text||'')+(m.emoji||'')||(m.hasImage?'[图片]':'[聊天记录]')),el('small','history-open','查看上下文 →'));results.append(row);
      }
      total+=page.messages.length;
      status.textContent=total?`已找到 ${total} 条${next?' · 可继续搜索更早记录':' · 已搜索完符合条件的保留记录'}`:next?'这批记录没有匹配，可继续搜索更早记录。':'没有找到匹配的聊天记录。';
      if(next){const moreButton=action('继续搜索更早记录',()=>search(true));moreButton.classList.add('history-search-more');results.append(moreButton);}
    }catch(e){if(valid())status.textContent=e.message;}finally{loading(false);}
  }
  async function openContext(id){
    if(busy)return;loading(true);status.textContent='正在读取上下文…';
    try {
      const page=await rpc(`${prefix}.context`,{...source,messageId:id});
      if(!valid())return;
      clear(context);contextAnchor=page.anchorId;form.hidden=results.hidden=true;context.hidden=false;back.hidden=false;heading.textContent='消息上下文';status.textContent='';
      if(page.hasOlder)context.append(action('继续查看更早上下文',()=>openContext(page.messages[0].id)));
      for(const m of page.messages){
        const row=el('article','history-context-message'+(m.id===contextAnchor?' anchor':''));
        const author=m.senderNickname||m.sender||'消息';
        add(row,titled(el('strong','',author),m.senderTitle,m.senderTitleStyle),el('small','muted',fullDate(m.at)),el('p','',(m.text||'')+(m.emoji||'')));
        if(m.id===contextAnchor){row.setAttribute('aria-label','定位消息');row.prepend(el('small','history-open','定位消息'));}
        if(m.quote)row.append(el('blockquote','',`${m.quote.senderNickname||'引用'}：${m.quote.text||'[图片]'}`));
        if(m.forward)row.append(el('p','muted',`[聊天记录 · ${m.forward.count} 条]\n${(m.forward.preview||[]).join('\n')}`));
        const image=picture(m.image);if(image)row.append(image);context.append(row);
      }
      if(page.hasNewer)context.append(action('继续查看较新上下文',()=>openContext(page.messages.at(-1).id)));
      requestAnimationFrame(()=>context.querySelector('.anchor')?.scrollIntoView({block:'center'}));
    }catch(e){if(valid())status.textContent=e.message;}finally{loading(false);}
  }
  function fullDate(at){try{return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(at));}catch{return at||'';}}
  form.onsubmit=e=>{e.preventDefault();void search();};query.input.focus();
}
