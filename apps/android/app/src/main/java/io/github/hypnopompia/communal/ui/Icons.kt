package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.hypnopompia.communal.R

/*
 * The desktop's icons (apps/desktop/src/renderer/src/ui/icons.tsx), path for path: line icons on
 * a 20 px grid, the device marks, file icons with a labelled band, and people's discs. Change
 * them there and here together.
 */

private fun line(name: String, d: String): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 20f, 20f).addPath(
        pathData = PathParser().parsePathString(d).toNodes(),
        fill = null,
        stroke = SolidColor(Color.Black),
        strokeLineWidth = 1.6f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ).build()

object Glyphs {
    val Library = line("library", "M3 4h4v12H3zM8.5 4h4v12h-4zM14 5l3.2-.8 2.3 11.3-3.2.7z")
    val Search = line("search", "M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM13 13l4.5 4.5")
    val People = line(
        "people",
        "M7 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 16.5c.6-2.8 2.6-4.5 5-4.5s4.4 1.7 5 4.5M13.5 9a2.5 2.5 0 1 0 0-5M14.5 12c1.8.4 3 1.9 3.5 4.5",
    )
    val Transfers = line("transfers", "M10 3v10M6 9l4 4 4-4M4 16.5h12")
    val Sync = line(
        "subscriptions",
        "M4 10a6 6 0 0 1 10.2-4.3L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 0 1-10.2 4.3L4 12.5M4 16v-3.5h3.5",
    )
    val Settings = line(
        "settings",
        "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4",
    )
    val Folder = line(
        "folder",
        "M2.5 6.5V15a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5H9.5L8 4.5H4A1.5 1.5 0 0 0 2.5 6z",
    )
    val Device = line("device", "M3 5h14v8H3zM1.5 15.5h17")
    val Back = line("back", "M12 4l-6 6 6 6")
    val Chevron = line("chevron", "M8 6l4 4-4 4")
    val Close = line("close", "M5 5l10 10M15 5L5 15")
    val Plus = line("plus", "M10 4v12M4 10h12")
    val Check = line("check", "M4 10.5l4 4 8-9")
    val Globe = line(
        "globe",
        "M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM2.5 10h15M10 2.5c2 2 3 4.5 3 7.5s-1 5.5-3 7.5c-2-2-3-4.5-3-7.5s1-5.5 3-7.5z",
    )
    val User = line("user", "M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4.5 16.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5")
    val Eye = line("eye", "M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10zM10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z")
    val Shield = line("shield", "M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z")
    val Hub = line("hub", "M10 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4 12.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM16 12.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM9 7.2l-4 5.5M11 7.2l4 5.5M6 14.5h8")
    val Pause = line("pause", "M7 4.5v11M13 4.5v11")
    val Play = line("play", "M6.5 4.5v11l9-5.5z")
    val Grid = line("grid", "M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z")
    val List = line("list", "M3.5 5h13M3.5 10h13M3.5 15h13")
    val More = line("more", "M10 4.5v.1M10 10v.1M10 15.5v.1")
    val Filter = line("filter", "M3 5h14M5.5 10h9M8 15h4")
    val Open = line("open", "M11 3.5h5.5V9M16.5 3.5L9 11M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8")
    val Phone = line("phone", "M6 2.5h8a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zM9 15h2")
    val Info = line("info", "M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM10 9v5M10 6.2v.1")
    val Update = line("update", "M10 3v9M6 8l4 4 4-4M3.5 15.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1")
}

/** What kind of device it is (ADR 0023), drawn like the desktop's `PlatformIcon`. */
private val PLATFORMS = mapOf(
    "darwin" to line(
        "Mac",
        "M10 6.6c-.9-.7-2-1-3-.8-1.9.4-3 2.2-2.8 4.5.3 3 2 6.2 3.7 6.2.9 0 1.2-.5 2.1-.5s1.2.5 2.1.5c1.7 0 3.4-3.2 3.7-6.2.2-2.3-.9-4.1-2.8-4.5-1-.2-2.1.1-3 .8zM10.2 5.6c.1-1.5 1-2.6 2.5-3-.1 1.5-1 2.6-2.5 3z",
    ),
    "win32" to line("Windows", "M3.5 3.5h5.3v5.3H3.5zM11.2 3.5h5.3v5.3h-5.3zM3.5 11.2h5.3v5.3H3.5zM11.2 11.2h5.3v5.3h-5.3z"),
    "linux" to line(
        "Linux",
        "M10 2.5c-1.9 0-3 1.5-3 3.6 0 1.3-.4 2.1-1.2 3.3-1 1.5-1.8 3-1.5 4.6.3 1.6 2 2.5 5.7 2.5s5.4-.9 5.7-2.5c.3-1.6-.5-3.1-1.5-4.6-.8-1.2-1.2-2-1.2-3.3 0-2.1-1.1-3.6-3-3.6zM10 9.5c-1.6 0-2.5 1.7-2.5 3.5s.9 2.9 2.5 2.9 2.5-1.1 2.5-2.9-.9-3.5-2.5-3.5zM8.9 5.4v.4M11.1 5.4v.4M9.2 7.2h1.6L10 8z",
    ),
    "android" to line("Android", "M4 14.5a6 6 0 0 1 12 0zM6.6 9.4 5 6.8M13.4 9.4 15 6.8M7.9 12v.1M12.1 12v.1"),
)

