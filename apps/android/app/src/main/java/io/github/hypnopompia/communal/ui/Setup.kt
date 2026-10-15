package io.github.hypnopompia.communal.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * First start: link this phone to your account from one of your computers (the usual way), or
 * start a new account on a hub with just this phone.
 */
@Composable
fun Setup(model: AppModel, snackbar: SnackbarHostState) {
    var linking by rememberSaveable { mutableStateOf(true) }
    var hub by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf(Build.MODEL ?: "Phone") }
    var busy by rememberSaveable { mutableStateOf(false) }
    val url = runCatching { if (hub.isBlank()) "" else hubUrl(hub) }.getOrDefault("")
    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { pad ->
        Column(
            // The app draws edge to edge, so Android doesn't shrink it for the keyboard: make room
            // here, and the focused field scrolls into view.
            Modifier.fillMaxSize().padding(pad).imePadding().verticalScroll(rememberScrollState()).padding(vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = 480.dp).padding(horizontal = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Mark(80.dp, Modifier.padding(top = 24.dp))
                Text("Welcome to Communal", style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
                Text(
                    "Find files your friends share, download them to this phone, and keep folders in sync, like music " +
                        "from your computer. This phone downloads only: it never shares its own files.",
                    Modifier.padding(horizontal = 16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                    SegmentedButton(linking, { linking = true }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("I have Communal") }
                    SegmentedButton(!linking, { linking = false }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("I’m new") }
                }
                Panel {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        if (linking) {
                            Steps(
                                "On your computer, open Communal › Settings › Devices and choose Get a code.",
                                "Type the hub’s address and that code here.",
                                "Approve this phone on your computer.",
                            )
                        } else {
                            Text(
                                "Join a hub with a new account. You can add your computers to it later.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        OutlinedTextField(
                            hub, { hub = it }, Modifier.fillMaxWidth(),
                            label = { Text("Hub address") },
                            placeholder = { Text("hub.example.com") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        )
                        if (linking) {
                            OutlinedTextField(
                                code, { code = it.uppercase() }, Modifier.fillMaxWidth(),
                                label = { Text("Code from your computer") },
                                placeholder = { Text("K7Q2-9XZD") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                            )
                        } else {
                            OutlinedTextField(
                                name, { name = it }, Modifier.fillMaxWidth(),
                                label = { Text("Your name") },
                                supportingText = { Text("What people on the hub see") },
                                singleLine = true,
                            )
                        }
                        OutlinedTextField(
                            phone, { phone = it }, Modifier.fillMaxWidth(),
                            label = { Text("This phone’s name") },
                            singleLine = true,
                        )
                        Button(
                            enabled = !busy && url.isNotEmpty() && phone.isNotBlank() &&
                                (if (linking) code.isNotBlank() else name.isNotBlank()),
                            onClick = {
                                busy = true
                                model.act(null) {
                                    try {
                                        if (linking) model.api.link(url, code.trim(), phone.trim())
                                        else model.api.join(url, name.trim(), phone.trim())
                                    } finally {
                                        busy = false
                                        model.reloadStatus()
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                        ) {
                            if (busy) {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                                Text(if (linking) "  Waiting for your computer…" else "  Joining…")
                            } else {
                                Text(if (linking) "Link this phone" else "Join")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Steps(vararg steps: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        steps.forEachIndexed { i, s ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("${i + 1}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text(s, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
