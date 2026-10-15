package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.Connection
import io.github.hypnopompia.communal.Hub
import io.github.hypnopompia.communal.Person
import kotlinx.coroutines.delay

/** Someone, with their connection on each hub you share (ADR 0021: shown once). */
private class Someone(val person: Person, val lines: MutableList<Pair<String, Connection>> = mutableListOf())

/**
 * People (the desktop's screen, less groups and access, which belong to sharing): requests to
 * answer, finding people, your connections and requests you sent.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PeopleScreen(model: AppModel) {
    val connections by model.connections.collectAsStateWithLifecycle()
    val status by model.status.collectAsStateWithLifecycle()
    val refreshing by model.refreshing.collectAsStateWithLifecycle()
    val hubs = status?.hubs.orEmpty()
    val ready = hubs.filter { it.ready }
    val many = hubs.size > 1
    var verifying by remember { mutableStateOf<Pair<String, Person>?>(null) }
    var removing by remember { mutableStateOf<Triple<String, Person, String>?>(null) } // hub, person, state
    LaunchedEffect(Unit) { model.reloadConnections() }

    fun group(state: String): List<Someone> {
        val by = LinkedHashMap<String, Someone>()
        for (h in hubs) for (c in connections[h.id].orEmpty().filter { it.state == state }) {
            by.getOrPut(c.user_id) { Someone(c.person) }.lines += h.id to c
        }
        return by.values.toList()
    }
    val incoming = group("pending_in")
    val accepted = group("accepted")
    val outgoing = group("pending_out")
    fun on(hub: String) = if (many) hubs.firstOrNull { it.id == hub }?.let { " on ${hubName(it)}" }.orEmpty() else ""
    val away = hubs.filter { !it.ready }

    PullToRefreshBox(refreshing, { model.refreshAll() }, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                Text(
                    "Connect with people you know to see what they share with you. Either of you can disconnect at any time." +
                        if (many) " You connect on each hub separately." else "",
                    Modifier.padding(horizontal = 20.dp).padding(bottom = 4.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (away.isNotEmpty()) item {
                Notice(Tone.Warn) {
                    NoticeText(
                        away.joinToString(", ") { hubName(it) } + (if (away.size == 1) " isn’t" else " aren’t") +
                            " reachable right now, so people there aren’t shown.",
                    )
                }
            }
            if (incoming.isNotEmpty()) {
                item { SectionTitle("Want to connect with you") }
                item {
                    PanelRows(incoming) { p ->
                        PersonItem(p.person) {
                            for ((hub, c) in p.lines) {
                                HubLine("Asked ${ago(c.since)}${on(hub)}") {
                                    TextButton({
                                        model.act(null) { model.api.disconnect(hub, p.person.user_id); model.reloadConnections() }
                                    }) { Text("Decline") }
                                    Button({
                                        model.act("Connected with ${p.person.display_name}") {
                                            model.api.connect(hub, p.person.user_id, "accept"); model.reloadConnections()
                                        }
                                    }) { Text("Accept") }
                                }
                            }
                        }
                    }
                }
            }
            if (ready.isNotEmpty()) item { FindPeople(model, ready, connections) }
            item { SectionTitle("Connections") }
            if (accepted.isEmpty()) item {
                EmptyState(
                    "No connections yet",
                    "Search for someone above and send them a request. They’ll see it the next time they open Communal.",
                    icon = Glyphs.People,
                    modifier = Modifier.height(300.dp),
                )
            } else item {
                PanelRows(accepted) { p ->
                    val first = p.lines.first().second
                    PersonItem(
                        p.person,
                        online = first.online,
                        sub = first.seen?.let { seenLabel(it) },
                        action = {
                            TextButton({ verifying = p.lines.first().first to p.person }) {
                                Text(if (p.person.verified) "Safety code" else "Verify")
                            }
                        },
                    ) {
                        for ((hub, c) in p.lines) {
                            HubLine("Connected ${ago(c.since)}${on(hub)}") {
                                TextButton({ removing = Triple(hub, p.person, "accepted") }) { Text("Disconnect") }
                            }
                        }
                    }
                }
            }
            if (outgoing.isNotEmpty()) {
                item { SectionTitle("Waiting for an answer") }
                item {
                    PanelRows(outgoing) { p ->
                        PersonItem(p.person) {
                            for ((hub, c) in p.lines) {
                                HubLine("Asked ${ago(c.since)}${on(hub)}") {
                                    TextButton({
                                        model.act("Request cancelled") {
                                            model.api.disconnect(hub, p.person.user_id); model.reloadConnections()
                                        }
                                    }) { Text("Cancel request") }
                                }
                            }
                        }
                    }
                }
            }
            item { Box(Modifier.height(24.dp)) }
        }
    }
    verifying?.let { (hub, person) -> VerifyDialog(model, hub, person) { verifying = null } }
    removing?.let { (hub, person, _) ->
        val where = if (many) hubs.firstOrNull { it.id == hub }?.let { hubName(it) } else null
        val name = person.display_name
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(if (where != null) "Disconnect from $name on $where?" else "Disconnect from $name?") },
            text = {
                Text(
                    "You stop seeing what $name shares with you${where?.let { " on $it" }.orEmpty()}, and $name stops seeing " +
                        "what you shared with them there, right away. You can connect again later." +
                        if (where != null) " Other hubs you’re both on aren’t affected." else "",
                )
            },
            confirmButton = {
                TextButton({
                    removing = null
                    model.act("Disconnected from $name") { model.api.disconnect(hub, person.user_id); model.reloadConnections() }
                }) { Text("Disconnect") }
            },
            dismissButton = { TextButton({ removing = null }) { Text("Stay connected") } },
        )
    }
}

@Composable
private fun PersonItem(
    p: Person,
    online: Boolean? = null,
    sub: String? = null,
    action: (@Composable () -> Unit)? = null,
    lines: @Composable () -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Disc(p.display_name, p.fingerprint, 40.dp, online)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            p.display_name,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        VerifiedMark(p.verified)
                    }
                    sub?.let { StatusPill(it, if (online == true) Tone.On else Tone.Off) }
                }
                action?.invoke()
            }
            lines()
        }
    }
}

/** "Connected 3 days ago on Home", and what can be done about it there. */
@Composable
private fun HubLine(text: String, actions: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = Brand.tones.faint)
        actions()
    }
}

