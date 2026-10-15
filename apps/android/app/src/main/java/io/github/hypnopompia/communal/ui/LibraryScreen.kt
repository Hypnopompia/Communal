package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.Entry
import io.github.hypnopompia.communal.LibraryDevice
import io.github.hypnopompia.communal.Listing
import io.github.hypnopompia.communal.Person

/** Someone you can browse, with their computers (the same computer on two hubs is one). */
private class Sharer(val person: Person, val devices: MutableList<LibraryDevice> = mutableListOf(), val hubs: MutableList<String> = mutableListOf())

/** Everyone you can browse, grouped by person, you first, as on the desktop. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(model: AppModel, onFindPeople: () -> Unit, onOpen: (Place) -> Unit) {
    val devices by model.library.collectAsStateWithLifecycle()
    val status by model.status.collectAsStateWithLifecycle()
    val phones by model.phones.collectAsStateWithLifecycle()
    val refreshing by model.refreshing.collectAsStateWithLifecycle()
    val me = status?.account?.user_id
    val people = LinkedHashMap<String, Sharer>()
    // Phones never share, so they're left out.
    for (d in devices.filter { it.device_id != status?.device_id && it.device_id !in phones }) {
        val p = people.getOrPut(d.user.user_id) { Sharer(d.user) }
        if (d.hub !in p.hubs) p.hubs += d.hub
        val twin = p.devices.indexOfFirst { it.device_id == d.device_id }
        if (twin < 0) p.devices += d else if (!p.devices[twin].online && d.online) p.devices[twin] = d
    }
    val list = people.values.sortedByDescending { it.person.user_id == me }
    PullToRefreshBox(refreshing, { model.refreshAll() }, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                Text(
                    "Everything shared with you or with everyone on your hub, computer by computer.",
                    Modifier.padding(horizontal = 20.dp).padding(bottom = 4.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (list.none { it.person.user_id != me }) item {
                EmptyState(
                    "Nobody has shared anything with you yet",
                    "Connect with the people you know on your hub. Once they share a folder with you, it shows up here.",
                    icon = Glyphs.Library,
                    modifier = Modifier.height(420.dp),
                    action = { Button(onFindPeople) { Text("Find people") } },
                )
            }
            for (p in list) {
                val mine = p.person.user_id == me
                item(key = "p:" + p.person.user_id) {
                    PersonHead(model, p.person, mine, p.devices.any { it.online }, p.hubs)
                }
                item(key = "d:" + p.person.user_id) {
                    PanelRows(p.devices) { d ->
                        Item(
                            d.device_name,
                            leading = {
                                PlatformIcon(d.platform, 26.dp, tint = if (d.online) MaterialTheme.colorScheme.onSurface else Brand.tones.faint)
                            },
                            extra = { StatusPill(seenLabel(d.seen), if (d.online) Tone.On else Tone.Off, Modifier.padding(top = 2.dp)) },
                            trailing = { Icon(Glyphs.Chevron, null, Modifier.size(18.dp), tint = Brand.tones.faint) },
                            onClick = { onOpen(Place(d.hub, d.device_id, d.device_name)) },
                        )
                    }
                }
            }
            item { Box(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun PersonHead(model: AppModel, person: Person, mine: Boolean, online: Boolean, hubs: List<String>) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 22.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Disc(person.display_name, person.fingerprint, 40.dp, online)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    if (mine) "${person.display_name} (you)" else person.display_name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                VerifiedMark(person.verified)
            }
            if (!mine) ConnectLines(model, person, hubs)
        }
    }
}

/**
 * People who share with the whole hub show up before you're connected: ask them to connect
 * from here, as on the desktop. Connections are per hub, so one line per hub they're on.
 */
@Composable
fun ConnectLines(model: AppModel, person: Person, hubs: List<String>) {
    val connections by model.connections.collectAsStateWithLifecycle()
    val status by model.status.collectAsStateWithLifecycle()
    val all = status?.hubs.orEmpty()
    for (hub in hubs.distinct()) {
        // A hub that's offline or hasn't answered: say nothing rather than guess.
        val known = connections[hub] ?: continue
        val on = if (all.size > 1) all.firstOrNull { it.id == hub }?.let { " on ${hubName(it)}" }.orEmpty() else ""
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (known.firstOrNull { it.user_id == person.user_id }?.state) {
                "accepted" -> Faint("Connected$on")
                "pending_out" -> Faint("Request sent$on")
                "pending_in" -> {
                    Faint("Wants to connect$on")
                    TextButton({
                        model.act("Connected with ${person.display_name}") {
                            model.api.connect(hub, person.user_id, "accept"); model.reloadConnections()
                        }
                    }) { Text("Accept") }
                }
                else -> TextButton({
                    model.act("Asked ${person.display_name} to connect") {
                        model.api.connect(hub, person.user_id); model.reloadConnections()
                    }
                }) { Text("Connect$on") }
            }
        }
    }
}

