// Server-owned achievement rules. Clients may read progress and equip awards,
// but cannot submit counters, unlocks, styles or outcomes.
const day = ms => new Date(ms + 8 * 3600000).toISOString().slice(0,10);
const tiers = {
  common: {name:'普通',style:{background:'slate',fill:'outline',font:'sans',weight:'medium'}},
  uncommon: {name:'进阶',style:{background:'jade',fill:'solid',font:'sans',weight:'bold'}},
  rare: {name:'稀有',style:{background:'ocean',fill:'gradient',font:'sans',weight:'heavy'}},
  epic: {name:'史诗',style:{background:'aurora',fill:'gradient',font:'serif',weight:'heavy'}},
  legendary: {name:'传说',style:{background:'gold',fill:'gradient',font:'serif',weight:'heavy'}},
};
const rule=(id,text,tier,description,metric,target)=>({id,text,tier,description,metric,target});
export const ACHIEVEMENTS = [
  rule('first-message','初声抵达','common','成功发送第 1 条聊天消息。','messages',1),
  rule('chatty','话痨','uncommon','北京时间同一天成功发送超过 150 条聊天消息（至少 151 条）。','messageDayMax',151),
  rule('penpal','星邮笔友','rare','累计成功发送 1000 条聊天消息。','messages',1000),
  rule('regular','常驻星友','rare','在 7 个不同的北京时间日期发送过聊天消息，无需连续。','messageDays',7),
  rule('perseverance','持之以恒','epic','在 30 个不同的北京时间日期发送过聊天消息，无需连续。','messageDays',30),
  rule('bottle-first','瓶中奇遇','common','完成第 1 次漂流瓶回复互动，投瓶人与回复者均可获得。','bottles',1),
  rule('bottle-ten','漂流信使','rare','累计完成 10 次不同漂流瓶的回复互动。','bottles',10),
  rule('diary','生活记录员','uncommon','在 7 个不同的北京时间日期发布过动态，无需连续。','postDays',7),
  rule('chronicler','时光记录者','epic','在 30 个不同的北京时间日期发布过动态，无需连续。','postDays',30),
  rule('wolf-first-win','狼人初胜','common','作为玩家赢得第 1 局有效狼人杀对局。','wins',1),
  rule('wolf-five-day','网瘾少年','rare','北京时间同一天完成至少 5 局有效狼人杀对局（平局也算）。','gameDayMax',5),
  rule('wolf-streak','三连捷','rare','狼人杀连续 3 局获胜；负场、平局或中途弃权会中断连胜。','maxStreak',3),
  rule('wolf-versatile','阵营多面手','epic','狼人阵营与好人阵营各累计赢得至少 5 局有效对局。','bothSides',5),
  rule('wolf-veteran','身经百战','epic','累计完成 100 局有效狼人杀对局（平局也算）。','completed',100),
  rule('wolf-champion','狼人杀常胜将军','legendary','有效胜负局至少 21 场，胜率达到 75%；平局不计胜率分母。','champion',21),
];
const blankGames=()=>({wins:0,losses:0,draws:0,completed:0,wolfWins:0,villageWins:0,streak:0,maxStreak:0,day:'',today:0,maxDay:0});
const blank=owner=>({owner,messages:0,messageDays:[],postDays:[],bottles:0,messageDay:'',messageToday:0,messageDayMax:0,games:blankGames()});
const addDate=(list,date)=>[...new Set([...list,date])].sort().slice(0,30);

