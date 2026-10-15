package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.Hit
import io.github.hypnopompia.communal.SearchResult
import io.github.hypnopompia.communal.plural
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val KINDS = listOf(
    null to "Any kind",
    "image" to "Pictures",
    "video" to "Videos",
    "audio" to "Music",
    "document" to "Documents",
    "text" to "Text",
    "archive" to "Archives",
    "code" to "Code",
    "disk_image" to "Disk images",
    "other" to "Other",
)

private val FROM = listOf("anyone" to "Anyone", "connections" to "My connections", "verified" to "People I’ve verified")

private val SIZES = listOf(0L to "Any size", 1_000_000L to "Over 1 MB", 100_000_000L to "Over 100 MB", 1_000_000_000L to "Over 1 GB")

/** Searches every hub at once (ADR 0007): one result per file, however many people have it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(model: AppModel, onShowFolder: (Place) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var kind by rememberSaveable { mutableStateOf<String?>(null) }
    var minSize by rememberSaveable { mutableLongStateOf(0L) }
    var available by rememberSaveable { mutableStateOf(false) }
    var from by rememberSaveable { mutableStateOf("anyone") }
    var hits by remember { mutableStateOf<List<Hit>?>(null) }
    var last by remember { mutableStateOf<SearchResult?>(null) }
    var down by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var thumbsReady by remember { mutableIntStateOf(0) }
    var open by remember { mutableStateOf<Hit?>(null) }
    var filtering by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    val library by model.library.collectAsStateWithLifecycle()
    val connections by model.connections.collectAsStateWithLifecycle()
    val names = remember(connections, library) { Names(connections, library) }
    val filtered = kind != null || minSize > 0
    val q = query.trim()

    /** Thumbnails come from each file's online source, one batch per device. */
    suspend fun thumbsFor(list: List<Hit>) {
        list.filter { it.thumb }
            .mapNotNull { h -> h.sources.firstOrNull { it.online }?.let { it to h.hash } }
            .groupBy({ (s, _) -> s.hub to s.device_id }, { (_, hash) -> hash })
            .forEach { (k, hashes) ->
                runCatching { model.api.fetchThumbs(k.first, k.second, hashes.distinct()) }
                thumbsReady++
            }
    }

    /** Dotfiles stay out (the synced folder's marker), and a file seen on an earlier page once. */
    fun merge(old: List<Hit>, page: List<Hit>): List<Hit> {
        val seen = old.map { it.hash }.toMutableSet()
        return old + page.filter { !it.name.startsWith(".") && seen.add(it.hash) }
    }

    LaunchedEffect(q, kind, minSize, available, from) {
        if (q.isEmpty() && !filtered) {
            hits = null
            last = null
            return@LaunchedEffect
        }
        delay(300) // typing
        busy = true
        error = null
        val r = runCatching { model.api.search(q, kind, minSize, available, from) }
        busy = false
        r.onSuccess { found ->
            last = found
            down = found.hubs.count { !it.ok }
            hits = merge(emptyList(), found.hits)
            thumbsFor(found.hits)
        }.onFailure { error = it.message }
    }
    val cursors = last?.hubs?.mapNotNull { h -> h.cursor?.let { h.hub to it } }?.toMap().orEmpty()
    fun more() = scope.launch {
        busy = true
        runCatching { model.api.search(q, kind, minSize, available, from, cursors) }
            .onSuccess { page ->
                last = page
                hits = merge(hits.orEmpty(), page.hits)
                thumbsFor(page.hits)
            }
            .onFailure { model.message.value = it.message }
        busy = false
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextField(
                query, { query = it },
                Modifier.weight(1f),
                placeholder = { Text("Search shared files", maxLines = 1) },
                leadingIcon = { Icon(Glyphs.Search, null) },
                trailingIcon = {
                    if (query.isNotEmpty()) IconButton({ query = "" }) { Icon(Glyphs.Close, "Clear") }
                },
                singleLine = true,
                shape = CircleShape,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
            )
            val active = listOf(minSize > 0, available, from != "anyone").count { it }
            IconButton({ filtering = true }, Modifier.padding(start = 4.dp)) {
                BadgedBox(badge = { if (active > 0) Badge { Text("$active") } }) { Icon(Glyphs.Filter, "Filters") }
            }
        }
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for ((k, label) in KINDS.take(6)) Chip(kind == k, label) { kind = k }
        }
        Box(Modifier.fillMaxWidth().height(4.dp)) {
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        val list = hits
        when {
            error != null -> EmptyState("Search didn’t work", error, icon = Glyphs.Search)
            list == null -> EmptyState(
                "Find anything shared with you",
                "Type part of a name. Every word counts, so “beach 2019” finds “Beach trip (2019).mp4”.",
                icon = Glyphs.Search,
            )
            list.isEmpty() && !busy -> EmptyState(
                "No matches",
                when {
                    available -> "Nothing matching is on a computer that’s been around lately. Try turning off “Only available files”."
                    from != "anyone" -> "Nothing matching comes from ${if (from == "verified") "people you’ve verified" else "your connections"}. Try “Anyone”."
                    else -> "Try fewer or shorter words, or a different kind."
                },
                icon = Glyphs.Search,
            )
            else -> LazyColumn(Modifier.fillMaxSize()) {
                if (down > 0) item {
                    Notice(Tone.Warn) { NoticeText("${plural(down, "hub")} didn’t answer, so some results may be missing.") }
                }
                item { Box(Modifier.height(8.dp)) }
                itemsIndexed(list, key = { _, h -> h.hash }) { i, h ->
                    Box(Modifier.panelItem(i, list.size)) { HitRow(model, h, names, thumbsReady) { open = h } }
                }
                if (cursors.isNotEmpty()) item {
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        OutlinedButton({ more() }, enabled = !busy) { Text(if (busy) "Loading…" else "Show more") }
                    }
                }
                item { Box(Modifier.height(24.dp)) }
            }
        }
    }
    open?.let { h ->
        val best = h.sources.firstOrNull()
        val folder = best?.let { s ->
            val d = names.device(s.device_id)
            Place(s.hub, s.device_id, d?.device_name ?: "Computer", s.path.substringBeforeLast('/', "").let { if (it.isEmpty()) "" else "$it/" })
        }
        ActionSheet(
            model,
            Target.File(h.hash, h.name, h.size, h.icon, h.thumb, h.meta, fromLine(h, names), folder),
            onClose = { open = null },
            onShowFolder = onShowFolder,
        )
    }
    if (filtering) {
        ModalBottomSheet({ filtering = false }, containerColor = MaterialTheme.colorScheme.surfaceContainerLowest) {
            Column(
                Modifier.navigationBarsPadding().padding(horizontal = 24.dp).padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Filters", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton({
                        kind = null; minSize = 0; available = false; from = "anyone"
                    }) { Text("Reset") }
                }
                FilterGroup("Kind") { for ((k, label) in KINDS) Chip(kind == k, label) { kind = k } }
                FilterGroup("Size") { for ((v, label) in SIZES) Chip(minSize == v, label) { minSize = v } }
                FilterGroup("From") { for ((v, label) in FROM) Chip(from == v, label) { from = v } }
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Only available files", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "On a computer that’s online now or was seen in the past week",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(available, { available = it })
                }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun FilterGroup(title: String, chips: @Composable () -> Unit) {
    Text(title, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { chips() }
}

@Composable
private fun Chip(selected: Boolean, label: String, onClick: () -> Unit) {
    FilterChip(
        selected, onClick, { Text(label) },
        colors = FilterChipDefaults.filterChipColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            selectedContainerColor = MaterialTheme.colorScheme.primary,
            selectedLabelColor = MaterialTheme.colorScheme.onPrimary,
        ),
        border = FilterChipDefaults.filterChipBorder(true, selected, borderColor = Brand.tones.line),
    )
}

