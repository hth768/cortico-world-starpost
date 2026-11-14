@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package io.starpost.mobile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest

internal fun chatImage(bytes:ByteArray):JSONObject {
    require(bytes.size<=10*1024*1024){"请选择 10 MB 以内的图片"}
    val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
    require(bounds.outWidth>0&&bounds.outHeight>0&&bounds.outWidth.toLong()*bounds.outHeight<=40_000_000){"请选择 4000 万像素以内的有效图片"}
    if(bounds.outMimeType=="image/gif"){require(bytes.size<=1024*1024){"GIF 须在 1 MiB 以内"};return obj("mime" to "image/gif","base64" to Base64.encodeToString(bytes,Base64.NO_WRAP))}
    var encoded=backgroundImage(bytes)
    if(encoded.size>1024*1024){val bitmap=requireNotNull(BitmapFactory.decodeByteArray(encoded,0,encoded.size));try{for(q in listOf(70,50)){val out=ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.JPEG,q,out);encoded=out.toByteArray();if(encoded.size<=1024*1024)break}}finally{bitmap.recycle()}}
    require(encoded.size<=1024*1024){"图片压缩后仍超过 1 MiB，请缩小图片"}
    return obj("mime" to "image/jpeg","base64" to Base64.encodeToString(encoded,Base64.NO_WRAP))
}

@Composable internal fun ChatPhotoButton(ui:UiActions,enabled:Boolean,label:String="发送图片",onSend:(JSONObject)->Unit){
    val context=LocalContext.current;val scope=rememberCoroutineScope();var image by remember{mutableStateOf<JSONObject?>(null)};var busy by remember{mutableStateOf(false)}
    var choose by remember{mutableStateOf(false)}
    var cameraPath by rememberSaveable{mutableStateOf<String?>(null)}
    val camera=rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()){success->
        val file=cameraPath?.let(::File);cameraPath=null
        if(file!=null)scope.launch{busy=true;try{
            if(success)image=withContext(Dispatchers.IO){require(file.length() in 1..10L*1024*1024){"照片超过 10 MB，请降低相机分辨率"};chatImage(file.readBytes())}
        }catch(e:CancellationException){throw e}catch(e:Exception){ui.vm.notice(e.message?:"照片读取失败")}finally{file.delete();busy=false}}
    }
    val picker=rememberLauncherForActivityResult(ActivityResultContracts.GetContent()){uri:Uri?->if(uri!=null)scope.launch{
        busy=true;try{image=withContext(Dispatchers.IO){val bytes=context.contentResolver.openInputStream(uri)?.use{stream->val out=ByteArrayOutputStream();val buf=ByteArray(8192);while(true){val n=stream.read(buf);if(n<0)break;require(out.size()+n<=10*1024*1024){"请选择 10 MB 以内的图片"};out.write(buf,0,n)};out.toByteArray()}?:error("无法读取图片");chatImage(bytes)}}catch(e:CancellationException){throw e}catch(e:Exception){ui.vm.notice(e.message?:"图片处理失败")}finally{busy=false}
    }}
    Box{
        IconButton(enabled=enabled&&!busy,onClick={choose=true}){Glyph("add","图片与拍照")}
        DropdownMenu(expanded=choose,onDismissRequest={choose=false}){
            DropdownMenuItem(text={Text("拍照发送")},onClick={choose=false;try{
                val dir=File(context.cacheDir,"camera-capture").apply{mkdirs()}
                dir.listFiles()?.filter{it.isFile&&System.currentTimeMillis()-it.lastModified()>86400000}?.forEach{it.delete()}
                val file=File.createTempFile("photo-",".jpg",dir);cameraPath=file.absolutePath
                camera.launch(FileProvider.getUriForFile(context,"${context.packageName}.updates",file))
            }catch(e:Exception){cameraPath?.let{File(it).delete()};cameraPath=null;ui.vm.notice("无法启动系统相机，请确认设备已安装相机应用")}})
            DropdownMenuItem(text={Text("从相册选择")},onClick={choose=false;picker.launch("image/*")})
        }
    }
    image?.let{picture->AlertDialog(onDismissRequest={image=null},title={Text(label)},text={MessageImage(picture,ui)},confirmButton={Button(enabled=enabled,onClick={image=null;onSend(picture)}){Text(label)}},dismissButton={TextButton(onClick={image=null}){Text("取消")}})}
}

internal fun messageImageFile(context:Context,image:JSONObject):File {
        val bytes=Base64.decode(image.getString("base64"),Base64.DEFAULT);require(bytes.size<=1024*1024)
        val extension=mapOf("image/png" to "png","image/jpeg" to "jpg","image/gif" to "gif","image/webp" to "webp")[image.str("mime")]?:error("图片格式无效")
        val directory=File(context.cacheDir,"message-images").apply{mkdirs()};val hash=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)};val file=File(directory,"$hash.$extension");file.writeBytes(bytes)
        directory.listFiles()?.filter{it!=file&&it.isFile}?.sortedByDescending{it.lastModified()}?.drop(9)?.forEach{it.delete()}
        return file
}

internal fun copyMessage(context:Context,m:JSONObject){
    val clipboard=context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager;val image=m.optJSONObject("image")
    if(image!=null){
        val uri=FileProvider.getUriForFile(context,"${context.packageName}.updates",messageImageFile(context,image))
        clipboard.setPrimaryClip(ClipData.newUri(context.contentResolver,"星邮图片",uri))
    }else clipboard.setPrimaryClip(ClipData.newPlainText("星邮消息",m.str("text")+m.str("emoji")+(m.optJSONObject("forward")?.let{"\n[聊天记录 · ${it.optInt("count")} 条]\n${it.strings("preview").joinToString("\n")}"}?:"")))
}

