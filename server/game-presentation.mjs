import { anonymousPlayer, seatNumber } from './game-privacy.mjs';
// Presentation is derived only after the caller has checked room/role permissions.
export const ROLE_LABELS = { wolf:'狼人', witch:'女巫', seer:'预言家', guard:'守卫', hunter:'猎人', villager:'平民' };
const PHASES = { scheduled:'等待集合', assigning:'分发身份', started:'游戏开始', night_wolf:'狼人行动', night_gods:'神职行动', dawn:'天亮结算', day:'白天讨论', vote:'公开投票', vote_open:'公开投票', hunter:'猎人行动', finished:'终局复盘', closed:'对局结束', cancelled:'预约取消', opening:'序幕', roles:'领取剧本', clues:'搜集线索', discussion:'讨论推理', accusation:'指认凶手', reveal:'真相揭晓' };
const CHANNELS = { public:'公共频道', private:'私密频道', wolf:'狼人频道', judge:'法官频道', outside:'局外讨论' };
export function gameSeats(game, nickname, mystery = false) {
  const players = mystery || !game.participants?.length ? game.joined ?? [] : game.participants;
  return players.map((id, index) => {const number=seatNumber(game,id,index+1),anonymous=anonymousPlayer(game,id),nick=anonymous?`${number}号`:game.playerNames?.[id] || nickname(id);return { id, number, anonymous, hostRole:mystery&&id===game.creator,
    nickname:nick&&nick!==id?nick:(id.endsWith('H')?'匿名人类':'未设置昵称'),
    alive:mystery ? !game.left?.includes(id) : game.status==='scheduled' || Boolean(game.alive?.includes(id)),
    checkedIn:Boolean(game.checkedIn?.includes(id)) };});
}
export function playerLabel(seats, id) {
  if (!id || id==='abstain') return '弃票 / 无目标';
  const seat=seats.find(s=>s.id===id);
  return seat ? seat.anonymous ? `${seat.number}号` : `${seat.number}号 · ${seat.nickname}` : '场外成员';
}
export function replacePlayerIds(value, seats, judgeId, names = false) {
  const labels = new Map(seats.map(s=>[s.id, names && !s.anonymous ? `${s.number}号（${s.nickname}）` : `${s.number}号`]));
  if (judgeId && !labels.has(judgeId)) labels.set(judgeId,'法官');
  return String(value ?? '').replace(/(?<![\w])\d{5,12}H?(?![\w])/g,id=>labels.get(id) ?? id);
}
export function presentGamePage(source, page, nickname, { omniscient=false, label='获准视角 · 只读' } = {}) {
  const mystery=page.game?.gameType==='mystery', seats=gameSeats(source,nickname,mystery);
  if (omniscient && !mystery) for(const seat of seats) if(ROLE_LABELS[source.roles?.[seat.id]])seat.role=source.roles[seat.id];
  const name=id=>id===source.judgeBotId ? '法官' : playerLabel(seats,id)+(mystery&&id===source.creator?' · 主持':'');
  const list=ids=>(ids??[]).map(name).join('、');
  const roles=values=>Object.entries(values??{}).map(([id,role])=>({player:name(id),role:ROLE_LABELS[role]??'未知身份'}));
  let day=null, phase='';
  const messages=(page.messages??[]).map(m=>{
    day=Number.isInteger(m.day)?m.day:day;
    phase=PHASES[m.kind]?m.kind:(m.phase || phase);
    const round=mystery ? PHASES[phase] || '剧情记录' : day ? `第 ${day} ${phase.startsWith('night')?'夜':'天'} · ${PHASES[phase]||'对局记录'}` : '对局记录';
    let body=m.text??'',title=PHASES[m.kind]||(mystery?'剧情通知':'法官消息'),votes=[],reveals=[];
    if(!mystery)switch(m.kind){
      case 'chat':case 'left':break;
      case 'role':title='私密身份';body=`${name(m.to)}的身份：${ROLE_LABELS[m.role]??'未知'}${m.teammates?.length?'；狼人队友：'+list(m.teammates):''}`;break;
      case 'assignments':title='法官身份表';body='仅获准的观战视角显示身份表。';reveals=roles(m.roles);break;
      case 'started':body=Object.entries(m.rules??{}).filter(([,n])=>Number.isInteger(n)&&n>0).map(([r,n])=>`${ROLE_LABELS[r]||r} ${n}人`).join(' · ');break;
      case 'night_wolf':body='天黑请闭眼，狼人选择袭击目标。';break;
      case 'night_gods':body='神职依次完成夜间行动。';break;
      case 'day':body='公共讨论开始，玩家完成发言后进入投票。';break;
      case 'dawn':body=m.deaths?.length?`本夜出局：${list(m.deaths)}`:'平安夜，无人出局。';break;
      case 'inspect_result':title='查验结果';body=`${name(m.target)}：${m.isWolf?'狼人':'非狼人'}`;break;
      case 'witch_prompt':title='女巫行动提示';body=`狼刀目标：${m.victim?name(m.victim):'无'}；解药${m.saveAvailable?'可用':'不可用'}，毒药${m.poisonAvailable?'可用':'不可用'}。`;break;
      case 'vote_open':body='投票开始，玩家可选择目标或弃票。';break;
      case 'vote':title='投票';body=`${name(m.voter)} ${m.target==='abstain'||!m.target?'弃票':'投给 '+name(m.target)}`;break;
      case 'vote_result':title='投票结算';body=m.eliminated?`公投出局：${name(m.eliminated)}`:m.tie?'平票或无人投票，本轮无人出局。':'本轮无人出局。';votes=Object.entries(m.votes??{}).map(([id,target])=>({player:name(id),target:target==='abstain'||!target?'弃票':name(target)}));break;
      case 'attack_vote':title='狼人选刀';body=`${name(m.botId)} 选择袭击 ${name(m.target)}`;break;
      case 'hunter_wait':case 'hunter_prompt':title='猎人行动';body=`等待${m.botId?name(m.botId):'猎人'}选择开枪或放弃。`;break;
      case 'hunter_shot':title='猎人开枪';body=`${name(m.hunter)}${m.target?'带走 '+name(m.target):'放弃开枪'}`;break;
      case 'forfeit':title='弃权出局';body=`${name(m.botId)} 弃权出局。`;break;
      case 'finished':title='终局结算';body=m.winner==='wolves'?'狼人阵营获胜':m.winner==='village'?'好人阵营获胜':'本局平局';reveals=roles(m.roles);break;
      case 'closed':body='聊天室已关闭，可以继续查看回放。';break;
      default:body=body||PHASES[m.kind]||'游戏状态已更新。';
    }
    const seat=seats.find(s=>s.id===m.sender);
    return {...m,display:{title,body:replacePlayerIds(body,seats,source.judgeBotId,true),
      speaker:m.sender==='system'?(mystery?'星邮剧本主持':'星邮法官'):seat?name(m.sender):m.senderNickname||'场外成员',
      seat:seat?.number,channel:CHANNELS[m.channel]||'游戏频道',round,
      key:m.kind!=='chat'&&!['vote','attack_vote','witch_prompt'].includes(m.kind),votes,reveals}};
  });
  return {...page,game:{...page.game,seats,viewLabel:label,omniscient,startedAt:source.startedAt??null},messages};
}
