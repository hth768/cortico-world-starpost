package io.starpost.mobile

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35],qualifiers="w412dp-h892dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposeUiTest {
    @get:Rule val compose=createComposeRule()
    private fun client()=StarpostClient(ApplicationProvider.getApplicationContext<Application>())
    private val account get()=obj("humanId" to "10003H","nickname" to "星河访客","email" to "hello@example.com","botId" to "10001","bots" to JSONArray().put(obj("botId" to "10001","nickname" to "陈玥汐")))
    private fun shot(name:String){val file=File("../.deployment/compose/screenshots/$name.png");file.parentFile.mkdirs();compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,file.outputStream())}
    @Test fun loginAndDarkTheme(){
        val vm=client();val state=mutableStateOf(ClientState(starting=false,theme="light"))
        compose.setContent { StarpostTheme(state.value.theme,false){StarpostApp(vm,state.value)} }
        compose.onNodeWithText("邮箱地址").performTextInput("hello@example.com")
        shot("android-login-light")
        compose.runOnIdle{state.value=state.value.copy(theme="dark")}
        compose.onNodeWithText("hello@example.com").assertExists()
        shot("android-login-dark")
    }
    @Test fun chatDraftAndFocusSurviveRefreshAndTheme(){
        val vm=client();val message=obj("id" to "demo1","sender" to "10004H","senderNickname" to "小夏","text" to "今晚一起看星星吗？","at" to "2026-11-01T12:00:00Z")
        val state=mutableStateOf(ClientState(starting=false,signedIn=true,account=account,social=obj("friendProfiles" to JSONArray().put(obj("botId" to "10004H","nickname" to "小夏"))),route=Route("socialHistory","10004H"),data=obj("messages" to JSONArray().put(message)),theme="light"))
        compose.setContent {StarpostTheme(state.value.theme,false){StarpostApp(vm,state.value)}}
        val input=compose.onNode(hasSetTextAction());input.performClick();input.performTextInput("好呀，稍等我一下")
        compose.runOnIdle{state.value=state.value.copy(data=obj("messages" to JSONArray().put(message).put(obj("id" to "demo2","sender" to "10004H","senderNickname" to "小夏","text" to "我发现了一个看流星的好地方 ✨","at" to "2026-11-01T12:01:00Z"))),theme="dark")}
        input.assertTextContains("好呀，稍等我一下");input.assertIsFocused()
        compose.onNodeWithText("我发现了一个看流星的好地方 ✨").assertExists()
        shot("android-chat-dark")
        compose.runOnIdle{state.value=state.value.copy(theme="light")};input.assertIsFocused();shot("android-chat-light")
    }
    @Test fun readOnlyBotHistoryHasNoComposer(){
        val vm=client();val state=ClientState(starting=false,signedIn=true,account=account,route=Route("history","10002"),data=obj("messages" to JSONArray()),theme="light")
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,state)}}
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        compose.onNodeWithContentDescription("发送消息").assertDoesNotExist()
    }
    @Test fun settingsExposeThemeAndBotBinding(){
        val vm=client();val state=ClientState(starting=false,signedIn=true,account=account,route=Route("settings"),theme="light",expiresAt=1794744000000)
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,state)}}
        compose.onNodeWithText("跟随系统").assertExists();compose.onNodeWithText("壁纸动态配色").assertExists()
        shot("android-settings-light")
    }
    @Test fun supportEntryOpensAfdian(){
        var opened=""
        val browser=object:androidx.compose.ui.platform.UriHandler{override fun openUri(uri:String){opened=uri}}
        val vm=client();val state=ClientState(starting=false,signedIn=true,account=account,route=Route("settings"),theme="dark")
        compose.setContent{androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalUriHandler provides browser){StarpostTheme("dark",false){StarpostApp(vm,state)}}}
        compose.onNodeWithText("支持星邮开发").performScrollTo().performClick()
        org.junit.Assert.assertEquals("https://afdian.com/a/starpost",opened)
        shot("android-support-afdian")
    }
    @Test fun activeGameShowsRoleActionsAndHidesSocialNavigation(){
        val vm=client();val state=ClientState(starting=false,signedIn=true,account=account,route=Route("humanRoom","demo-game"),activeGame="demo-game",theme="dark",data=obj(
            "game" to obj("title" to "星夜推理局","day" to 2,"ownRole" to "seer","status" to "night_gods","phaseDeadlineAt" to "2026-11-01T12:10:00Z"),
            "messages" to JSONArray().put(obj("id" to "g1","sender" to "system","senderNickname" to "星邮法官","kind" to "role","role" to "seer","channel" to "private","at" to "2026-11-01T12:00:00Z")),
            "channels" to JSONArray(),"options" to JSONArray().put(obj("move" to "inspect","label" to "查验身份","targets" to JSONArray().put(obj("id" to "10002","nickname" to "小夏")))).put(obj("move" to "skip","label" to "跳过本夜","targets" to JSONArray().put(obj("id" to "","nickname" to "跳过"))))))
        compose.setContent{StarpostTheme("dark",false){StarpostApp(vm,state)}}
        compose.onNodeWithText("查验身份").assertExists();compose.onNodeWithText("跳过本夜").assertExists()
        compose.onNodeWithContentDescription("更多功能").assertDoesNotExist();compose.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        shot("android-game-dark")
    }
    @Test fun ownerChannelKeepsIndependentIdentity(){
        val vm=client();val state=ClientState(starting=false,signedIn=true,account=account,route=Route("owner"),theme="light",data=obj("messages" to JSONArray().put(obj("id" to "o1","direction" to "human","address" to "旅人","text" to "今天交到朋友了吗？","at" to "2026-11-01T12:26:00Z")).put(obj("id" to "o2","direction" to "bot","text" to "交到了，就是他骗了我一整局狼人杀。","at" to "2026-11-01T12:26:00Z")).put(obj("id" to "o3","direction" to "human","address" to "旅人","text" to "那明天还一起玩吗？","at" to "2026-11-01T12:27:00Z")).put(obj("id" to "o4","direction" to "bot","text" to "玩。朋友还是要交的，票还是要投他的。","at" to "2026-11-01T12:27:00Z"))))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,state)}}
        compose.onNodeWithText("陈玥汐").assertExists();compose.onNodeWithContentDescription("发送消息").assertExists();shot("android-owner-light")
    }
}