fun platformIcon(platform: String?): ImageVector = PLATFORMS[platform] ?: Glyphs.Device

fun platformLabel(platform: String?): String = when (platform) {
    "darwin" -> "Mac"
    "win32" -> "Windows"
    "linux" -> "Linux"
    "android" -> "Android"
    else -> "Computer"
}

/** A device's kind as an icon, labelled for screen readers ("Mac"). */
@Composable
fun PlatformIcon(platform: String?, size: Dp = 22.dp, tint: Color = MaterialTheme.colorScheme.onSurface) {
    Icon(platformIcon(platform), platformLabel(platform), Modifier.size(size), tint = tint)
}

/** The app mark: three overlapping hexagons (the launcher icon's, without its tile). */
@Composable
fun Mark(size: Dp = 28.dp, modifier: Modifier = Modifier) {
    Image(painterResource(R.drawable.ic_mark), null, modifier.size(size))
}

private class FileStyle(val label: String, val color: Color)

/** By the core's icon id (`iconFor()`), the same labels and colours as the desktop. */
private val FILE_STYLE = mapOf(
    "image" to FileStyle("IMG", Color(0xFF2F8F83)),
    "image-raw" to FileStyle("RAW", Color(0xFF2F8F83)),
    "image-vector" to FileStyle("SVG", Color(0xFF2F8F83)),
    "video" to FileStyle("VID", Color(0xFF7A4FD6)),
    "audio" to FileStyle("AUD", Color(0xFFD0518A)),
    "pdf" to FileStyle("PDF", Color(0xFFC8432F)),
    "ebook" to FileStyle("BOOK", Color(0xFFA0612B)),
    "word" to FileStyle("DOC", Color(0xFF2F5BEA)),
    "spreadsheet" to FileStyle("XLS", Color(0xFF1F8A4C)),
    "presentation" to FileStyle("PPT", Color(0xFFD36A1F)),
    "document" to FileStyle("DOC", Color(0xFF4F5D6B)),
    "archive" to FileStyle("ZIP", Color(0xFF8A6D1F)),
    "disk-image" to FileStyle("DISK", Color(0xFF5A6A7A)),
    "code" to FileStyle("CODE", Color(0xFF3A6F9A)),
    "code-web" to FileStyle("WEB", Color(0xFF3A6F9A)),
    "code-data" to FileStyle("DATA", Color(0xFF3A6F9A)),
    "code-shell" to FileStyle("SH", Color(0xFF3A6F9A)),
    "text" to FileStyle("TXT", Color(0xFF6B7682)),
    "markdown" to FileStyle("MD", Color(0xFF6B7682)),
    "table" to FileStyle("CSV", Color(0xFF1F8A4C)),
    "subtitles" to FileStyle("SUB", Color(0xFF7A4FD6)),
    "font" to FileStyle("FONT", Color(0xFF4F5D6B)),
    "executable" to FileStyle("APP", Color(0xFF4F5D6B)),
    "package" to FileStyle("PKG", Color(0xFF8A6D1F)),
    "database" to FileStyle("DB", Color(0xFF3A6F9A)),
    "calendar" to FileStyle("CAL", Color(0xFFC8432F)),
    "contact" to FileStyle("CARD", Color(0xFF2F5BEA)),
    "torrent" to FileStyle("TOR", Color(0xFF4F5D6B)),
    "certificate" to FileStyle("CERT", Color(0xFF8A6D1F)),
    "model-3d" to FileStyle("3D", Color(0xFF7A4FD6)),
    "file" to FileStyle("FILE", Color(0xFF6B7682)),
)

private val PAGE = PathParser().parsePathString("M8 3h14l7 7v21a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z").toPath()
private val FOLD = PathParser().parsePathString("M22 3v5a2 2 0 0 0 2 2h5").toPath()
private val FOLDER = PathParser().parsePathString("M4 9a2 2 0 0 1 2-2h8l3 3h13a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z").toPath()

