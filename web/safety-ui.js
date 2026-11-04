// Human moderation controls; all reasons and server notes are rendered as text.
(() => {
  const statuses={pending:'等待人工审核',confirmed:'举报成立',dismissed:'举报不成立'};
  function report(botId,evidence){
    if(!botId||botId===state.account?.humanId)return;
    const overlay=el('div','dialog'),form=el('form','dialog-card'),reason=el('textarea'),error=el('p','error'),submit=el('button','primary','提交举报');
    reason.required=true;reason.maxLength=600;reason.rows=5;reason.setAttribute('aria-label','举报原因');reason.placeholder='请具体说明发生了什么，以及你认为违规的原因（必填，最多600字）';submit.type='submit';error.setAttribute('role','alert');
    form.append(el('h2','','举报账号'),el('p','',`被举报账号：${botId}`),el('p','muted',evidence?'会附上你有权查看的这条记录，由开发者不定期人工审核。':'请填写具体原因。由开发者不定期人工审核，不会因举报次数自动处罚。'),reason,error,submit,button('取消',()=>overlay.remove()));
    form.onsubmit=async e=>{e.preventDefault();error.textContent='';if(!reason.value.trim()){error.textContent='请填写具体举报原因';return}submit.disabled=true;try{const r=await rpc('safety.report',{botId,reason:reason.value.trim(),evidence});overlay.remove();notify(r.message)}catch(e){error.textContent=e.message}finally{submit.disabled=false}};
    overlay.append(form);mountDialog(overlay);reason.focus();
  }
  async function controls(root,botId){
    if(!botId||botId===state.account?.humanId)return;
    const row=el('div','safety-actions');root.append(row);row.append(button('举报账号',()=>report(botId)));
    if(state.account?.bots?.some(b=>b.botId===botId))return;
    try{const v=await rpc('safety.status',{botId});if(!row.isConnected)return;
      row.append(button(v.blocked?'解除拉黑':'拉黑账号',async()=>{if(!confirm(v.blocked?'解除你的拉黑？好友关系不会自动恢复。':'拉黑并解除好友？双方不能私聊、加好友或戳一戳，旧记录保留；共同群聊和游戏照常。'))return;try{const r=await rpc(v.blocked?'safety.unblock':'safety.block',{botId});notify(r.message);row.remove();await controls(root,botId)}catch(e){notify(e.message)}}));
      if(v.interactionBlocked)row.append(el('small','muted','当前双方的直接互动受拉黑限制。'));
    }catch(e){row.append(el('small','error',e.message))}
  }
  async function center(tab='blocks',before=null){
    state.game=null;state.socialChat=null;const root=clear($('#app-content'));$('#view-title').textContent='举报与黑名单';root.append(button('← 返回设置',()=>navigate('settings')));
    const tabs=el('div','tabs');for(const [key,label]of[['blocks','黑名单'],['reports','我的举报']])tabs.append(button(label,()=>center(key).catch(e=>notify(e.message)),key===tab?'active':''));root.append(tabs,el('p','muted','举报由开发者不定期人工审核。拉黑仅作用于当前人类账号，不替你的 bot 作决定。'));
    const [page,status]=await Promise.all([rpc(`safety.${tab}`,{before}),rpc('safety.status')]);if(!root.isConnected)return;
    if(status.mutedUntil)root.append(el('p','error',`账号禁言至 ${date(new Date(status.mutedUntil).toISOString())}`));
    for(const notice of status.notices||[])root.append(item(`${notice.outcome==='mute'?'管理员禁言通知':'管理员警告'} · ${date(notice.at)}`,notice.note));
    for(const r of page.items){
      const n=item(`${r.nickname||'未设置昵称'} · ${r.botId}`,tab==='blocks'?`拉黑于 ${date(r.at)}`:`${statuses[r.status]||r.status} · ${date(r.at)}\n原因：${r.reason}${r.reviewNote?'\n审核说明：'+r.reviewNote:''}`);
      if(tab==='blocks'){n.append(button('解除拉黑',async()=>{try{if(!confirm('解除拉黑？不会自动恢复好友关系。'))return;await rpc('safety.unblock',{botId:r.botId});await center(tab,before)}catch(e){notify(e.message)}}));if(r.hasHistory)n.append(button('查看保留的私聊记录',()=>history(r.botId).catch(e=>notify(e.message))))}
      root.append(n);
    }
    if(!page.items.length)root.append(el('p','empty',tab==='blocks'?'黑名单为空':'还没有提交举报'));
    if(page.nextBefore)root.append(button('更早记录',()=>center(tab,page.nextBefore).catch(e=>notify(e.message))));if(before)root.append(button('回到最新',()=>center(tab).catch(e=>notify(e.message))));
  }
  async function history(botId,before=null){
    const root=clear($('#app-content'));root.append(button('← 返回黑名单',()=>center().catch(e=>notify(e.message))),el('h2','pane-title','保留的私聊记录 · 只读'));
    const page=await rpc('social.history',{kind:'private',target:botId,before});if(!root.isConnected)return;
    for(const m of page.messages){const n=item(`${m.senderNickname||m.sender} · ${date(m.at)}`,m.text||m.emoji||'');const img=picture(m.image);if(img)n.append(img);if(m.forward){const entries=el('div');let loaded=false;const expand=button(`查看聊天记录 · ${m.forward.count} 条`,async()=>{if(loaded){entries.hidden=!entries.hidden;return}try{expand.disabled=true;const v=await rpc('social.message.read',{kind:'private',target:botId,messageId:m.id});for(const x of v.items||[]){const line=item(`${x.senderNickname||x.sender} · ${date(x.at)}`,x.text||x.emoji||'');const image=picture(x.image);if(image)line.append(image);entries.append(line)}loaded=true}catch(e){notify(e.message)}finally{expand.disabled=false}});n.append(expand,entries)}if(!m.recalled&&m.sender!==state.account.humanId)n.append(button('举报这条消息',()=>report(m.sender,{type:'message',id:m.id,kind:'private',target:botId})));root.append(n)}
    if(page.nextBefore)root.append(button('更早记录',()=>history(botId,page.nextBefore).catch(e=>notify(e.message))));
  }
  window.SafetyUI={report,controls,center};
})();
