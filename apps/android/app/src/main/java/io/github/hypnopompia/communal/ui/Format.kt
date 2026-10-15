package io.github.hypnopompia.communal.ui

import io.github.hypnopompia.communal.Hub
import io.github.hypnopompia.communal.Meta
import java.net.URI
import java.text.DateFormat
import java.util.Date
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

fun rate(bytesPerSecond: Double) = size(bytesPerSecond.toLong()) + "/s"

/** "just now", "5 min ago", "3 h ago", "2 days ago", else the date, as the desktop's `ago()`. */
fun ago(unixSeconds: Long): String {
    val d = System.currentTimeMillis() / 1000 - unixSeconds
    return when {
        d < 60 -> "just now"
        d < 3600 -> "${d / 60} min ago"
        d < 86400 -> "${d / 3600} h ago"
        d < 7 * 86400 -> "${d / 86400} days ago"
        else -> DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(unixSeconds * 1000))
    }
}

/**
 * "Maya’s iMac" from an owner and a device name, without doubling the owner when the device
 * name already starts with their name or first name, as the desktop's `computerName()`.
 */
fun computerName(owner: String, device: String): String {
    val d = device.trim().lowercase()
    val names = listOf(owner.trim(), owner.trim().split(Regex("\\s+")).first()).map { it.lowercase() }
    val named = names.any { n -> n.isNotEmpty() && d.startsWith(n) && d.getOrNull(n.length)?.isLetter() != true }
    return if (named) device else "$owner’s $device"
}

/** "4032×3024, 3:42, Artist, 4.2 MB", as the desktop's `describe()`. */
fun describe(meta: Meta, bytes: Long): String = listOfNotNull(
    if (meta.width != null && meta.height != null) "${meta.width}×${meta.height}" else null,
    meta.duration?.let { duration(it) },
    meta.pages?.let { "$it pages" },
    meta.artist,
    size(bytes),
).joinToString(", ")

/** Turns what a person types ("hub.example.com") into the hub's WebSocket URL, as the desktop's `hubUrl()`. */
fun hubUrl(input: String): String {
    var s = input.trim()
    if (!Regex("^wss?://", RegexOption.IGNORE_CASE).containsMatchIn(s)) s = "wss://" + s.replace(Regex("^https?://", RegexOption.IGNORE_CASE), "")
    val u = URI(s)
    return if (u.path.isNullOrEmpty() || u.path == "/") URI(u.scheme, u.userInfo, u.host, u.port, "/v1", u.query, u.fragment).toString() else s
}
