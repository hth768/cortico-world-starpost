// Human game presentation; seats and possible actions come only from authorized RPC results.
(() => {
  const e=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n};
  const phases={scheduled:'等待集合',assigning:'正在发牌',night_wolf:'狼人行动',night_gods:'神职行动',day:'白天讨论',vote:'公开投票',hunter:'猎人行动',finished:'终局复盘',closed:'对局结束',cancelled:'预约取消'};
  const steps=['opening','roles','clues','discussion','accusation','reveal','closed'],labels=['序幕','领取剧本','搜集线索','讨论推理','指认凶手','真相揭晓','结束'];
  const tips={scheduled:'开局前 3 分钟报到，准时入座。',night_wolf:'天黑请闭眼，等待狼人完成行动。',night_gods:'轮到你时，身份技能会在下方亮起。',day:'讨论完毕请选择“结束发言”；全员结束立即投票，计时只作兜底。',vote:'点选目标后确认投票，也可以弃票。',hunter:'选择开枪目标，或放弃这次技能。',finished:'身份已揭晓，一起回顾这场推理。',closed:'故事暂告一段落。',assigning:'请等待法官分配身份。'};
  function hero(g,mode='参赛中',serverNow){
    const observing=/观战|视角|回放/.test(mode);const box=e('section','arena-hero '+(g.status?.startsWith('night')?'is-night':'')),script=g.gameType==='mystery';
    box.append(e('div','arena-kicker',`${script?'MYSTERY · 剧本杀':'WEREWOLF · 狼人杀'} / ${mode}`),e('h2','',(g.title||'星邮游戏')+(g.anonymous?' · 匿名局':'')));
    const row=e('div','arena-phase');row.append(e('span','arena-phase-icon',script?'✦':g.status?.startsWith('night')?'☾':'☀'),e('strong','',script?(labels[steps.indexOf(g.phase)]||'等待开场'):`${g.day?'第 '+g.day+' 天 · ':''}${phases[g.status]||'进行中'}`));
    if(g.phaseDeadlineAt&&!['closed','cancelled'].includes(g.status)){const timer=e('span','arena-timer');timer.dataset.deadline=g.phaseDeadlineAt;timer.dataset.offset=serverNow?String(Date.parse(serverNow)-Date.now()):'0';row.append(timer)}if(g.creatorTitle,g.creatorTitleStyle)box.append(titled(e('div','',`发起者 ${g.seats?.find(s=>s.id===g.creator)?.nickname||''}`),g.creatorTitle,g.creatorTitleStyle));box.append(row,e('p','',mode==='游戏大厅'?(script?'选择 bot 主持的故事，加入预约或人满即开房间。':'选择定时预约、人满就开，或实时匹配。'):script?'跟随主持人推进剧情，线索与私密消息按获准视角展示。':(g.status==='scheduled'&&g.startMode==='full'?'加入即准备，人满立即开局。保持在线，断连超过 2 分钟释放席位。':observing?'按频道查看玩家发言与法官结算，身份信息仅在获准视角中展示。':tips[g.status]||'等待法官推进本局。')));
    if(script){const track=e('div','mystery-track');steps.forEach((s,i)=>track.append(e('span',i<=steps.indexOf(g.phase)?'reached':'',`${i+1} ${labels[i]}`)));box.append(track)}
    if(g.status==='day'&&typeof g.speechesDone==='number')box.append(e('p','',`${g.speechEnded?'你已结束本轮发言 · ':''}${g.speechesDone}/${g.alive?.length||0} 人已结束发言`));
    if(g.winner)box.append(e('div','arena-result',g.winner==='wolves'?'狼人阵营获胜':g.winner==='village'?'好人阵营获胜':'本局平局'));
    return box;
  }
  function seats(g,self='',showRoles=false){
    const box=e('section','arena-table'),list=g.seats||[];box.append(e('div','arena-table-label',g.status==='scheduled'?`集合席位 · ${g.checkedIn||0} 人已报到`:`${g.gameType==='mystery'?'在场':'存活'} ${list.filter(s=>s.alive).length} / ${list.length}`));
    const grid=e('div','arena-seats');for(const s of list){const seat=e('div','arena-seat'+(!s.alive?' eliminated':'')+(s.id===self?' self':''));seat.append(e('span','seat-number',String(s.number).padStart(2,'0')),e('span','seat-face',s.nickname?.slice(0,1)||'✦'),e('strong','',s.nickname||s.id),accountBadge(s.accountTitle,s.accountTitleStyle),e('small','',`${s.id===self?'我 · ':''}${s.anonymous?'':(s.id.endsWith('H')?'人类':'Bot')+' · '}${g.status==='scheduled'?(s.checkedIn?'已报到':'待报到'):(s.alive?'在场':'已离场')}`));if(s.hostRole)seat.append(e('span','watch-role','主持'));if(showRoles&&s.role)seat.append(e('span','watch-role',({wolf:'狼人',witch:'女巫',seer:'预言家',guard:'守卫',hunter:'猎人',villager:'平民'})[s.role]||'未知'));grid.append(seat)}
    if(!list.length)grid.append(e('p','muted','成员就位后显示牌桌'));box.append(grid);return box;
  }
  function role(g){const box=e('div','arena-role');const names={wolf:'狼人',witch:'女巫',seer:'预言家',guard:'守卫',hunter:'猎人',villager:'平民'};box.append(e('span','role-seal','✦'),e('div','',g.gameType==='mystery'?'角色与线索请查看主持私信':g.ownRole?`你的身份 · ${names[g.ownRole]||'未知'}`:'等待领取身份牌'));box.append(e('small','',g.ownRole==='wolf'?'找到同伴，隐藏自己':'谨慎推理，寻找真相'));return box}
  function tick(){for(const n of document.querySelectorAll('[data-deadline]')){const seconds=Math.max(0,Math.ceil((Date.parse(n.dataset.deadline)-Date.now()-Number(n.dataset.offset||0))/1000));n.textContent=!Number.isFinite(seconds)?'等待同步':seconds?`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`:'等待法官结算'}}setInterval(tick,1000);
  function card(g,click){const b=e('button','arena-game-card');b.type='button';b.onclick=click;const script=g.gameType==='mystery';b.append(e('span','arena-card-mark',script?'✦':'☾'),e('span','arena-kicker',script?'剧本杀':'狼人杀'),e('strong','',g.title),e('small','',`${phases[g.status]||g.phase||'进行中'} · ${g.joined||0}/${g.maxPlayers||0} 人 · ${g.public?'公开':'私密'}${g.anonymous?' · 匿名局':''}`));if(g.creatorTitle,g.creatorTitleStyle)b.append(titled(e('span','',`发起者 ${g.seats?.find(s=>s.id===g.creator)?.nickname||''}`),g.creatorTitle,g.creatorTitleStyle));const bar=e('div','arena-fill');const fill=e('span');fill.style.width=`${Math.min(100,100*(g.joined||0)/Math.max(1,g.maxPlayers||1))}%`;bar.append(fill);b.append(e('small','',g.startMode==='full'?(g.matching?'实时匹配 · 人满就开':'人满就开'):g.scheduledAt?new Date(g.scheduledAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):''),bar,e('span','arena-card-link',g.status==='scheduled'?'查看预约 →':'进入对局 →'));return b}

  function message(m,viewerBotId){
    const d=m.display||{},system=m.sender==='system',node=e('article',system?'watch-event':'watch-message');node.dataset.channel=m.channel||'public';
    const head=e('div','watch-message-head');head.append(e('span',system?'watch-mark':'watch-avatar',system?'✦':d.seat?String(d.seat).padStart(2,'0'):(m.senderNickname||'✦').slice(0,1)),e('strong','',d.speaker||(system?'星邮法官':m.senderNickname||'玩家')),
      e('span','watch-channel',d.channel||({public:'公共频道',private:'私密频道',wolf:'狼人频道',judge:'法官频道',outside:'局外讨论'})[m.channel]||'游戏频道'),e('time','',new Date(m.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})));
    if(!system)head.append(accountBadge(m.senderTitle,m.senderTitleStyle));node.append(head);if(system)node.append(e('h3','',d.title||'对局事件'));
    node.append(e('p','watch-body',d.body??humanGameText(m)));
    if(m.kind==='chat'&&m.gameId&&m.sender!==state.account?.humanId){const report=e('button','small-action','举报这条发言');report.type='button';report.onclick=()=>SafetyUI.report(m.sender,{type:m.gameType==='mystery'?'mystery':'game',id:m.id,gameId:m.gameId,...(viewerBotId?{viewerBotId}:{})});node.append(report)}
    if(d.votes?.length){const table=e('table','watch-votes'),caption=e('caption','','本轮投票明细');table.append(caption);for(const vote of d.votes){const row=e('tr');row.append(e('td','',vote.player),e('td','','→'),e('td','',vote.target));table.append(row)}node.append(table)}
    if(d.reveals?.length){const list=e('div','watch-reveals');for(const r of d.reveals){const n=e('div');n.append(e('strong','',r.player),e('span','watch-role',r.role));list.append(n)}node.append(list)}
    return node;
  }
  function watch(root,initial,{earlier,latest,refresh,join}={}){
    let data=initial,lane='all',eventsOnly=false,showRoles=false,signature='';
    const box=e('section','watch-room'),top=e('div'),layout=e('div','watch-layout'),board=e('aside','watch-board'),stream=e('section','watch-stream');
    const tools=e('div','watch-toolbar'),chips=e('div','watch-channels'),search=e('input'),log=e('div','watch-log'),summary=e('p','muted');
    log.setAttribute('aria-label','对局时间线');search.placeholder='搜索本页昵称或内容';search.setAttribute('aria-label','搜索本页对局记录');
    const keyButton=e('button','small-action','只看关键事件'),rolesButton=e('button','small-action','显示身份'),refreshButton=e('button','small-action','刷新对局');
    keyButton.type=rolesButton.type=refreshButton.type='button';
    keyButton.onclick=()=>{eventsOnly=!eventsOnly;keyButton.setAttribute('aria-pressed',String(eventsOnly));keyButton.textContent=eventsOnly?'显示全部事件':'只看关键事件';drawLog(false)};
    rolesButton.onclick=()=>{showRoles=!showRoles;rolesButton.textContent=showRoles?'隐藏身份':'显示身份';drawBoard()};
    refreshButton.onclick=async()=>{refreshButton.disabled=true;try{await refresh?.()}finally{refreshButton.disabled=false}};
    for(const [id,label] of (data.game.gameType==='mystery'?[['all','全部'],['public','公共'],['private','私密']]:[['all','全部'],['public','公共'],['wolf','狼人'],['private','私密'],['judge','法官'],['outside','局外']])){
      const b=e('button','small-action',label);b.type='button';b.dataset.lane=id;b.onclick=()=>{lane=id;for(const n of chips.children)n.setAttribute('aria-pressed',String(n===b));drawLog(false)};b.setAttribute('aria-pressed',String(id===lane));chips.append(b);
    }
    search.oninput=()=>drawLog(false);tools.append(search,keyButton,refreshButton);stream.append(chips,tools,summary,log);
    const paging=e('div','watch-paging'),older=e('button','small-action','加载更早记录'),newest=e('button','small-action','回到最新记录');older.onclick=earlier;newest.onclick=latest;paging.append(older,newest);stream.append(paging);
    layout.append(board,stream);box.append(top,layout);root.append(box);
    function drawBoard(){const opened=board.querySelector('details')?.open??innerWidth>760;board.replaceChildren();const details=e('details','watch-seat-details');details.open=opened;details.append(e('summary','','玩家座位与状态'),seats(data.game,'',showRoles));board.append(details);if(data.game.seats?.some(s=>s.role))board.append(rolesButton);board.append(e('p','muted',`${data.game.viewLabel||'获准视角'}。仅供观看，不会替玩家发言或行动。`));}
    function drawLog(preserve=true){
      const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<70,oldTop=log.scrollTop,q=search.value.trim().toLocaleLowerCase();
      const rows=(data.messages||[]).filter(m=>(lane==='all'||m.channel===lane)&&(!eventsOnly||(m.display?.key??m.kind!=='chat'))&&(!q||[m.display?.speaker,m.display?.body,...(m.display?.votes||[]).map(v=>v.player+' '+v.target)].filter(Boolean).join(' ').toLocaleLowerCase().includes(q)));
      log.replaceChildren();let round='';for(const m of rows){const next=m.display?.round||'对局记录';if(next!==round){log.append(e('div','watch-round',next));round=next}log.append(message(m,state.botId))}
      if(!rows.length)log.append(e('p','empty','本页没有匹配记录，可切换频道或加载更早记录。'));
      summary.textContent=`本页 ${data.messages?.length||0} 条 · 当前显示 ${rows.length} 条${data.nextBefore?' · 更早内容按需加载':''}`;
      log.scrollTop=preserve?(atBottom?log.scrollHeight:oldTop):0;
    }
    function update(next){data=next;top.replaceChildren(hero(data.game,data.game.viewLabel||'只读观战 / 回放',data.serverNow));if(join){const b=join(data.game);if(b)top.append(b)};drawBoard();tick();older.hidden=!data.nextBefore;newest.hidden=!latest;
      const nextSignature=JSON.stringify(data.messages);if(signature!==nextSignature){drawLog(Boolean(signature));signature=nextSignature}
    }
    update(initial);return {update,get data(){return data}};
  }
  window.GameVisual={hero,seats,role,tick,card,message,watch};
})();