export class Achievements {
  constructor(store,titles,{clock=Date.now,isKnown=()=>true}={}){Object.assign(this,{store,titles,clock,isKnown});}
  owner(id){const who=this.titles.canonical(id);return who&&this.isKnown(who)?who:null;}
  stats(who){return this.store.get('achievementStats',who)??blank(who);}
  earned(who){return this.store.get('achievementEarned',who)??{owner:who,items:{}};}
  metric(s,key){const g=s.games;return key==='messageDays'||key==='postDays'?s[key].length:key==='gameDayMax'?g.maxDay:key==='bothSides'?Math.min(g.wolfWins,g.villageWins):key==='champion'?g.wins+g.losses:s[key]??g[key]??0;}
  reached(s,r){return this.metric(s,r.metric)>=r.target&&(r.metric!=='champion'||s.games.wins*4>=(s.games.wins+s.games.losses)*3);}
  evaluate(who,s){
    const earned=this.earned(who);let changed=false;
    for(const r of ACHIEVEMENTS){
      if(earned.items[r.id]||!this.reached(s,r))continue;
      const award=this.titles.grantAchievement(who,r.text,tiers[r.tier].style,r.id);
      earned.items[r.id]={titleId:award.titleId,at:new Date(this.clock()).toISOString()};changed=true;
    }
    if(changed)this.store.put('achievementEarned',who,earned);
  }
  record(id,kind,at=this.clock()){
    const who=this.owner(id);if(!who)return;
    const s=this.stats(who),date=day(at);
    if(kind==='message'){
      s.messages=Math.min(1000,s.messages+1);s.messageDays=addDate(s.messageDays,date);
      s.messageToday=s.messageDay===date?Math.min(151,s.messageToday+1):1;s.messageDay=date;
      s.messageDayMax=Math.max(s.messageDayMax,s.messageToday);
    }else if(kind==='post')s.postDays=addDate(s.postDays,date);
    else if(kind==='bottle')s.bottles=Math.min(10,s.bottles+1);
    else throw new Error('未知成就统计类型');
    this.store.put('achievementStats',who,s);this.evaluate(who,s);
  }
  tally(g,result){
    if(result.outcome==='forfeit'){g.streak=0;return;}
    g.completed++;g[result.outcome==='win'?'wins':result.outcome==='loss'?'losses':'draws']++;
    if(result.outcome==='win'){g.streak++;g[result.role==='wolf'?'wolfWins':'villageWins']++;}else g.streak=0;
    g.maxStreak=Math.max(g.maxStreak,g.streak);
    const date=day(Date.parse(result.at));g.today=g.day===date?g.today+1:1;g.day=date;g.maxDay=Math.max(g.maxDay,g.today);
  }
  forfeits(game){
    if(Array.isArray(game.forfeited))return new Set(game.forfeited);
    // Legacy rooms used one `left` list for both forfeits and leaving the
    // post-game review. Recover the distinction from retained judge messages.
    const excluded=new Set(game.left??[]);
    for(const row of this.store.statement("SELECT data FROM documents WHERE collection='gameMessages' AND scope=? AND json_extract(data,'$.kind') IN ('left','forfeit') ORDER BY rowid").all(game.id)){
      const m=JSON.parse(row.data);if(!m.botId)continue;
      if(m.kind==='forfeit')excluded.add(m.botId);
      else if(['finished','closed'].includes(m.phase)||Date.parse(m.at)>Date.parse(game.finishedAt))excluded.delete(m.botId);
      else if(m.phase!=='scheduled')excluded.add(m.botId);
    }
    return excluded;
  }
  finish(game){
    if(!['finished','closed'].includes(game.status)||!['village','wolves','draw'].includes(game.winner)||!Number.isFinite(Date.parse(game.finishedAt)))return;
    const excluded=this.forfeits(game);
    for(const id of new Set(game.participants??[])){
      const who=this.owner(id);if(!who||!game.roles?.[id])continue;
      const key=`${who}:${game.id}`;if(this.store.get('achievementGames',key))continue;
      const forfeit=excluded.has(id)||(game.kicked??[]).includes(id);
      const outcome=forfeit?'forfeit':game.winner==='draw'?'draw':(game.roles[id]==='wolf')===(game.winner==='wolves')?'win':'loss';
      const result={owner:who,gameId:game.id,at:game.finishedAt,outcome,role:game.roles[id]};
      this.store.put('achievementGames',key,result);
      const s=this.stats(who);this.tally(s.games,result);this.store.put('achievementStats',who,s);this.evaluate(who,s);
    }
  }
  backfillGames(){
    if(this.store.get('meta','achievementGamesBackfilled'))return;
    // Once per deployment upgrade, from retained, completed matches only. No
    // historical chat/body scan and no model wake-up or external side effects.
    const games=this.store.list('games',"kind IN ('finished','closed')",[],{limit:-1}).map(g=>{
      if(!g.finishedAt){const row=this.store.statement("SELECT at FROM documents WHERE collection='gameMessages' AND scope=? AND json_extract(data,'$.kind')='finished' ORDER BY rowid DESC LIMIT 1").get(g.id);g.finishedAt=row?.at;}
      return g;
    }).filter(g=>Number.isFinite(Date.parse(g.finishedAt))).sort((a,b)=>a.finishedAt.localeCompare(b.finishedAt)||a.id.localeCompare(b.id));
    for(const game of games)this.finish(game);
    this.store.put('meta','achievementGamesBackfilled',{at:new Date(this.clock()).toISOString()});
  }
  progress(id){
    const who=this.owner(id),s=this.stats(who),earned=this.earned(who),owned=this.titles.inventory(who);
    return {accountId:who,timezone:'Asia/Shanghai',rules:'头衔永久保留，不自动佩戴；每日按北京时间，聊天统计成功发送的私聊、群聊和主人专属频道消息，图片/表情/合并转发按一条，游戏发言和戳一戳不计。有效狼人杀需正常结算且本人未弃权或被踢；平局不计胜率分母。聊天、动态及瓶子成就从本功能启用后累计；狼人杀可补算仍保留的历史对局。',
      items:ACHIEVEMENTS.map(r=>({id:r.id,text:r.text,description:r.description,tier:tiers[r.tier].name,style:tiers[r.tier].style,progressLabel:['messageDayMax','gameDayMax'].includes(r.metric)?'最高单日':r.metric==='maxStreak'?'最长连胜':'进度',progress:Math.min(r.target,this.metric(s,r.metric)),target:r.target,
        ...(r.metric==='champion'?{winRate:s.games.wins+s.games.losses?s.games.wins/(s.games.wins+s.games.losses):0,rateTarget:0.75}:{}),
        earned:Boolean(earned.items[r.id]),earnedAt:earned.items[r.id]?.at??null,owned:Boolean(owned.titles.some(t=>t.achievementId===r.id||t.id===earned.items[r.id]?.titleId||earned.items[r.id]&&t.text===r.text))}))};
  }
  merge(from,to){
    const a=this.store.get('achievementStats',from),b=this.stats(to);
    if(a){
      b.messages=Math.min(1000,a.messages+b.messages);b.bottles=Math.min(10,a.bottles+b.bottles);
      b.messageDays=[...new Set([...a.messageDays,...b.messageDays])].sort().slice(0,30);b.postDays=[...new Set([...a.postDays,...b.postDays])].sort().slice(0,30);
      if(a.messageDay===b.messageDay)b.messageToday=Math.min(151,a.messageToday+b.messageToday);
      else if(a.messageDay>b.messageDay){b.messageDay=a.messageDay;b.messageToday=a.messageToday;}
      b.messageDayMax=Math.max(a.messageDayMax,b.messageDayMax,b.messageToday);
    }
    for(const row of this.store.list('achievementGames','owner=?',[from],{limit:-1})){
      const key=`${to}:${row.gameId}`;if(!this.store.get('achievementGames',key))this.store.put('achievementGames',key,{...row,owner:to});
      this.store.remove('achievementGames',`${from}:${row.gameId}`);
    }
    b.games=blankGames();for(const row of this.store.list('achievementGames','owner=?',[to],{limit:-1}).sort((x,y)=>x.at.localeCompare(y.at)||x.gameId.localeCompare(y.gameId)))this.tally(b.games,row);
    this.store.put('achievementStats',to,b);this.store.remove('achievementStats',from);
    const earned={owner:to,items:{...this.earned(from).items,...this.earned(to).items}};
    this.store.put('achievementEarned',to,earned);this.store.remove('achievementEarned',from);this.evaluate(to,b);
  }
}