/** "From Maya, Sam and 2 more". */
private fun fromLine(h: Hit, names: Names): String {
    val owners = h.sources.map { it.owner }.distinct()
    val shown = owners.take(3).joinToString(", ") { names.user(it) }
    return "From $shown" + if (owners.size > 3) " and ${owners.size - 3} more" else ""
}

@Composable
private fun HitRow(model: AppModel, h: Hit, names: Names, thumbsReady: Int, onClick: () -> Unit) {
    // Two copies on one computer are one source as far as anyone downloading is concerned.
    val computers = h.sources.map { it.device_id }.distinct().size
    val online = h.sources.filter { it.online }.map { it.device_id }.distinct().size
    Item(
        h.meta.title ?: h.name,
        sub = describe(h.meta, h.size) + ". " + fromLine(h, names),
        subLines = 1,
        leading = { Thumb(model.api, h.hash, h.icon, h.thumb, thumbsReady, 48.dp) },
        extra = {
            StatusPill(
                when {
                    online > 0 && computers > 1 -> "$online of $computers computers online"
                    online > 0 -> "Online"
                    else -> seenLabel(h.sources.firstOrNull()?.seen ?: "older")
                },
                if (online > 0) Tone.On else Tone.Off,
                Modifier.padding(top = 2.dp),
            )
        },
        onClick = onClick,
    )
}

/**
 * One row of a panel in a lazy list: the panel's card, edge and hairlines drawn row by row, so a
 * long list of results still reads as one panel.
 */
@Composable
fun Modifier.panelItem(i: Int, n: Int): Modifier {
    val r = 16.dp
    val bg = MaterialTheme.colorScheme.surfaceContainerLowest
    val line = Brand.tones.line
    val first = i == 0
    val lastOne = i == n - 1
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(
        topStart = if (first) r else 0.dp, topEnd = if (first) r else 0.dp,
        bottomStart = if (lastOne) r else 0.dp, bottomEnd = if (lastOne) r else 0.dp,
    )
    return this.padding(horizontal = 16.dp).clip(shape).background(bg).drawBehind {
        val rad = r.toPx()
        val w = 1.dp.toPx()
        // The whole panel's outline, reaching past this row where it goes on: clipping leaves
        // only this row's part of it.
        val top = if (first) w / 2 else -rad * 2
        val bottom = if (lastOne) size.height - w / 2 else size.height + rad * 2
        drawRoundRect(line, Offset(w / 2, top), Size(size.width - w, bottom - top), CornerRadius(rad), style = Stroke(w))
        if (!first) drawLine(line, Offset(16.dp.toPx(), 0f), Offset(size.width, 0f), w)
    }
}