/** A page with a coloured band and a short label ("PDF", "ZIP"), on the desktop's 36 px grid. */
@Composable
fun FileIcon(icon: String, size: Dp = 36.dp) {
    val s = FILE_STYLE[icon] ?: FILE_STYLE.getValue("file")
    val surface = MaterialTheme.colorScheme.surfaceContainerLowest
    val line = Brand.tones.line
    val measurer = rememberTextMeasurer()
    val style = remember(s.label) {
        TextStyle(
            color = Color.White,
            fontFamily = Atkinson,
            fontWeight = FontWeight.Bold,
            fontSize = (if (s.label.length > 3) 6.2f else 7.4f).sp,
        )
    }
    Canvas(Modifier.size(size)) {
        val k = this.size.width / 36f
        scale(k, k, pivot = Offset.Zero) {
            drawPath(PAGE, surface)
            drawPath(PAGE, line, style = Stroke(1.5f))
            drawPath(FOLD, line, style = Stroke(1.5f))
            drawRoundRect(s.color, Offset(4f, 18f), Size(24f, 10f), CornerRadius(2f))
        }
        // The label's size is in grid units: turn the scaled pixels back into sp for measuring.
        val text = measurer.measure(s.label, style.copy(fontSize = (style.fontSize.value * k).toSp()))
        drawText(
            text,
            topLeft = Offset(16f * k - text.size.width / 2f, 23f * k - text.size.height / 2f),
        )
    }
}

@Composable
fun FolderIcon(size: Dp = 36.dp) {
    val accent = MaterialTheme.colorScheme.primary
    val surface = MaterialTheme.colorScheme.surfaceContainerLowest
    val fill = lerp(surface, accent, 0.22f)
    val edge = accent.copy(alpha = 0.45f)
    Canvas(Modifier.size(size)) {
        val k = this.size.width / 36f
        scale(k, k, pivot = Offset.Zero) {
            drawPath(FOLDER, fill)
            drawPath(FOLDER, edge, style = Stroke(1.5f))
        }
    }
}

private fun lerp(a: Color, b: Color, t: Float) =
    Color(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t, 1f)

private val BY_EXT = mapOf(
    "jpg" to "image", "jpeg" to "image", "png" to "image", "gif" to "image", "webp" to "image", "heic" to "image",
    "mp4" to "video", "mkv" to "video", "mov" to "video", "avi" to "video", "webm" to "video",
    "mp3" to "audio", "flac" to "audio", "wav" to "audio", "m4a" to "audio", "ogg" to "audio",
    "pdf" to "pdf", "epub" to "ebook", "doc" to "word", "docx" to "word", "xls" to "spreadsheet",
    "xlsx" to "spreadsheet", "ppt" to "presentation", "pptx" to "presentation", "zip" to "archive",
    "rar" to "archive", "7z" to "archive", "iso" to "disk-image", "dmg" to "disk-image",
    "txt" to "text", "md" to "markdown", "csv" to "table",
)

/** An icon from a file name alone, for places that only know the name (transfers). */
fun iconForName(name: String): String = BY_EXT[name.substringAfterLast('.', "").lowercase()] ?: "file"

/**
 * A person's identity disc. Its colour comes from their account fingerprint (FNV-1a, as the
 * desktop's `hueOf`), so the same person looks the same on every hub, screen and client.
 */
fun hueOf(seed: String): Float {
    var h = -2128831035 // 2166136261 as a signed int
    for (c in seed) h = (h xor c.code) * 16777619
    return (h.toUInt() % 360u).toFloat()
}

@Composable
fun Disc(name: String, seed: String, size: Dp = 40.dp, online: Boolean? = null) {
    val hue = hueOf(seed)
    val initial = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
    Box(Modifier.size(size)) {
        Box(
            Modifier.size(size).clip(CircleShape).background(
                Brush.linearGradient(
                    listOf(Color.hsl(hue, 0.62f, 0.52f), Color.hsl((hue + 40) % 360, 0.58f, 0.40f)),
                ),
            ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                initial,
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = (size.value * 0.44f).sp,
                fontFamily = Atkinson,
            )
        }
        if (online == true) {
            val dot = size * 0.3f
            Box(
                Modifier.size(dot).align(Alignment.BottomEnd).offset(1.dp, 1.dp)
                    .clip(CircleShape)
                    .border(2.dp, MaterialTheme.colorScheme.background, CircleShape)
                    .background(Brand.tones.online)
                    .semantics { contentDescription = "Online" },
            )
        }
    }
}

/** Shown after the name of someone this user verified by comparing safety codes. */
@Composable
fun VerifiedMark(on: Boolean, size: Dp = 15.dp) {
    if (on) Icon(Glyphs.Shield, "Verified", Modifier.size(size), tint = Brand.tones.online)
}
