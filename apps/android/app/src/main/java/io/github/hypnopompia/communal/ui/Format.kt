package io.github.hypnopompia.communal.ui

import io.github.hypnopompia.communal.Hub
import io.github.hypnopompia.communal.Meta
import java.net.URI
import kotlin.math.roundToInt

/** Same rules as the desktop's format.ts. */
fun size(bytes: Long): String {
    if (bytes < 1000) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var v = bytes.toDouble()
    var u = -1
    do {
        v /= 1000
        u++
    } while (v >= 1000 && u < units.size - 1)
    return (if (v < 10) "%.1f".format(v) else v.roundToInt().toString()) + " " + units[u]
}

fun duration(seconds: Double): String {
    val s = seconds.roundToInt()
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = (s % 60).toString().padStart(2, '0')
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:$sec" else "$m:$sec"
}

/** Same wording as `seenLabel()` in core (ADR 0015). */
fun seenLabel(seen: String) = when (seen) {
    "now" -> "Online"
    "today" -> "Offline, seen today"
    "week" -> "Offline, seen this week"
    "month" -> "Offline, seen this month"
    else -> "Offline for over a month"
}

fun hubName(hub: Hub): String = hub.name ?: runCatching { URI(hub.url).host }.getOrNull() ?: hub.url

/** "Artist · Album · 3:42" for music, "4032 × 3024" for pictures, and so on. */
fun metaLine(meta: Meta, sizeBytes: Long): String = listOfNotNull(
    meta.artist,
    meta.album,
    meta.duration?.let { duration(it) },
    if (meta.width != null && meta.height != null) "${meta.width} × ${meta.height}" else null,
    meta.pages?.let { "$it pages" },
    size(sizeBytes),
).joinToString(" · ")
