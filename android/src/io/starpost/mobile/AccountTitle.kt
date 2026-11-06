package io.starpost.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import org.json.JSONObject

private object TitleDesign {
    private var cached:JSONObject?=null
    @Synchronized fun load(context:android.content.Context):JSONObject = cached ?: context.assets.open("title-style-presets.json").bufferedReader().use{JSONObject(it.readText())}.also{cached=it}
}

/** Only server grants populate this badge; it is separate from nickname/role. */
@Composable internal fun AccountTitleBadge(title:String, compact:Boolean=false, style:JSONObject?=null) {
    if(title.isBlank())return
    val context=LocalContext.current
    val presets=remember(context){TitleDesign.load(context)}
    fun option(key:String,group:String):String {val value=style?.opt(key);return if(value is String&&presets.getJSONObject(group).has(value))value else presets.getJSONObject("defaults").getString(key)}
    val background=option("background","backgrounds")
    val fill=option("fill","fills")
    val font=option("font","fonts")
    val weight=option("weight","weights")
    val dark=MaterialTheme.colorScheme.surface.luminance()<0.5f
    val colors=presets.getJSONObject("backgrounds").getJSONObject(background).getJSONArray(if(dark)"dark" else "light")
    fun color(i:Int)=Color(android.graphics.Color.parseColor(colors.getString(i)))
    val brush=Brush.linearGradient(if(fill=="gradient")listOf(color(0),color(1))else List(2){color(if(fill=="solid")1 else 0)})
    Surface(shape=RoundedCornerShape(if(fill=="outline")50.dp else 8.dp),color=Color.Transparent,
        contentColor=color(2),
        border=BorderStroke(if(fill=="outline")2.dp else 1.dp,color(3)),
        modifier=Modifier.semantics{contentDescription="账号头衔：$title"}) {
        Box(Modifier.background(brush)) {
        Text("✦ $title",Modifier.padding(horizontal=if(compact)5.dp else 9.dp,vertical=3.dp),
            style=if(compact)MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium,
            fontFamily=when(font){"serif"->FontFamily.Serif;"mono"->FontFamily.Monospace;else->FontFamily.SansSerif},
            fontWeight=FontWeight(presets.getJSONObject("weights").getJSONObject(weight).getInt("value")),
            fontStyle=if(style?.opt("italic")==true)FontStyle.Italic else FontStyle.Normal)
        }
    }
}
