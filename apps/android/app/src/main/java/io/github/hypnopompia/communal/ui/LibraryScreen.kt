package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.Entry
import io.github.hypnopompia.communal.Hub
import io.github.hypnopompia.communal.Person
import io.github.hypnopompia.communal.LibraryDevice
import io.github.hypnopompia.communal.Listing

/** Computers you can browse: yours first, then people sharing with you or with the whole hub. */
@Composable
fun LibraryScreen(model: AppModel, onOpen: (Place) -> Unit) {
    val devices by model.library.collectAsStateWithLifecycle()
    val status by model.status.collectAsStateWithLifecycle()
    val phones by model.phones.collectAsStateWithLifecycle()
    val me = status?.account?.user_id
    val (mine, others) = devices
        .filter { it.device_id != status?.device_id && it.device_id !in phones }
        .partition { it.user.user_id == me }
    if (devices.isEmpty()) {
        Hint("Nothing to browse yet. Computers you and your connections share from show up here.")
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        if (mine.isNotEmpty()) {
            item { Header("Your computers") }
            items(mine, key = { it.hub + it.device_id }) { DeviceRow(it, onOpen) }
        }
        for ((user, list) in others.groupBy { it.user.user_id }) {
            item(key = user) {
                Header(list.first().user.display_name + if (list.first().user.verified) " ✓" else "")
                ConnectLines(model, list.first().user, list.map { it.hub }.distinct(), status?.hubs.orEmpty())
            }
            items(list, key = { it.hub + it.device_id }) { DeviceRow(it, onOpen) }
        }
    }
}

/**
 * People who share with the whole hub show up before you're connected: ask them to connect
 * from here, as on the desktop. Connections are per hub, so one line per hub they're on.
 */
@Composable
private fun ConnectLines(model: AppModel, person: Person, hubs: List<String>, all: List<Hub>) {
    val connections by model.connections.collectAsStateWithLifecycle()
    for (hub in hubs) {
        // A hub that's offline or hasn't answered: say nothing rather than guess.
        val known = connections[hub] ?: continue
        val on = if (all.size > 1) all.firstOrNull { it.id == hub }?.let { " on ${hubName(it)}" }.orEmpty() else ""
        Row(Modifier.padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            when (known[person.user_id]) {
                "accepted" -> StateText("Connected$on")
                "pending_out" -> StateText("Request sent$on")
                "pending_in" -> {
                    StateText("Wants to connect$on")
                    TextButton({ model.act("Connected with ${person.display_name}") { model.api.connect(hub, person.user_id, "accept"); model.reloadConnections() } }) { Text("Accept") }
                }
                else -> TextButton({ model.act("Asked ${person.display_name} to connect") { model.api.connect(hub, person.user_id); model.reloadConnections() } }) { Text("Connect$on") }
            }
        }
    }
}

@Composable
private fun StateText(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
}

@Composable
private fun Header(text: String) {
    Text(
        text,
        Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp),
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
private fun DeviceRow(d: LibraryDevice, onOpen: (Place) -> Unit) {
    ListItem(
        headlineContent = { Text(d.device_name) },
        supportingContent = { Text(seenLabel(d.seen)) },
        leadingContent = { Icon(Icons.Default.Computer, null, tint = if (d.online) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.outline) },
        modifier = Modifier.clickableRow { onOpen(Place(d.hub, d.device_id, d.device_name)) },
    )
}

/** One folder on a device, with its subfolders and files. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowseScreen(model: AppModel, place: Place, go: (Place?) -> Unit) {
    val status by model.status.collectAsStateWithLifecycle()
    val tick by model.tick.collectAsStateWithLifecycle()
    var listing by remember(place) { mutableStateOf<Listing?>(null) }
    var error by remember(place) { mutableStateOf<String?>(null) }
    var thumbsReady by remember { mutableIntStateOf(0) }
    var sheet by remember { mutableStateOf<Target?>(null) }
    val hubUrl = status?.hubs?.firstOrNull { it.id == place.hub }?.url ?: ""

    LaunchedEffect(place, tick) {
        runCatching { model.api.browse(place.hub, place.device, place.path) }
            .onSuccess { raw ->
                // Like the desktop: dotfiles (the synced folder's .communal-sync marker) stay out.
                val l = raw.copy(files = raw.files.filter { !it.name.startsWith(".") })
                listing = l
                error = null
                val hashes = l.files.filter { it.thumb && it.hash != null }.map { it.hash!! }
                if (hashes.isNotEmpty() && l.online) {
                    runCatching { model.api.fetchThumbs(place.hub, place.device, hashes) }
                    thumbsReady++
                }
            }
            .onFailure { error = it.message }
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            // The app's Scaffold already keeps clear of the status bar.
            windowInsets = WindowInsets(0),
            title = {
                Text(
                    if (place.path.isEmpty()) place.name else place.path.trimEnd('/').substringAfterLast('/'),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            navigationIcon = {
                IconButton({ go(if (place.path.isEmpty()) null else place.copy(path = parentOf(place.path))) }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                }
            },
            actions = {
                if (place.path.isNotEmpty()) {
                    IconButton({ sheet = Target.Folder(place.hub, hubUrl, place.device, place.path) }) {
                        Icon(Icons.Default.MoreVert, "Download or keep in sync")
                    }
                }
            },
        )
        val l = listing
        when {
            error != null -> Hint(error!!)
            l == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
            l.dirs.isEmpty() && l.files.isEmpty() -> Hint("Nothing here you can see.")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                if (!l.online) item {
                    Text(
                        "${place.name} is offline: you can look, but downloads wait until it’s back.",
                        Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                items(l.dirs, key = { "d:" + it.name }) { d ->
                    ListItem(
                        headlineContent = { Text(d.name) },
                        leadingContent = { FolderIcon() },
                        trailingContent = {
                            IconButton({ sheet = Target.Folder(place.hub, hubUrl, place.device, place.path + d.name + "/") }) {
                                Icon(Icons.Default.MoreVert, "Download or keep in sync")
                            }
                        },
                        modifier = Modifier.clickableRow { go(place.copy(path = place.path + d.name + "/")) },
                    )
                }
                items(l.files, key = { "f:" + it.path }) { f -> FileRow(model, f, thumbsReady) { f.hash?.let { sheet = Target.File(it, f.name) } } }
            }
        }
    }
    sheet?.let { ActionSheet(model, it, onClose = { sheet = null }) }
}

@Composable
private fun FileRow(model: AppModel, f: Entry, thumbsReady: Int, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(f.meta.title ?: f.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Text(
                if (f.hash == null) "Not ready yet: the owner’s computer is still preparing it" else metaLine(f.meta, f.size),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        leadingContent = { Thumb(model.api, f.hash, f.kind, f.thumb, thumbsReady) },
        modifier = Modifier.clickableRow(onClick),
    )
}
