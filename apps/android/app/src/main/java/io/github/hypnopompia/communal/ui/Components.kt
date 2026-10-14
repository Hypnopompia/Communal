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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.Api
import java.io.File

private val thumbs = LruCache<String, ImageBitmap>(300)

fun kindIcon(kind: String): ImageVector = when (kind) {
    "image" -> Icons.Default.Image
    "video" -> Icons.Default.Movie
    "audio" -> Icons.Default.Audiotrack
    "document", "text" -> Icons.Default.Description
    "archive", "disk_image" -> Icons.Default.Archive
    "code" -> Icons.Default.Code
    else -> Icons.AutoMirrored.Filled.InsertDriveFile
}

/**
 * A file's thumbnail once it's in the core's cache (screens fetch thumbnails in batches first),
 * else its kind's icon.
 */
@Composable
fun Thumb(api: Api, hash: String?, kind: String, hasThumb: Boolean, ready: Int, size: Dp = 44.dp) {
    val bitmap by produceState(hash?.let { thumbs.get(it) }, hash, hasThumb, ready) {
        if (hash == null || !hasThumb || value != null) return@produceState
        val bytes = runCatching { api.thumb(hash) }.getOrNull() ?: return@produceState
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() ?: return@produceState
        thumbs.put(hash, bmp)
        value = bmp
    }
    Box(
        Modifier.size(size).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        val b = bitmap
        if (b != null) Image(b, null, Modifier.size(size), contentScale = ContentScale.Crop)
        else Icon(kindIcon(kind), null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun FolderIcon(size: Dp = 44.dp) {
    Box(
        Modifier.size(size).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center,
    ) { Icon(Icons.Default.Folder, null, tint = MaterialTheme.colorScheme.primary) }
}

/** What an action sheet acts on: one file, or a folder on someone's device. */
sealed interface Target {
    val title: String

    data class File(val hash: String, val name: String, override val title: String = name) : Target

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
fun ActionSheet(model: AppModel, target: Target, onClose: () -> Unit) {
    val remotes by model.remotes.collectAsStateWithLifecycle()
    var following by remember { mutableStateOf<String?>(null) } // "phone" or a device id
    ModalBottomSheet(onDismissRequest = onClose) {
        Column(Modifier.padding(bottom = 24.dp)) {
            Text(
                target.title,
                Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Option(Icons.Default.PhoneAndroid, "Download to this phone", "Saved in Download/Communal") {
                onClose()
                when (target) {
                    is Target.File -> model.act("Downloading ${target.name}") { model.api.download(target.hash, target.name) }
                    is Target.Folder -> model.act("Downloading ${target.title}") {
                        model.api.downloadFolder(target.hubId, target.device, target.path)
                    }
                }
            }
            if (target is Target.Folder) {
                Option(Icons.Default.Sync, "Keep in sync on this phone", "New files arrive here automatically") {
                    following = "phone"
                }
            }
            if (remotes.isNotEmpty()) HorizontalDivider(Modifier.padding(vertical = 8.dp))
            for (r in remotes) {
                val d = r.device
                val why = when {
                    !d.online -> "Offline"
                    r.allowed == false -> "Turn on “Let my other devices start downloads” in its Settings › Downloads (communal remote allow on a server)"
                    r.allowed == null -> "Checking…"
                    else -> "Saved in its downloads folder"
                }
                val usable = d.online && r.allowed == true
                Option(Icons.Default.Computer, "Download to ${d.name}", why, enabled = usable) {
                    onClose()
                    when (target) {
                        is Target.File -> model.act("${d.name} is downloading ${target.name}") {
                            model.api.remoteDownload(d.device_id, target.hash, target.name)
                        }
                        is Target.Folder -> model.act("${d.name} is downloading ${target.title}") {
                            model.api.remoteDownloadFolder(d.device_id, target.hubUrl, target.device, target.path)
                        }
                    }
                }
                if (target is Target.Folder) {
                    Option(Icons.Default.Sync, "Keep in sync on ${d.name}", why, enabled = usable) {
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
            onClose()
            if (f == "phone") {
                model.act("Keeping ${target.title} in sync") {
                    model.api.subscribe(target.hubId, target.device, target.path, mirror)
                }
            } else {
                model.act("Keeping ${target.title} in sync on the computer") {
                    model.api.remoteSubscribe(f, target.hubUrl, target.device, target.path, mirror)
                }
            }
        }
    }
}

/** Asked when following a folder (HANDOFF §5): should files deleted there be deleted here? */
@Composable
private fun FollowDialog(where: String, onCancel: () -> Unit, onOk: (mirrorDeletes: Boolean) -> Unit) {
    var mirror by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("Keep in sync on $where") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("New and changed files in this folder will be downloaded to $where whenever both are online.")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(mirror, { mirror = it })
                    Text("Also remove files that are deleted there (they go to the trash, never straight away)")
                }
            }
        },
        confirmButton = { TextButton({ onOk(mirror) }) { Text("Keep in sync") } },
        dismissButton = { TextButton(onCancel) { Text("Cancel") } },
    )
}

@Composable
private fun Option(icon: ImageVector, title: String, sub: String, enabled: Boolean = true, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title, color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline) },
        supportingContent = { Text(sub) },
        leadingContent = { Icon(icon, null) },
        modifier = Modifier.fillMaxWidth().let { if (enabled) it.clickableRow(onClick) else it },
    )
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
