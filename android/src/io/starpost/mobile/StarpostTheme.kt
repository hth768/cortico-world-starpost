@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package io.starpost.mobile

import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.size
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

private val Light = lightColorScheme(
    primary=Color(0xFF4356B5), onPrimary=Color.White, primaryContainer=Color(0xFFDEE1FF), onPrimaryContainer=Color(0xFF18266B),
    secondary=Color(0xFF35675B),onSecondary=Color.White,secondaryContainer=Color(0xFFB8ECDD),onSecondaryContainer=Color(0xFF124D41),
    tertiary=Color(0xFF974932),onTertiary=Color.White,tertiaryContainer=Color(0xFFFFDBCF),onTertiaryContainer=Color(0xFF75321E),
    background=Color(0xFFF9F9FF),onBackground=Color(0xFF1A1B25),surface=Color(0xFFF9F9FF),onSurface=Color(0xFF1A1B25),
    surfaceContainerLowest=Color.White,surfaceContainerLow=Color(0xFFF3F3FC),surfaceContainer=Color(0xFFEEEFF8),surfaceContainerHigh=Color(0xFFE8E9F2),surfaceContainerHighest=Color(0xFFE2E3EC),
    onSurfaceVariant=Color(0xFF454651),outline=Color(0xFF757681),outlineVariant=Color(0xFFC5C5D2)
)
private val Dark = darkColorScheme(
    primary=Color(0xFFBAC3FF),onPrimary=Color(0xFF102477),primaryContainer=Color(0xFF2B3D9B),onPrimaryContainer=Color(0xFFDEE1FF),
    secondary=Color(0xFF9DD0C2),onSecondary=Color(0xFF00382D),secondaryContainer=Color(0xFF1C5044),onSecondaryContainer=Color(0xFFB8ECDD),
    tertiary=Color(0xFFFFB59C),onTertiary=Color(0xFF5B210E),tertiaryContainer=Color(0xFF793620),onTertiaryContainer=Color(0xFFFFDBCF),
    background=Color(0xFF11121B),onBackground=Color(0xFFE3E2ED),surface=Color(0xFF11121B),onSurface=Color(0xFFE3E2ED),
    surfaceContainerLowest=Color(0xFF0C0D15),surfaceContainerLow=Color(0xFF191A24),surfaceContainer=Color(0xFF1E1F29),surfaceContainerHigh=Color(0xFF282933),surfaceContainerHighest=Color(0xFF33343F),
    onSurfaceVariant=Color(0xFFC5C5D2),outline=Color(0xFF8F8F9C),outlineVariant=Color(0xFF454651)
)
@Composable internal fun StarpostTheme(mode:String,dynamic:Boolean,content:@Composable ()->Unit) {
    val dark=when(mode){"dark"->true;"light"->false;else->isSystemInDarkTheme()}
    val context=LocalContext.current
    val colors=if(dynamic&&Build.VERSION.SDK_INT>=31){if(dark)dynamicDarkColorScheme(context)else dynamicLightColorScheme(context)}else if(dark)Dark else Light
    SideEffect { (context as? android.app.Activity)?.window?.let { window ->
        androidx.core.view.WindowCompat.getInsetsController(window,window.decorView).apply { isAppearanceLightStatusBars=!dark;isAppearanceLightNavigationBars=!dark }
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(colors.background.toArgb()))
    } }
    MaterialExpressiveTheme(colorScheme=colors,motionScheme=MotionScheme.expressive(),content=content)
}

/** Shared, small outline icon set. Geometry is independent of remote fonts. */
private val paths=mapOf(
    "chat" to "M5 4H19Q21 4 21 6V16Q21 18 19 18H9L4 21V6Q4 4 5 4M8 9H17M8 13H14",
    "people" to "M9 3A4 4 0 1 0 9 11A4 4 0 1 0 9 3M2 21V18Q2 14 9 14Q16 14 16 18V21M17 4Q22 5 20 9M19 14Q23 15 23 19",
    "explore" to "M12 2A10 10 0 1 0 12 22A10 10 0 1 0 12 2M16 8L14 14L8 16L10 10Z",
    "person" to "M12 3A4 4 0 1 0 12 11A4 4 0 1 0 12 3M4 21V18Q4 14 12 14Q20 14 20 18V21",
    "add" to "M12 5V19M5 12H19",
    "back" to "M14 5L7 12L14 19M7 12H21",
    "search" to "M10 3A7 7 0 1 0 10 17A7 7 0 1 0 10 3M15 15L21 21",
    "game" to "M7 7H17Q20 7 21 11L23 19Q23 22 20 20L16 17H8L4 20Q1 22 1 19L3 11Q4 7 7 7M7 10V15M4.5 12.5H9.5M16 11H16.1M19 14H19.1",
    "sun" to "M12 7A5 5 0 1 0 12 17A5 5 0 1 0 12 7M12 1V3M12 21V23M1 12H3M21 12H23M4 4L6 6M18 18L20 20M4 20L6 18M18 6L20 4",
    "moon" to "M20 16A9 9 0 1 1 8 4A8 8 0 0 0 20 16Z",
    "send" to "M3 3L22 12L3 21L7 12ZM7 12H22",
    "sticker" to "M5 3H19Q21 3 21 5V14L14 21H5Q3 21 3 19V5Q3 3 5 3M14 21V16Q14 14 16 14H21M7 8H7.1M15 8H15.1M7 12Q10 15 13 12",
    "mail" to "M4 5H20Q22 5 22 7V18Q22 20 20 20H4Q2 20 2 18V7Q2 5 4 5M3 7L12 13L21 7",
    "check" to "M4 12L9 17L20 6",
    "close" to "M6 6L18 18M18 6L6 18",
    "lock" to "M7 10V7A5 5 0 0 1 17 7V10M5 10H19V22H5ZM12 15V18",
    "refresh" to "M20 8A9 9 0 1 0 21 15M20 2V8H14",
    "more" to "M5 12H5.1M12 12H12.1M19 12H19.1",
    "link" to "M9 15L15 9M7 17L5 19A4 4 0 0 1 0 13L6 7A4 4 0 0 1 11 7M13 17A4 4 0 0 0 18 17L24 11A4 4 0 0 0 19 5L17 7",
    "chevron" to "M9 5L16 12L9 19",
    "down" to "M5 9L12 16L19 9",
    "spark" to "M12 2L15 9L22 12L15 15L12 22L9 15L2 12L9 9Z"
)
@Composable internal fun Glyph(name:String,description:String?=null,modifier:Modifier=Modifier,color:Color=LocalContentColor.current) {
    val path=remember(name){PathParser().parsePathString(paths[name]?:paths.getValue("spark")).toPath()}
    Canvas(modifier.size(24.dp).then(if(description!=null)Modifier.semantics{contentDescription=description}else Modifier)) {
        scale(size.width/24f,size.height/24f,pivot=androidx.compose.ui.geometry.Offset.Zero){drawPath(path,color,style=Stroke(1.8f,cap=StrokeCap.Round,join=StrokeJoin.Round))}
    }
}
