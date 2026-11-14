package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35],qualifiers="w412dp-h892dp-xhdpi")
class HoldVoiceGestureTest {
    @get:Rule val compose=createComposeRule()
    @Test fun holdReleaseSendsSwipeCancelsAndShortTapDoesNotRecord(){
        var started=0;val released=mutableListOf<Boolean>();var cancelled=0
        compose.setContent{Box(Modifier.fillMaxSize().padding(top=300.dp)){HoldVoiceGesture(true,{started++;true},{released+=it},{cancelled++},{})}}
        val mic=compose.onNodeWithContentDescription("长按录音，松手发送，上滑取消")
        mic.performTouchInput{click()};compose.runOnIdle{assertEquals(0,started)}
        mic.performTouchInput{down(center);advanceEventTime(800);up()}
        compose.runOnIdle{assertEquals(1,started);assertEquals(listOf(false),released);assertEquals(0,cancelled)}
        mic.performTouchInput{down(center);advanceEventTime(800);moveTo(center+Offset(0f,-200f));up()}
        compose.runOnIdle{assertEquals(2,started);assertEquals(listOf(false,true),released)}
        mic.performTouchInput{down(center);advanceEventTime(800);cancel()}
        compose.runOnIdle{assertEquals(3,started);assertEquals(2,released.size);assertEquals(1,cancelled)}
    }
    @Test fun failedStartAndLeavingTheConversationNeverSend(){
        val allowed=mutableStateOf(false);val shown=mutableStateOf(true);var sent=0;var cancelled=0
        compose.setContent{if(shown.value)HoldVoiceGesture(true,{allowed.value},{sent++},{cancelled++},{})}
        val mic=compose.onNodeWithContentDescription("长按录音，松手发送，上滑取消")
        mic.performTouchInput{down(center);advanceEventTime(800);up()};compose.runOnIdle{assertEquals(0,sent);allowed.value=true}
        mic.performTouchInput{down(center);moveTo(center,delayMillis=800)};compose.runOnIdle{shown.value=false};compose.waitForIdle()
        compose.runOnIdle{assertEquals(0,sent);assertEquals(1,cancelled)}
    }
}
