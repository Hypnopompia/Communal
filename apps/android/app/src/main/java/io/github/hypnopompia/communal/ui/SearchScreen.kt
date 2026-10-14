package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.hypnopompia.communal.Hit
import kotlinx.coroutines.delay

private val KINDS = listOf(null to "All", "audio" to "Music", "video" to "Video", "image" to "Pictures", "document" to "Documents")

/** Searches every hub at once (ADR 0007); results merge by content. */
@Composable
fun SearchScreen(model: AppModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var kind by rememberSaveable { mutableStateOf<String?>(null) }
    var hits by remember { mutableStateOf<List<Hit>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var thumbsReady by remember { mutableIntStateOf(0) }
    var open by remember { mutableStateOf<Hit?>(null) }
    val focus = LocalFocusManager.current

    LaunchedEffect(query, kind) {
        if (query.isBlank()) {
            hits = null
            return@LaunchedEffect
        }
        delay(300) // typing
        busy = true
        error = null
        val r = runCatching { model.api.search(query.trim(), kind) }
        busy = false
        r.onSuccess { found ->
            // Like Browse: dotfiles (the synced folder's .communal-sync marker) stay out.
            val result = found.copy(hits = found.hits.filter { !it.name.startsWith(".") })
            hits = result.hits
            // Thumbnails come from each file's online source, one batch per device.
            result.hits.filter { it.thumb }
                .mapNotNull { h -> h.sources.firstOrNull { it.online }?.let { it to h.hash } }
                .groupBy({ (s, _) -> s.hub to s.device_id }, { (_, hash) -> hash })
                .forEach { (k, hashes) ->
                    runCatching { model.api.fetchThumbs(k.first, k.second, hashes.distinct()) }
                    thumbsReady++
                }
        }.onFailure { error = it.message }
    }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query, { query = it },
            Modifier.fillMaxWidth().padding(16.dp, 16.dp, 16.dp, 8.dp),
            placeholder = { Text("Search everyone’s shared files") },
            leadingIcon = { Icon(Icons.Default.Search, null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
        )
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for ((k, label) in KINDS) FilterChip(kind == k, { kind = k }, { Text(label) })
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
        val list = hits
        when {
            error != null -> Hint(error!!)
            list == null -> Hint("Search by name, artist or album. Results come from everyone you can see on your hubs.")
            list.isEmpty() && !busy -> Hint("Nothing found.")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(list, key = { it.hash }) { h -> HitRow(model, h, thumbsReady) { open = h } }
            }
        }
    }
    open?.let { h -> ActionSheet(model, Target.File(h.hash, h.name), onClose = { open = null }) }
}

@Composable
private fun HitRow(model: AppModel, h: Hit, thumbsReady: Int, onClick: () -> Unit) {
    val online = h.sources.count { it.online }
    ListItem(
        headlineContent = { Text(h.meta.title ?: h.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Column {
                Text(metaLine(h.meta, h.size), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    if (online > 0) "${online} online" + if (h.sources.size > online) " of ${h.sources.size}" else ""
                    else seenLabel(h.sources.firstOrNull()?.seen ?: "older"),
                    color = if (online > 0) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.outline,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        },
        leadingContent = { Thumb(model.api, h.hash, h.kind, h.thumb, thumbsReady) },
        modifier = Modifier.clickableRow(onClick),
    )
}

@Composable
fun Hint(text: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.TopCenter) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
