package io.starpost.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File

private var playingVoice:MediaPlayer?=null

@Composable internal fun VoiceButton(ui:UiActions,m:JSONObject,messageId:String=m.str("id"),itemIndex:Int?=null){
    val audio=m.optJSONObject("audio")?:return
    if(m.optBoolean("recalled"))return
    val context=LocalContext.current;val lifecycle=LocalLifecycleOwner.current;val scope=rememberCoroutineScope()
    val s=ui.vm.state.value;val route=s.route;val bot=s.account.str("botId");val account=s.account.str("humanId")
    var busy by remember(messageId,itemIndex){mutableStateOf(false)};var playing by remember(messageId,itemIndex){mutableStateOf(false)}
    var player by remember(messageId,itemIndex){mutableStateOf<MediaPlayer?>(null)};var file by remember(messageId,itemIndex){mutableStateOf<File?>(null)}
    var job by remember{mutableStateOf<Job?>(null)}
    fun stop(){job?.cancel();job=null;player?.let{if(playingVoice===it)playingVoice=null;runCatching{it.release()}};player=null;playing=false;busy=false;file?.delete();file=null}
    DisposableEffect(messageId,itemIndex,route,bot,account,lifecycle){
        val observer=LifecycleEventObserver{_,event->if(event==Lifecycle.Event.ON_STOP)stop()};lifecycle.lifecycle.addObserver(observer)
        onDispose{lifecycle.lifecycle.removeObserver(observer);stop()}
    }
    FilledTonalButton(enabled=!busy,onClick={
        if(playing){stop();return@FilledTonalButton}
        busy=true
        job=scope.launch{try{
            val owner=route.page=="owner";val viewer=route.page=="history"||route.page=="blockedHistory"
            val args=obj("kind" to if(owner)"owner" else route.kind,"target" to if(owner)bot else route.id,"messageId" to messageId,"viewerBotId" to bot).apply{if(itemIndex!=null)put("itemIndex",itemIndex)}
            val result=ui.vm.readAudio(if(owner)"owner.audio" else if(viewer)"message.audio" else "social.message.audio",args)
            require(result.str("mime") in listOf("audio/mpeg","audio/wav","audio/ogg","audio/webm","audio/mp4")){"不支持的语音格式"}
            val data=result.str("base64");require(data.length<=6990508){"语音超过大小限制"}
            val voice=withContext(Dispatchers.IO){val dir=File(context.cacheDir,"voice-playback").apply{mkdirs()};dir.listFiles()?.filter{it.isFile&&System.currentTimeMillis()-it.lastModified()>86400000}?.forEach{it.delete()};File.createTempFile("voice-",".audio",dir).apply{writeBytes(Base64.decode(data,Base64.DEFAULT))}}
            file=voice
            val mp=MediaPlayer();player=mp
            mp.setOnPreparedListener{if(player===it){playingVoice?.let{old->runCatching{old.pause()}};playingVoice=it;it.start();playing=true;busy=false}}
            mp.setOnCompletionListener{stop()};mp.setOnErrorListener{_,_,_->stop();ui.vm.notice("播放失败，音频格式可能不受设备支持");true}
            mp.setDataSource(voice.absolutePath);mp.prepareAsync()
        }catch(e:CancellationException){throw e}catch(e:Exception){stop();ui.vm.notice(e.message?:"无法播放语音")}}
    }){Text(if(busy)"正在读取语音…" else if(playing)"■ 停止播放" else "▶ 语音"+(if(audio.optLong("durationMs")>0)" · ${(audio.optLong("durationMs")+999)/1000}秒" else ""))}
}