/** Search a hub's members by name and ask them to connect. */
@Composable
private fun FindPeople(model: AppModel, hubs: List<Hub>, connections: Map<String, List<Connection>>) {
    var hubId by rememberSaveable { mutableStateOf(hubs.first().id) }
    val hub = hubs.firstOrNull { it.id == hubId } ?: hubs.first()
    var q by rememberSaveable { mutableStateOf("") }
    var sent by remember(hub.id) { mutableStateOf(setOf<String>()) }
    val known = connections[hub.id].orEmpty().map { it.user_id }.toSet()
    val results by produceState<List<Person>?>(null, hub.id, q) {
        val t = q.trim()
        if (t.isEmpty()) {
            value = null
            return@produceState
        }
        delay(300)
        value = runCatching { model.api.findPeople(hub.id, t).users }.getOrElse { emptyList() }
    }
    SectionTitle("Find people")
    if (hubs.size > 1) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for (h in hubs) FilterChip(h.id == hub.id, { hubId = h.id }, { Text(hubName(h)) })
        }
    }
    TextField(
        q, { q = it },
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        placeholder = { Text(if (hubs.size > 1) "Name, on ${hubName(hub)}" else "Name") },
        leadingIcon = { Icon(Glyphs.Search, null) },
        singleLine = true,
        shape = CircleShape,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
        ),
    )
    val r = results
    when {
        r == null -> {}
        r.isEmpty() -> Text(
            "Nobody on ${hubName(hub)} goes by that name.",
            Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        else -> PanelRows(r, Modifier.padding(top = 10.dp)) { u ->
            Item(
                u.display_name,
                sub = "Key ${u.fingerprint.take(19)}",
                leading = { Disc(u.display_name, u.fingerprint, 36.dp) },
                trailing = {
                    if (u.user_id in known || u.user_id in sent) {
                        Text(
                            if (u.user_id in sent) "Request sent" else "Already connected or asked",
                            style = MaterialTheme.typography.bodySmall,
                            color = Brand.tones.faint,
                        )
                    } else {
                        FilledTonalButton({
                            model.act("Asked ${u.display_name} to connect") {
                                model.api.connect(hub.id, u.user_id)
                                sent = sent + u.user_id
                                model.reloadConnections()
                            }
                        }) { Text("Connect") }
                    }
                },
            )
        }
    }
}

/** Safety codes (HANDOFF §2): compared out of band, then marked as verified here. */
@Composable
private fun VerifyDialog(model: AppModel, hub: String, person: Person, onClose: () -> Unit) {
    val code by produceState<Result<String>?>(null, hub, person.user_id) {
        value = runCatching { model.api.safetyCode(hub, person.user_id).code }
    }
    AlertDialog(
        onDismissRequest = onClose,
        icon = { Icon(Glyphs.Shield, null, tint = Brand.tones.online) },
        title = { Text("Verify ${person.display_name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    "Compare this code with the one ${person.display_name} sees, in person or on a call. " +
                        "If they match, nobody is pretending to be either of you.",
                )
                val c = code
                Box(
                    Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium)
                        .background(MaterialTheme.colorScheme.surfaceContainerLow).padding(16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        c?.getOrNull() ?: c?.exceptionOrNull()?.message ?: "…",
                        fontFamily = if (c?.isSuccess == true) FontFamily.Monospace else null,
                        fontSize = if (c?.isSuccess == true) 20.sp else 14.sp,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        letterSpacing = 1.sp,
                    )
                }
            }
        },
        confirmButton = {
            if (person.verified) {
                TextButton({
                    onClose()
                    model.act("Verification removed") { model.api.verify(hub, person.user_id, false); model.refreshAll() }
                }) { Text("Remove verification") }
            } else {
                TextButton(
                    {
                        onClose()
                        model.act("${person.display_name} verified") { model.api.verify(hub, person.user_id, true); model.refreshAll() }
                    },
                    enabled = code?.isSuccess == true,
                ) { Text("The codes match") }
            }
        },
        dismissButton = { TextButton(onClose) { Text(if (person.verified) "Close" else "Not now") } },
    )
}
