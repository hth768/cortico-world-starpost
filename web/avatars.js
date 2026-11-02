// Images are fetched on demand. Snapshots only carry the content hash.
const avatarCache=new Map();
const avatarDrafts=new Map();
let avatarGestureUntil=0;
function bindAvatarDraft(input,key){
  input.dataset.avatarDraft=key;
  if(!avatarDrafts.has(key)){if(avatarDrafts.size>=100)avatarDrafts.delete(avatarDrafts.keys().next().value);avatarDrafts.set(key,{text:'',mentions:new Map()})}
  const draft=avatarDrafts.get(key);input.value=draft.text;
  input.addEventListener('input',()=>{draft.text=input.value;for(const [id,name]of draft.mentions)if(!input.value.includes(`@${name} `))draft.mentions.delete(id)});
}
function avatarMention(id,name){
  const input=$('#app-content .composer textarea');if(!input)return;
  const token=`@${name} `;if(input.value.length+token.length>3000){notify('消息已达到长度上限');return}
  input.setRangeText(token,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input'));avatarDrafts.get(input.dataset.avatarDraft)?.mentions.set(id,name);input.focus();
}
function avatarMentionIds(input){return [...(avatarDrafts.get(input.dataset.avatarDraft)?.mentions||[])].filter(([,name])=>input.value.includes(`@${name} `)).map(([id])=>id)}
function avatarGestures(node,{open,mention,poke}){
  let single,hold,start,suppress=false;
  node.classList.add('interactive-avatar');node.tabIndex=0;node.setAttribute('role','button');node.setAttribute('aria-label',poke?'查看个人主页；长按 @，双击戳一戳':'查看个人主页');
  node.addEventListener('pointerdown',e=>{if(e.button!==0)return;avatarGestureUntil=Date.now()+1200;start=[e.clientX,e.clientY];suppress=false;clearTimeout(hold);if(mention)hold=setTimeout(()=>{suppress=true;clearTimeout(single);single=null;if(node.isConnected)mention()},500)});
  node.addEventListener('pointermove',e=>{if(start&&Math.hypot(e.clientX-start[0],e.clientY-start[1])>10){clearTimeout(hold);suppress=true}});
  for(const event of ['pointerup','pointercancel','pointerleave'])node.addEventListener(event,()=>{clearTimeout(hold);start=null});
  node.addEventListener('contextmenu',e=>{if(mention)e.preventDefault()});
  node.addEventListener('click',e=>{e.stopPropagation();e.preventDefault();if(suppress)return;if(!poke){open();return}if(single){clearTimeout(single);single=null;poke()}else single=setTimeout(()=>{single=null;if(node.isConnected)open()},300)});
  node.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation()});
  node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();clearTimeout(single);single=null;open()}});
}
function avatarNode(id,version,label,actions={}){
  const node=el('span','card-avatar',Array.from(label||'星')[0]);
  node.dataset.tone=String(Array.from(label||'').reduce((a,c)=>a+c.codePointAt(0),0)%3);
  if(/^\d{5,12}H?$/.test(id||'')){node.dataset.avatarId=id;avatarGestures(node,{open:()=>profile(id,actions.profileAction||'social.profile'),...actions});node.setAttribute('aria-label',`${label||id}的头像，单击查看主页${actions.mention?'，长按 @':''}${actions.poke?'，双击戳一戳':''}`);}
  if(!id||!version)return node;
  const key=`${state.account?.humanId}:${state.botId}:${id}:${version}`;
  if(!avatarCache.has(key)){
    if(avatarCache.size>=64)avatarCache.delete(avatarCache.keys().next().value);
    const load=async()=>{
      let result;try{result=await rpc('social.profile',{botId:id,section:'avatar'})}catch{result=await rpc('profile',{botId:id,section:'avatar'})}
      const v=result.image;
      if(!v||result.avatarVersion!==version||!['image/png','image/jpeg'].includes(v.mime)||typeof v.base64!=='string'||v.base64.length>174764||!/^[A-Za-z0-9+/=]+$/.test(v.base64))return null;
      return `data:${v.mime};base64,${v.base64}`;
    };
    const task=load().catch(()=>{avatarCache.delete(key);return null});avatarCache.set(key,task);
  }
  avatarCache.get(key).then(url=>{if(url){const img=el('img');img.alt=`${label||'用户'}的头像`;img.src=url;img.onerror=()=>{node.textContent=Array.from(label||'星')[0]};node.replaceChildren(img)}});
  return node;
}
async function avatarUpload(file){
  if(!file||file.size>10*1024*1024||!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw Error('请选择 10 MB 以内的 PNG、JPEG、WebP 或 GIF 图片');
  const bitmap=await createImageBitmap(file);
  try{
    if(bitmap.width*bitmap.height>40_000_000)throw Error('图片尺寸过大');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,256,256);
    const size=Math.min(bitmap.width,bitmap.height);ctx.drawImage(bitmap,(bitmap.width-size)/2,(bitmap.height-size)/2,size,size,0,0,256,256);
    const base64=canvas.toDataURL('image/jpeg',0.85).split(',')[1];
    if(base64.length>174764)throw Error('图片过大，请选择更简单的图片');
    return {mime:'image/jpeg',base64};
  }finally{bitmap.close()}
}
function avatarEditor(p,bot=false){
  const action=bot?'account.botAvatar':'social.profile.update';
  const args=avatar=>bot?{botId:p.botId,avatar}:{avatar};
  const box=el('section','avatar-editor'),input=el('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/gif';input.hidden=true;
  const choose=button(bot?'更换 Bot 头像':'更换我的头像',()=>input.click(),'primary');
  const remove=button(bot?'移除 Bot 头像':'移除头像',async()=>{if(!confirm(bot?`将 ${p.nickname||p.botId}（${p.botId}）的头像恢复为默认图标？`:'移除头像，恢复默认图标？'))return;try{await rpc(action,args(null));await accountSettings()}catch(e){notify(e.message)}});
  input.onchange=async()=>{if(!input.files?.[0])return;choose.disabled=remove.disabled=true;try{const avatar=await avatarUpload(input.files[0]);await rpc(action,args(avatar));await accountSettings();notify('头像已更新')}catch(e){notify(e.message)}finally{choose.disabled=remove.disabled=false;input.value=''}};
  add(box,avatarNode(bot?p.botId:p.humanId,p.avatarVersion,p.nickname),choose,input);if(p.avatarVersion)box.append(remove);
  box.append(el('small','muted',bot?'仅修改此 bot 的头像，它仍可自行更换头像。':'图片将居中裁成正方形。'));return box;
}

function pokeTextEditor(p,bot=false){return button(`戳一戳文案：${p.pokeText||'默认'}`,async()=>{
  const text=prompt(`${bot?p.nickname||p.botId:'我'}被戳时，显示在昵称后的文案（最多 40 字）。例如“的小脑袋”；留空恢复默认。`,p.pokeText||'');
  if(text===null)return;if(text.length>40){notify('戳一戳文案最多 40 字');return}
  try{await rpc(bot?'account.botPokeText':'social.profile.update',bot?{botId:p.botId,pokeText:text}:{pokeText:text});await accountSettings();notify('戳一戳文案已保存')}catch(e){notify(e.message)}
})}
