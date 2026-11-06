// Game aliases are presentation/action references, never account identifiers.
const account = value => typeof value === 'string' && /^\d{5,12}H?$/.test(value);
export function booleanOption(value, fallback=false) {
  if(value===undefined)return fallback;
  if(typeof value!=='boolean')throw new Error('匿名选项须为布尔值');
  return value;
}
export function gamePrivacy(store,who,args={}) {
  const old=store.get('gamePrivacy',who)??{anonymous:false};
  if(args.anonymous!==undefined)store.put('gamePrivacy',who,{owner:who,anonymous:booleanOption(args.anonymous)});
  return {anonymous:args.anonymous??old.anonymous,appliesTo:'之后加入的狼人杀与剧本杀；整局匿名优先，已加入对局保持原设置'};
}
export function captureGameSeats(game,store,extra=[]) {
  if(!game.privacyVersion)return;
  game.seatNumbers??={};game.anonymousPlayers??={};
  const ids=[...(game.joined??[]),...(game.participants??[]),game.judgeBotId,...extra].filter(account);
  for(const id of ids)if(!Object.hasOwn(game.seatNumbers,id)) {
    game.seatNumbers[id]=id===game.judgeBotId&&!game.joined?.includes(id)?0:Math.max(0,...Object.values(game.seatNumbers))+1;
    game.anonymousPlayers[id]=store.get('gamePrivacy',id)?.anonymous===true;
  }
}
export const anonymousPlayer=(game,id)=>Boolean(account(id)&&game?.privacyVersion&&(game.anonymous||game.anonymousPlayers?.[id]));
export const seatNumber=(game,id,fallback)=>game.seatNumbers?.[id]??fallback;
export const gameAlias=(game,id)=>`seat:${game.seatNumbers[id]}`;

export function preparePrivacyJoin(game,store) {
  if(game.privacyVersion)return;
  // Existing reservations retain current members' public identity. A new
  // entrant still gets the preference they selected before joining.
  game.privacyVersion=1;
  captureGameSeats(game,store);
  for(const id of Object.keys(game.anonymousPlayers))game.anonymousPlayers[id]=false;
}

export class GamePrivacy {
  constructor(store,nickname){Object.assign(this,{store,nickname});}
  get(id){return typeof id==='string'?(this.store.get('games',id)??this.store.get('mysteryGames',id)):null;}
  decode(args={},action) {
    if(!["game.act","game.vote","game.assign","mystery.message","human.move","safety.report"].includes(action))return args;
    const game=this.get(args.gameId??args.evidence?.gameId);if(!game)return args;
    const resolve=value=>{
      if(typeof value!=='string'||!value.startsWith('seat:'))return value;
      const id=Object.keys(game.seatNumbers??{}).find(id=>gameAlias(game,id)===value);
      if(!id)throw new Error('本局座位不存在，请重新查看房间');return id;
    };
    const out={...args};for(const key of ['target','toBotId','botId'])if(key in out)out[key]=resolve(out[key]);
    if(Array.isArray(out.assignments))out.assignments=out.assignments.map(a=>({...a,botId:resolve(a.botId)}));
    return out;
  }
  project(value){
    const cache=new Map(),plans=new Map();
    const plan=g=>{if(!plans.has(g.id)){const hidden=Object.keys(g.seatNumbers??{}).filter(id=>anonymousPlayer(g,id));const names=hidden.flatMap(id=>[...new Set([g.playerNames?.[id],this.nickname(id)])].filter(n=>n&&n!==id).map(name=>({name,number:g.seatNumbers[id]}))).sort((a,b)=>b.name.length-a.name.length);plans.set(g.id,{hidden,names});}return plans.get(g.id);};
    const context=id=>{if(!cache.has(id)){const g=this.get(id);cache.set(id,g?.privacyVersion?g:null);}return cache.get(id);};
    const walk=(v,g=null,key='')=>{
      if(v===null||v===undefined)return v;
      if(Array.isArray(v))return v.map(x=>walk(x,g,key));
      if(typeof v!=='object'){
        if(typeof v!=='string'||!g)return v;
        const {hidden,names}=plan(g);
        if(hidden.includes(v))return gameAlias(g,v);
        let text=v.replace(/(?<![\w])\d{5,12}H?(?![\w])/g,id=>hidden.includes(id)?`${g.seatNumbers[id]}号`:id);
        if(/text|body|nickname|speaker|title|reason|message|prompt|label/i.test(key)){
          for(const {name,number} of names)text=text.split(name).join(`${number}号`);
        }
        return text;
      }
      g=context(v.gameId??v.game?.gameId??v.featured?.gameId??v.source?.gameId)??g;
      if(g&&!plan(g).hidden.length)g=null;
      if(!g)return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,null,k)]));
      const id=[v.sender,v.botId,v.humanId,('nickname' in v?v.id:null),v.author].find(account);
      const hidden=id&&anonymousPlayer(g,id), creatorHidden=anonymousPlayer(g,g.creator);
      const out={};
      for(const [k,x] of Object.entries(v)){
        if(['titlesById','seatNumbers','anonymousPlayers','playerNames','recipients','invitedBy','sourceTarget','sourceKind'].includes(k))continue;
        if(creatorHidden&&['creator','creatorTitle','creatorTitleStyle'].includes(k))continue;
        if(creatorHidden&&v.kind==='game'&&['author','authorTitle','authorTitleStyle'].includes(k))continue;
        if(creatorHidden&&v.kind==='mystery'&&['author','authorTitle','authorTitleStyle'].includes(k))continue;
        if(k==='judgeBotId'&&anonymousPlayer(g,x)){out[k]='judge';continue;}
        if(hidden&&/avatar|title|bio|accountType|isHuman|isBot|isOwner|isCreator/i.test(k))continue;
        if(hidden&&['nickname','senderNickname'].includes(k)){out[k]=`${g.seatNumbers[id]}号`;continue;}
        if(k==='hostNickname'&&creatorHidden){out[k]='主持';continue;}
        out[anonymousPlayer(g,k)&&g.seatNumbers?.[k]?gameAlias(g,k):k]=walk(x,g,k);
      }
      if(hidden)out.anonymous=true;
      if(v.gameId===g.id&&g.presetId&&'status' in v)out.hostReference=anonymousPlayer(g,g.creator)?gameAlias(g,g.creator):g.creator;
      if(v.gameId===g.id&&('status' in v||'maxPlayers' in v)){out.anonymous=Boolean(g.anonymous);out.identityRule='匿名玩家只以座位号显示；行动参数沿用返回的 seat:N，不要查询或猜测账号身份。';}
      return out;
    };
    return walk(value);
  }
}
