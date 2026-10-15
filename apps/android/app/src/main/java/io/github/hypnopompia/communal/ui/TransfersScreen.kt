package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.FileCounts
import io.github.hypnopompia.communal.RemoteSubscription
import io.github.hypnopompia.communal.RemoteTransfer
import io.github.hypnopompia.communal.Subscription
import io.github.hypnopompia.communal.Transfer
import io.github.hypnopompia.communal.plural
import kotlinx.coroutines.delay

private val ACTIVE = setOf("active", "queued", "waiting")

/** Downloads on this phone and folders kept in sync, or a computer's (remote control). */
@Composable
fun TransfersScreen(model: AppModel) {
    val remotes by model.remotes.collectAsStateWithLifecycle()
    val usable = remotes.filter { it.device.online && it.allowed == true }
    var view by rememberSaveable { mutableStateOf<String?>(null) } // null: this phone
    Column(Modifier.fillMaxSize()) {
        Text(
            "Downloads come straight from the computers that have the file.",
            Modifier.padding(horizontal = 20.dp).padding(bottom = 4.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (usable.isNotEmpty()) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val options = listOf(Triple<String?, String, String>(null, "This phone", "android")) +
                    usable.map { Triple(it.device.device_id, it.device.name, it.device.platform) }
                for ((id, label, platform) in options) {
                    val on = view == id
                    FilterChip(
                        on, { view = id }, { Text(label) },
                        leadingIcon = { Icon(platformIcon(platform), null, Modifier.size(16.dp)) },
                        colors = FilterChipDefaults.filterChipColors(
                            containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                            selectedContainerColor = MaterialTheme.colorScheme.primary,
                            selectedLabelColor = MaterialTheme.colorScheme.onPrimary,
                            selectedLeadingIconColor = MaterialTheme.colorScheme.onPrimary,
                        ),
                        border = FilterChipDefaults.filterChipBorder(true, on, borderColor = Brand.tones.line),
                    )
                }
            }
        }
        val v = view
        if (v == null || usable.none { it.device.device_id == v }) PhoneTransfers(model)
        else RemoteTransfers(model, v)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PhoneTransfers(model: AppModel) {
    val transfers by model.transfers.collectAsStateWithLifecycle()
    val subs by model.subscriptions.collectAsStateWithLifecycle()
    val library by model.library.collectAsStateWithLifecycle()
    val connections by model.connections.collectAsStateWithLifecycle()
    val refreshing by model.refreshing.collectAsStateWithLifecycle()
    val names = remember(connections, library) { Names(connections, library) }
    val context = LocalContext.current
    val running = transfers.filter { it.state in ACTIVE }
    val finished = transfers.filter { it.state !in ACTIVE }.sortedByDescending { it.updated_at }
    PullToRefreshBox(refreshing, { model.refreshAll() }, Modifier.fillMaxSize()) {
        if (transfers.isEmpty() && subs.isEmpty()) {
            EmptyState(
                "No downloads yet",
                "Find something in Search or the Library and download it. Folders you keep in sync show up here too.",
                icon = Glyphs.Transfers,
            )
            return@PullToRefreshBox
        }
        LazyColumn(Modifier.fillMaxSize()) {
            if (running.isNotEmpty()) {
                item { SectionTitle("Downloading") }
                item {
                    PanelRows(running) { t ->
                        TransferRow(
                            name = t.name, state = t.state, size = t.size, done = t.bytes_done,
                            speed = t.sources.sumOf { it.rate },
                            detail = if (t.state == "queued" && t.error != null) "Waiting its turn: the computer that has it is sending other files."
                            else t.diagnosis?.message ?: t.error,
                            sources = t.sources.filter { it.rate > 0 || t.state == "active" }.map { s ->
                                val d = names.device(s.device_id)
                                Triple(d?.platform, d?.let { computerName(it.user.display_name, it.device_name) } ?: "A computer", s.rate)
                            },
                            tips = t.diagnosis?.takeIf { t.state == "waiting" || t.state == "failed" }?.let { it.fix to it.tips },
                            onCancel = { model.act(null) { model.api.cancel(t.id) } },
                        )
                    }
                }
            }
            if (subs.isNotEmpty()) {
                item { SectionTitle("Kept in sync") }
                item { PanelRows(subs) { s -> SubscriptionRow(model, s) } }
            }
            if (finished.isNotEmpty()) {
                item {
                    SectionTitle("Finished") {
                        TextButton({ model.act(null) { model.api.clearFinished() } }) { Text("Clear") }
                    }
                }
                item {
                    PanelRows(finished.take(100)) { t ->
                        TransferRow(
                            name = t.name, state = t.state, size = t.size, done = t.bytes_done,
                            detail = (if (t.state == "failed") t.diagnosis?.message ?: t.error else null),
                            requestedBy = t.requested_by,
                            finishedAt = t.updated_at,
                            tips = t.diagnosis?.takeIf { t.state == "failed" }?.let { it.fix to it.tips },
                            onOpen = t.final_path?.takeIf { t.state == "done" }?.let { p -> { openFile(context, p) } },
                        )
                    }
                }
            }
            item { Box(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun SubscriptionRow(model: AppModel, s: Subscription) = SubscriptionItem(
    path = s.path,
    files = s.files,
    paused = s.paused,
    noAccess = s.status == "no_access",
    where = null,
    onPause = { model.act(null) { model.api.setPaused(s.id, !s.paused) } },
    onStop = { model.act("Stopped keeping it in sync. The files stay.") { model.api.unsubscribe(s.id) } },
)

/** A folder kept in sync, on this phone or a computer (`where`: its destination there). */
@Composable
private fun SubscriptionItem(
    path: String,
    files: FileCounts,
    paused: Boolean,
    noAccess: Boolean,
    where: String?,
    onPause: () -> Unit,
    onStop: () -> Unit,
) {
    val f = files
    Item(
        path.trimEnd('/').substringAfterLast('/'),
        leading = { FolderIcon(36.dp) },
        sub = when {
            noAccess -> "Not shared any more, or gone"
            paused -> "Paused"
            f.pending > 0 -> "${f.done} here, ${f.pending} to go" + if (f.failed > 0) ", ${f.failed} failed" else ""
            else -> "${plural(f.done, "file")} here" + if (f.failed > 0) ", ${f.failed} failed" else ""
        } + (where?.let { " · in $it" } ?: ""),
        subColor = if (noAccess) Brand.tones.warn else MaterialTheme.colorScheme.onSurfaceVariant,
        trailing = {
            IconButton(onPause) { Icon(if (paused) Glyphs.Play else Glyphs.Pause, if (paused) "Resume" else "Pause") }
            IconButton(onStop) { Icon(Glyphs.Close, "Stop keeping in sync") }
        },
    )
}

/**
 * A computer's folders kept in sync and its downloads, asked for every few seconds while this
 * is on screen (ADR 0023).
 */
@Composable
private fun RemoteTransfers(model: AppModel, device: String) {
    var list by remember(device) { mutableStateOf<List<RemoteTransfer>?>(null) }
    var subs by remember(device) { mutableStateOf<List<RemoteSubscription>>(emptyList()) }
    var error by remember(device) { mutableStateOf<String?>(null) }
    var refresh by remember(device) { mutableIntStateOf(0) }
    LaunchedEffect(device, refresh) {
        while (true) {
            runCatching { model.api.remoteTransfers(device) }
                .onSuccess { list = it; error = null }
                .onFailure { error = it.message }
            // An older computer doesn't answer this one: it just shows none.
            runCatching { model.api.remoteSubscriptions(device) }.onSuccess { subs = it }
            delay(if (list.orEmpty().any { it.state == "active" }) 3_000 else 10_000)
        }
    }
    val l = list
    when {
        error != null && l == null -> EmptyState("That computer didn’t answer", error, icon = Glyphs.Device)
        l == null -> LinearProgressIndicator(Modifier.fillMaxWidth().padding(16.dp))
        l.isEmpty() && subs.isEmpty() -> EmptyState("No downloads on that computer", icon = Glyphs.Transfers)
        else -> LazyColumn(Modifier.fillMaxSize()) {
            val running = l.filter { it.state in ACTIVE }
            val finished = l.filter { it.state !in ACTIVE }
            if (running.isNotEmpty()) {
                item { SectionTitle("Downloading") }
                item { PanelRows(running) { t -> RemoteRow(model, device, t) } }
            }
            if (subs.isNotEmpty()) {
                item { SectionTitle("Kept in sync") }
                item {
                    PanelRows(subs) { s ->
                        SubscriptionItem(
                            path = s.path,
                            files = s.files,
                            paused = s.paused,
                            noAccess = s.status == "no_access",
                            where = s.destination?.let { "$it › ${s.folder}" } ?: s.folder,
                            onPause = {
                                model.act(null) { model.api.remoteSetPaused(device, s.id, !s.paused); refresh++ }
                            },
                            onStop = {
                                model.act("Stopped keeping it in sync there. The files stay.") {
                                    model.api.remoteUnsubscribe(device, s.id); refresh++
                                }
                            },
                        )
                    }
                }
            }
            if (finished.isNotEmpty()) {
                item { SectionTitle("Finished") }
                item { PanelRows(finished) { t -> RemoteRow(model, device, t) } }
            }
            item { Box(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun RemoteRow(model: AppModel, device: String, t: RemoteTransfer) = TransferRow(
    name = t.name,
    state = t.state,
    size = t.size,
    done = t.bytes_done,
    detail = t.error,
    requestedBy = t.requested_by,
    finishedAt = t.updated_at.takeIf { t.state == "done" },
    onCancel = if (t.state in ACTIVE) ({ model.act(null) { model.api.remoteCancel(device, t.id) } }) else null,
)

@Composable
private fun TransferRow(
    name: String,
    state: String,
    size: Long?,
    done: Long,
    detail: String?,
    speed: Double = 0.0,
    requestedBy: String? = null,
    finishedAt: Long? = null,
    sources: List<Triple<String?, String, Double>> = emptyList(),
    tips: Pair<String?, List<String>>? = null,
    onCancel: (() -> Unit)? = null,
    onOpen: (() -> Unit)? = null,
) {
    val total = size ?: 0
    val sub = when (state) {
        "queued" -> detail ?: "Starting…"
        "active" -> if (total > 0) "${size(done)} of ${size(total)}" + (if (speed > 0) ", ${rate(speed)}" else "") else "Getting the file’s details…"
        "waiting" -> detail ?: "Waiting for a computer that has it to come online."
        "done" -> listOfNotNull(finishedAt?.let { "Downloaded ${ago(it)}" } ?: "Downloaded", size?.let { size(it) }).joinToString(", ")
        "failed" -> detail ?: "Failed"
        else -> "Cancelled"
    } + (requestedBy?.let { " · Started from $it" } ?: "")
    Item(
        name,
        sub = sub,
        subLines = 3,
        subColor = when (state) {
            "failed" -> Brand.tones.danger
            "waiting" -> Brand.tones.warn
            else -> MaterialTheme.colorScheme.onSurfaceVariant
        },
        leading = { FileIcon(iconForName(name), 34.dp) },
        onClick = onOpen,
        extra = {
            if (state == "active" && total > 0) {
                LinearProgressIndicator(
                    { (done.toFloat() / total).coerceIn(0f, 1f) },
                    Modifier.fillMaxWidth().padding(top = 6.dp),
                    trackColor = MaterialTheme.colorScheme.surfaceVariant,
                )
            }
            if (state == "active" && sources.isNotEmpty()) {
                Column(Modifier.padding(top = 4.dp)) {
                    for ((platform, who, r) in sources) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            PlatformIcon(platform, 13.dp, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text("$who: ${rate(r)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            if (tips != null && tips.second.isNotEmpty()) {
                Notice(Tone.Warn, Modifier.padding(top = 6.dp), inset = 0.dp) {
                    tips.first?.let { Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold) }
                    tips.second.forEach { Text("•  $it", style = MaterialTheme.typography.bodySmall) }
                }
            }
        },
        trailing = {
            when {
                onCancel != null -> IconButton(onCancel) { Icon(Glyphs.Close, "Cancel") }
                onOpen != null -> IconButton(onOpen) { Icon(Glyphs.Open, "Open") }
            }
        },
    )
}
