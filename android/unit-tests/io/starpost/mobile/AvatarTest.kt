package io.starpost.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.util.Base64
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[26,35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AvatarTest {
    @Test fun cropProducesSmallStaticSquareWithoutOriginalMetadata() {
        val source=Bitmap.createBitmap(800,400,Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.BLUE)
        val bytes=ByteArrayOutputStream().apply{source.compress(Bitmap.CompressFormat.PNG,100,this)}.toByteArray()
        source.recycle()
        val payload=avatarUpload(bytes)
        assertEquals("image/jpeg",payload.str("mime"))
        val encoded=Base64.decode(payload.str("base64"),Base64.DEFAULT)
        assertTrue(encoded.size<=131072)
        val bitmap=BitmapFactory.decodeByteArray(encoded,0,encoded.size)
        assertEquals(256,bitmap.width);assertEquals(256,bitmap.height)
        assertTrue(Color.blue(bitmap.getPixel(128,128))>200)
        bitmap.recycle()
    }
    @Test fun rejectsInvalidOrOversizedInput() {
        for(bytes in listOf("<svg/>".toByteArray(),ByteArray(10*1024*1024+1))) {
            try{avatarUpload(bytes);fail("invalid image accepted")}catch(expected:IllegalArgumentException){assertNotNull(expected.message)}
        }
    }
    @Test fun honorsCameraOrientationBeforeUploading() {
        val source=Bitmap.createBitmap(64,64,Bitmap.Config.ARGB_8888)
        for(y in 0..63)for(x in 0..63)source.setPixel(x,y,if(x<32)Color.RED else Color.BLUE)
        val original=ByteArrayOutputStream().apply{source.compress(Bitmap.CompressFormat.JPEG,95,this)}.toByteArray()
        // A real APP1/Exif orientation=6 fixture; do not depend on emulator file metadata writers.
        val hex="ffe1002245786966000049492a0008000000010012010300010000000600000000000000"
        val exif=hex.chunked(2).map{it.toInt(16).toByte()}.toByteArray()
        val payload=avatarUpload(original.copyOfRange(0,2)+exif+original.copyOfRange(2,original.size))
        val bytes=Base64.decode(payload.str("base64"),Base64.DEFAULT)
        val image=BitmapFactory.decodeByteArray(bytes,0,bytes.size)
        assertTrue(Color.red(image.getPixel(128,40))>200)
        assertTrue(Color.blue(image.getPixel(128,210))>200)
        image.recycle();source.recycle()
    }
}
