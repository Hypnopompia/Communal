package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.RemoteTransfer
import io.github.hypnopompia.communal.plural
import io.github.hypnopompia.communal.Subscription
import io.github.hypnopompia.communal.Transfer
import kotlinx.coroutines.delay

/** Downloads on this phone and folders kept in sync, or a computer's downloads (remote). */
@Composable
fun TransfersScreen(model: AppModel) {
    val remotes by model.remotes.collectAsStateWithLifecycle()
    val usable = remotes.filter { it.device.online && it.allowed == true }
    var view by rememberSaveable { mutableStateOf<String?>(null) } // null: this phone
    Column(Modifier.fillMaxSize()) {
        if (usable.isNotEmpty()) {
            val options = listOf<Pair<String?, String>>(null to "This phone") + usable.map { it.device.device_id to it.device.name }
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(16.dp, 16.dp, 16.dp, 0.dp)) {
                options.forEachIndexed { i, (id, label) ->
                    SegmentedButton(view == id, { view = id }, SegmentedButtonDefaults.itemShape(i, options.size)) {
                        Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        val v = view
        if (v == null || usable.none { it.device.device_id == v }) PhoneTransfers(model)
        else RemoteTransfers(model, v)
    }
}

@Composable
private fun PhoneTransfers(model: AppModel) {
    val transfers by model.transfers.collectAsStateWithLifecycle()
    val subs by model.subscriptions.collectAsStateWithLifecycle()
    val context = LocalContext.current
    if (transfers.isEmpty() && subs.isEmpty()) {
        Hint("Nothing yet. Files you download, and folders you keep in sync, show up here.")
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        if (subs.isNotEmpty()) {
            item { Section("Kept in sync") }
            items(subs, key = { it.id }) { s -> SubscriptionRow(model, s) }
        }
        if (transfers.isNotEmpty()) {
            item {
                Row(Modifier.fillMaxWidth().padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Section("Downloads", Modifier.weight(1f))
                    if (transfers.any { it.state == "done" || it.state == "failed" || it.state == "cancelled" })
                        TextButton({ model.act(null) { model.api.clearFinished() } }) { Text("Clear finished") }
                }
            }
            items(transfers, key = { it.id }) { t ->
                TransferRow(
                    name = t.name,
                    state = t.state,
                    size = t.size,
                    done = t.bytes_done,
                    detail = t.diagnosis?.message ?: t.error,
                    onCancel = { model.act(null) { model.api.cancel(t.id) } },
                    onOpen = t.final_path?.takeIf { t.state == "done" }?.let { p -> { openFile(context, p) } },
                )
            }
        }
    }
}

@Composable
private fun SubscriptionRow(model: AppModel, s: Subscription) {
    val f = s.files
    ListItem(
        headlineContent = { Text(s.path.trimEnd('/').substringAfterLast('/')) },
        supportingContent = {
            Text(
                when {
                    s.status == "no_access" -> "Not shared with you any more, or gone"
                    s.paused -> "Paused"
                    f.pending > 0 -> "${f.done} here, ${f.pending} to go" + if (f.failed > 0) ", ${f.failed} failed" else ""
                    else -> "${plural(f.done, "file")} here" + if (f.failed > 0) ", ${f.failed} failed" else ""
                },
            )
        },
        leadingContent = { Icon(Icons.Default.Sync, null) },
        trailingContent = {
            Row {
                IconButton({ model.act(null) { model.api.setPaused(s.id, !s.paused) } }) {
                    Icon(if (s.paused) Icons.Default.PlayArrow else Icons.Default.Pause, if (s.paused) "Resume" else "Pause")
                }
                IconButton({ model.act("Stopped keeping it in sync. The files stay.") { model.api.unsubscribe(s.id) } }) {
                    Icon(Icons.Default.Close, "Stop keeping in sync")
                }
            }
        },
    )
}

/** A computer's downloads, asked for every few seconds while this is on screen (ADR 0023). */
@Composable
private fun RemoteTransfers(model: AppModel, device: String) {
    var list by remember(device) { mutableStateOf<List<RemoteTransfer>?>(null) }
    var error by remember(device) { mutableStateOf<String?>(null) }
    LaunchedEffect(device) {
        while (true) {
            runCatching { model.api.remoteTransfers(device) }
                .onSuccess { list = it; error = null }
                .onFailure { error = it.message }
            delay(if (list.orEmpty().any { it.state == "active" }) 3_000 else 10_000)
        }
    }
    val l = list
    when {
        error != null && l == null -> Hint(error!!)
        l == null -> LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 16.dp))
        l.isEmpty() -> Hint("No downloads on that computer.")
        else -> LazyColumn(Modifier.fillMaxSize()) {
            items(l, key = { it.id }) { t ->
                TransferRow(
                    name = t.name,
                    state = t.state,
                    size = t.size,
                    done = t.bytes_done,
                    detail = t.error ?: t.requested_by?.let { "Started from $it" },
                    onCancel = { model.act(null) { model.api.remoteCancel(device, t.id) } },
                    onOpen = null,
                )
            }
        }
    }
}

@Composable
private fun TransferRow(
    name: String,
    state: String,
    size: Long?,
    done: Long,
    detail: String?,
    onCancel: () -> Unit,
    onOpen: (() -> Unit)?,
) {
    val total = size ?: 0
    ListItem(
        headlineContent = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    when (state) {
                        "active" -> if (total > 0) "${size(done)} of ${size(total)}" else "Starting…"
                        "queued" -> "Waiting its turn"
                        "waiting" -> detail ?: "Waiting for a source to come online"
                        "done" -> listOfNotNull(size?.let { size(it) }, detail?.takeIf { it.startsWith("Started") }).joinToString(" · ").ifEmpty { "Done" }
                        "failed" -> detail ?: "Failed"
                        else -> "Cancelled"
                    },
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (state == "active" && total > 0) LinearProgressIndicator({ (done.toFloat() / total).coerceIn(0f, 1f) }, Modifier.fillMaxWidth())
            }
        },
        trailingContent = {
            if (state == "active" || state == "queued" || state == "waiting")
                IconButton(onCancel) { Icon(Icons.Default.Close, "Cancel") }
        },
        modifier = if (onOpen != null) Modifier.clickableRow(onOpen) else Modifier,
    )
}

@Composable
private fun Section(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp),
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
}
