// Audio is fetched only on play, with the same conversation permission as its message.
(() => {
  let active=null;
  const urls=new Map();
  function closeAudio(){if(active){active.pause();active=null}}
  function attach(root,m,c){
    if(!m.audio||m.recalled)return;
    const wrap=el('div','voice-message'),play=button('▶ 播放语音'+(m.audio.durationMs?` · ${Math.ceil(m.audio.durationMs/1000)}秒`:''),async()=>{
      play.disabled=true;
      try{
        const mode=c.voiceMode||c.mode,action=mode==='owner'?'owner.audio':mode==='readonly'?'message.audio':'social.message.audio';
        const value=await rpc(action,{kind:c.kind,target:c.target,messageId:c.voiceMessageId||m.id,...(c.voiceItemIndex!==undefined?{itemIndex:c.voiceItemIndex}:{})});
        if(!root.isConnected)return;
        if(!/^audio\/(mpeg|wav|ogg|webm|mp4)$/.test(value.mime)||value.base64.length>6990508)throw Error('语音数据格式不合法');
        const bytes=Uint8Array.from(atob(value.base64),v=>v.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:value.mime}));
        const audio=el('audio');audio.controls=true;audio.preload='none';audio.src=url;audio.setAttribute('aria-label','语音消息');
        audio.onplay=()=>{if(active!==audio)closeAudio();active=audio};urls.set(audio,url);wrap.replaceChildren(audio);await audio.play();
      }catch(e){notify(e.message);play.disabled=false;}
    });wrap.append(play);root.append(wrap);
  }
  function holdButton(send){
    const control=button('🎙',()=>{});control.setAttribute('aria-label','长按录音，松手发送，上滑取消');control.title='长按录音，松手发送，上滑取消';control.classList.add('voice-hold');
    let stream,recorder,overlay,status,timer,longTimer,start=0,originY=0,held=false,cancelled=false,ended=false,wantSend=false,limit=false,session=0,chunks=[],bytes=0,pending=null,sending=false;
    function cleanup(){session++;clearTimeout(longTimer);clearInterval(timer);held=false;ended=true;wantSend=false;if(recorder?.state==='recording')recorder.stop();stream?.getTracks().forEach(t=>t.stop());stream=null;overlay?.remove();overlay=null;recorder=null;control.classList.remove('recording');}
    function paint(){if(status)status.textContent=cancelled?'松手取消':limit?'已达录音上限 · 松手发送':'录音中 · '+Math.min(120,Math.floor((Date.now()-start)/1000))+' / 120 秒 · 松手发送';}
    async function submit(){if(!pending||sending)return;sending=true;control.disabled=true;try{
      const {blob,durationMs}=pending,base64=await new Promise((ok,no)=>{const reader=new FileReader();reader.onload=()=>ok(reader.result.split(',')[1]);reader.onerror=no;reader.readAsDataURL(blob)});
      await send({mime:blob.type,base64,durationMs});pending=null;control.textContent='🎙';
    }catch(e){notify(e.message);control.textContent='重发语音';}finally{sending=false;control.disabled=false}}
    async function begin(){
      if(!held)return;
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){cleanup();notify('录音需要 HTTPS 和支持录音的浏览器');return;}
      const ticket=++session;ended=false;wantSend=false;limit=false;chunks=[];bytes=0;
      try{
        const audioStream=await navigator.mediaDevices.getUserMedia({audio:true});
        if(ticket!==session||!held){audioStream.getTracks().forEach(t=>t.stop());notify('麦克风已授权，请再次长按录音');return;}
        stream=audioStream;const mime=['audio/mp4','audio/webm;codecs=opus','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw Error('浏览器没有可用的录音编码器');
        recorder=new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:64000});
        overlay=el('div','voice-recording-overlay');status=el('strong');overlay.append(status,el('small','','手指上滑取消发送'));document.body.append(overlay);control.classList.add('recording');
        recorder.ondataavailable=e=>{if(ticket!==session||!e.data.size)return;bytes+=e.data.size;if(bytes>5*1024*1024){cleanup();notify('录音超过 5 MiB，请缩短录音');return;}chunks.push(e.data)};
        recorder.onerror=()=>{cleanup();notify('录音失败，请检查麦克风')};
        recorder.onstop=()=>{
          clearInterval(timer);audioStream.getTracks().forEach(t=>t.stop());if(ticket!==session)return;
          ended=true;const blob=new Blob(chunks,{type:mime.split(';')[0]}),durationMs=Math.min(120000,Date.now()-start);
          if(blob.size&&durationMs>=500)pending={blob,durationMs};
          if(wantSend){cleanup();if(pending)void submit();else notify('录音太短，请重新长按录音')}
        };
        start=Date.now();recorder.start(500);paint();timer=setInterval(()=>{if(!control.isConnected){cleanup();return;}if(Date.now()-start>=120000&&!limit){limit=true;if(recorder?.state==='recording')recorder.stop();}paint()},200);
      }catch(e){cleanup();notify(e.name==='NotAllowedError'?'请允许麦克风权限后重试':e.message)}
    }
    function release(discard=false){clearTimeout(longTimer);held=false;if(discard||cancelled){pending=null;cleanup();return;}if(!recorder){cleanup();return;}wantSend=true;if(recorder.state==='recording')recorder.stop();else if(ended){cleanup();if(pending)void submit();}}
    control.addEventListener('pointerdown',e=>{if(e.button!==0||sending||pending)return;e.preventDefault();control.setPointerCapture(e.pointerId);held=true;cancelled=false;originY=e.clientY;longTimer=setTimeout(begin,350)});
    control.addEventListener('pointermove',e=>{if(!held)return;cancelled=e.clientY<originY-72;overlay?.classList.toggle('cancel',cancelled);paint()});
    control.addEventListener('pointerup',()=>release());control.addEventListener('pointercancel',()=>release(true));
    control.addEventListener('contextmenu',e=>e.preventDefault());control.onclick=()=>{if(pending&&!sending)void submit()};
    control.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat&&!sending&&!pending){e.preventDefault();held=true;cancelled=false;void begin()}if(e.key==='Escape'){pending=null;cleanup();control.textContent='🎙'}});
    control.addEventListener('keyup',e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();release()}});
    control.addEventListener('blur',()=>{if(held)release(true)});
    const background=()=>{if(document.hidden)release(true)};document.addEventListener('visibilitychange',background);
    const observer=new MutationObserver(()=>{if(!control.isConnected){cleanup();pending=null;document.removeEventListener('visibilitychange',background);observer.disconnect()}});queueMicrotask(()=>{if(control.isConnected)observer.observe(document.documentElement,{childList:true,subtree:true})});
    return control;
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden)closeAudio()});
  new MutationObserver(()=>{for(const [audio,url]of urls)if(!audio.isConnected){audio.pause();URL.revokeObjectURL(url);urls.delete(audio)}}).observe(document.documentElement,{childList:true,subtree:true});
  window.VoiceUI={attach,button:holdButton};
})();
