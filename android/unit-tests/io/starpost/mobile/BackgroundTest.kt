package io.starpost.mobile

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[26,35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BackgroundTest {
    @Test fun imageCopyUsesScopedCacheAndTextCopyUsesClipboard(){
        val context=ApplicationProvider.getApplicationContext<Application>();val bytes=image()
        val clipboard=context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val file=messageImageFile(context,obj("mime" to "image/png","base64" to android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)))
        val uri=androidx.core.content.FileProvider.getUriForFile(context,"${context.packageName}.updates",providerTestFile(file))
        assertEquals("content",uri.scheme);assertEquals("${context.packageName}.updates",uri.authority)
        assertTrue(uri.path!!.startsWith("/message_images/"));assertArrayEquals(bytes,file.readBytes())
        assertThrows(IllegalArgumentException::class.java){androidx.core.content.FileProvider.getUriForFile(context,"${context.packageName}.updates",providerTestFile(File(context.filesDir,"credentials.json")))}
        copyMessage(context,obj("text" to "可复制的文字","emoji" to "🌟"))
        assertEquals("可复制的文字🌟",clipboard.primaryClip?.getItemAt(0)?.text.toString())
    }
    private fun image(w:Int=200,h:Int=100):ByteArray {
        val bitmap=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888);bitmap.eraseColor(android.graphics.Color.CYAN)
        return ByteArrayOutputStream().also{bitmap.compress(Bitmap.CompressFormat.PNG,100,it);bitmap.recycle()}.toByteArray()
    }
    @Test fun chatPhotoKeepsAspectAndFitsRelayLimit(){
        val result=chatImage(image(3200,1600));assertEquals("image/jpeg",result.str("mime"));val bytes=android.util.Base64.decode(result.str("base64"),android.util.Base64.DEFAULT);assertTrue(bytes.size<=1024*1024)
        val bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.size);assertEquals(1600,bitmap.width);assertEquals(800,bitmap.height);bitmap.recycle()
        try{chatImage("not an image".toByteArray());fail("invalid image accepted")}catch(_:IllegalArgumentException){}
    }
    @Test fun resizesWithoutSquareCroppingAndRejectsInvalidOrOversizeInput(){
        val result=backgroundImage(image(3200,1600));val bitmap=BitmapFactory.decodeByteArray(result,0,result.size)
        assertEquals(1600,bitmap.width);assertEquals(800,bitmap.height);assertTrue(result.size<2*1024*1024);bitmap.recycle()
        for(bytes in listOf(byteArrayOf(1,2,3),ByteArray(10*1024*1024+1))){try{backgroundImage(bytes);fail("invalid image accepted")}catch(_:IllegalArgumentException){}}
    }
    @Test fun backgroundAndMaskSurviveRecreationAndResetRemovesStoredImage()= runBlocking {
        val context=ApplicationProvider.getApplicationContext<Application>();val file=File(context.cacheDir,"background-test.png");file.writeBytes(image())
        try{
            val first=BackgroundAppearance(context);first.load();first.change(context,Uri.fromFile(file));first.updateMask(.8f)
            val second=BackgroundAppearance(context);second.load();assertNotNull(second.bitmap);assertEquals(.8f,second.mask,0f)
            file.writeText("broken");try{second.change(context,Uri.fromFile(file));fail("invalid upload accepted")}catch(_:IllegalArgumentException){}
            assertNotNull(second.bitmap);assertFalse(second.busy)
            val afterFailure=BackgroundAppearance(context);afterFailure.load();assertNotNull(afterFailure.bitmap)
            second.change(context,null);val reset=BackgroundAppearance(context);reset.load();assertNull(reset.bitmap);assertEquals(.6f,reset.mask,0f)
            assertFalse(File(context.filesDir,"appearance-background.jpg").exists())
        }finally{file.delete();File(context.filesDir,"appearance-background.jpg").delete();context.getSharedPreferences("starpost-appearance",0).edit().clear().commit()}
    }
}
