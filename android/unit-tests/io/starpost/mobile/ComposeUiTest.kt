package io.starpost.mobile

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.json.JSONObject
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
    @Test fun updateDialogOffersDownloadAndPersistentSnooze(){
        var updated=0;var ignored=0
        val release=AndroidRelease(BuildConfig.VERSION_CODE.toLong()+1,"1.3.1",26,5_000_000,"a".repeat(64),"${UPDATE_REPO}download/v0.21.0/starpost-android.apk","• 支持搜索自己并打开个人主页\n• 游戏成员可以邀请好友\n• 新增手机一键更新")
        compose.setContent{StarpostTheme("light",false){AppUpdateDialog(AppUpdateState(UpdateStage.AVAILABLE,release,visible=true),{updated++},{ignored++},{},{},{})}}
        compose.onNodeWithText("发现星邮新版本").assertExists()
        compose.onNodeWithText("立即更新").performClick();compose.onNodeWithText("今日不提醒").performClick()
        compose.runOnIdle{org.junit.Assert.assertEquals(1,updated);org.junit.Assert.assertEquals(1,ignored)}
        shot("android-update-light")
    }
    @Test fun updateDownloadShowsProgressAndCancel(){
        var canceled=false
        compose.setContent{StarpostTheme("dark",false){AppUpdateDialog(AppUpdateState(UpdateStage.DOWNLOADING,visible=true,progress=0.42f,message="正在下载更新"),{},{},{},{canceled=true},{})}}
        compose.onNodeWithText("42% · 可在后台继续下载，返回星邮后安装").assertExists()
        compose.onNodeWithText("后台下载").assertExists();compose.onNodeWithText("取消下载").performClick()
        compose.runOnIdle{org.junit.Assert.assertTrue(canceled)}
        shot("android-update-dark")
    }
    private fun checkInstallerHandoff(allowed:Boolean){
        val app=ApplicationProvider.getApplicationContext<Application>()
        org.robolectric.Shadows.shadowOf(app.packageManager).setCanRequestPackageInstalls(allowed)
        val prefs=app.getSharedPreferences("installer-ui-test",0);prefs.edit().clear().commit()
        val scope=kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob()+kotlinx.coroutines.Dispatchers.Main.immediate)
        val release=AndroidRelease(BuildConfig.VERSION_CODE.toLong()+1,"1.3.1",26,10,"a".repeat(64),"${UPDATE_REPO}download/v0.21.0/starpost-android.apk","测试安装流程")
        val backend=object:UpdateBackend{
            override fun latest()=release
            override fun enqueue(release:AndroidRelease)=1L
            override fun query(id:Long)=UpdateDownload(android.app.DownloadManager.STATUS_SUCCESSFUL,10)
            override fun verify(release:AndroidRelease)=providerTestFile(File(app.cacheDir,"updates/update.apk").apply{parentFile!!.mkdirs();writeText("test-apk")})
            override fun remove(id:Long){}
            override fun clean(){}
        }
        val updater=UpdateController(prefs,backend,scope,io=kotlinx.coroutines.Dispatchers.Main.immediate)
        try {
            compose.setContent{StarpostTheme("light",false){AppUpdateHost(updater)}}
            compose.runOnIdle{updater.check(true)}
            compose.onNodeWithText("立即更新").performClick();compose.waitForIdle()
            compose.runOnIdle {
                val intent=org.robolectric.Shadows.shadowOf(app).nextStartedActivity
                org.junit.Assert.assertNotNull(intent)
                if(allowed){
                    org.junit.Assert.assertEquals(android.content.Intent.ACTION_VIEW,intent.action)
                    org.junit.Assert.assertEquals(APK_MIME,intent.type)
                    org.junit.Assert.assertEquals("content",intent.data!!.scheme)
                    org.junit.Assert.assertEquals("${app.packageName}.updates",intent.data!!.authority)
                    org.junit.Assert.assertTrue(intent.flags and android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION !=0)
                } else org.junit.Assert.assertEquals(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,intent.action)
                org.junit.Assert.assertFalse(updater.state.value.autoInstall)
                org.junit.Assert.assertNull(org.robolectric.Shadows.shadowOf(app).nextStartedActivity)
            }
        } finally {scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()}
    }
    @Test fun updateRequestsUnknownSourcePermissionWhenNeeded(){checkInstallerHandoff(false)}
    @Test fun updateOpensSystemInstallerWithTemporaryReadOnlyUri(){checkInstallerHandoff(true)}
    @Test fun searchCardsOpenProfilesWithoutSendingFriendRequests(){
        var opened=0;var requested=0
        compose.setContent{StarpostTheme("light",false){SearchResultCard(obj("botId" to "10004H","nickname" to "小夏"),false,false,{opened++},{requested++})}}
        compose.onNodeWithText("小夏").performClick()
        compose.runOnIdle{org.junit.Assert.assertEquals(1,opened);org.junit.Assert.assertEquals(0,requested)}
        compose.onNodeWithText("申请好友").performClick()
        compose.runOnIdle{org.junit.Assert.assertEquals(1,opened);org.junit.Assert.assertEquals(1,requested)}
    }
    @Test fun ownSearchCardOpensProfileAndHasNoFriendRequestButton(){
        var opened=false
        compose.setContent{StarpostTheme("dark",false){SearchResultCard(obj("botId" to "10003H","nickname" to "星河访客"),true,false,{opened=true},{error("不能申请自己为好友")})}}
        compose.onNodeWithText("10003H · 人类 · 我自己").assertExists()
        compose.onNodeWithText("申请好友").assertDoesNotExist()
        compose.onNodeWithText("星河访客").performClick()
        compose.runOnIdle{org.junit.Assert.assertTrue(opened)}
        shot("android-search-self")
    }
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
    @Test fun reservationInvitationEntryRequiresPermission(){
        val vm=client();val g=obj("title" to "朋友的私密局","status" to "scheduled","canInvite" to true,"creator" to "10002","rules" to obj(),"rulebook" to obj())
        val state=mutableStateOf(ClientState(starting=false,signedIn=true,account=account,route=Route("humanReservation","invite-game"),data=obj("humanId" to "10003H","game" to g)))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,state.value)}}
        compose.onNodeWithText("邀请好友 / 群成员").assertExists()
        compose.runOnIdle{state.value=state.value.copy(data=obj("humanId" to "10003H","game" to JSONObject(g.toString()).put("canInvite",false)))}
        compose.onNodeWithText("邀请好友 / 群成员").assertDoesNotExist()
    }
    @Test fun memberInvitationPickerOffersFriendsOwnBotsAndGroups(){
        val vm=client();val state=ClientState(starting=false,signedIn=true,account=account,route=Route("gameInvite","invite-game"),theme="dark",data=obj(
            "friendProfiles" to JSONArray().put(obj("botId" to "10004H","nickname" to "小夏")),"groups" to JSONArray().put(obj("id" to "group-demo","name" to "推理同好群"))))
        compose.setContent{StarpostTheme("dark",false){StarpostApp(vm,state)}}
        compose.onNodeWithText("小夏").assertExists();compose.onNodeWithText("陈玥汐").assertExists()
        compose.onNodeWithText("群成员").performClick();compose.onNodeWithText("推理同好群").performClick()
        compose.onNodeWithText("向「推理同好群」的群成员发送本局邀请？").assertExists()
        shot("android-game-member-invite")
    }
}
