package io.starpost.mobile

import android.Manifest
import android.app.Application
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35])
class ChatAlertOnboardingTest {
    @get:Rule val compose=createComposeRule()
    private val app get()=ApplicationProvider.getApplicationContext<Application>()
    private val ready get()=ClientState(starting=false,signedIn=true,account=obj("humanId" to "10001H"))
    @Before fun reset(){
        app.getSharedPreferences("owner-alerts",0).edit().clear().commit()
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    }

    @Test fun firstLaunchOffersBeforeLoginAndConsentSurvivesUntilAccountIsReady(){
        val state=mutableStateOf(ClientState())
        val host=mutableStateOf(0)
        var enabled=0
        compose.setContent{key(host.value){StarpostTheme("light",false){
            OfferChatAlerts(state.value,{enabled++;OwnerAlerts(app).enable("test-session",obj())},{})
        }}}
        compose.onNodeWithText("开启聊天消息通知？").assertExists()
        compose.onNodeWithText("允许通知").performClick()
        compose.onNodeWithText("开启聊天消息通知？").assertDoesNotExist()
        compose.runOnIdle{
            assertEquals(0,enabled)
            assertTrue(OwnerAlerts(app).pendingEnable)
            // Initial session loading may report logged out; consent must survive it.
            OwnerAlerts(app).disable()
            state.value=ClientState(starting=false)
            host.value++
        }
        compose.onNodeWithText("开启聊天消息通知？").assertDoesNotExist()
        compose.runOnIdle{assertEquals(0,enabled);state.value=ready.copy(account=obj("humanId" to "10001H","needsEmail" to true))}
        compose.runOnIdle{assertEquals(0,enabled);state.value=ready.copy(working=true)}
        compose.runOnIdle{assertEquals(0,enabled);state.value=ready}
        compose.runOnIdle{
            assertEquals(1,enabled)
            assertNotNull(OwnerAlerts(app).subscription)
            assertFalse(OwnerAlerts(app).pendingEnable)
            host.value++
        }
        compose.runOnIdle{assertEquals(1,enabled)}
    }

    @Test fun declineIsRememberedAcrossReopeningAndLogin(){
        val state=mutableStateOf(ClientState(starting=false))
        val host=mutableStateOf(0)
        var enabled=0
        compose.setContent{key(host.value){StarpostTheme("light",false){OfferChatAlerts(state.value,{enabled++},{})}}}
        compose.onNodeWithText("暂不开启").performClick()
        compose.runOnIdle{host.value++;state.value=ready}
        compose.onNodeWithText("开启聊天消息通知？").assertDoesNotExist()
        compose.runOnIdle{assertEquals(0,enabled);assertFalse(OwnerAlerts(app).pendingEnable)}
    }

    @Test fun deniedSystemPermissionDoesNotStartConnectionOrRepeatOffer(){
        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        OwnerAlerts(app).answerOffer(true)
        var enabled=0
        compose.setContent{StarpostTheme("light",false){OfferChatAlerts(ready,{enabled++},{})}}
        compose.onNodeWithText("开启聊天消息通知？").assertDoesNotExist()
        compose.runOnIdle{assertEquals(0,enabled);assertNull(OwnerAlerts(app).subscription)}
    }

    @Test fun failedEnableDoesNotRetryOnEveryRefreshAndLegacyRefusalStaysRespected(){
        val state=mutableStateOf(ready)
        OwnerAlerts(app).answerOffer(true)
        var attempts=0
        compose.setContent{StarpostTheme("light",false){OfferChatAlerts(state.value,{attempts++},{})}}
        compose.runOnIdle{assertEquals(1,attempts);state.value=ready.copy(working=true)}
        compose.runOnIdle{state.value=ready}
        compose.runOnIdle{assertEquals(1,attempts);OwnerAlerts(app).answerOffer(false)}
        compose.onNodeWithText("开启聊天消息通知？").assertDoesNotExist()
    }
}
