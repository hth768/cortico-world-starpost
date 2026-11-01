package io.starpost.mobile

import android.app.Application
import android.app.DownloadManager
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.time.Instant

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35])
class AppUpdaterTest {
    private val release=AndroidRelease(12,"1.2.2",26,1024,"a".repeat(64),"${UPDATE_REPO}download/v0.21.0/starpost-android.apk","新增手机更新")
    private lateinit var prefs:SharedPreferences
    private var clock=Instant.parse("2026-11-02T12:00:00Z").toEpochMilli()
    private class FakeBackend(var release:AndroidRelease):UpdateBackend {
        var checks=0;var starts=0;var verifications=0;var removed=0L
        var latestError=false;var corrupt=false
        var row=UpdateDownload(DownloadManager.STATUS_SUCCESSFUL,1024)
        override fun latest():AndroidRelease {checks++;check(!latestError){"网络不可用"};return release}
        override fun enqueue(release:AndroidRelease):Long{starts++;return 42L}
        override fun query(id:Long)=row
        override fun remove(id:Long){removed=id}
        override fun clean(){}
        override fun verify(release:AndroidRelease):File{verifications++;check(!corrupt){"校验失败"};return File("update.apk")}
    }
    @Before fun setup(){prefs=ApplicationProvider.getApplicationContext<Application>().getSharedPreferences("updater-test",0);prefs.edit().clear().commit()}
    @Test fun metadataRejectsForeignHttpMutableAndOversizedDownloads(){
        assertEquals(release,AndroidRelease.parse(release.json().toString()))
        for((field,value) in listOf("packageName" to "attacker.app","apkUrl" to release.url.replace("https:","http:"),
            "apkUrl" to release.url.replace("github.com","github.com.evil.example"),"apkUrl" to "${UPDATE_REPO}latest/download/starpost-android.apk",
            "sha256" to "bad","bytes" to MAX_APK_BYTES+1,"versionCode" to 0,"schema" to 9)) {
            assertThrows(Exception::class.java){AndroidRelease.parse(release.json().put(field,value).toString())}
        }
    }
    @Test fun identityPreventsDowngradesWrongPackageAndWrongSigner(){
        fun verify(pkg:String=BuildConfig.APPLICATION_ID,code:Long=12,name:String="1.2.2",current:Long=11,signers:Set<String> =setOf("trusted")) =
            verifyUpdateIdentity(release,pkg,code,name,current,setOf("trusted"),signers)
        verify()
        assertThrows(Exception::class.java){verify(pkg="other")}
        assertThrows(Exception::class.java){verify(code=13)}
        assertThrows(Exception::class.java){verify(name="1.2.3")}
        assertThrows(Exception::class.java){verify(current=12)}
        assertThrows(Exception::class.java){verify(signers=setOf("other"))}
        assertThrows(Exception::class.java){verify(signers=emptySet())}
    }
    @Test fun todaySuppressionSurvivesRestartAndManualCheckBypassesIt()=runTest {
        val backend=FakeBackend(release)
        fun controller()=UpdateController(prefs,backend,this,{clock},11,35,StandardTestDispatcher(testScheduler))
        val updater=controller();updater.check();runCurrent()
        assertTrue(updater.state.value.visible);assertEquals(1,backend.checks)
        updater.ignoreToday();assertFalse(updater.state.value.visible)
        val restarted=controller();clock+=7*60*60*1000L // 03:00 Beijing next day, past the normal check interval.
        restarted.check();runCurrent();assertTrue(restarted.state.value.visible)
        restarted.ignoreToday();val again=controller();again.check();runCurrent();assertEquals(2,backend.checks)
        again.check(true);runCurrent();assertEquals(3,backend.checks);assertTrue(again.state.value.visible)
    }
    @Test fun autoCheckIsThrottledAndDoesNotInterruptWhenOfflineOrCurrent()=runTest {
        val backend=FakeBackend(release.copy(code=11))
        val updater=UpdateController(prefs,backend,this,{clock},11,35,StandardTestDispatcher(testScheduler))
        updater.check();runCurrent();assertEquals(UpdateStage.CURRENT,updater.state.value.stage);assertFalse(updater.state.value.visible)
        updater.check();runCurrent();assertEquals(1,backend.checks)
        backend.latestError=true;clock+=6*60*60*1000L
        updater.check();runCurrent();assertFalse(updater.state.value.visible)
        updater.check(true);runCurrent();assertEquals("网络不可用",updater.state.value.message);assertTrue(updater.state.value.visible)
    }
    @Test fun downloadRequiresClickAndHandsOffOnlyAfterVerification()=runTest {
        val backend=FakeBackend(release)
        val updater=UpdateController(prefs,backend,this,{clock},11,35,StandardTestDispatcher(testScheduler))
        updater.check();runCurrent();assertEquals(0,backend.starts)
        updater.download();runCurrent()
        assertEquals(1,backend.starts);assertEquals(UpdateStage.READY,updater.state.value.stage)
        assertTrue(updater.state.value.autoInstall);assertEquals(1,backend.verifications)
        val job=async{updater.prepareInstall()};runCurrent();assertNotNull(job.await())
        assertFalse(updater.state.value.autoInstall);assertFalse(prefs.getBoolean("autoInstall",true))
        assertEquals(2,backend.verifications) // Revalidate just before granting the URI.
        updater.installerOpened();assertFalse(updater.state.value.visible)
        updater.check(true);assertTrue(updater.state.value.visible);assertFalse(updater.state.value.autoInstall)
    }
    @Test fun badDownloadedApkCannotReachInstallerAndCanBeRetried()=runTest {
        val backend=FakeBackend(release).apply{corrupt=true}
        val updater=UpdateController(prefs,backend,this,{clock},11,35,StandardTestDispatcher(testScheduler))
        updater.check();runCurrent();updater.download();runCurrent()
        assertEquals(UpdateStage.ERROR,updater.state.value.stage);assertFalse(updater.state.value.autoInstall)
        assertEquals(42L,backend.removed);assertEquals(0L,prefs.getLong("downloadId",0))
        assertNull(updater.prepareInstall())
        backend.corrupt=false;updater.download();runCurrent();assertEquals(UpdateStage.READY,updater.state.value.stage)
    }
    @Test fun downloadSurvivesProcessRestartAndHandledInstallerDoesNotReopen()=runTest {
        prefs.edit().putLong("downloadId",42).putString("release",release.json().toString()).putBoolean("autoInstall",false).commit()
        val backend=FakeBackend(release)
        val updater=UpdateController(prefs,backend,this,{clock},11,35,StandardTestDispatcher(testScheduler))
        updater.foreground(true);runCurrent();updater.foreground(false)
        assertEquals(UpdateStage.READY,updater.state.value.stage);assertEquals(0,backend.starts)
        assertFalse(updater.state.value.autoInstall)
        updater.installWhenReady();assertTrue(updater.state.value.autoInstall)
    }
    @Test fun successfulUpgradeCleansOldApk()=runTest {
        prefs.edit().putLong("downloadId",42).putString("release",release.json().toString()).commit()
        val backend=FakeBackend(release)
        val updater=UpdateController(prefs,backend,this,{clock},12,35,StandardTestDispatcher(testScheduler))
        updater.foreground(true);runCurrent();updater.foreground(false)
        assertEquals(42L,backend.removed);assertEquals(0L,prefs.getLong("downloadId",0));assertEquals(0,backend.verifications)
    }
    @Test fun cancelWhileEnqueueingDoesNotLeaveAnOrphanOrStartTwoDownloads()=runTest {
        val backend=FakeBackend(release).apply{row=UpdateDownload(DownloadManager.STATUS_RUNNING,100)}
        val updater=UpdateController(prefs,backend,this,{clock},11,35,StandardTestDispatcher(testScheduler))
        updater.check();runCurrent();updater.download();updater.cancelDownload();updater.download();runCurrent()
        assertEquals(1,backend.starts);assertEquals(42L,backend.removed)
        assertEquals(UpdateStage.AVAILABLE,updater.state.value.stage);assertEquals(0L,prefs.getLong("downloadId",0))
    }
    @Test fun unsupportedAndroidGetsNoDownload()=runTest {
        val backend=FakeBackend(release.copy(minSdk=36))
        val updater=UpdateController(prefs,backend,this,{clock},11,35,StandardTestDispatcher(testScheduler))
        updater.check(true);runCurrent();updater.download();runCurrent()
        assertEquals(UpdateStage.ERROR,updater.state.value.stage);assertNull(updater.state.value.release);assertEquals(0,backend.starts)
    }
}