@Composable internal fun RecordVoiceButton(ui:UiActions,enabled:Boolean,onSend:(JSONObject,()->Unit)->Unit){
    val context=LocalContext.current;val lifecycle=LocalLifecycleOwner.current
    var open by remember{mutableStateOf(false)};var recorder by remember{mutableStateOf<MediaRecorder?>(null)}
    var file by remember{mutableStateOf<File?>(null)};var started by remember{mutableLongStateOf(0)};var elapsed by remember{mutableIntStateOf(0)}
    var cancel by remember{mutableStateOf(false)};var limited by remember{mutableStateOf(false)};var pending by remember{mutableStateOf<JSONObject?>(null)}
    val sendLatest by rememberUpdatedState(onSend)
    fun close(){recorder?.let{runCatching{it.stop()};it.release()};recorder=null;file?.delete();file=null;open=false;cancel=false;limited=false}
    fun stopRecording():Boolean{val r=recorder?:return file!=null;recorder=null;return try{r.stop();true}catch(e:Exception){false}finally{r.release()}}
    fun sendPending(){val audio=pending?:return;sendLatest(audio){pending=null}}
    fun finish(discard:Boolean){
        val duration=(System.currentTimeMillis()-started).coerceAtMost(120000).toInt();val stopped=stopRecording()
        try{if(!discard){require(stopped&&duration>=500){"录音太短，请重新长按录音"};val bytes=file!!.readBytes();require(bytes.size in 12..5*1024*1024){"录音超过大小限制"};pending=obj("mime" to "audio/mp4","base64" to Base64.encodeToString(bytes,Base64.NO_WRAP),"durationMs" to duration)}}
        catch(e:Exception){ui.vm.notice(e.message?:"录音失败")}
        finally{close()}
        if(!discard&&pending!=null)sendPending()
    }
    fun begin():Boolean=try{
        close();val dir=File(context.cacheDir,"voice-recording").apply{mkdirs()};dir.listFiles()?.filter{it.isFile}?.forEach{it.delete()}
        val output=File.createTempFile("record-",".m4a",dir);file=output
        @Suppress("DEPRECATION") val r=if(Build.VERSION.SDK_INT>=31)MediaRecorder(context)else MediaRecorder()
        recorder=r;r.setAudioSource(MediaRecorder.AudioSource.MIC);r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);r.setAudioSamplingRate(44100);r.setAudioEncodingBitRate(64000);r.setOutputFile(output.absolutePath);r.setMaxDuration(120000);r.setMaxFileSize(5L*1024*1024)
        r.setOnInfoListener{_,what,_->if(what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED||what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED){limited=stopRecording();if(!limited){close();ui.vm.notice("录音失败")}}}
        r.setOnErrorListener{_,_,_->close();ui.vm.notice("麦克风录音失败，请重试")};r.prepare();r.start();started=System.currentTimeMillis();elapsed=0;open=true;true
    }catch(e:Exception){close();ui.vm.notice("无法录音，请检查麦克风权限或是否被其他应用占用");false}
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){granted->ui.vm.notice(if(granted)"已授权，请再次长按录音" else "录音需要麦克风权限，可在系统设置中允许")}
    val beginLatest by rememberUpdatedState(::begin);val finishLatest by rememberUpdatedState(::finish);val closeLatest by rememberUpdatedState(::close)
    DisposableEffect(lifecycle){val observer=LifecycleEventObserver{_,event->if(event==Lifecycle.Event.ON_STOP)close()};lifecycle.lifecycle.addObserver(observer);onDispose{lifecycle.lifecycle.removeObserver(observer);close()}}
    LaunchedEffect(open){while(open){delay(250);elapsed=((System.currentTimeMillis()-started)/1000).toInt().coerceAtMost(120);if(elapsed>=120&&!limited){limited=stopRecording()}}}
    if(pending!=null){Row{TextButton(enabled=enabled,onClick={sendPending()}){Text("重发语音")};TextButton(enabled=enabled,onClick={pending=null}){Text("丢弃")}}}
    else HoldVoiceGesture(enabled,onStart={
        if(ContextCompat.checkSelfPermission(context,Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){permission.launch(Manifest.permission.RECORD_AUDIO);false}else beginLatest()
    },onFinish={finishLatest(it)},onCancel={closeLatest()},onSlide={cancel=it})
    if(open)Popup(alignment=Alignment.Center,properties=PopupProperties(focusable=false)){
        Surface(shape=MaterialTheme.shapes.extraLarge,color=if(cancel)MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer){Column(Modifier.padding(28.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(12.dp)){
            Text(if(cancel)"松手取消" else if(limited)"已达录音上限 · 松手发送" else "录音中 · 松手发送",style=MaterialTheme.typography.titleLarge)
            Text("$elapsed / 120 秒");Text("手指上滑取消发送")
        }}
    }
}
