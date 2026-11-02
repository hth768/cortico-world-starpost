(() => {
  const LIMIT=10*1024*1024, key='starpost-background-mask';
  let url='', busy=false, mask=.6;
  try { const saved=localStorage.getItem(key);if(saved!==null&&Number.isFinite(Number(saved)))mask=Math.max(.2,Math.min(.9,Number(saved))); } catch {}
  const emit=()=>{document.documentElement.style.setProperty('--background-mask',`${Math.round(mask*100)}%`);document.documentElement.style.setProperty('--custom-background',url?`url("${url}")`:'none');document.documentElement.classList.toggle('custom-background',!!url);dispatchEvent(new Event('starpost-background'));};
  function database(mode,operation){return new Promise((resolve,reject)=>{
    const request=indexedDB.open('starpost-appearance',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('background');
    request.onerror=()=>reject(new Error('浏览器无法保存背景，请检查存储权限'));
    request.onblocked=()=>reject(new Error('请关闭其他星邮页面后重试'));
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('background',mode);let result;
      const op=operation(tx.objectStore('background'));op.onsuccess=()=>{result=op.result};
      tx.oncomplete=()=>{db.close();resolve(result)};tx.onabort=tx.onerror=()=>{db.close();reject(new Error('背景保存失败，可能是本地存储空间不足'))};
    };
  });}
  async function replace(blob){url=blob?await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取背景'));reader.readAsDataURL(blob)}):'';emit();}
  const ready=database('readonly',s=>s.get('image')).then(blob=>{if(blob instanceof Blob&&blob.type==='image/jpeg'&&blob.size<=2*1024*1024)return replace(blob)}).catch(()=>{});
  async function normalize(file){
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>LIMIT)throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片');
    let bitmap;
    try { bitmap=await createImageBitmap(file,{imageOrientation:'from-image'}); } catch {throw new Error('无法读取这张图片，请换一张试试');}
    try {
      if(bitmap.width*bitmap.height>40_000_000)throw new Error('图片尺寸过大，请选择 4000 万像素以内的图片');
      const ratio=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));
      if(!blob||blob.size>2*1024*1024)throw new Error('图片处理失败或过大，请换一张图片');
      return blob;
    } finally {bitmap.close();}
  }
  async function change(file){
    if(busy)return;busy=true;emit();
    try {await ready;const blob=file?await normalize(file):null;await database('readwrite',s=>blob?s.put(blob,'image'):s.delete('image'));await replace(blob);if(!blob)setMask(.6);}
    finally {busy=false;emit();}
  }
  function setMask(value){mask=Math.max(.2,Math.min(.9,Number.isFinite(Number(value))?Number(value):.6));try{localStorage.setItem(key,String(mask))}catch{}emit();}
  window.starpostBackground={get url(){return url},get busy(){return busy},get mask(){return mask},change,setMask,ready};
  emit();
})();
