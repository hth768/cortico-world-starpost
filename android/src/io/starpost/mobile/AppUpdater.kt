package io.starpost.mobile

import android.app.Application
import android.app.DownloadManager
import android.content.SharedPreferences
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

internal enum class UpdateStage { IDLE, CHECKING, AVAILABLE, DOWNLOADING, VERIFYING, READY, CURRENT, ERROR }
internal data class AppUpdateState(
    val stage:UpdateStage=UpdateStage.IDLE, val release:AndroidRelease?=null,
    val visible:Boolean=false, val progress:Float=0f, val message:String="", val autoInstall:Boolean=false,
)

internal class UpdateController(
    private val prefs:SharedPreferences, private val backend:UpdateBackend, private val scope:CoroutineScope,
    private val now:()->Long=System::currentTimeMillis, private val currentCode:Long=BuildConfig.VERSION_CODE.toLong(),
    private val sdk:Int=Build.VERSION.SDK_INT, private val io:CoroutineDispatcher=Dispatchers.IO,
) {
    private val mutable=MutableStateFlow(AppUpdateState())
    val state=mutable.asStateFlow()
    private var transfer:Job?=null
    private var checking:Job?=null
    private var foregroundJob:Job?=null
    private var restored=false
    private var downloadId=0L
    private var generation=0
    private var cancelling=false

    fun foreground(active:Boolean) {
        foregroundJob?.cancel(); foregroundJob=null
        if(active) foregroundJob=scope.launch {
            restore()
            while(isActive){check();delay(60_000)}
        }
    }
    private suspend fun restore() {
        if(restored)return
        restored=true
        downloadId=prefs.getLong("downloadId",0)
        if(downloadId<=0)return
        val release=runCatching{AndroidRelease.parse(prefs.getString("release","")!!)}.getOrNull()
        if(release==null || release.code<=currentCode) {
            val old=downloadId;downloadId=0;forgetTransfer()
            withContext(io){runCatching{backend.remove(old)}}
        } else {
            mutable.value=AppUpdateState(UpdateStage.DOWNLOADING,release,visible=prefs.getString("ignoredDay","")!=updateDay(now()))
            monitor(release)
        }
    }
    fun check(manual:Boolean=false) {
        if(state.value.stage in listOf(UpdateStage.DOWNLOADING,UpdateStage.VERIFYING,UpdateStage.READY)) {
            if(manual)mutable.value=state.value.copy(visible=true)
            return
        }
        if(checking?.isActive==true) { if(manual)mutable.value=state.value.copy(visible=true);return }
        if(!checkUpdateAllowed(now(),prefs.getLong("lastCheck",0),prefs.getString("ignoredDay","")!!,manual))return
        // Persist an attempt time as well: network failures must not cause a retry on every resume.
        prefs.edit().putLong("lastCheck",now()).apply()
        mutable.value=AppUpdateState(UpdateStage.CHECKING,visible=manual)
        checking=scope.launch {
            try {
                val latest=withContext(io){backend.latest()}
                val visible=manual||state.value.visible
                mutable.value=when {
                    latest.code<=currentCode -> AppUpdateState(UpdateStage.CURRENT,visible=visible,message="当前已是最新版本")
                    latest.minSdk>sdk -> AppUpdateState(UpdateStage.ERROR,visible=visible,message="新版需要 Android API ${latest.minSdk} 及以上，当前版本仍可继续使用")
                    else -> AppUpdateState(UpdateStage.AVAILABLE,latest,visible=visible||prefs.getString("ignoredDay","")!=updateDay(now()))
                }
            } catch(cancel:CancellationException){throw cancel}
            catch(error:Exception){mutable.value=AppUpdateState(UpdateStage.ERROR,visible=state.value.visible,message=error.message?:"检查更新失败，请稍后重试")}
        }
    }
    fun ignoreToday() {
        prefs.edit().putString("ignoredDay",updateDay(now())).putBoolean("autoInstall",false).apply()
        mutable.value=state.value.copy(visible=false,autoInstall=false)
    }
    fun dismiss() { mutable.value=state.value.copy(visible=false) }
    fun download() {
        val release=state.value.release?:return
        if(state.value.stage in listOf(UpdateStage.DOWNLOADING,UpdateStage.VERIFYING,UpdateStage.READY))return
        if(cancelling)return
        checking?.cancel()
        val ticket=++generation
        mutable.value=AppUpdateState(UpdateStage.DOWNLOADING,release,visible=true,message="正在准备下载")
        transfer=scope.launch {
            try {
                val old=downloadId;downloadId=0
                // Finish persisting the system task even if this Activity/ViewModel is being destroyed.
                withContext(io+NonCancellable){
                    if(old>0)backend.remove(old)
                    downloadId=backend.enqueue(release)
                    prefs.edit().putLong("downloadId",downloadId).putString("release",release.json().toString()).putBoolean("autoInstall",true).commit()
                }
                if(ticket!=generation)return@launch
                watch(release,ticket)
            } catch(cancel:CancellationException){throw cancel}
            catch(error:Exception){if(ticket==generation)fail(error)}
        }
    }
    private fun monitor(release:AndroidRelease) {
        val ticket=++generation
        transfer=scope.launch {
            try {watch(release,ticket)}
            catch(cancel:CancellationException){throw cancel}
            catch(error:Exception){if(ticket==generation)fail(error)}
        }
    }
    private suspend fun watch(release:AndroidRelease,ticket:Int) {
        while(ticket==generation) {
            val row=withContext(io){backend.query(downloadId)}
            if(ticket!=generation)return
            require(row.downloaded<=release.bytes){"下载文件超出预期大小"}
            when(row.status) {
                DownloadManager.STATUS_SUCCESSFUL -> {
                    mutable.value=state.value.copy(stage=UpdateStage.VERIFYING,message="正在校验安装包")
                    withContext(io){backend.verify(release)}
                    if(ticket==generation)mutable.value=state.value.copy(stage=UpdateStage.READY,progress=1f,message="下载完成，可以安装",autoInstall=prefs.getBoolean("autoInstall",false))
                    return
                }
                DownloadManager.STATUS_FAILED -> error(when(row.reason) {
                    DownloadManager.ERROR_INSUFFICIENT_SPACE -> "存储空间不足，请清理后重试"
                    else -> "下载失败（${row.reason}），请检查网络后重试"
                })
                else -> mutable.value=state.value.copy(progress=(row.downloaded.toFloat()/release.bytes).coerceIn(0f,1f),message=if(row.status==DownloadManager.STATUS_PAUSED)"网络暂不可用，等待恢复后继续下载" else "正在下载更新")
            }
            delay(1000)
        }
    }
    fun cancelDownload() {
        if(cancelling)return
        cancelling=true;generation++
        val previous=transfer
        mutable.value=state.value.copy(message="正在取消下载")
        transfer=scope.launch {
            previous?.join()
            val old=downloadId;downloadId=0;forgetTransfer()
            withContext(io){runCatching{backend.remove(old)}}
            mutable.value=AppUpdateState(UpdateStage.AVAILABLE,state.value.release,visible=true)
            cancelling=false
        }
    }
    private fun forgetTransfer(){prefs.edit().remove("downloadId").remove("release").remove("autoInstall").apply()}
    private suspend fun fail(error:Exception) {
        val old=downloadId;downloadId=0;forgetTransfer()
        withContext(io){runCatching{backend.remove(old)}}
        mutable.value=state.value.copy(stage=UpdateStage.ERROR,message=error.message?:"更新失败，请重试",autoInstall=false)
    }
    fun consumeAutoInstall() {
        prefs.edit().putBoolean("autoInstall",false).apply()
        mutable.value=state.value.copy(autoInstall=false)
    }
    fun installWhenReady(){prefs.edit().putBoolean("autoInstall",true).apply();mutable.value=state.value.copy(autoInstall=true)}
    suspend fun prepareInstall():File? {
        if(state.value.stage!=UpdateStage.READY)return null
        consumeAutoInstall()
        return try {withContext(io){backend.verify(requireNotNull(state.value.release))}}
        catch(cancel:CancellationException){throw cancel}
        catch(error:Exception){fail(error);null}
    }
    fun installerOpened(){mutable.value=state.value.copy(visible=false,autoInstall=false)}
    fun installProblem(message:String){consumeAutoInstall();mutable.value=state.value.copy(visible=true,message=message)}
}

internal class AppUpdater(application:Application):AndroidViewModel(application) {
    val controller=UpdateController(application.getSharedPreferences("app_updates",0),AndroidUpdateBackend(application),viewModelScope)
}
