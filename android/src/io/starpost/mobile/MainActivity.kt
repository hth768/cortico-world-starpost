package io.starpost.mobile

import android.os.Bundle
import android.content.Intent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity: ComponentActivity() {
    private val client by viewModels<StarpostClient>()
    private val updater by viewModels<AppUpdater>()
    override fun onCreate(savedInstanceState:Bundle?) {
        val mode=getSharedPreferences("appearance",0).getString("theme","system")
        if(mode=="dark")setTheme(R.style.Theme_Starpost_Dark)
        else if(mode=="light")setTheme(R.style.Theme_Starpost_Light)
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                val alerts = OwnerAlerts(this@MainActivity)
                if (alerts.subscription != null) runCatching { alerts.resume() }
                OwnerAlerts.refreshVisible = client::refresh
                try {
                    client.state.collect { state ->
                        val bot = state.account.str("botId")
                        OwnerAlerts.visibleBot = bot.takeIf { state.signedIn && state.route.page == "owner" && state.route.before == null }
                        if (OwnerAlerts.visibleBot != null) {
                            val messages = state.data.rows("messages").filter { it.str("botId") == bot }
                            alerts.seen(bot, messages.maxOfOrNull { it.optLong("cursor") } ?: 0)
                        }
                        openNoticeIfReady(state)
                    }
                } finally {
                    OwnerAlerts.visibleBot = null
                    OwnerAlerts.refreshVisible = null
                }
            }
        }
        enableEdgeToEdge()
        setContent {
            val state by client.state.collectAsStateWithLifecycle()
            StarpostTheme(state.theme,state.dynamicColor) {
                StarpostApp(client,state)
                AppUpdateHost(updater.controller)
            }
        }
    }
    private fun openNoticeIfReady(state: ClientState) {
        val action=intent?.action
        if (action !in listOf(OwnerAlerts.OPEN,OwnerAlerts.OPEN_CHAT) || state.starting || state.working || state.account.str("humanId").isEmpty()) return
        val path = intent.data?.pathSegments
        setIntent(Intent(this, MainActivity::class.java))
        if (action==OwnerAlerts.OPEN && path?.size == 2) client.openOwnerAlert(path[0], path[1])
        if (action==OwnerAlerts.OPEN_CHAT && path?.size == 3) client.openChatAlert(path[0],path[1],path[2])
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openNoticeIfReady(client.state.value)
    }
    override fun onStart(){super.onStart();client.foreground(true);updater.controller.foreground(true)}
    override fun onResume(){super.onResume();UpdateRestart.visible(this)}
    override fun onStop(){client.foreground(false);updater.controller.foreground(false);super.onStop()}
}
