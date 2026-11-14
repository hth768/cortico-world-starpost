package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.json.JSONObject

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35],qualifiers="w412dp-h892dp-xhdpi")
class ChatTimelineTest {
    @get:Rule val compose = createComposeRule()
    private fun messages(start:Int=1,end:Int=25)= (start..end).map { obj("id" to "m$it", "text" to "消息 $it") }

    @Test fun incomingAndOwnMessagesFollowButReadingHistoryStaysPut() {
        val rows=mutableStateOf(messages());val sent=mutableStateOf(0)
        compose.setContent { StarpostTheme("light",false) { ChatTimeline("owner:10001",null,rows.value,sent.value,Modifier.height(400.dp),latest={}) {
            Text(it.str("text"),Modifier.fillMaxWidth().height(85.dp))
        } } }
        compose.onNodeWithText("消息 25").assertIsDisplayed()
        compose.runOnIdle { rows.value=messages(end=26) }
        compose.onNodeWithText("消息 26").assertIsDisplayed()
        compose.onNodeWithTag("chat-jump").assertDoesNotExist()
        compose.onNodeWithTag("chat-timeline").performTouchInput { swipeDown(durationMillis=500) }
        compose.waitForIdle()
        compose.onNodeWithTag("chat-jump").assertIsDisplayed()
        val before=compose.onAllNodes(hasText("消息 ",substring=true)).fetchSemanticsNodes().map { it.id }
        compose.runOnIdle { rows.value=messages(start=4,end=29) }
        compose.onNodeWithText("有新消息 · 回到底部 ↓").assertIsDisplayed()
        compose.onNodeWithText("消息 29").assertDoesNotExist()
        org.junit.Assert.assertTrue(compose.onAllNodes(hasText("消息 ",substring=true)).fetchSemanticsNodes().any { it.id in before })
        compose.onNodeWithTag("chat-jump").performClick()
        compose.onNodeWithText("消息 29").assertIsDisplayed()
        compose.onNodeWithTag("chat-timeline").performTouchInput { swipeDown(durationMillis=500) }
        compose.runOnIdle { sent.value++;rows.value=messages(start=5,end=30) }
        compose.onNodeWithText("消息 30").assertIsDisplayed()
        compose.onNodeWithTag("chat-jump").assertDoesNotExist()
    }

    @Test fun lateImageSizeAndConversationAndHistoryPageChangesAreIsolated() {
        val tall=mutableStateOf(false);val conversation=mutableStateOf("group:a");val page=mutableStateOf<Long?>(null)
        val rows=mutableStateOf(messages());var latestRequests=0
        compose.setContent { StarpostTheme("dark",false) { ChatTimeline(conversation.value,page.value,rows.value,0,Modifier.height(400.dp),latest={latestRequests++;page.value=null}) {
            Column(Modifier.fillMaxWidth()){Text(it.str("text"));Spacer(Modifier.height(if(it.str("id")=="m25"&&tall.value)210.dp else 60.dp));Text("结尾 ${it.str("id")}")}
        } } }
        compose.runOnIdle { tall.value=true }
        compose.onNodeWithText("结尾 m25").assertIsDisplayed()
        compose.onNodeWithTag("chat-timeline").performTouchInput { swipeDown(durationMillis=500) }
        compose.runOnIdle { conversation.value="private:b" }
        compose.onNodeWithText("结尾 m25").assertIsDisplayed()
        compose.onNodeWithTag("chat-jump").assertDoesNotExist()
        compose.runOnIdle { page.value=123L;rows.value=messages(end=15) }
        compose.onNodeWithText("回到最新消息 ↓").performClick()
        org.junit.Assert.assertEquals(1,latestRequests)
        compose.runOnIdle { rows.value=messages() }
        compose.onNodeWithText("结尾 m25").assertIsDisplayed()
    }
}