@Composable internal fun MessageActionMenu(ui:UiActions,m:JSONObject,canWrite:Boolean,mine:Boolean,onDismiss:()->Unit,onQuote:()->Unit={},onRecall:()->Unit={},onForward:()->Unit={},onSelect:()->Unit={},onReport:(()->Unit)?=null){
    val context=LocalContext.current
    ModalBottomSheet(onDismissRequest=onDismiss){Column(Modifier.padding(24.dp).navigationBarsPadding(),verticalArrangement=Arrangement.spacedBy(12.dp)){
        Text("消息操作",style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold)
        val actions=mutableListOf<Pair<String,()->Unit>>("复制" to {try{copyMessage(context,m);ui.vm.notice("已复制")}catch(e:Exception){ui.vm.notice(e.message?:"复制失败")}})
        if(canWrite&&!m.optBoolean("recalled")){
            actions+="引用" to onQuote
            val age=runCatching{System.currentTimeMillis()-java.time.Instant.parse(m.str("at")).toEpochMilli()}.getOrDefault(Long.MAX_VALUE)
            if(mine&&age in 0..120000)actions+="撤回" to onRecall
            actions+="转发" to onForward;actions+="多选" to onSelect
        }
        if(m.optJSONObject("image")!=null&&!m.optBoolean("recalled"))actions+="保存表情" to {ui.vm.collect(m.getJSONObject("image"))}
        if(onReport!=null&&!m.optBoolean("recalled"))actions+="举报" to onReport
        actions.chunked(3).forEach{row->Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){row.forEach{(label,fn)->FilledTonalButton(modifier=Modifier.weight(1f).heightIn(min=56.dp),onClick={fn();onDismiss()}){Text(label)}};repeat(3-row.size){Spacer(Modifier.weight(1f))}}}
        TextButton(onClick=onDismiss,modifier=Modifier.fillMaxWidth()){Text("取消")}
    }}
}

@Composable internal fun ForwardCard(value:JSONObject,onClick:()->Unit){
    OutlinedCard(onClick=onClick,shape=RoundedCornerShape(18.dp),modifier=Modifier.widthIn(min=180.dp,max=320.dp)){
        Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
            Text("聊天记录 · ${value.optInt("count")} 条",fontWeight=FontWeight.Bold)
            value.strings("preview").take(3).forEach{Text(it,style=MaterialTheme.typography.bodySmall,maxLines=1,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis)}
            HorizontalDivider();Text("查看完整聊天记录 →",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable internal fun ForwardRecordDialog(ui:UiActions,value:JSONObject,onDismiss:()->Unit){
    var menu by remember{mutableStateOf<JSONObject?>(null)}
    AlertDialog(onDismissRequest=onDismiss,title={Text("完整聊天记录")},text={Column(Modifier.heightIn(max=560.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(14.dp)){
        Text("转发时保存的记录，保留原作者和发送时间。",style=MaterialTheme.typography.labelMedium)
        if(value.optJSONObject("message")?.optBoolean("recalled")==true)Text("该记录已撤回")
        value.rows("items").forEachIndexed{index,m->Surface(shape=RoundedCornerShape(20.dp),color=MaterialTheme.colorScheme.surfaceContainerHigh,modifier=Modifier.fillMaxWidth().combinedClickable(onClick={},onLongClick={menu=m})){
            Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){AccountTitleBadge(m.str("senderTitle"),style=m.optJSONObject("senderTitleStyle"));Text("${m.str("senderNickname",m.str("sender"))} · ${m.str("sender")}\n${time(m.str("at"))}",style=MaterialTheme.typography.labelSmall);m.optJSONObject("quote")?.let{Text("引用 ${it.str("senderNickname")}：${it.str("text")}",style=MaterialTheme.typography.bodySmall)};if(m.str("text").isNotEmpty()||m.str("emoji").isNotEmpty())Text(m.str("text")+m.str("emoji"));VoiceButton(ui,m,value.optJSONObject("message")?.str("id")?:"",index);MessageImage(m.optJSONObject("image"),ui,onLongClick={menu=m})}
        }}
    }},confirmButton={TextButton(onClick=onDismiss){Text("关闭")}})
    menu?.let{MessageActionMenu(ui,it,false,false,{menu=null})}
}

@Composable internal fun ForwardTargetDialog(ui:UiActions,s:ClientState,contacts:JSONObject,count:Int,onDismiss:()->Unit,onTarget:(Route)->Unit){
    AlertDialog(onDismissRequest=onDismiss,title={Text("转发聊天记录 · $count 条")},text={Column(Modifier.heightIn(max=460.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
        Text("选择接收对象，发送一张可展开的记录卡片。")
        contacts.rows("friendProfiles").forEach{p->TextButton(enabled=!s.working,onClick={onTarget(Route("socialHistory",p.str("botId"),"private"))}){Text(contactName(p,p.str("botId")))}}
        contacts.rows("groups").forEach{g->TextButton(enabled=!s.working,onClick={onTarget(Route("socialHistory",g.str("id"),"group"))}){Text("群聊 · ${g.str("name")}")}}
        if(s.account.str("botId").isNotEmpty())TextButton(enabled=!s.working,onClick={onTarget(Route("owner"))}){Text("我的 bot · 专属频道")}
    }},confirmButton={TextButton(onClick=onDismiss){Text("取消")}})
}
