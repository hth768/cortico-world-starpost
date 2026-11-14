import {createServer,request} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {createStarpostServer} from '../server/server.mjs';
mkdirSync(resolve('.deployment/test-tmp'),{recursive:true});
const dir=mkdtempSync(resolve('.deployment/test-tmp/search-web-')),mails=[],keys={10001:'a'.repeat(32),10002:'b'.repeat(32)};
const app=createStarpostServer({file:join(dir,'data.json'),keys,port:0,sendMail:async m=>mails.push(m)});await app.listen();
const backend=`http://127.0.0.1:${app.server.address().port}`;
async function post(path,body,token=''){const r=await fetch(backend+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});const v=await r.json();assert(v.ok,v.error);return v.result;}
const old=await post('/mobile/login',{botId:'10001',credential:keys['10001']});
const v=await post('/mobile/auth',{action:'code',email:'preview@example.com',purpose:'claim'},old.accessToken);
const account=await post('/mobile/auth',{action:'claim',email:'preview@example.com',nickname:'星河旅人',password:'preview-pass-123',challengeId:v.challengeId,code:mails.at(-1).code},old.accessToken);
app.store.befriend(account.humanId,'10002');app.store.befriend('10001','10002');
app.store.put('profiles','10002',{nickname:'晚风',bio:'一起出发'});
app.store.saveGroup({id:'preview-group',name:'周末出游计划',owner:account.humanId,members:[account.humanId,'10002']});
for(let i=0;i<60;i++){
  const at=new Date(Date.parse('2026-11-14T04:00:00Z')+i*60000).toISOString(),text=`海边散步 ${i+1}：周末一起看看日落，带上相机和喜欢的零食。`;
  for(const [collection,m]of[['ownerMessages',{id:`o${i}`,kind:'owner',botId:'10001',direction:'bot',sender:'10001',senderNickname:'陈玥汐'}],['messages',{id:`p${i}`,kind:'private',sender:'10002',target:account.humanId,senderNickname:'晚风'}],['messages',{id:`g${i}`,kind:'group',sender:'10002',target:'preview-group',senderNickname:'晚风'}],['messages',{id:`b${i}`,kind:'private',sender:'10002',target:'10001',senderNickname:'晚风'}]])app.store.put(collection,m.id,{...m,text,at});
}
const proxy=createServer((req,res)=>{
  if(req.method==='GET'){
    const path=new URL(req.url,'http://localhost').pathname;
    const file=/^\/[\w.-]+\.(js|css|json|svg)$/.test(path)?path.slice(1):'index.html';
    const full=resolve('web',file);if(!existsSync(full)){res.writeHead(404);res.end();return;}
    res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html');res.end(readFileSync(full));return;
  }
  const up=request(backend+req.url,{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});up.on('error',()=>res.end());req.pipe(up);
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${proxy.address().port}`;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const browser=spawn(process.env.STARPOST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${join(dir,'browser')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let ws;
try{
  const portFile=join(dir,'browser','DevToolsActivePort');for(let i=0;i<100&&!existsSync(portFile);i++)await delay(200);
  const port=readFileSync(portFile,'utf8').split('\n')[0],target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let seq=0;const pending=new Map(),exceptions=[];
  const cdp=(method,params={})=>new Promise((r,j)=>{const id=++seq;pending.set(id,{r,j});ws.send(JSON.stringify({id,method,params}));});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(Error(JSON.stringify(m.error))):p.r(m.result);}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);};
  const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expression=>{for(let i=0;i<80;i++){if(await js(`Boolean(${expression})`))return;await delay(150);}throw Error('timeout '+expression+' '+await js('document.body.innerText.slice(-1000)'));};
  const click=text=>js(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled&&b.offsetParent)?.click()`);
  const shot=async name=>{const out=resolve('.deployment/history-search-preview');mkdirSync(out,{recursive:true});writeFileSync(join(out,name+'.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));};
  await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Page.enable');
  await cdp('Network.setCookie',{name:'starpost_session',value:account.accessToken,url:base+'/web',path:'/web',httpOnly:true});
  await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:base+'/app/owner'});await until('typeof state!=="undefined" && state.account?.humanId && document.querySelector("#app-content textarea")');

  const bottom=()=>js('(()=>{const l=document.querySelector(".chat-log");return l.scrollHeight-l.clientHeight-l.scrollTop<3})()');
  const topAnchor=()=>js('(()=>{const l=document.querySelector(".chat-log"),t=l.getBoundingClientRect().top,n=[...l.querySelectorAll("[data-message-id]")].find(n=>n.getBoundingClientRect().bottom>t+1);return {id:n?.dataset.messageId,y:n?.getBoundingClientRect().top-t}})()');
  const refresh=()=>js('state.view==="owner"?loadOwner(document.querySelector(".chat-log")):state.view==="social"?socialChatHistory(true):loadChat(document.querySelector(".chat-log"))');
  const scrollUp=async()=>{await js('(()=>{const l=document.querySelector(".chat-log");l.dispatchEvent(new WheelEvent("wheel",{deltaY:-500}));l.scrollTop-=500;l.dispatchEvent(new Event("scroll"));l.dispatchEvent(new Event("scrollend"))})()');await delay(100);};
  let sequence=60;
  async function incoming(mode){const id='new'+sequence++,at=new Date(Date.parse('2026-11-14T08:00:00Z')+sequence*60000).toISOString();
    const m=mode==='owner'?{kind:'owner',botId:'10001',direction:'bot',sender:'10001',senderNickname:'陈玥汐'}:{kind:mode==='group'?'group':'private',sender:'10002',target:mode==='group'?'preview-group':mode==='readonly'?'10001':account.humanId,senderNickname:'晚风'};
    app.store.put(mode==='owner'?'ownerMessages':'messages',id,{id,...m,at,text:'新消息 '+id+'，这是回归验证里的普通聊天。'});await refresh();await delay(150);
  }
  for(const mode of ['owner','private','group','readonly']){
    if(mode==='owner')await js('navigate("owner")');
    else if(mode==='readonly')await js('(async()=>{state.kind="private";state.chat={kind:"private",target:"10002"};await navigate("chats")})()');
    else await js('(async()=>{state.kind='+JSON.stringify(mode)+';state.socialChat={kind:'+JSON.stringify(mode)+',target:'+JSON.stringify(mode==='group'?'preview-group':'10002')+'};await navigate("social")})()');
    await delay(150);assert(await bottom(),mode+' initial bottom');
    await incoming(mode);assert(await bottom(),mode+' incoming follows');
    await scrollUp();const anchor=await topAnchor();assert(!(await bottom()),mode+' scrolled up');
    await incoming(mode);const after=await topAnchor();assert.equal(after.id,anchor.id,mode+' preserve row');assert(Math.abs(after.y-anchor.y)<3,mode+' preserve offset');
    assert.equal(await js('document.querySelector(".chat-jump").textContent'),'有新消息 · 回到底部 ↓');
    await js('document.querySelector(".chat-jump").click()');await delay(200);assert(await bottom(),mode+' jump latest');
    await js('(()=>{const last=document.querySelector(".chat-log").lastElementChild;const img=new Image();img.style.height="210px";img.style.width="80px";img.style.display="block";setTimeout(()=>{img.src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";last.append(img)},80)})()');
    await delay(350);assert(await bottom(),mode+' late image follows');
    if(mode!=='readonly'){
      await scrollUp();await js('(()=>{const t=document.querySelector(".composer textarea");t.value="发送后应该看见这条消息";t.dispatchEvent(new Event("input"))})()');
      if(mode==='owner'){await js('(async()=>{state.address=(await rpc("owner.address",{address:"旅人"})).address})()');await click('发送');}
      else await js('document.querySelector(".composer").requestSubmit()');
      await until('document.querySelector(".composer textarea").value===""');await delay(250);assert(await bottom(),mode+' own send follows');
    }
    console.log('PASS '+mode+': initial/incoming/reading anchor/new-message badge/send/image');
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await js('navigate("owner")');await delay(200);assert(await bottom(),'phone initial');await scrollUp();await incoming('owner');await shot('scroll-phone-new-message');
  assert(await js('document.querySelector(".chat-log").clientHeight>200'));
  await click('查看更早消息');await delay(200);assert.equal(await js('document.querySelector(".chat-log").scrollTop'),0);
  const older=await topAnchor();await refresh();await delay(100);assert.equal((await topAnchor()).id,older.id);
  await js('document.querySelector(".chat-jump").click()');await delay(200);assert(await bottom(),'older page jump');
  assert.equal(exceptions.length,0,JSON.stringify(exceptions));console.log('PASS all web scroll regression cases');

}finally{ws?.close();browser.kill();await new Promise(r=>proxy.close(r));await app.close();}
