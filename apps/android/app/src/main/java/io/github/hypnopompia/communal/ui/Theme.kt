package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The desktop's palette (apps/desktop/src/renderer/src/styles.css).
private val Light = lightColorScheme(
    primary = Color(0xFF2F5BEA),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE3EAFD),
    onPrimaryContainer = Color(0xFF1A2330),
    secondary = Color(0xFF2A9670),
    secondaryContainer = Color(0xFFE3EAFD),
    onSecondaryContainer = Color(0xFF1A2330),
    tertiary = Color(0xFFE8A73F),
    background = Color(0xFFE9EEEC),
    onBackground = Color(0xFF1A2330),
    surface = Color(0xFFF7F9F8),
    onSurface = Color(0xFF1A2330),
    surfaceVariant = Color(0xFFDFE5E2),
    onSurfaceVariant = Color(0xFF4F5D6B),
    outline = Color(0xFF7D8994),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF7D9BFF),
    onPrimary = Color(0xFF0E1A3D),
    primaryContainer = Color(0xFF243A7A),
    onPrimaryContainer = Color(0xFFE6EBEF),
    secondary = Color(0xFF5CC79F),
    secondaryContainer = Color(0xFF243A7A),
    onSecondaryContainer = Color(0xFFE6EBEF),
    tertiary = Color(0xFFF0BE6A),
    background = Color(0xFF151A1F),
    onBackground = Color(0xFFE6EBEF),
    surface = Color(0xFF1C2228),
    onSurface = Color(0xFFE6EBEF),
    surfaceVariant = Color(0xFF283039),
    onSurfaceVariant = Color(0xFFAAB5BF),
    outline = Color(0xFF6E7A85),
)

@Composable
fun CommunalTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
