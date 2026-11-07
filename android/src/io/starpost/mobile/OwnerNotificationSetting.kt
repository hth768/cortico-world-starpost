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
            Text("我的 bot 消息通知", style = MaterialTheme.typography.titleMedium)
            Text("离开应用后，用常驻连接接收绑定 bot 的专属消息。", style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = enabled, enabled = !state.working && (enabled || state.account.rows("bots").isNotEmpty()), onCheckedChange = { on ->
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
