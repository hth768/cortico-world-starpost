package io.starpost.mobile

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
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
    @Test fun capsuleComposerKeepsDraftAndSupportsCustomTimeAndThreePhotos(){
        val vm=client();val ready=mutableStateOf(false);val dark=mutableStateOf(false)
        val state=mutableStateOf(ClientState(starting=false,signedIn=true,account=account,route=Route("newCapsule")))
        compose.setContent{StarpostTheme(if(dark.value)"dark" else "light",false){if(ready.value)StarpostApp(vm,state.value)else Text("正在初始化测试会话")}}
        compose.waitUntil(5000){compose.runOnIdle{!vm.state.value.starting}};compose.runOnIdle{ready.value=true}
        compose.onNodeWithText("时间胶囊留言").performTextInput("未来的我，希望你仍然记得今天。")
        compose.onNodeWithText("1 年后").performScrollTo().performClick()
        compose.runOnIdle{org.junit.Assert.assertEquals("years",vm.capsuleDraft().unit);org.junit.Assert.assertEquals("未来的我，希望你仍然记得今天。",vm.capsuleDraft().text);dark.value=true}
        compose.onNodeWithText("指定日期").performScrollTo().performClick()
        compose.onNodeWithText("开启时间（北京时间）").performScrollTo().performTextInput("2035-01-01 09:00")
        compose.onNodeWithContentDescription("添加到时间胶囊").performScrollTo().assertIsEnabled()
        compose.runOnIdle{repeat(3){vm.capsuleDraft().images.add(obj("mime" to "image/png","base64" to "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNIOfHsPwAGuAMSOUNQWgAAAABJRU5ErkJggg=="))}}
        compose.onNodeWithContentDescription("添加到时间胶囊").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("移除图片 3").performScrollTo().performClick()
        compose.onNodeWithContentDescription("添加到时间胶囊").performScrollTo().assertIsEnabled();shot("android-capsule-compose-dark")
        compose.runOnIdle{state.value=state.value.copy(error="网络暂时不可用")}
        compose.onNodeWithText("未来的我，希望你仍然记得今天。").assertExists()
    }
    @Test fun capsuleListHidesSealedContentAndOffersOnlyDueLetterRead(){
        val vm=client();val items=JSONArray().put(obj("id" to "sealed","opensAt" to "2030-11-03T10:00:00Z","createdAt" to "2026-11-03T10:00:00Z","imageCount" to 3,"ready" to false)).put(obj("id" to "due","opensAt" to "2026-11-03T10:00:00Z","createdAt" to "2025-11-03T10:00:00Z","imageCount" to 0,"ready" to true))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,route=Route("capsules"),data=obj("items" to items,"sealed" to 1,"unread" to 1)))}}
        compose.onNodeWithText("封存中",substring=false).assertExists()
        compose.onAllNodesWithText("打开时间胶囊").assertCountEquals(1)
        compose.onNodeWithText("打开时间胶囊").performScrollTo().assertExists();shot("android-capsule-list-light")
    }
    @Test fun matchmakingChoosesTwentyPlayersAndShowsWaitingAndExit(){
        val vm=client();val data=mutableStateOf(obj("humanId" to "10003H","rules" to obj("dailyLimit" to 5),"games" to JSONArray()))
        compose.setContent{StarpostTheme("dark",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,route=Route("games"),data=data.value))}}
        compose.onNodeWithText("20 人").performScrollTo().performClick()
        compose.onNodeWithText("开始匹配").performScrollTo().performClick()
        compose.onNodeWithText("以自己的人类身份匹配 20 人局？匹配满员立即开局。").assertExists()
        compose.onNodeWithText("取消",useUnmergedTree=true).performClick()
        compose.runOnIdle{data.value=JSONObject(data.value.toString()).put("matching",obj("state" to "waiting","game" to obj("gameId" to "queue","maxPlayers" to 20,"joined" to 7)))}
        compose.onNodeWithText("正在匹配 20 人局 · 已就位 7/20 人").performScrollTo().assertExists()
        compose.onNodeWithText("开始匹配").assertDoesNotExist();compose.onNodeWithText("退出匹配").performScrollTo().assertExists();shot("android-match-waiting")
    }
    @Test fun fullRoomOmitsCheckinAndMatchCreatorCannotCancelOtherPlayers(){
        val vm=client();val g=obj("gameId" to "queue","title" to "6 人实时匹配","startMode" to "full","matching" to true,"status" to "scheduled","creator" to "10003H","joined" to 2,"maxPlayers" to 6,"checkedIn" to 2,"seats" to JSONArray())
        val data=mutableStateOf(obj("humanId" to "10003H","game" to g,"messages" to JSONArray()))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,route=Route("humanReservation","queue"),data=data.value))}}
        compose.onNodeWithText("实时匹配 · 人满就开 · 加入即准备，请保持在线").assertExists()
        compose.onNodeWithText("集合报到").assertDoesNotExist();compose.onNodeWithText("取消本局").assertDoesNotExist()
        compose.onNodeWithText("退出预约").performScrollTo().assertExists()
        compose.runOnIdle{data.value=obj("humanId" to "10003H","game" to JSONObject(g.toString()).put("startMode","scheduled").put("matching",false).put("scheduledAt","2026-11-03T12:00:00Z"),"messages" to JSONArray())}
        compose.onNodeWithText("集合报到").performScrollTo().assertExists();compose.onNodeWithText("取消本局").performScrollTo().assertExists()
    }
    @Test fun scheduleRetainsTimedModeAndOffersPublicFullMode(){
        val vm=client();compose.setContent{StarpostTheme("light",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,route=Route("schedule")))}}
        compose.onNodeWithText("定时预约").assertExists();compose.onNodeWithText("人满就开").performClick()
        compose.onNodeWithText("公开并公告到广场").assertExists();compose.onNode(isToggleable()).assertIsOn().assertIsNotEnabled()
        compose.onNodeWithText("定时预约").performClick();compose.onNode(isToggleable()).assertIsEnabled()
    }
    @Test fun publicReservationOffersHumanJoinWithoutInvitationOnlyBeforeStart(){
        val vm=client()
        val game=obj("gameId" to "public-game","title" to "今晚的公开局","public" to true,"published" to true,"status" to "scheduled","gameType" to "werewolf","scheduledAt" to "2026-11-03T10:00:00Z")
        val state=mutableStateOf(ClientState(starting=false,signedIn=true,account=account,route=Route("game","public-game"),data=obj("game" to game,"messages" to JSONArray())))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,state.value)}}
        compose.onNodeWithText("加入预约（无需邀请）").performScrollTo().performClick()
        compose.onNodeWithText("以自己的人类身份加入「今晚的公开局」？${gameStartLabel(game)}。").assertExists()
        compose.onNodeWithText("取消",useUnmergedTree=true).performClick()
        for(updated in listOf(JSONObject(game.toString()).put("public",false),JSONObject(game.toString()).put("published",false),JSONObject(game.toString()).put("status","day"),JSONObject(game.toString()).put("gameType","mystery"))){
            compose.runOnIdle{state.value=state.value.copy(data=obj("game" to updated,"messages" to JSONArray()))}
            compose.onNodeWithText("加入预约（无需邀请）").assertDoesNotExist()
        }
        compose.runOnIdle{state.value=state.value.copy(route=Route("square"),data=obj("items" to JSONArray().put(JSONObject(game.toString()).put("kind","game").put("text","广场公开预约"))))}
        compose.onNodeWithText("加入预约（无需邀请）").performScrollTo().assertExists()
        shot("android-public-game-join")
    }
    @Test fun humanFeedWorksWithoutBotBindingAndHasNoDailyQuota(){
        val vm=client();val human=JSONObject(account.toString()).put("botId","").put("bots",JSONArray())
        val post=obj("id" to "post-1","authorProfile" to obj("botId" to "10005H","nickname" to "海风"),"text" to "今天在海边看见了一颗很亮的星星。","at" to "2026-11-03T11:00:00Z","hasImage" to true)
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=human,route=Route("feed"),data=obj("items" to JSONArray().put(post))))}}
        compose.onNodeWithText("发动态").assertExists();compose.onNodeWithText("查看 Bot 动态 · 只读").assertDoesNotExist();compose.onNodeWithText("今天在海边看见了一颗很亮的星星。").assertExists();shot("android-human-feed")
        compose.onNodeWithText("海",useUnmergedTree=true).performTouchInput{click()};compose.mainClock.advanceTimeBy(400);compose.waitForIdle();org.junit.Assert.assertEquals("social",vm.state.value.route.kind)
    }
    @Test fun communityComposerPreservesDraftOnFailedRequestAndThemeChange(){
        val vm=client()
        // The real app waits for session loading before showing an editor. Let that
        // finish before injecting the signed-in UI fixture, so startup cannot clear its draft.
        val state=mutableStateOf(ClientState(starting=false,signedIn=true,account=account,route=Route("newPost")))
        val dark=mutableStateOf(false)
        val ready=mutableStateOf(false)
        compose.setContent{StarpostTheme(if(dark.value)"dark" else "light",false){if(ready.value)StarpostApp(vm,state.value)else Text("正在初始化测试会话")}}
        compose.waitUntil(5000){compose.runOnIdle{!vm.state.value.starting}}
        compose.runOnIdle{ready.value=true}
        compose.onNode(hasSetTextAction()).performTextInput("今天的小事，留在星邮。")
        compose.runOnIdle{org.junit.Assert.assertEquals("今天的小事，留在星邮。",vm.communityDraft("post").text)}
        compose.runOnIdle{state.value=state.value.copy(error="操作过于频繁，请稍后重试");dark.value=true}
        compose.onNodeWithText("今天的小事，留在星邮。").assertExists();compose.onNodeWithContentDescription("添加到动态").assertExists();shot("android-post-compose-dark")
        compose.runOnIdle{state.value=state.value.copy(route=Route("throwBottle"),error="")}
        compose.onNodeWithText("今天的小事，留在星邮。").assertDoesNotExist();compose.onNodeWithContentDescription("添加到动态").assertDoesNotExist()
        compose.runOnIdle{state.value=state.value.copy(route=Route("newPost"))};compose.onNodeWithText("今天的小事，留在星邮。").assertExists()
    }
    @Test fun postRepliesAndDeleteBelongToHumanAuthorOnly(){
        val vm=client();val post=obj("id" to "post-1","author" to "10005H","authorProfile" to obj("botId" to "10005H","nickname" to "海风"),"text" to "你的今天过得怎么样？","at" to "2026-11-03T11:00:00Z")
        val comment=obj("id" to "comment-1","author" to "10006H","authorProfile" to obj("botId" to "10006H","nickname" to "小夏"),"text" to "捞到了一个有趣的瓶子。","at" to "2026-11-03T11:01:00Z")
        val state=mutableStateOf(ClientState(starting=false,signedIn=true,account=account,route=Route("post","post-1"),data=obj("post" to post,"comments" to JSONArray().put(comment))))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,state.value)}}
        compose.onNodeWithText("删除我的动态").assertDoesNotExist();compose.onNodeWithText("回复这条评论").performScrollTo().performClick();compose.onNodeWithText("回复 小夏").assertExists()
        compose.onNode(hasSetTextAction()).performTextInput("我也想看看");compose.onNodeWithText("取消回复").performScrollTo().performClick();compose.onNodeWithText("我也想看看").assertExists()
        compose.runOnIdle{state.value=state.value.copy(data=obj("post" to JSONObject(post.toString()).put("author","10003H"),"comments" to JSONArray().put(comment)))}
        compose.onNodeWithText("删除我的动态").assertExists()
    }
    @Test fun bottleReplyIsAvailableOnlyToPickerAndBeforeReply(){
        val vm=client();val bottle=obj("id" to "bottle-1","author" to "10001","authorProfile" to obj("botId" to "10001","nickname" to "小星"),"pickedBy" to "10003H","pickerProfile" to obj("botId" to "10003H","nickname" to "星河访客"),"text" to "偶然看到这只瓶子的人，你好呀。","at" to "2026-11-03T10:00:00Z","pickedAt" to "2026-11-03T11:00:00Z")
        val state=mutableStateOf(ClientState(starting=false,signedIn=true,account=account,route=Route("bottle","bottle-1"),data=bottle))
        compose.setContent{StarpostTheme("dark",false){StarpostApp(vm,state.value)}}
        compose.onNodeWithText("回复这个瓶子").assertExists();compose.onNodeWithText("申请加对方为好友").assertExists();shot("android-human-bottle-dark")
        compose.runOnIdle{state.value=state.value.copy(data=JSONObject(bottle.toString()).put("reply","很高兴遇见你").put("isFriend",true))}
        compose.onNodeWithText("回复这个瓶子").assertDoesNotExist();compose.onNodeWithText("申请加对方为好友").assertDoesNotExist();compose.onNodeWithText("你们已经是好友。").assertExists()
    }
    @Test fun messageLongPressQuotesWithoutLosingDraftOnRefresh(){
        val vm=client();val message=obj("id" to "local-message","sender" to "10003H","senderNickname" to "星河访客","text" to "今晚一起玩狼人杀吧","at" to java.time.Instant.now().toString())
        val state=mutableStateOf(ClientState(starting=false,signedIn=true,account=account,route=Route("socialHistory","10005H"),data=obj("messages" to JSONArray().put(message))))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,state.value)}}
        compose.onNode(hasSetTextAction()).performTextInput("未发送的草稿")
        compose.onNodeWithText("今晚一起玩狼人杀吧").performTouchInput{longClick()}
        compose.onNodeWithText("复制").assertExists();compose.onNodeWithText("撤回").assertExists();compose.onNodeWithText("转发").assertExists();compose.onNodeWithText("保存表情").assertDoesNotExist()
        compose.onNodeWithText("引用").performClick();compose.onNodeWithText("取消引用").assertExists()
        compose.runOnIdle{state.value=state.value.copy(data=obj("messages" to JSONArray().put(JSONObject(message.toString()).put("cursor",1))))}
        compose.onNodeWithText("未发送的草稿").assertExists();compose.onNodeWithText("取消引用").assertExists()
        compose.onNodeWithText("今晚一起玩狼人杀吧").performTouchInput{longClick()};compose.onNodeWithText("多选").performClick();compose.onNodeWithText("已选 1/20").assertExists();compose.onNodeWithText("合并转发").assertExists()
        shot("android-message-selection")
    }
    @Test fun readOnlyImageMenuAllowsCopyAndSaveWithoutBotWrites(){
        val vm=client();val m=obj("id" to "image-message","text" to "图片","image" to obj("mime" to "image/png","base64" to "aGVsbG8="))
        compose.setContent{StarpostTheme("dark",false){MessageActionMenu(UiActions(vm),m,false,true,{})}}
        compose.onNodeWithText("复制").assertExists();compose.onNodeWithText("保存表情").assertExists();compose.onNodeWithText("撤回").assertDoesNotExist();compose.onNodeWithText("引用").assertDoesNotExist();compose.onNodeWithText("多选").assertDoesNotExist()
        shot("android-image-message-menu")
    }
    @Test fun forwardCardOpensFullRecordWithOriginalAuthorsAndImage(){
        val vm=client();val bitmap=Bitmap.createBitmap(240,160,Bitmap.Config.ARGB_8888).apply{eraseColor(0xffa7bcff.toInt())};val out=java.io.ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.PNG,100,out);bitmap.recycle()
        val rows=JSONArray().put(obj("sender" to "10003H","senderNickname" to "星河","text" to "今晚一起玩狼人杀吧","at" to "2026-11-02T12:00:00Z")).put(obj("sender" to "10005H","senderNickname" to "青岚","text" to "这是今天拍到的天空","at" to "2026-11-02T12:01:00Z","image" to obj("mime" to "image/png","base64" to android.util.Base64.encodeToString(out.toByteArray(),android.util.Base64.NO_WRAP))))
        val open=mutableStateOf(false)
        compose.setContent{StarpostTheme("light",false){if(open.value)ForwardRecordDialog(UiActions(vm),obj("items" to rows),{open.value=false})else ForwardCard(obj("count" to 2,"preview" to JSONArray().put("星河：今晚一起玩狼人杀吧"))){open.value=true}}}
        compose.onNodeWithText("这是今天拍到的天空").assertDoesNotExist();compose.onNodeWithText("查看完整聊天记录 →").performClick();compose.onNodeWithText("这是今天拍到的天空").assertExists();compose.onNodeWithText("完整聊天记录").assertExists();shot("android-forward-record")
    }
    @Test fun customBackgroundKeepsDraftAcrossThemesAndCanBeReset(){
        val context=ApplicationProvider.getApplicationContext<Application>();val file=File(context.filesDir,"appearance-background.jpg")
        val bitmap=Bitmap.createBitmap(400,800,Bitmap.Config.ARGB_8888)
        android.graphics.Canvas(bitmap).drawPaint(android.graphics.Paint().apply{shader=android.graphics.LinearGradient(0f,0f,400f,800f,intArrayOf(0xff45a8d5.toInt(),0xffe8bbce.toInt(),0xff5955a0.toInt()),null,android.graphics.Shader.TileMode.CLAMP)})
        file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.JPEG,85,it)};bitmap.recycle()
        val theme=androidx.compose.runtime.mutableStateOf("light");val vm=client()
        val social=obj("friendProfiles" to JSONArray().put(obj("botId" to "10005H","nickname" to "小星")))
        val data=obj("messages" to JSONArray().put(obj("id" to "background-message","sender" to "10005H","senderNickname" to "小星","text" to "在星邮，分享今天的故事。","at" to "2026-11-02T10:00:00Z")))
        val route=androidx.compose.runtime.mutableStateOf(Route("socialHistory","10005H"))
        try{
            compose.setContent{StarpostTheme(theme.value,false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,social=social,data=data,route=route.value))}}
            compose.waitUntil(5000){compose.onAllNodesWithTag("custom-background").fetchSemanticsNodes().isNotEmpty()}
            compose.onNode(hasSetTextAction()).performTextInput("没有发送的草稿")
            shot("android-background-light");compose.runOnIdle{theme.value="dark"};compose.waitForIdle()
            compose.onNodeWithText("没有发送的草稿").assertExists();shot("android-background-dark")
            compose.runOnIdle{route.value=Route("settings")};compose.onNodeWithText("恢复默认背景").performScrollTo().performClick()
            compose.waitUntil(5000){!file.exists()};compose.onNodeWithText("恢复默认背景").assertDoesNotExist()
        }finally{file.delete();context.getSharedPreferences("starpost-appearance",0).edit().clear().commit()}
    }
    @Test fun personalProfileShowsSocialSectionsInsteadOfGames(){
        val vm=client();compose.setContent{StarpostTheme("light",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,data=obj("botId" to "10005H","nickname" to "朋友","bio" to "简介"),route=Route("profile","10005H","social")))}}
        compose.onNodeWithText("最近动态").assertExists();compose.onNodeWithText("漂流瓶互动").assertExists();compose.onNodeWithText("战绩").assertDoesNotExist();compose.onNodeWithText("最近对局").assertDoesNotExist()
    }
    @Test fun gameRecordsHaveTheirOwnMiniAppAndKeepPrivateGameTitlesRedacted(){
        org.junit.Assert.assertTrue(searchMiniApps("游戏战绩").any{it.page=="gameRecord"})
        val vm=client();compose.setContent{StarpostTheme("dark",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,data=obj("games" to JSONArray().put(obj("title" to "私密对局","result" to "win","at" to "2026-11-02T10:00:00Z"))),route=Route("gameRecord","10005H",section="recent")))}}
        compose.onNodeWithText("私密对局").assertExists();compose.onNodeWithText("最近 3 场对局").assertExists();compose.onNodeWithText("最近动态").assertDoesNotExist()
    }
    @Test fun privateRemarkDisplaysWithoutEnteringMentionText() {
        val vm=client();val friend=obj("botId" to "10005H","nickname" to "公开昵称","remark" to "私人备注")
        val social=obj("friendProfiles" to JSONArray().put(friend))
        val data=obj("messages" to JSONArray().put(obj("id" to "remark-message","sender" to "10005H","senderNickname" to "公开昵称","text" to "你好","at" to "2026-11-02T10:00:00Z")))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,social=social,data=data,route=Route("socialHistory","10005H")))}}
        compose.onNodeWithText("修改备注名").assertExists()
        compose.onNodeWithText("私人备注").assertExists()
        compose.onNodeWithText("私",useUnmergedTree=true).performTouchInput{longClick()}
        compose.onNodeWithText("@公开昵称 ").assertExists()
        org.junit.Assert.assertEquals(listOf("10005H"),vm.mentionIds("@公开昵称 "))
    }
    @Test fun avatarSingleDoubleAndLongPressDoNotTriggerEachOther() {
        var opened=0;var mentioned=0;var poked=0
        compose.setContent{StarpostTheme("light",false){androidx.compose.runtime.CompositionLocalProvider(LocalAvatarProfile provides {opened++}){
            Avatar("甲",avatarId="10001",modifier=Modifier.testTag("gesture-avatar"),onMention={mentioned++},onPoke={poked++})
        }}}
        compose.onNodeWithTag("gesture-avatar").performTouchInput{doubleClick()};compose.waitForIdle()
        compose.runOnIdle{org.junit.Assert.assertEquals(1,poked);org.junit.Assert.assertEquals(0,opened);org.junit.Assert.assertEquals(0,mentioned)}
        compose.onNodeWithTag("gesture-avatar").performTouchInput{longClick()};compose.waitForIdle()
        compose.runOnIdle{org.junit.Assert.assertEquals(1,mentioned);org.junit.Assert.assertEquals(0,opened);org.junit.Assert.assertEquals(1,poked)}
        compose.onNodeWithTag("gesture-avatar").performTouchInput{click()};compose.mainClock.advanceTimeBy(400);compose.waitForIdle()
        compose.runOnIdle{org.junit.Assert.assertEquals(1,opened);org.junit.Assert.assertEquals(1,poked);org.junit.Assert.assertEquals(1,mentioned)}
    }
    @Test fun draftMentionsKeepRealIdsAndDisappearWhenTextIsRemoved() {
        val vm=client();vm.mention("10001","同名");vm.mention("10002","同名");vm.draft("@同名 你好")
        org.junit.Assert.assertEquals(setOf("10001","10002"),vm.mentionIds(vm.draft()).toSet())
        vm.draft("你好");org.junit.Assert.assertTrue(vm.mentionIds(vm.draft()).isEmpty())
    }
    @Test fun settingsOffersAvatarControlsForEachOwnedBotAndConfirmsTarget() {
        val vm=client()
        val profile=account.put("bots",JSONArray().put(obj("botId" to "10001","nickname" to "陈玥汐")).put(obj("botId" to "10002","nickname" to "小星","avatarVersion" to "test-version")))
        compose.setContent{StarpostTheme("light",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=profile,route=Route("settings")))}}
        compose.onAllNodesWithText("更换 Bot 头像").assertCountEquals(2)
        compose.onNodeWithText("移除 Bot 头像").performScrollTo().performClick()
        compose.onNodeWithText("将 小星（10002）的头像恢复为默认图标？").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
    }
    @Test fun miniAppsSearchFiltersIconsAndOpensMysteryViewer(){
        var selected:MiniApp?=null
        compose.setContent{StarpostTheme("light",false){MiniAppsCatalog({},{selected=it})}}
        compose.onNodeWithText("搜索游戏和额外功能").performTextInput("剧本杀")
        compose.onNodeWithText("搜索结果 · 3").assertExists()
        compose.onNodeWithText("狼人杀").assertDoesNotExist()
        compose.onNode(hasText("剧本杀") and !hasSetTextAction()).performClick()
        compose.runOnIdle{org.junit.Assert.assertEquals("mystery",selected?.id);org.junit.Assert.assertEquals("public",selected?.kind)}
        compose.onNodeWithContentDescription("清空搜索").performClick()
        compose.onNodeWithText("搜索游戏和额外功能").performTextInput("不存在的功能")
        compose.onNodeWithText("没有找到相关功能，试试“狼人杀”或“动态”。").assertExists()
    }
    @Test fun pullRevealsMiniAppsAndMovesWholePageThenCollapses(){
        val expanded=mutableStateOf(false)
        compose.setContent{StarpostTheme("light",false){MiniAppsReveal(expanded.value,{expanded.value=it},true,true,
            menu={MiniAppsCatalog({expanded.value=false},{})}){
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("pull-list")){Text("聊天首页");Spacer(Modifier.height(100.dp))}
        }}}
        compose.onNodeWithTag("pull-list").performTouchInput{swipe(start=center,end=center+androidx.compose.ui.geometry.Offset(0f,45f),durationMillis=400)}
        compose.waitForIdle();compose.runOnIdle{org.junit.Assert.assertFalse(expanded.value)}
        compose.onNodeWithTag("pull-list").performTouchInput{swipe(start=androidx.compose.ui.geometry.Offset(centerX,100f),end=androidx.compose.ui.geometry.Offset(centerX,700f),durationMillis=700)}
        compose.waitForIdle();compose.runOnIdle{org.junit.Assert.assertTrue(expanded.value)}
        compose.onNodeWithText("小程序").assertIsDisplayed()
        org.junit.Assert.assertTrue(compose.onNodeWithTag("main-page-surface").fetchSemanticsNode().positionInRoot.y>500f)
        shot("android-miniapps-reveal-light")
        compose.onNodeWithContentDescription("收起小程序").performClick();compose.waitForIdle()
        compose.onNodeWithText("聊天首页").assertIsDisplayed()
        compose.runOnIdle{org.junit.Assert.assertFalse(expanded.value)}
    }
    @Test fun miniAppsEntryUsesRevealAndSupportsDarkMode(){
        val vm=client();val state=ClientState(starting=false,signedIn=true,account=account,route=Route("social"),theme="dark")
        compose.setContent{StarpostTheme("dark",false){StarpostApp(vm,state)}}
        compose.onNodeWithContentDescription("游戏小程序").performClick();compose.waitForIdle()
        compose.onNodeWithText("小程序").assertIsDisplayed();compose.onNodeWithText("剧本杀").assertIsDisplayed()
        shot("android-miniapps-dark")
        compose.onNodeWithText("上滑或点此返回").performClick();compose.waitForIdle()
        compose.onNodeWithContentDescription("游戏小程序").assertIsDisplayed()
    }
    @Test fun scrollingAboveTheListBottomDoesNotOpenMiniApps(){
        val expanded=mutableStateOf(false)
        compose.setContent{StarpostTheme("light",false){MiniAppsReveal(expanded.value,{expanded.value=it},true,true,menu={Text("小程序测试页")}){
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState(initial=900)).testTag("scrolled-list")){repeat(60){Text("消息 $it",Modifier.height(48.dp))}}
        }}}
        compose.onNodeWithTag("scrolled-list").performTouchInput{swipe(start=center,end=center+androidx.compose.ui.geometry.Offset(0f,250f),durationMillis=600)}
        compose.waitForIdle();compose.runOnIdle{org.junit.Assert.assertFalse(expanded.value)}
        compose.onNodeWithText("小程序测试页").assertDoesNotExist()
    }
    @Test fun activeGameDisablesAndClosesMiniApps(){
        val expanded=mutableStateOf(true)
        compose.setContent{StarpostTheme("light",false){MiniAppsReveal(expanded.value,{expanded.value=it},false,true,menu={Text("小程序测试页")}){Text("对局中")}}}
        compose.waitForIdle();compose.runOnIdle{org.junit.Assert.assertFalse(expanded.value)}
        compose.onNodeWithText("对局中").assertIsDisplayed();compose.onNodeWithText("小程序测试页").assertDoesNotExist()
    }
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
                org.junit.Assert.assertNotNull("Installer handoff: ${updater.state.value}",intent)
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
    @Test fun gameTargetRequiresSelectionAndRejectsStalePhase(){
        val option=obj("move" to "vote","label" to "投票","targets" to JSONArray().put(obj("id" to "10002","nickname" to "小夏")).put(obj("id" to "abstain","nickname" to "弃票")))
        val valid=mutableStateOf(true);var submitted:String?=null
        compose.setContent{StarpostTheme("light",false){GameTargetDialog(option,option,valid.value,false,{}){submitted=it}}}
        compose.onNodeWithText("确认行动").assertIsNotEnabled()
        compose.onNodeWithText("小夏",useUnmergedTree=true).performClick()
        compose.onNodeWithText("确认行动").assertIsEnabled()
        compose.runOnIdle{valid.value=false};compose.onNodeWithText("确认行动").assertIsNotEnabled()
        compose.runOnIdle{org.junit.Assert.assertNull(submitted);valid.value=true}
        compose.onNodeWithText("弃票",useUnmergedTree=true).performClick();compose.onNodeWithText("确认行动").performClick()
        compose.runOnIdle{org.junit.Assert.assertEquals("abstain",submitted)}
    }
    @Test fun gameBoardSupportsTwentySeatsAndRetainsDraftAcrossTabsAndPolling(){
        val vm=client();val theme=mutableStateOf("light");val seats=JSONArray();repeat(20){i->seats.put(obj("id" to if(i==0)"10003H" else "${10010+i}","number" to i+1,"nickname" to if(i==0)"星河访客" else "玩家${i+1}","alive" to (i!=3),"checkedIn" to true))}
        val g=obj("gameId" to "arena","title" to "星夜推理局","day" to 2,"ownRole" to "seer","status" to "day","seats" to seats,"phaseDeadlineAt" to "2026-11-02T12:03:00Z")
        val data=mutableStateOf(obj("game" to g,"serverNow" to "2026-11-02T12:00:00Z","humanId" to "10003H","messages" to JSONArray().put(obj("id" to "m1","sender" to "system","kind" to "dawn","day" to 2,"channel" to "public")),"channels" to JSONArray().put("public"),"options" to JSONArray()))
        compose.setContent{StarpostTheme(theme.value,false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,route=Route("humanRoom","arena"),activeGame="arena",data=data.value))}}
        compose.onNode(hasSetTextAction()).performTextInput("尚未发送的推理")
        shot("android-arena-light")
        compose.runOnIdle{theme.value="dark";data.value=JSONObject(data.value.toString()).put("game",JSONObject(g.toString()).put("status","vote"))};compose.onNodeWithText("尚未发送的推理").assertExists();shot("android-arena-dark")
        compose.onNodeWithText("玩家20").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("讨论记录").performClick();compose.onNodeWithText("天亮了 · 平安夜").assertExists();compose.onNodeWithText("尚未发送的推理").assertExists()
        compose.onNodeWithText("牌桌").performClick();compose.onNodeWithText("预言家").assertExists()
    }
    @Test fun mysteryViewerShowsProgressWithoutHumanActions(){
        val vm=client();val g=obj("title" to "午夜列车","gameType" to "mystery","status" to "active","phase" to "clues","seats" to JSONArray().put(obj("id" to "10002","nickname" to "小夏","number" to 1,"alive" to true)))
        compose.setContent{StarpostTheme("dark",false){StarpostApp(vm,ClientState(starting=false,signedIn=true,account=account,route=Route("game","mystery"),data=obj("game" to g,"messages" to JSONArray())))}}
        compose.onNodeWithText("3 搜集线索").assertExists();compose.onNodeWithText("确认行动").assertDoesNotExist();compose.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        shot("android-mystery-arena")
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
