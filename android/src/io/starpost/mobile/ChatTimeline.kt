package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import org.json.JSONObject

/** The bottom is item zero, so late image layout cannot push the last bubble offscreen. */
@Composable internal fun ChatTimeline(
    conversation: String, page: Long?, messages: List<JSONObject>, sent: Int,
    modifier: Modifier = Modifier, latest: () -> Unit, content: @Composable (JSONObject) -> Unit
) = key(conversation) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var following by remember { mutableStateOf(page == null) }
    var userScrolling by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf(false) }
    var previousTail by remember { mutableStateOf<String?>(null) }
    var previousPage by remember { mutableStateOf(page) }
    var buffered by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    val currentPage by rememberUpdatedState(page)
    val scroll = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y != 0f) {
                    userScrolling = true
                    following = false
                }
                return Offset.Zero
            }
        }
    }
    LaunchedEffect(list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset) }
            .distinctUntilChanged().collect { (moving, index, offset) ->
                if (userScrolling) {
                    following = currentPage == null && index == 0 && offset == 0
                    if (following) pending = false
                    if (!moving) userScrolling = false
                }
            }
    }
    LaunchedEffect(page, messages.toString()) {
        val changedPage = previousPage != page
        if (changedPage) { following = page == null; pending = false; buffered = emptyList(); previousPage = page }
        val tail = messages.lastOrNull()?.str("id")
        if (!changedPage && !following && page == null && previousTail != null && tail != previousTail) pending = true
        previousTail = tail
        buffered = if (!following && page == null) {
            val merged = linkedMapOf<String, JSONObject>()
            buffered.forEach { merged[it.str("id")] = it }; messages.forEach { merged[it.str("id")] = it }
            merged.values.take(300)
        } else messages
        if (following && page == null && buffered.isNotEmpty()) list.scrollToItem(0)
    }
    LaunchedEffect(sent) {
        if (sent > 0) { following = true; userScrolling = false; pending = false; if (page == null && buffered.isNotEmpty()) list.scrollToItem(0) }
    }
    Column(modifier) {
        LazyColumn(state = list, reverseLayout = true,
            modifier = Modifier.weight(1f).fillMaxWidth().nestedScroll(scroll).testTag("chat-timeline"),
            contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            items(buffered.asReversed(), key = { it.str("id", it.toString()) }) { content(it) }
        }
        if (!following || page != null) Row(Modifier.fillMaxWidth().height(44.dp).padding(horizontal=12.dp),horizontalArrangement=Arrangement.End,verticalAlignment=Alignment.CenterVertically){FilledTonalButton(
            modifier = Modifier.height(32.dp).testTag("chat-jump").semantics{contentDescription=if(pending)"有新消息，回到底部" else "回到最新消息"},
            contentPadding = PaddingValues(horizontal=12.dp,vertical=0.dp),
            onClick = {
                following = true; userScrolling = false; pending = false
                if (page != null) latest() else {
                    buffered = messages
                    scope.launch { if (buffered.isNotEmpty()) list.scrollToItem(0) }
                }
            }
        ) { Text(if (pending) "新消息 ↓" else if (page != null) "最新 ↓" else "到底部 ↓",fontSize=12.sp) }}
    }
}