@Composable
private fun Faint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Brand.tones.faint)
}

/** One folder on a device, with its subfolders and files, as a grid of thumbnails or a list. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowseScreen(model: AppModel, place: Place, go: (Place?) -> Unit) {
    val status by model.status.collectAsStateWithLifecycle()
    val tick by model.tick.collectAsStateWithLifecycle()
    val library by model.library.collectAsStateWithLifecycle()
    val settings by model.settings.value.collectAsStateWithLifecycle()
    var listing by remember(place) { mutableStateOf<Listing?>(null) }
    var error by remember(place) { mutableStateOf<String?>(null) }
    var thumbsReady by remember { mutableIntStateOf(0) }
    var sheet by remember { mutableStateOf<Target?>(null) }
    val hubUrl = status?.hubs?.firstOrNull { it.id == place.hub }?.url ?: ""
    val device = library.firstOrNull { it.device_id == place.device && it.hub == place.hub }
    val mine = device?.user?.user_id == status?.account?.user_id

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
    val online = listing?.online ?: device?.online ?: false
    val folder = { path: String -> Target.Folder(place.hub, hubUrl, place.device, path) }
    val open = { f: Entry ->
        f.hash?.let { sheet = Target.File(it, f.name, f.size, f.icon, f.thumb, f.meta) }
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            // The app's Scaffold already keeps clear of the status bar.
            windowInsets = WindowInsets(0),
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            title = {
                Text(
                    if (place.path.isEmpty()) place.name else place.path.trimEnd('/').substringAfterLast('/'),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            navigationIcon = {
                IconButton({ go(if (place.path.isEmpty()) null else place.copy(path = parentOf(place.path))) }) {
                    Icon(Glyphs.Back, "Back")
                }
            },
            actions = {
                IconButton({ model.settings.update { it.copy(grid = !it.grid) } }) {
                    Icon(if (settings.grid) Glyphs.List else Glyphs.Grid, if (settings.grid) "Show as a list" else "Show as a grid")
                }
            },
        )
        val l = listing
        val header: @Composable () -> Unit = {
            Column {
                if (place.path.isEmpty() && device != null) DeviceHead(model, device, online, mine, place.hub)
                Crumbs(place, go)
                if (place.path.isNotEmpty()) {
                    Row(
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        FilledTonalButton({ sheet = folder(place.path) }) {
                            Icon(Glyphs.Transfers, null, Modifier.size(18.dp))
                            Text("Download folder", Modifier.padding(start = 8.dp))
                        }
                        OutlinedButton({ sheet = folder(place.path) }) {
                            Icon(Glyphs.Sync, null, Modifier.size(18.dp))
                            Text("Keep in sync", Modifier.padding(start = 8.dp))
                        }
                    }
                }
                if (!online) {
                    Notice(Tone.Warn) {
                        NoticeText("${device?.user?.display_name ?: "Its owner"}’s computer is offline. You can look around, but downloads wait until it’s back.")
                    }
                }
            }
        }
        when {
            error != null -> Column { header(); EmptyState("Can’t open this folder", error, icon = Glyphs.Folder) }
            l == null -> Column { header(); LinearProgressIndicator(Modifier.fillMaxWidth().padding(16.dp)) }
            l.dirs.isEmpty() && l.files.isEmpty() -> Column {
                header()
                EmptyState("Nothing here", "This folder is empty, or nothing in it is shared with you.", icon = Glyphs.Folder)
            }
            settings.grid -> LazyVerticalGrid(
                GridCells.Adaptive(108.dp),
                Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item(span = { GridItemSpan(maxLineSpan) }) { Box(Modifier.bleed(12.dp)) { header() } }
                items(l.dirs, key = { "d:" + it.name }) { d ->
                    Tile(d.name, "Folder", onClick = { go(place.copy(path = place.path + d.name + "/")) }) { FolderIcon(64.dp) }
                }
                items(l.files, key = { "f:" + it.path }) { f ->
                    Tile(
                        f.meta.title ?: f.name,
                        if (f.hash == null) "Still being prepared" else describe(f.meta, f.size),
                        onClick = { open(f) },
                    ) { Thumb(model.api, f.hash, f.icon, f.thumb, thumbsReady, fill = true) }
                }
            }
            else -> LazyColumn(Modifier.fillMaxSize()) {
                item { header() }
                item {
                    Panel(Modifier.padding(top = 8.dp)) {
                        l.dirs.forEachIndexed { i, d ->
                            if (i > 0) PanelDivider()
                            Item(
                                d.name,
                                leading = { FolderIcon(36.dp) },
                                trailing = {
                                    IconButton({ sheet = folder(place.path + d.name + "/") }) {
                                        Icon(Glyphs.More, "Download or keep in sync")
                                    }
                                },
                                onClick = { go(place.copy(path = place.path + d.name + "/")) },
                            )
                        }
                        l.files.forEachIndexed { i, f ->
                            if (i > 0 || l.dirs.isNotEmpty()) PanelDivider()
                            Item(
                                f.meta.title ?: f.name,
                                sub = if (f.hash == null) "Still being prepared" else describe(f.meta, f.size),
                                leading = { Thumb(model.api, f.hash, f.icon, f.thumb, thumbsReady) },
                                onClick = { open(f) },
                            )
                        }
                    }
                }
                item { Box(Modifier.height(24.dp)) }
            }
        }
    }
    sheet?.let { ActionSheet(model, it, onClose = { sheet = null }) }
}

/** Whose computer this is: their disc, its kind and whether it's around, as the desktop's head. */
@Composable
private fun DeviceHead(model: AppModel, d: LibraryDevice, online: Boolean, mine: Boolean, hub: String) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Disc(d.user.display_name, d.user.fingerprint, 48.dp, online)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    computerName(d.user.display_name, d.device_name),
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                VerifiedMark(d.user.verified)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    PlatformIcon(d.platform, 15.dp, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(platformLabel(d.platform), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                StatusPill(seenLabel(if (online) "now" else d.seen), if (online) Tone.On else Tone.Off)
            }
            if (!mine) ConnectLines(model, d.user, listOf(hub))
        }
    }
}

