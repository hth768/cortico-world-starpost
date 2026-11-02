// Human game presentation; seats and possible actions come only from authorized RPC results.
(() => {
  const e=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n};
  const phases={scheduled:'等待集合',assigning:'正在发牌',night_wolf:'狼人行动',night_gods:'神职行动',day:'白天讨论',vote:'公开投票',hunter:'猎人行动',finished:'终局复盘',closed:'对局结束',cancelled:'预约取消'};
  const steps=['opening','roles','clues','discussion','accusation','reveal','closed'],labels=['序幕','领取剧本','搜集线索','讨论推理','指认凶手','真相揭晓','结束'];
  const tips={scheduled:'开局前 3 分钟报到，准时入座。',night_wolf:'天黑请闭眼，等待狼人完成行动。',night_gods:'轮到你时，身份技能会在下方亮起。',day:'分享线索、倾听发言，找出藏在人群里的狼人。',vote:'点选目标后确认投票，也可以弃票。',hunter:'选择开枪目标，或放弃这次技能。',finished:'身份已揭晓，一起回顾这场推理。',closed:'故事暂告一段落。',assigning:'请等待法官分配身份。'};
  function hero(g,mode='参赛中',serverNow){
    const box=e('section','arena-hero '+(g.status?.startsWith('night')?'is-night':'')),script=g.gameType==='mystery';
    box.append(e('div','arena-kicker',`${script?'MYSTERY · 剧本杀':'WEREWOLF · 狼人杀'} / ${mode}`),e('h2','',g.title||'星邮游戏'));
    const row=e('div','arena-phase');row.append(e('span','arena-phase-icon',script?'✦':g.status?.startsWith('night')?'☾':'☀'),e('strong','',script?(labels[steps.indexOf(g.phase)]||'等待开场'):`${g.day?'第 '+g.day+' 天 · ':''}${phases[g.status]||'进行中'}`));
    if(g.phaseDeadlineAt&&!['closed','cancelled'].includes(g.status)){const timer=e('span','arena-timer');timer.dataset.deadline=g.phaseDeadlineAt;timer.dataset.offset=serverNow?String(Date.parse(serverNow)-Date.now()):'0';row.append(timer)}box.append(row,e('p','',script?'跟随主持人推进剧情，线索与私密消息按获准视角展示。':tips[g.status]||'等待法官推进本局。'));
    if(script){const track=e('div','mystery-track');steps.forEach((s,i)=>track.append(e('span',i<=steps.indexOf(g.phase)?'reached':'',`${i+1} ${labels[i]}`)));box.append(track)}
    if(g.winner)box.append(e('div','arena-result',g.winner==='wolves'?'狼人阵营获胜':g.winner==='village'?'好人阵营获胜':'本局平局'));
    return box;
  }
  function seats(g,self=''){
    const box=e('section','arena-table'),list=g.seats||[];box.append(e('div','arena-table-label',g.status==='scheduled'?`集合席位 · ${g.checkedIn||0} 人已报到`:`${g.gameType==='mystery'?'在场':'存活'} ${list.filter(s=>s.alive).length} / ${list.length}`));
    const grid=e('div','arena-seats');for(const s of list){const seat=e('div','arena-seat'+(!s.alive?' eliminated':'')+(s.id===self?' self':''));seat.append(e('span','seat-number',String(s.number).padStart(2,'0')),e('span','seat-face',s.nickname?.slice(0,1)||'✦'),e('strong','',s.nickname||s.id),e('small','',`${s.id===self?'我 · ':''}${s.id.endsWith('H')?'人类':'Bot'} · ${g.status==='scheduled'?(s.checkedIn?'已报到':'待报到'):(s.alive?'在场':'已离场')}`));grid.append(seat)}
    if(!list.length)grid.append(e('p','muted','成员就位后显示牌桌'));box.append(grid);return box;
  }
  function role(g){const box=e('div','arena-role');const names={wolf:'狼人',witch:'女巫',seer:'预言家',guard:'守卫',hunter:'猎人',villager:'平民'};box.append(e('span','role-seal','✦'),e('div','',g.ownRole?`你的身份 · ${names[g.ownRole]||'未知'}`:'等待领取身份牌'));box.append(e('small','',g.ownRole==='wolf'?'找到同伴，隐藏自己':'谨慎推理，寻找真相'));return box}
  function tick(){for(const n of document.querySelectorAll('[data-deadline]')){const seconds=Math.max(0,Math.ceil((Date.parse(n.dataset.deadline)-Date.now()-Number(n.dataset.offset||0))/1000));n.textContent=!Number.isFinite(seconds)?'等待同步':seconds?`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`:'等待法官结算'}}setInterval(tick,1000);
  function card(g,click){const b=e('button','arena-game-card');b.type='button';b.onclick=click;const script=g.gameType==='mystery';b.append(e('span','arena-card-mark',script?'✦':'☾'),e('span','arena-kicker',script?'剧本杀 · 观战':'狼人杀'),e('strong','',g.title),e('small','',`${phases[g.status]||g.phase||'进行中'} · ${g.joined||0}/${g.maxPlayers||0} 人 · ${g.public?'公开':'私密'}`));const bar=e('div','arena-fill');const fill=e('span');fill.style.width=`${Math.min(100,100*(g.joined||0)/Math.max(1,g.maxPlayers||1))}%`;bar.append(fill);b.append(e('small','',g.scheduledAt?new Date(g.scheduledAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):''),bar,e('span','arena-card-link',g.status==='scheduled'?'查看预约 →':'进入对局 →'));return b}
  window.GameVisual={hero,seats,role,tick,card};
})();
