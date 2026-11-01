package io.starpost.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.CompositionLocalProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity: ComponentActivity() {
    private val client by viewModels<StarpostClient>()
    private val updater by viewModels<AppUpdater>()
    override fun onCreate(savedInstanceState:Bundle?) {
        val mode=getSharedPreferences("appearance",0).getString("theme","system")
        if(mode=="dark")setTheme(R.style.Theme_Starpost_Dark)
        else if(mode=="light")setTheme(R.style.Theme_Starpost_Light)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val state by client.state.collectAsStateWithLifecycle()
            StarpostTheme(state.theme,state.dynamicColor) {
                CompositionLocalProvider(LocalAppUpdater provides updater.controller) {
                    StarpostApp(client,state)
                    AppUpdateHost(updater.controller)
                }
            }
        }
    }
    override fun onStart(){super.onStart();client.foreground(true);updater.controller.foreground(true)}
    override fun onStop(){client.foreground(false);updater.controller.foreground(false);super.onStop()}
}
