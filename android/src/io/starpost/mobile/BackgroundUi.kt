package io.starpost.mobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Canvas
import android.net.Uri
import android.util.AtomicFile
import androidx.exifinterface.media.ExifInterface
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.roundToInt

/** Local-only, bounded image; metadata and the picked URI are never retained. */
internal fun backgroundImage(bytes:ByteArray):ByteArray {
    require(bytes.size<=10*1024*1024){"请选择 10 MB 以内的图片"}
    val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true}
    BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
    require(bounds.outMimeType in listOf("image/png","image/jpeg","image/webp")&&bounds.outWidth>0&&bounds.outHeight>0&&bounds.outWidth.toLong()*bounds.outHeight<=40_000_000){"请选择 4000 万像素以内的 PNG、JPEG 或 WebP 图片"}
    var sample=1
    while(maxOf(bounds.outWidth,bounds.outHeight)/sample>3200)sample*=2
    val decoded=requireNotNull(BitmapFactory.decodeByteArray(bytes,0,bytes.size,BitmapFactory.Options().apply{inSampleSize=sample})){"无法读取图片"}
    val orientation=runCatching{ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL)}.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    val matrix=Matrix().apply{when(orientation){
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL->setScale(-1f,1f)
        ExifInterface.ORIENTATION_ROTATE_180->setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL->setScale(1f,-1f)
        ExifInterface.ORIENTATION_TRANSPOSE->{setRotate(90f);postScale(-1f,1f)}
        ExifInterface.ORIENTATION_ROTATE_90->setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE->{setRotate(90f);postScale(1f,-1f)}
        ExifInterface.ORIENTATION_ROTATE_270->setRotate(270f)
    }}
    val oriented=Bitmap.createBitmap(decoded,0,0,decoded.width,decoded.height,matrix,true)
    val ratio=minOf(1f,1600f/maxOf(oriented.width,oriented.height))
    val scaled=Bitmap.createScaledBitmap(oriented,maxOf(1,(oriented.width*ratio).roundToInt()),maxOf(1,(oriented.height*ratio).roundToInt()),true)
    val flattened=Bitmap.createBitmap(scaled.width,scaled.height,Bitmap.Config.ARGB_8888)
    val output=ByteArrayOutputStream()
    try {Canvas(flattened).apply{drawColor(android.graphics.Color.WHITE);drawBitmap(scaled,0f,0f,null)};check(flattened.compress(Bitmap.CompressFormat.JPEG,85,output))}
    finally {listOf(flattened,scaled,oriented,decoded).distinct().forEach{it.recycle()}}
    return output.toByteArray().also{require(it.size<=2*1024*1024){"图片过大，请换一张图片"}}
}

internal class BackgroundAppearance(context:Context) {
    private val file=AtomicFile(File(context.filesDir,"appearance-background.jpg"))
    private val prefs=context.getSharedPreferences("starpost-appearance",Context.MODE_PRIVATE)
    var bitmap by mutableStateOf<Bitmap?>(null);private set
    var mask by mutableFloatStateOf(prefs.getFloat("background-mask",.6f).let{if(it.isFinite())it.coerceIn(.2f,.9f)else .6f});private set
    var busy by mutableStateOf(true);private set
    suspend fun load(){try{bitmap=withContext(Dispatchers.IO){runCatching{file.openRead().use{BitmapFactory.decodeStream(it)}}.getOrNull()}}finally{busy=false}}
    fun updateMask(value:Float){mask=if(value.isFinite())value.coerceIn(.2f,.9f)else .6f;prefs.edit().putFloat("background-mask",mask).apply()}
    suspend fun change(context:Context,uri:Uri?){
        if(busy)return;busy=true
        try {val image=withContext(Dispatchers.IO){
            if(uri==null){file.delete();null}else {
                val data=context.contentResolver.openInputStream(uri)?.use{input->
                    val out=ByteArrayOutputStream();val buffer=ByteArray(8192)
                    while(true){val n=input.read(buffer);if(n<0)break;require(out.size()+n<=10*1024*1024){"请选择 10 MB 以内的图片"};out.write(buffer,0,n)}
                    backgroundImage(out.toByteArray())}?:error("无法读取图片")
                val stream=file.startWrite()
                try {stream.write(data);file.finishWrite(stream)}catch(e:Exception){file.failWrite(stream);throw e}
                BitmapFactory.decodeByteArray(data,0,data.size)
            }
        };bitmap=image;if(uri==null)updateMask(.6f)
        }finally{busy=false}
    }
}
internal val LocalBackgroundScope=staticCompositionLocalOf<CoroutineScope?>{null}
internal val LocalBackground=staticCompositionLocalOf<BackgroundAppearance?>{null}
@Composable internal fun BackgroundLayer(appearance:BackgroundAppearance,modifier:Modifier=Modifier){
    appearance.bitmap?.let{Box(modifier.testTag("custom-background")){Image(it.asImageBitmap(),null,Modifier.fillMaxSize(),contentScale=ContentScale.Crop);Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background.copy(alpha=appearance.mask)))}}
}
@Composable internal fun BackgroundSettings(ui:UiActions){
    val appearance=LocalBackground.current?:return
    val context=LocalContext.current;val scope=LocalBackgroundScope.current?:rememberCoroutineScope()
    fun change(uri:Uri?){scope.launch{try{appearance.change(context,uri);ui.vm.notice(if(uri==null)"已恢复默认背景"else "背景已保存到本机")}catch(e:CancellationException){throw e}catch(e:Exception){ui.vm.notice(e.message?:"背景保存失败")}}}
    val picker=rememberLauncherForActivityResult(ActivityResultContracts.GetContent()){uri->if(uri!=null)change(uri)}
    SectionTitle("自定义背景","用于登录后的页面和聊天，仅保存在此设备，不上传或同步。图片居中铺满，可能裁掉边缘。")
    if(appearance.bitmap!=null){
        BackgroundLayer(appearance,Modifier.fillMaxWidth().height(140.dp).clip(RoundedCornerShape(20.dp)))
        Text("遮罩强度 ${(appearance.mask*100).roundToInt()}% · 越高文字越清晰")
        Slider(value=appearance.mask,onValueChange=appearance::updateMask,valueRange=.2f.. .9f,enabled=!appearance.busy)
    }
    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
        FilledTonalButton(enabled=!appearance.busy,onClick={picker.launch("image/*")}){Text(if(appearance.busy)"正在处理…"else "选择背景图片")}
        if(appearance.bitmap!=null)TextButton(enabled=!appearance.busy,onClick={change(null)}){Text("恢复默认背景")}
    }
    Text("PNG / JPEG / WebP，最大 10 MB；自动压缩为静态图片。",style=MaterialTheme.typography.bodySmall)
}