/** Shared folders › Music › 2019, each step tappable. */
@Composable
private fun Crumbs(place: Place, go: (Place?) -> Unit) {
    val segs = place.path.split('/').filter { it.isNotEmpty() }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val crumb = @Composable { label: String, here: Boolean, path: String ->
            if (here) {
                Text(label, Modifier.padding(horizontal = 8.dp, vertical = 12.dp), style = MaterialTheme.typography.labelLarge)
            } else {
                TextButton({ go(place.copy(path = path)) }) { Text(label, fontWeight = FontWeight.Normal) }
            }
        }
        crumb("Shared folders", segs.isEmpty(), "")
        segs.forEachIndexed { i, s ->
            Text("›", color = Brand.tones.faint)
            crumb(s, i == segs.size - 1, segs.take(i + 1).joinToString("/") + "/")
        }
    }
}

/** A folder or file in the grid (`.tile`): its art, then its name and what it is. */
@Composable
private fun Tile(name: String, meta: String?, onClick: () -> Unit, art: @Composable () -> Unit) {
    val shape = MaterialTheme.shapes.large
    Column(
        Modifier.clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .border(1.dp, Brand.tones.line, shape)
            .clickableRow(onClick)
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(1f).clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceContainerLow),
            contentAlignment = Alignment.Center,
        ) { art() }
        Text(
            name,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            minLines = 2,
        )
        if (meta != null) {
            Text(meta, style = MaterialTheme.typography.labelSmall, color = Brand.tones.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Reaches past the grid's side padding, so headers line up with the rest of the app. */
private fun Modifier.bleed(x: Dp) = layout { m, c ->
    val extra = (x * 2).roundToPx()
    val p = m.measure(c.copy(minWidth = c.minWidth + extra, maxWidth = c.maxWidth + extra))
    layout(p.width - extra, p.height) { p.place(-x.roundToPx(), 0) }
}
