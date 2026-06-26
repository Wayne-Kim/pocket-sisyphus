package com.pocketsisyphus.android.ui.sessions

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.AgentInfo
import com.pocketsisyphus.android.ui.components.RepoPathField
import com.pocketsisyphus.android.ui.theme.PsColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionSheet(
    creating: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onCreate: (repoPath: String, title: String?, agent: String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var repoPath by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var agent by remember { mutableStateOf("claude_code") }

    // Agents advertised by the daemon (claude_code / agy / codex / copilot / local_llm / opencode /
    // shell …) — dynamic like iOS so every installed adapter is offered. Empty ⇒ static fallback.
    var agentInfos by remember { mutableStateOf<List<AgentInfo>>(emptyList()) }
    LaunchedEffect(Unit) { agentInfos = runCatching { Ps.api.agents() }.getOrDefault(emptyList()) }
    val agentOptions: List<Pair<String, String>> = if (agentInfos.isNotEmpty()) {
        agentInfos.map { it.id to it.displayName }
    } else {
        listOf(
            "claude_code" to "Claude Code",
            "codex" to "Codex",
            "copilot" to "Copilot",
            "shell" to "Terminal",
        )
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.new_session_title), style = MaterialTheme.typography.titleLarge)

            RepoPathField(
                value = repoPath,
                onValueChange = { repoPath = it },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text(stringResource(R.string.new_session_title_optional)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Text(stringResource(R.string.backlog_agent), style = MaterialTheme.typography.labelLarge)
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                agentOptions.forEach { (id, label) ->
                    FilterChip(
                        selected = agent == id,
                        onClick = { agent = id },
                        label = { Text(label) },
                    )
                }
            }

            error?.let { Text(it, color = PsColor.danger, style = MaterialTheme.typography.bodySmall) }

            Button(
                onClick = { onCreate(repoPath, title, agent) },
                enabled = repoPath.isNotBlank() && !creating,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (creating) {
                    CircularProgressIndicator(
                        modifier = Modifier.height(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.height(0.dp))
                    Text("  " + stringResource(R.string.new_session_creating))
                } else {
                    Text(stringResource(R.string.new_session_create))
                }
            }
        }
    }
}
