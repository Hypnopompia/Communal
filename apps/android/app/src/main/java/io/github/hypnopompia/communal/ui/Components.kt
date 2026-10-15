package io.github.hypnopompia.communal.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.MediaScannerConnection
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.Api
import io.github.hypnopompia.communal.Meta
import java.io.File

private val thumbs = LruCache<String, ImageBitmap>(300)

/** The built-in destination every computer has, unless it keeps it from other devices. */
private const val DOWNLOADS = "Downloads"

/**
 * A file's thumbnail once it's in the core's cache (screens fetch thumbnails in batches first),
 * else its icon, as the desktop's `FileArt`. `fill` takes the whole of a grid tile.
 */
@Composable
fun Thumb(api: Api, hash: String?, icon: String, hasThumb: Boolean, ready: Int, size: Dp = 44.dp, fill: Boolean = false) {
    val b = rememberThumb(api, hash, hasThumb, ready)
    Box(
        (if (fill) Modifier.fillMaxSize() else Modifier.size(size))
            .clip(RoundedCornerShape(8.dp))
            .background(if (b != null) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent),
        contentAlignment = Alignment.Center,
    ) {
        if (b != null) Image(b, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else FileIcon(icon, if (fill) 56.dp else size * 0.86f)
    }
}

@Composable
private fun rememberThumb(api: Api, hash: String?, hasThumb: Boolean, ready: Int): ImageBitmap? {
    val bitmap by produceState(hash?.let { thumbs.get(it) }, hash, hasThumb, ready) {
        if (hash == null || !hasThumb || value != null) return@produceState
        val bytes = runCatching { api.thumb(hash) }.getOrNull() ?: return@produceState
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() ?: return@produceState
        thumbs.put(hash, bmp)
        value = bmp
    }
    return bitmap
}

/** What an action sheet acts on: one file, or a folder on someone's device. */
sealed interface Target {
    val title: String

    data class File(
        val hash: String,
        val name: String,
        val size: Long? = null,
        val icon: String = iconForName(name),
        val thumb: Boolean = false,
        val meta: Meta = Meta(),
        /** Who has it: "From Maya and Sam". */
        val from: String? = null,
        /** The folder it's in on its best source, for "Show folder" (search results). */
        val folder: Place? = null,
    ) : Target {
        override val title: String get() = meta.title ?: name
    }

    /** `hubId` is this phone's id for the hub; computers name hubs by URL. */
    data class Folder(val hubId: String, val hubUrl: String, val device: String, val path: String) : Target {
        override val title: String get() = path.trimEnd('/').substringAfterLast('/')
    }
}

/**
 * Where should this go? This phone, or one of your computers (remote control, ADR 0023). For a
 * folder: download it once, or keep it in sync.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActionSheet(model: AppModel, target: Target, onClose: () -> Unit, onShowFolder: ((Place) -> Unit)? = null) {
    val remotes by model.remotes.collectAsStateWithLifecycle()
    var following by remember { mutableStateOf<String?>(null) } // "phone" or a device id
    // A computer action waiting for the person to pick one of its destinations (ADR 0018).
    var choosing by remember { mutableStateOf<Pair<Remote, (String?) -> Unit>?>(null) }
    /** Runs `act` on that computer, asking which destination first when it has several. */
    fun onComputer(r: Remote, act: (String?) -> Unit) {
        when {
            r.destinations.size > 1 -> choosing = r to act
            // Its one destination; no name at all means its downloads folder.
            else -> act(r.destinations.singleOrNull()?.takeIf { it != DOWNLOADS })
        }
    }
    ModalBottomSheet(onDismissRequest = onClose, containerColor = MaterialTheme.colorScheme.surfaceContainerLowest) {
        // With several computers the options outgrow the screen: scroll, and keep the last one
        // clear of the navigation bar.
        Column(
            Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp),
        ) {
            SheetHeader(model, target)
            Option(Glyphs.Phone, "Download to this phone", "Saved in Download/Communal", primary = true) {
                onClose()
                when (target) {
                    is Target.File -> model.act("Downloading ${target.name}") { model.api.download(target.hash, target.name) }
                    is Target.Folder -> model.act("Downloading ${target.title}") {
                        model.api.downloadFolder(target.hubId, target.device, target.path)
                    }
                }
            }
            if (target is Target.Folder) {
                Option(Glyphs.Sync, "Keep in sync on this phone", "New files arrive here automatically") {
                    following = "phone"
                }
            }
            val folder = (target as? Target.File)?.folder
            if (folder != null && onShowFolder != null) {
                Option(Glyphs.Folder, "Show the folder it’s in", "On ${folder.name}") {
                    onClose()
                    onShowFolder(folder)
                }
            }
            if (remotes.isNotEmpty()) {
                Text(
                    "On your computers",
                    Modifier.padding(start = 24.dp, top = 16.dp, bottom = 4.dp),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            for (r in remotes) {
                val d = r.device
                val why = when {
                    !d.online -> "Offline"
                    r.allowed == false -> "Turn on “Let my other devices start downloads” in its Settings › Downloads (communal remote allow on a server)"
                    r.allowed == null -> "Checking…"
                    else -> "Saved in its downloads folder"
                }
                val usable = d.online && r.allowed == true
                // One row per destination it names (ADR 0018), its downloads folder first.
                // A computer can keep the downloads folder to itself (only Movies and TV, say).
                val dests: List<String?> =
                    if (usable && r.destinations.any { it != DOWNLOADS }) r.destinations else listOf(null)
                for (label in dests) {
                    val dest = label?.takeIf { it != DOWNLOADS }
                    Option(
                        platformIcon(d.platform),
                        if (label == null) "Download to ${d.name}" else "Download to ${d.name}: $label",
                        if (usable && label != null) (if (label == DOWNLOADS) "Its downloads folder" else "Its $label folder") else why,
                        enabled = usable,
                    ) {
                        onClose()
                        val into = dest?.let { " into $it" }.orEmpty()
                        when (target) {
                            is Target.File -> model.act("${d.name} is downloading ${target.name}$into") {
                                model.api.remoteDownload(d.device_id, target.hash, target.name, dest)
                            }
                            is Target.Folder -> model.act("${d.name} is downloading ${target.title}$into") {
                                model.api.remoteDownloadFolder(d.device_id, target.hubUrl, target.device, target.path, dest)
                            }
                        }
                    }
                }
                if (target is Target.Folder) {
                    val syncWhy = when {
                        !usable -> why
                        r.destinations.size > 1 -> "Choose: ${r.destinations.joinToString(", ")}"
                        r.destinations.singleOrNull()?.let { it != DOWNLOADS } == true -> "Into its ${r.destinations.single()} folder"
                        else -> why
                    }
                    Option(Glyphs.Sync, "Keep in sync on ${d.name}", syncWhy, enabled = usable) {
                        following = d.device_id
                    }
                }
            }
        }
    }
    val f = following
    if (f != null && target is Target.Folder) {
        FollowDialog(
            where = if (f == "phone") "this phone" else remotes.firstOrNull { it.device.device_id == f }?.device?.name ?: "that computer",
            onCancel = { following = null },
        ) { mirror ->
            following = null
            if (f == "phone") {
                onClose()
                model.act("Keeping ${target.title} in sync") {
                    model.api.subscribe(target.hubId, target.device, target.path, mirror)
                }
            } else {
                val r = remotes.firstOrNull { it.device.device_id == f }
                val go: (String?) -> Unit = { dest ->
                    onClose()
                    model.act("Keeping ${target.title} in sync on the computer" + (dest?.let { " in $it" } ?: "")) {
                        model.api.remoteSubscribe(f, target.hubUrl, target.device, target.path, mirror, dest)
                    }
                }
                if (r != null) onComputer(r, go) else go(null)
            }
        }
    }
    choosing?.let { (r, act) ->
        AlertDialog(
            onDismissRequest = { choosing = null },
            title = { Text("Where on ${r.device.name}?") },
            text = {
                Column {
                    r.destinations.forEach { dest ->
                        Item(
                            dest,
                            sub = if (dest == DOWNLOADS) "Its downloads folder" else null,
                            leading = { FolderIcon(32.dp) },
                            onClick = {
                                choosing = null
                                act(dest.takeIf { it != DOWNLOADS })
                            },
                        )
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton({ choosing = null }) { Text("Cancel") } },
        )
    }
}

/** Asked when following a folder (HANDOFF §5): should files deleted there be deleted here? */
@Composable
private fun FollowDialog(where: String, onCancel: () -> Unit, onOk: (mirrorDeletes: Boolean) -> Unit) {
    var mirror by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onCancel,
        icon = { Icon(Glyphs.Sync, null) },
        title = { Text("Keep in sync on $where") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("New and changed files in this folder will be downloaded to $where whenever both are online.")
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("Also remove deleted files", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "They go to the trash, never straight away",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(mirror, { mirror = it })
                }
            }
        },
        confirmButton = { TextButton({ onOk(mirror) }) { Text("Keep in sync") } },
        dismissButton = { TextButton(onCancel) { Text("Cancel") } },
    )
}

@Composable
private fun Option(icon: ImageVector, title: String, sub: String, enabled: Boolean = true, primary: Boolean = false, onClick: () -> Unit) {
    Item(
        title,
        Modifier.padding(horizontal = 8.dp),
        sub = sub,
        // A greyed-out computer explains how to turn it on: let that read in full.
        subLines = 4,
        enabled = enabled,
        onClick = onClick,
        leading = {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(
                    if (primary && enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    icon, null, Modifier.size(22.dp),
                    tint = when {
                        !enabled -> Brand.tones.faint
                        primary -> MaterialTheme.colorScheme.onPrimary
                        else -> MaterialTheme.colorScheme.onSurface
                    },
                )
            }
        },
    )
}

/** What the sheet is about: a picture's preview, else its icon, with what it is and who has it. */
@Composable
private fun SheetHeader(model: AppModel, target: Target) {
    when (target) {
        is Target.File -> {
            val big = rememberThumb(model.api, target.hash, target.thumb, 0)
            Column(
                Modifier.padding(horizontal = 24.dp).padding(bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                if (big != null) {
                    Image(
                        big, null,
                        Modifier.fillMaxWidth().heightIn(max = 280.dp)
                            .aspectRatio(big.width.toFloat() / big.height.coerceAtLeast(1))
                            .clip(RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant),
                        contentScale = ContentScale.Fit,
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    if (big == null) FileIcon(target.icon, 48.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(target.title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        listOfNotNull(target.meta.album, target.size?.let { describe(target.meta, it) }, target.from).forEach {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        is Target.Folder -> Row(
            Modifier.padding(horizontal = 24.dp).padding(bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            FolderIcon(48.dp)
            Column {
                Text(target.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("Folder", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** Opens a downloaded file in whatever app handles it (through the media library). */
fun openFile(context: Context, path: String) {
    val main = Handler(Looper.getMainLooper())
    if (!File(path).exists()) {
        Toast.makeText(context, "That file isn’t there any more", Toast.LENGTH_SHORT).show()
        return
    }
    MediaScannerConnection.scanFile(context, arrayOf(path), null) { _, uri ->
        main.post {
            if (uri == null) {
                Toast.makeText(context, "Android can’t open that file", Toast.LENGTH_SHORT).show()
                return@post
            }
            val mime = context.contentResolver.getType(uri)
            try {
                context.startActivity(
                    Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(context, "No app on this phone opens that kind of file", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
