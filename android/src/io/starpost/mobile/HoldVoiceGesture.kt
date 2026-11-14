package io.starpost.mobile

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable internal fun HoldVoiceGesture(enabled:Boolean,onStart:()->Boolean,onFinish:(Boolean)->Unit,onCancel:()->Unit,onSlide:(Boolean)->Unit){
    val distance=with(LocalDensity.current){72.dp.toPx()}
    val start by rememberUpdatedState(onStart);val finish by rememberUpdatedState(onFinish);val cancel by rememberUpdatedState(onCancel);val slide by rememberUpdatedState(onSlide)
    Box(Modifier.size(48.dp).semantics{contentDescription="长按录音，松手发送，上滑取消"}.pointerInput(enabled,distance){
        awaitEachGesture{
            val down=awaitFirstDown(requireUnconsumed=false)
            if(!enabled)return@awaitEachGesture
            val long=awaitLongPressOrCancellation(down.id)?:return@awaitEachGesture
            if(!start())return@awaitEachGesture
            var complete=false
            try{while(true){
                val event=awaitPointerEvent();val change=event.changes.firstOrNull{it.id==long.id}?:break
                // Compose represents system cancellation/disposal as a consumed release.
                if(!change.pressed&&change.isConsumed)break
                val discard=change.position.y<down.position.y-distance;slide(discard);change.consume()
                if(!change.pressed){complete=true;finish(discard);break}
            }}finally{if(!complete)cancel()}
        }
    },contentAlignment=Alignment.Center){Text("🎙",color=if(enabled)MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)}
}
