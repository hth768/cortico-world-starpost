package io.starpost.mobile

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

@Composable
internal fun OfferChatAlerts(ui:UiActions,state:ClientState){
    val context=LocalContext.current
    val alerts=remember{OwnerAlerts(context)}
    var offer by remember { mutableStateOf(alerts.subscription==null && !alerts.prefs.getBoolean("offeredChats",false)) }
    fun answered(){offer=false;alerts.prefs.edit().putBoolean("offeredChats",true).apply()}
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){granted->
        if(granted)ui.vm.enableOwnerAlerts() else ui.vm.notice("可在「我 → 聊天消息通知」重新开启")
    }
    if(offer && !state.starting && state.signedIn && !state.account.optBoolean("needsEmail") &&
        state.account.str("humanId").isNotEmpty() && state.activeGame.isEmpty() && !state.working){
        AlertDialog(onDismissRequest=::answered,title={Text("开启聊天消息通知？")},text={Text("开启后，星邮会保持一条后台连接，在通知栏提醒你的私聊、群聊和专属 bot 回复。每个聊天都可单独免打扰。")},
            confirmButton={TextButton(onClick={answered();alerts.channels()
                if(Build.VERSION.SDK_INT>=33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                else ui.vm.enableOwnerAlerts()
            }){Text("开启通知")}},dismissButton={TextButton(onClick=::answered){Text("暂不开启")}})
    }
}

@Composable
internal fun OwnerNotificationSetting(ui: UiActions, state: ClientState) {
    val context = LocalContext.current
    val alerts = remember(context) { OwnerAlerts(context) }
    var enabled by remember { mutableStateOf(alerts.subscription != null) }
    DisposableEffect(alerts) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> enabled = alerts.subscription != null }
        alerts.prefs.registerOnSharedPreferenceChangeListener(listener)
        onDispose { alerts.prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    fun openSettings() {
        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
    }
    var showSystemSettings by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) ui.vm.enableOwnerAlerts() else showSystemSettings = true
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text("聊天消息通知", style = MaterialTheme.typography.titleMedium)
            Text("通过常驻连接提醒私聊、群聊和「我的 bot」的新消息。群聊免打扰后，单独 @ 你仍会提醒。", style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = enabled, enabled = !state.working, onCheckedChange = { on ->
            alerts.channels()
            when {
                !on -> alerts.disable()
                Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED ->
                    permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                !alerts.permitted() -> openSettings()
                else -> ui.vm.enableOwnerAlerts()
            }
        })
    }
    if (showSystemSettings) TextButton(onClick = ::openSettings) { Text("在系统设置中允许通知") }
}
