package io.starpost.mobile

import android.app.Application
import android.content.pm.PackageInfo
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.os.Build
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.security.MessageDigest

@Suppress("DEPRECATION")
@RunWith(RobolectricTestRunner::class)
@Config(sdk=[26,35])
class UpdateSecurityTest {
    @Test fun verificationCopiesToPrivateCacheAndRejectsTampering(){
        val app=ApplicationProvider.getApplicationContext<Application>()
        val backend=AndroidUpdateBackend(app)
        backend.clean()
        val source=File(app.getExternalFilesDir("updates"),"download.apk");source.writeText("signed test apk")
        val hash=MessageDigest.getInstance("SHA-256").digest(source.readBytes()).joinToString(""){"%02x".format(it)}
        val release=AndroidRelease(BuildConfig.VERSION_CODE.toLong()+1,"1.3.1",26,source.length(),hash,"${UPDATE_REPO}download/v0.21.0/starpost-android.apk","")
        val pm=shadowOf(app.packageManager)
        val installed=pm.getInternalMutablePackageInfo(app.packageName)
        fun sign(info:PackageInfo){
            info.signatures=arrayOf(Signature("ab12"))
            if(Build.VERSION.SDK_INT>=28){info.signingInfo=ReflectionHelpers.newInstance(SigningInfo::class.java);shadowOf(info.signingInfo).setSignatures(info.signatures)}
        }
        sign(installed)
        val archive=PackageInfo().apply{packageName=app.packageName;versionCode=BuildConfig.VERSION_CODE+1;versionName="1.3.1";sign(this)}
        val partial=File(app.cacheDir,"updates/update.part");val ready=File(app.cacheDir,"updates/update.apk")
        pm.setPackageArchiveInfo(partial.path,archive);pm.setPackageArchiveInfo(ready.path,archive)
        val verified=backend.verify(release)
        assertEquals(ready,verified);assertArrayEquals(source.readBytes(),ready.readBytes());assertFalse(partial.exists())
        val uri=FileProvider.getUriForFile(app,"${app.packageName}.updates",providerTestFile(ready))
        assertEquals("content",uri.scheme);assertTrue(uri.path!!.startsWith("/app_update/"))
        assertThrows(IllegalArgumentException::class.java){FileProvider.getUriForFile(app,"${app.packageName}.updates",providerTestFile(File(app.filesDir,"credentials.json")))}
        ready.writeText("tampered cached file")
        assertThrows(IllegalArgumentException::class.java){backend.verify(release)}
        assertFalse(ready.exists())
        source.writeText("tampered download")
        assertThrows(IllegalArgumentException::class.java){backend.verify(release)}
        backend.clean()
    }
}
