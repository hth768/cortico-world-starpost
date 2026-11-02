package io.starpost.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.*
import java.io.ByteArrayOutputStream
import java.io.ByteArrayInputStream

internal val LocalAvatarProfile = staticCompositionLocalOf<((String)->Unit)?> { null }

internal val LocalAvatarClient = staticCompositionLocalOf<StarpostClient?> { null }

/** Decode bounded input and upload only a small, static, square JPEG. */
internal fun avatarUpload(bytes:ByteArray):org.json.JSONObject {
    require(bytes.size<=10*1024*1024){"请选择 10 MB 以内的图片"}
    val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true}
    BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
    require(bounds.outWidth>0&&bounds.outHeight>0&&bounds.outWidth.toLong()*bounds.outHeight<=40_000_000){"图片无效或尺寸过大"}
    var sample=1
    while(minOf(bounds.outWidth,bounds.outHeight)/sample>512||maxOf(bounds.outWidth,bounds.outHeight)/sample>2048)sample*=2
    val decoded=requireNotNull(BitmapFactory.decodeByteArray(bytes,0,bytes.size,BitmapFactory.Options().apply{inSampleSize=sample})){"无法读取图片"}
    val side=minOf(decoded.width,decoded.height)
    val cropped=Bitmap.createBitmap(decoded,(decoded.width-side)/2,(decoded.height-side)/2,side,side)
    val orientation=runCatching { ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL) }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    val matrix=Matrix().apply{when(orientation){
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL->setScale(-1f,1f)
        ExifInterface.ORIENTATION_ROTATE_180->setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL->setScale(1f,-1f)
        ExifInterface.ORIENTATION_TRANSPOSE->{setRotate(90f);postScale(-1f,1f)}
        ExifInterface.ORIENTATION_ROTATE_90->setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE->{setRotate(90f);postScale(1f,-1f)}
        ExifInterface.ORIENTATION_ROTATE_270->setRotate(270f)
    }}
    val oriented=Bitmap.createBitmap(cropped,0,0,side,side,matrix,true)
    val scaled=Bitmap.createScaledBitmap(oriented,256,256,true)
    val output=ByteArrayOutputStream()
    try { scaled.compress(Bitmap.CompressFormat.JPEG,85,output) }
    finally { listOf(scaled,oriented,cropped,decoded).distinct().forEach{it.recycle()} }
    val data=output.toByteArray();require(data.size<=131072){"图片过大，请选择更简单的图片"}
    return obj("mime" to "image/jpeg","base64" to Base64.encodeToString(data,Base64.NO_WRAP))
}

@Composable internal fun AvatarPicture(id:String,version:String,label:String) {
    val vm=LocalAvatarClient.current
    val bitmap by produceState<Bitmap?>(null,vm,id,version){
        if(vm!=null&&id.isNotBlank()&&version.isNotBlank())value=vm.avatar(id,version)
    }
    bitmap?.let { Image(it.asImageBitmap(),"$label 的头像",Modifier.fillMaxSize().clip(CircleShape),contentScale=ContentScale.Crop) }
}

@Composable internal fun AvatarEditor(ui:UiActions,version:String,botId:String="",botName:String="") {
    val action=if(botId.isEmpty())"social.profile.update" else "account.botAvatar"
    fun payload(image:org.json.JSONObject?)=obj("avatar" to image).apply{if(botId.isNotEmpty())put("botId",botId)}
    val context=LocalContext.current;val scope=rememberCoroutineScope();var busy by remember{mutableStateOf(false)}
    val picker=rememberLauncherForActivityResult(ActivityResultContracts.GetContent()){uri:Uri?->
        if(uri!=null)scope.launch {
            busy=true
            try {
                val image=withContext(Dispatchers.IO){
                    val bytes=context.contentResolver.openInputStream(uri)?.use{stream->
                        val output=ByteArrayOutputStream();val buffer=ByteArray(8192)
                        while(true){val count=stream.read(buffer);if(count<0)break;require(output.size()+count<=10*1024*1024){"请选择 10 MB 以内的图片"};output.write(buffer,0,count)}
                        output.toByteArray()}?:error("无法读取图片")
                    avatarUpload(bytes)
                }
                ui.vm.perform(action,payload(image)){ui.vm.notice("头像已更新")}
            }catch(e:CancellationException){throw e}catch(e:Exception){ui.vm.notice(e.message?:"无法读取图片")}
            finally {busy=false}
        }
    }
    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
        FilledTonalButton(enabled=!busy&&!ui.vm.state.value.working,onClick={picker.launch("image/*")}){Text(if(busy)"正在处理…" else if(botId.isEmpty())"更换我的头像" else "更换 Bot 头像")}
        if(version.isNotEmpty())TextButton(enabled=!busy&&!ui.vm.state.value.working,onClick={ui.confirm("移除头像",if(botId.isEmpty())"恢复默认头像？" else "将 $botName（$botId）的头像恢复为默认图标？"){ui.vm.perform(action,payload(null))}}){Text(if(botId.isEmpty())"移除头像" else "移除 Bot 头像")}
    }
    Text(if(botId.isEmpty())"图片将居中裁成正方形。" else "仅修改此 bot 的头像，它仍可自行更换头像。",style=MaterialTheme.typography.bodySmall)
}

@Composable internal fun PokeTextEditor(ui:UiActions,value:String,botId:String="",name:String="我") {
    TextButton(onClick={ui.form("${name}的戳一戳文案",listOf(TextFieldSpec("pokeText","昵称后的文案（最多 40 字）",value)),"例如填写“的小脑袋”，显示为“张三戳了戳李四的小脑袋”。留空恢复默认。"){fields->
        ui.vm.perform(if(botId.isEmpty())"social.profile.update" else "account.botPokeText",obj("pokeText" to fields["pokeText"]).apply{if(botId.isNotEmpty())put("botId",botId)})
    }}){Text("戳一戳文案：${value.ifEmpty{"默认"}}")}
}
