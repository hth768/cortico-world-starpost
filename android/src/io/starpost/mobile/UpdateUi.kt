package io.starpost.mobile

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.launch
import java.util.Locale

@Composable internal fun AppUpdateHost(updater:UpdateController) {
    val s by updater.state.collectAsStateWithLifecycle()
    val context=LocalContext.current
    val owner=LocalLifecycleOwner.current
    val lifecycle by owner.lifecycle.currentStateAsState()
    val scope=rememberCoroutineScope()
    var launching by remember{mutableStateOf(false)}
    var permissionPending by rememberSaveable{mutableStateOf(false)}
    val installer=rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        launching=false
        if(it.resultCode==android.app.Activity.RESULT_CANCELED)UpdateRestart.cancel(context)
        updater.installerReturned()
    }
    fun installVerified() {
        if(launching)return
        launching=true
        scope.launch {
            val apk=updater.prepareInstall()
            if(apk==null){launching=false;return@launch}
            if(owner.lifecycle.currentState!=Lifecycle.State.RESUMED){launching=false;updater.installWhenReady();return@launch}
            try {
                val uri=FileProvider.getUriForFile(context,"${context.packageName}.updates",apk)
                check(UpdateRestart.expect(context,requireNotNull(updater.state.value.release).code))
                installer.launch(Intent(Intent.ACTION_VIEW).setDataAndType(uri,APK_MIME)
                    .putExtra(Intent.EXTRA_RETURN_RESULT,true)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    .apply{clipData=ClipData.newRawUri("星邮更新",uri)})
                updater.installerOpened()
            } catch(error:Exception) { UpdateRestart.cancel(context);launching=false;updater.installProblem("无法打开安装界面，请检查系统安装权限后重试") }
        }
    }
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        permissionPending=false
        if(context.packageManager.canRequestPackageInstalls())updater.installWhenReady()
        else updater.installProblem("尚未允许安装更新。点击“继续安装”可以重新开启权限。")
    }
    fun requestInstall() {
        if(launching||permissionPending)return
        updater.consumeAutoInstall()
        if(context.packageManager.canRequestPackageInstalls()) installVerified()
        else try {
            permissionPending=true
            permission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:${context.packageName}")))
        } catch(error:Exception){permissionPending=false;updater.installProblem("请在系统设置中允许星邮安装未知应用，然后重试")}
    }
    LaunchedEffect(s.autoInstall,s.stage,lifecycle) {
        if(s.autoInstall && s.stage==UpdateStage.READY && lifecycle==Lifecycle.State.RESUMED)requestInstall()
    }
    AppUpdateDialog(s,onUpdate={if(s.stage==UpdateStage.READY)requestInstall() else updater.download()},
        onIgnore=updater::ignoreToday,onDismiss=if(s.stage in listOf(UpdateStage.AVAILABLE,UpdateStage.READY))updater::ignoreToday else updater::dismiss,onCancel=updater::cancelDownload)
}

class StarpostUpdateProvider:FileProvider()

@Composable internal fun AppUpdateDialog(s:AppUpdateState,onUpdate:()->Unit,onIgnore:()->Unit,onDismiss:()->Unit,onCancel:()->Unit) {
    if(!s.visible)return
    val busy=s.stage in listOf(UpdateStage.DOWNLOADING,UpdateStage.VERIFYING)
    AlertDialog(
        onDismissRequest=onDismiss,
        title={Text(when(s.stage){UpdateStage.AVAILABLE->"发现星邮新版本";UpdateStage.READY->"星邮更新已下载";else->"星邮应用更新"})},
        text={Column(Modifier.heightIn(max=380.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)){
            s.release?.let{r->
                Text("${BuildConfig.VERSION_NAME} → ${r.name} · ${String.format(Locale.ROOT,"%.1f",r.bytes/1048576.0)} MB",style=MaterialTheme.typography.titleMedium)
                if(r.notes.isNotBlank())Text(r.notes,style=MaterialTheme.typography.bodyMedium)
            }
            if(s.stage==UpdateStage.CHECKING){LinearProgressIndicator(Modifier.fillMaxWidth());Text("正在检查新版本")}
            if(busy){
                if(s.stage==UpdateStage.DOWNLOADING)LinearProgressIndicator(progress={s.progress},modifier=Modifier.fillMaxWidth())
                else LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            if(s.message.isNotBlank())Text(s.message,color=if(s.stage==UpdateStage.ERROR)MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            if(s.stage==UpdateStage.DOWNLOADING)Text("${(s.progress*100).toInt()}% · 可在后台继续下载，返回星邮后安装")
            if(s.stage in listOf(UpdateStage.AVAILABLE,UpdateStage.READY))Text("下载完成后会打开系统安装界面，请确认安装。选择今天不再提示，将在北京时间明天 0 点恢复提醒。",style=MaterialTheme.typography.bodySmall)
        }},
        confirmButton={when(s.stage){
            UpdateStage.AVAILABLE->TextButton(onClick=onUpdate){Text("立即更新")}
            UpdateStage.READY->TextButton(onClick=onUpdate){Text("继续安装")}
            UpdateStage.ERROR->TextButton(onClick=onUpdate){Text("重试下载")}
            else->TextButton(onClick=onDismiss){Text(if(busy)"后台下载" else "关闭")}
        }},
        dismissButton={when{
            s.stage in listOf(UpdateStage.AVAILABLE,UpdateStage.READY)->TextButton(onClick=onIgnore){Text("今天不再提示")}
            busy->TextButton(onClick=onCancel){Text("取消下载")}
            s.stage==UpdateStage.ERROR->TextButton(onClick=onDismiss){Text("稍后")}
        }},
    )
}
