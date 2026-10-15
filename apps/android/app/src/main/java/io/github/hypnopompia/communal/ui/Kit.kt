package io.github.hypnopompia.communal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/*
 * The desktop's building blocks (styles.css: .panel, .row, .status, .notice, .empty), so screens
 * on both clients read the same way.
 */

/** A white card with a hairline edge, holding rows (`.panel.rows`). */
@Composable
fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val shape = MaterialTheme.shapes.large
    Column(
        modifier.fillMaxWidth().padding(horizontal = 16.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .border(1.dp, Brand.tones.line, shape),
        content = content,
    )
}

@Composable
fun PanelDivider() = HorizontalDivider(Modifier.padding(start = 16.dp), color = Brand.tones.line)

/** Rows in a panel, with hairlines between them. */
@Composable
fun <T> PanelRows(items: List<T>, modifier: Modifier = Modifier, row: @Composable (T) -> Unit) {
    if (items.isEmpty()) return
    Panel(modifier) {
        items.forEachIndexed { i, it ->
            if (i > 0) PanelDivider()
            row(it)
        }
    }
}

/** One row: something to recognise it by, a title and a line under it, and what you can do. */
@Composable
fun Item(
    title: String,
    modifier: Modifier = Modifier,
    sub: String? = null,
    subColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    titleLines: Int = 1,
    subLines: Int = 2,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    extra: (@Composable ColumnScope.() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth()
            .let { if (onClick != null && enabled) it.clickableRow(onClick) else it }
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        leading?.let { Box(contentAlignment = Alignment.Center) { it() } }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                color = if (enabled) MaterialTheme.colorScheme.onSurface else Brand.tones.faint,
                maxLines = titleLines,
                overflow = TextOverflow.Ellipsis,
            )
            sub?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = subColor, maxLines = subLines, overflow = TextOverflow.Ellipsis)
            }
            extra?.invoke(this)
        }
        trailing?.let { Row(verticalAlignment = Alignment.CenterVertically, content = it) }
    }
}

/** A section's heading (`h2`), with an optional action at its end. */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 22.dp, bottom = 8.dp).heightIn(min = 28.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
        action?.invoke()
    }
}

enum class Tone { On, Off, Warn, Bad }

/** A coloured dot and a few words: "Online", "Offline, seen today" (`.status`). */
@Composable
fun StatusPill(text: String, tone: Tone, modifier: Modifier = Modifier) {
    val t = Brand.tones
    val color = when (tone) {
        Tone.On -> t.online
        Tone.Off -> t.faint
        Tone.Warn -> t.warn
        Tone.Bad -> t.danger
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = if (tone == Tone.Off) t.faint else color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A tinted box for something to know or fix (`.notice`, `.notice.warn`, `.notice.bad`). */
@Composable
fun Notice(
    tone: Tone = Tone.Off,
    modifier: Modifier = Modifier,
    /** Space at the sides: none inside a row. */
    inset: Dp = 16.dp,
    action: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val t = Brand.tones
    val (bg, edge) = when (tone) {
        Tone.Warn -> t.warnSoft to t.warn.copy(alpha = 0.35f)
        Tone.Bad -> t.dangerSoft to t.danger.copy(alpha = 0.35f)
        Tone.On -> t.onlineSoft to t.online.copy(alpha = 0.35f)
        Tone.Off -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)
    }
    val shape = MaterialTheme.shapes.medium
    Column(
        modifier.fillMaxWidth().padding(horizontal = inset, vertical = 6.dp)
            .clip(shape).background(bg).border(1.dp, edge, shape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        content()
        action?.let { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { it() } }
    }
}

@Composable
fun NoticeText(text: String) = Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)

/** Nothing to show yet, and what to do about it (`.empty`). */
@Composable
fun EmptyState(
    title: String,
    body: String? = null,
    icon: ImageVector? = null,
    modifier: Modifier = Modifier,
    art: (@Composable () -> Unit)? = null,
    action: (@Composable () -> Unit)? = null,
) {
    Box(modifier.fillMaxSize().padding(horizontal = 32.dp, vertical = 48.dp), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 420.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when {
                art != null -> art()
                icon != null -> Box(
                    Modifier.size(72.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
                    contentAlignment = Alignment.Center,
                ) { Icon(icon, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.primary) }
            }
            Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
            body?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            action?.let { Box(Modifier.padding(top = 8.dp)) { it() } }
        }
    }
}
