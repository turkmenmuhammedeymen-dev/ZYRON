package com.zyron.lab

import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

private val Ink = Color(0xFF080D17)
private val Panel = Color(0xFF141E2D)
private val Accent = Color(0xFF63E0C8)
private val Muted = Color(0xFF9AAAC0)
private val Danger = Color(0xFFFF7D86)

data class TestValue(val id: Long, val key: String, val value: String, val type: String)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { ZyronApp() }
    }
}

@Composable
private fun ZyronApp() {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("zyron_local_lab", android.content.Context.MODE_PRIVATE) }
    val entries = remember { mutableStateListOf<TestValue>() }
    var selectedTab by remember { mutableStateOf("Overview") }
    var search by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("All") }
    var newKey by remember { mutableStateOf("") }
    var newValue by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<TestValue?>(null) }
    var editValue by remember { mutableStateOf("") }
    var fileName by remember { mutableStateOf("No file selected") }
    var filePreview by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Local workspace ready") }
    var history by remember { mutableStateOf(listOf<String>()) }
    var profileName by remember { mutableStateOf("") }
    var profiles by remember { mutableStateOf(listOf<String>()) }
    var showSaveProfile by remember { mutableStateOf(false) }
    var showLoadProfile by remember { mutableStateOf(false) }
    var minNumber by remember { mutableStateOf("") }
    var maxNumber by remember { mutableStateOf("") }

    fun log(message: String) {
        history = (listOf("${System.currentTimeMillis()} • $message") + history).take(60)
        status = message
        prefs.edit().putString("history", history.joinToString("\n")).apply()
    }
    fun persist() {
        val array = JSONArray()
        entries.forEach { item ->
            array.put(JSONObject().put("id", item.id).put("key", item.key).put("value", item.value).put("type", item.type))
        }
        prefs.edit().putString("values", array.toString()).apply()
    }
    fun saveProfile(name: String) {
        val clean = name.trim()
        if (clean.isBlank()) { status = "Profile name is required"; return }
        val all = runCatching { JSONObject(prefs.getString("profiles", "{}") ?: "{}") }.getOrElse { JSONObject() }
        val snapshot = JSONArray()
        entries.forEach { snapshot.put(JSONObject().put("id", it.id).put("key", it.key).put("value", it.value).put("type", it.type)) }
        all.put(clean, snapshot)
        prefs.edit().putString("profiles", all.toString()).apply()
        profiles = (0 until all.length()).map { all.names()?.optString(it) ?: "" }.filter { it.isNotBlank() }
        log("Saved profile: $clean")
    }
    fun loadProfile(name: String) {
        runCatching {
            val all = JSONObject(prefs.getString("profiles", "{}") ?: "{}")
            val snapshot = all.getJSONArray(name)
            val loaded = mutableListOf<TestValue>()
            for (i in 0 until snapshot.length()) {
                val o = snapshot.getJSONObject(i)
                loaded.add(TestValue(o.optLong("id", System.currentTimeMillis() + i), o.getString("key"), o.getString("value"), o.optString("type", "TEXT")))
            }
            entries.clear(); entries.addAll(loaded); persist(); log("Loaded profile: $name")
        }.onFailure { status = "Could not load profile: ${it.message ?: "invalid profile"}" }
    }
    fun importJson(raw: String) {
        runCatching {
            val array = JSONArray(raw)
            val incoming = mutableListOf<TestValue>()
            for (i in 0 until array.length()) {
                val o = array.getJSONObject(i)
                val key = o.optString("key").trim()
                val value = o.optString("value")
                require(key.isNotBlank() && value.isNotBlank()) { "Each entry needs key and value" }
                val type = if (value.toLongOrNull() != null) "INTEGER" else if (value.toDoubleOrNull() != null) "DECIMAL" else "TEXT"
                incoming.add(TestValue(System.currentTimeMillis() + i, key, value, type))
            }
            require(incoming.isNotEmpty()) { "No values found" }
            val merged = (incoming + entries).distinctBy { it.key.lowercase() }
            entries.clear(); entries.addAll(merged); persist(); log("Imported ${incoming.size} JSON values")
        }.onFailure { status = "JSON import failed: ${it.message ?: "invalid JSON"}" }
    }
    fun addValue(key: String, value: String) {
        if (key.isBlank() || value.isBlank()) {
            status = "Enter both a name and a value"
            return
        }
        if (entries.any { it.key.equals(key.trim(), true) }) {
            status = "A value with this name already exists"
            return
        }
        val type = if (value.toLongOrNull() != null) "INTEGER" else if (value.toDoubleOrNull() != null) "DECIMAL" else "TEXT"
        entries.add(0, TestValue(System.currentTimeMillis(), key.trim(), value.trim(), type))
        persist()
        log("Added local value: ${key.trim()}")
    }

    LaunchedEffect(Unit) {
        val raw = prefs.getString("values", null)
        if (!raw.isNullOrBlank()) runCatching {
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                entries.add(TestValue(obj.optLong("id"), obj.optString("key"), obj.optString("value"), obj.optString("type", "TEXT")))
            }
        }
        history = prefs.getString("history", "")?.lines()?.filter { it.isNotBlank() } ?: emptyList()
        val savedProfiles = runCatching { JSONObject(prefs.getString("profiles", "{}") ?: "{}") }.getOrElse { JSONObject() }
        profiles = (0 until savedProfiles.length()).map { savedProfiles.names()?.optString(it) ?: "" }.filter { it.isNotBlank() }
        if (entries.isEmpty()) {
            entries.addAll(listOf(
                TestValue(1, "coins_demo", "12500", "INTEGER"),
                TestValue(2, "speed_demo", "72.5", "DECIMAL"),
                TestValue(3, "player_label", "ZYRON Tester", "TEXT"),
                TestValue(4, "level_demo", "18", "INTEGER")
            ))
            persist()
        }
    }

    val openFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) {
            runCatching {
                val text = context.contentResolver.openInputStream(uri)?.use { input ->
                    BufferedReader(InputStreamReader(input)).readText().take(12000)
                } ?: "Unable to read this file"
                fileName = uri.lastPathSegment ?: "Selected document"
                filePreview = text
                log("Opened user-selected document: $fileName")
            }.onFailure { status = "File read failed: ${it.message ?: "unknown error"}" }
        }
    }
    val saveFile = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri: Uri? ->
        if (uri != null) {
            runCatching {
                val array = JSONArray()
                entries.forEach { array.put(JSONObject().put("key", it.key).put("value", it.value).put("type", it.type)) }
                context.contentResolver.openOutputStream(uri)?.use { it.write(array.toString(2).toByteArray()) }
                log("Exported ${entries.size} local values")
            }.onFailure { status = "Export failed: ${it.message ?: "unknown error"}" }
        }
    }

    MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Ink, surface = Panel)) {
        Surface(Modifier.fillMaxSize(), color = Ink) {
            Column(Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 16.dp)) {
                Text("ZYRON", color = Color.White, fontSize = 29.sp, fontWeight = FontWeight.Black, letterSpacing = 2.sp)
                Text("BEYOND THE GAME  •  LOCAL TESTING SUITE", color = Accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
                Spacer(Modifier.height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    listOf("Overview", "Test Lab", "File Lab", "Diagnostics").forEach { tab ->
                        FilterChip(selected = selectedTab == tab, onClick = { selectedTab = tab }, label = { Text(tab, fontSize = 11.sp) })
                    }
                }
                Spacer(Modifier.height(14.dp))
                Text(status, color = Muted, fontSize = 11.sp)
                Spacer(Modifier.height(12.dp))
                when (selectedTab) {
                    "Test Lab" -> {
                        Text("LOCAL VALUE LAB", color = Accent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        Text("Manage sample values stored only inside ZYRON.", color = Muted, fontSize = 12.sp)
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(newKey, { newKey = it }, Modifier.fillMaxWidth(), label = { Text("Value name") }, singleLine = true)
                        Spacer(Modifier.height(6.dp))
                        OutlinedTextField(newValue, { newValue = it }, Modifier.fillMaxWidth(), label = { Text("Value (number or text)") }, singleLine = true)
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { addValue(newKey, newValue); if (status.startsWith("Added")) { newKey = ""; newValue = "" } }) { Text("Add value") }
                            OutlinedButton(onClick = { saveFile.launch("zyron-values.json") }) { Text("Export JSON") }
                        }
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(search, { search = it }, Modifier.fillMaxWidth(), label = { Text("Search by name or value") }, singleLine = true)
                        Spacer(Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf("All", "Exact", "Numbers", "Integer", "Decimal", "Text").forEach { option ->
                                FilterChip(selected = filter == option, onClick = { filter = option }, label = { Text(option) })
                            }
                        }
                        val visible = entries.filter { item ->
                            val matches = search.isBlank() || item.key.contains(search, true) || item.value.contains(search, true)
                            val numeric = item.value.toDoubleOrNull()
                            val rangeMatches = (minNumber.isBlank() || (numeric != null && numeric >= (minNumber.toDoubleOrNull() ?: Double.NEGATIVE_INFINITY))) &&
                                (maxNumber.isBlank() || (numeric != null && numeric <= (maxNumber.toDoubleOrNull() ?: Double.POSITIVE_INFINITY)))
                            matches && rangeMatches && when (filter) {
                                "Exact" -> search.isNotBlank() && item.value.equals(search, true)
                                "Numbers" -> item.type == "INTEGER" || item.type == "DECIMAL"
                                "Text" -> item.type == "TEXT"
                                "Integer" -> item.type == "INTEGER"
                                "Decimal" -> item.type == "DECIMAL"
                                else -> true
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(minNumber, { minNumber = it }, Modifier.weight(1f), label = { Text("Min") }, singleLine = true)
                            OutlinedTextField(maxNumber, { maxNumber = it }, Modifier.weight(1f), label = { Text("Max") }, singleLine = true)
                        }
                        Spacer(Modifier.height(8.dp))
                        Text("${visible.size} MATCHES  •  ${entries.size} TOTAL", color = Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 20.dp)) {
                            items(visible, key = { it.id }) { item ->
                                ValueCard(item,
                                    onEdit = { editing = item; editValue = item.value },
                                    onDelete = { entries.remove(item); persist(); log("Deleted local value: ${item.key}") },
                                    onPlus = { adjust(item, 1, entries, ::persist, ::log) },
                                    onMinus = { adjust(item, -1, entries, ::persist, ::log) }
                                )
                            }
                        }
                    }
                    "File Lab" -> {
                        Text("FILE INSPECTOR", color = Accent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        Text("Only documents you explicitly select are opened. ZYRON does not browse other apps' private files.", color = Muted, fontSize = 12.sp)
                        Spacer(Modifier.height(14.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { openFile.launch(arrayOf("text/*", "application/json", "application/xml")) }) { Text("Choose file") }
                            OutlinedButton(onClick = { importJson(filePreview) }, enabled = filePreview.isNotBlank()) { Text("Import JSON") }
                        }
                        Text(fileName, color = Color.White, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(8.dp))
                        Surface(color = Panel, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().weight(1f, fill = false)) {
                            Text(if (filePreview.isBlank()) "Selected file content will appear here (up to 12 KB)." else filePreview,
                                Modifier.padding(14.dp), color = Muted, fontSize = 11.sp)
                        }
                    }
                    "Diagnostics" -> {
                        Text("DEVICE & APP DIAGNOSTICS", color = Accent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        InfoRow("Android", Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")")
                        InfoRow("Device", Build.MANUFACTURER + " " + Build.MODEL)
                        InfoRow("App package", context.packageName)
                        InfoRow("Local values", entries.size.toString())
                        InfoRow("Recent events", history.size.toString())
                        Spacer(Modifier.height(12.dp))
                        Text("ACTIVITY HISTORY", color = Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                        LazyColumn(Modifier.heightIn(max = 280.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            items(history) { Text(it, color = Muted, fontSize = 10.sp) }
                        }
                    }
                    else -> {
                        Text("YOUR PRIVATE TEST WORKSPACE", color = Accent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        Text("A focused toolkit for data and files you own or are authorized to test.", color = Color.White, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(14.dp))
                        InfoRow("Local test values", entries.size.toString())
                        InfoRow("History events", history.size.toString())
                        InfoRow("Storage", "On-device preferences")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { showSaveProfile = true }) { Text("Save profile") }
                            OutlinedButton(onClick = { showLoadProfile = true }, enabled = profiles.isNotEmpty()) { Text("Load profile") }
                        }
                        Text("Saved profiles: ${profiles.size}", color = Muted, fontSize = 11.sp)
                        Spacer(Modifier.height(12.dp))
                        listOf("Test Lab" to "Add, search, filter, edit and adjust local sample values.", "File Lab" to "Open and preview documents you choose.", "Diagnostics" to "View device information and app activity.").forEach { (title, desc) ->
                            Surface(color = Panel, shape = RoundedCornerShape(15.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                                Column(Modifier.padding(15.dp)) {
                                    Text(title, color = Color.White, fontWeight = FontWeight.Bold)
                                    Text(desc, color = Muted, fontSize = 11.sp)
                                    Text("OPEN  →", color = Accent, fontSize = 10.sp, modifier = Modifier.padding(top = 8.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (showSaveProfile) AlertDialog(
        onDismissRequest = { showSaveProfile = false },
        title = { Text("Save test profile") },
        text = { OutlinedTextField(profileName, { profileName = it }, label = { Text("Profile name") }, singleLine = true) },
        confirmButton = { TextButton(onClick = { saveProfile(profileName); profileName = ""; showSaveProfile = false }) { Text("Save") } },
        dismissButton = { TextButton(onClick = { showSaveProfile = false }) { Text("Cancel") } }
    )
    if (showLoadProfile) AlertDialog(
        onDismissRequest = { showLoadProfile = false },
        title = { Text("Load test profile") },
        text = { Column { profiles.forEach { name -> TextButton(onClick = { loadProfile(name); showLoadProfile = false }) { Text(name) } } } },
        confirmButton = { TextButton(onClick = { showLoadProfile = false }) { Text("Close") } }
    )
    editing?.let { item ->
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit ${item.key}") },
            text = { OutlinedTextField(editValue, { editValue = it }, label = { Text("New value") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text)) },
            confirmButton = {
                TextButton(onClick = {
                    val index = entries.indexOfFirst { it.id == item.id }
                    if (index >= 0 && editValue.isNotBlank()) {
                        val type = if (editValue.toLongOrNull() != null) "INTEGER" else if (editValue.toDoubleOrNull() != null) "DECIMAL" else "TEXT"
                        entries[index] = item.copy(value = editValue, type = type)
                        persist()
                        log("Edited local value: ${item.key}")
                    }
                    editing = null
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } }
        )
    }
}

private fun adjust(item: TestValue, delta: Int, entries: SnapshotStateList<TestValue>, persist: () -> Unit, log: (String) -> Unit) {
    val number = item.value.toLongOrNull()
    if (number == null) {
        log("Numeric adjustment skipped: ${item.key} is not an integer")
        return
    }
    val index = entries.indexOfFirst { it.id == item.id }
    if (index >= 0) {
        entries[index] = item.copy(value = (number + delta).toString())
        persist()
        log("Adjusted local value: ${item.key}")
    }
}

@Composable
private fun ValueCard(item: TestValue, onEdit: () -> Unit, onDelete: () -> Unit, onPlus: () -> Unit, onMinus: () -> Unit) {
    Surface(color = Panel, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(13.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(item.key, color = Color.White, fontWeight = FontWeight.Bold)
                    Text(item.type, color = Muted, fontSize = 9.sp)
                }
                Text(item.value, color = Accent, fontWeight = FontWeight.Bold)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 8.dp)) {
                if (item.type == "INTEGER") {
                    OutlinedButton(onClick = onMinus, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) { Text("−1") }
                    OutlinedButton(onClick = onPlus, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) { Text("+1") }
                }
                TextButton(onClick = onEdit) { Text("Edit") }
                TextButton(onClick = onDelete, colors = ButtonDefaults.textButtonColors(contentColor = Danger)) { Text("Delete") }
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Muted, fontSize = 12.sp)
        Text(value, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}
