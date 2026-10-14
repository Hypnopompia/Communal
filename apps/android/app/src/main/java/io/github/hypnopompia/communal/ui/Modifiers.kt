package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.clickable
import androidx.compose.ui.Modifier

fun Modifier.clickableRow(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)
