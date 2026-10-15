package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.hypnopompia.communal.R

/*
 * The desktop's look (apps/desktop/src/renderer/src/styles.css): a quiet sage-grey workspace
 * where people are the colour. Cobalt marks what you can do, green marks what's reachable now.
 * Keep the two in step.
 */

/** The desktop's colours that Material has no slot for. */
@Immutable
data class Tones(
    val online: Color,
    val onlineSoft: Color,
    val warn: Color,
    val warnSoft: Color,
    val danger: Color,
    val dangerSoft: Color,
    /** Hairlines around panels and file icons (`--line`). */
    val line: Color,
    /** The faintest text (`--ink-3`). */
    val faint: Color,
)

private val LightTones = Tones(
    online = Color(0xFF18936A),
    onlineSoft = Color(0xFFDFF3EA),
    warn = Color(0xFFA8660F),
    warnSoft = Color(0xFFFBEFDC),
    danger = Color(0xFFC03A26),
    dangerSoft = Color(0xFFFBE5E1),
    line = Color(0xFFD3DBD8),
    faint = Color(0xFF7D8994),
)

private val DarkTones = Tones(
    online = Color(0xFF49C595),
    onlineSoft = Color(0xFF193A2E),
    warn = Color(0xFFE8A94F),
    warnSoft = Color(0xFF3B2D17),
    danger = Color(0xFFF07A66),
    dangerSoft = Color(0xFF42221D),
    line = Color(0xFF2E3842),
    faint = Color(0xFF7B8792),
)

private val Light = lightColorScheme(
    primary = Color(0xFF2F5BEA),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE3EAFD),
    onPrimaryContainer = Color(0xFF1A2330),
    secondary = Color(0xFF18936A),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE3EAFD),
    onSecondaryContainer = Color(0xFF1A2330),
    tertiary = Color(0xFFE8A73F),
    background = Color(0xFFE9EEEC),
    onBackground = Color(0xFF1A2330),
    surface = Color(0xFFE9EEEC),
    onSurface = Color(0xFF1A2330),
    surfaceVariant = Color(0xFFE3E9E7),
    onSurfaceVariant = Color(0xFF4F5D6B),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF3F6F5),
    surfaceContainer = Color(0xFFDFE6E3),
    surfaceContainerHigh = Color.White,
    surfaceContainerHighest = Color(0xFFF3F6F5),
    outline = Color(0xFF7D8994),
    outlineVariant = Color(0xFFD3DBD8),
    error = Color(0xFFC03A26),
    errorContainer = Color(0xFFFBE5E1),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF7D9BFF),
    onPrimary = Color(0xFF0F1830),
    primaryContainer = Color(0xFF24304F),
    onPrimaryContainer = Color(0xFFE6EBEF),
    secondary = Color(0xFF49C595),
    onSecondary = Color(0xFF0F1830),
    secondaryContainer = Color(0xFF24304F),
    onSecondaryContainer = Color(0xFFE6EBEF),
    tertiary = Color(0xFFF0BE6A),
    background = Color(0xFF151A1F),
    onBackground = Color(0xFFE6EBEF),
    surface = Color(0xFF151A1F),
    onSurface = Color(0xFFE6EBEF),
    surfaceVariant = Color(0xFF232B33),
    onSurfaceVariant = Color(0xFFAAB5BF),
    surfaceContainerLowest = Color(0xFF1D242B),
    surfaceContainerLow = Color(0xFF1D242B),
    surfaceContainer = Color(0xFF11161A),
    surfaceContainerHigh = Color(0xFF1D242B),
    surfaceContainerHighest = Color(0xFF232B33),
    outline = Color(0xFF7B8792),
    outlineVariant = Color(0xFF2E3842),
    error = Color(0xFFF07A66),
    errorContainer = Color(0xFF42221D),
)

@OptIn(ExperimentalTextApi::class)
private fun weight(w: Int) =
    Font(R.font.atkinson_hyperlegible_next, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))

/** Atkinson Hyperlegible Next, the desktop's font: one variable file, four weights. */
val Atkinson = FontFamily(weight(400), weight(500), weight(600), weight(700))

private fun typography(): Typography {
    val base = Typography()
    fun TextStyle.a(w: FontWeight? = null) = copy(fontFamily = Atkinson, fontWeight = w ?: fontWeight)
    return Typography(
        displayLarge = base.displayLarge.a(FontWeight.Bold),
        displayMedium = base.displayMedium.a(FontWeight.Bold),
        displaySmall = base.displaySmall.a(FontWeight.Bold),
        headlineLarge = base.headlineLarge.a(FontWeight.Bold),
        headlineMedium = base.headlineMedium.a(FontWeight.Bold).copy(letterSpacing = (-0.2).sp),
        headlineSmall = base.headlineSmall.a(FontWeight.Bold).copy(letterSpacing = (-0.2).sp),
        titleLarge = base.titleLarge.a(FontWeight.Bold).copy(fontSize = 22.sp, letterSpacing = (-0.2).sp),
        titleMedium = base.titleMedium.a(FontWeight.Bold),
        titleSmall = base.titleSmall.a(FontWeight.Bold),
        bodyLarge = base.bodyLarge.a().copy(fontSize = 16.sp, letterSpacing = 0.sp),
        bodyMedium = base.bodyMedium.a().copy(fontSize = 14.sp, letterSpacing = 0.sp),
        bodySmall = base.bodySmall.a().copy(fontSize = 13.sp, letterSpacing = 0.sp),
        labelLarge = base.labelLarge.a(FontWeight.Bold),
        labelMedium = base.labelMedium.a(FontWeight.SemiBold),
        labelSmall = base.labelSmall.a(FontWeight.SemiBold),
    )
}

/** The desktop's radii: 6, 10 and 16 px. */
private val CommunalShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(10.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

private val LocalTones = staticCompositionLocalOf { LightTones }

/** The extra colours, as `Brand.tones.online`. */
object Brand {
    val tones: Tones
        @Composable @ReadOnlyComposable get() = LocalTones.current
}

@Composable
fun CommunalTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val scheme: ColorScheme = if (dark) Dark else Light
    CompositionLocalProvider(LocalTones provides if (dark) DarkTones else LightTones) {
        MaterialTheme(colorScheme = scheme, typography = typography(), shapes = CommunalShapes, content = content)
    }
}
