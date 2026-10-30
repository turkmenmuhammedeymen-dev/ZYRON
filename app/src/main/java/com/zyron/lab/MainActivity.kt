package com.zyron.lab

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Ink = Color(0xFF090D16)
private val Panel = Color(0xFF141C2B)
private val Accent = Color(0xFF61D8C5)
private val Muted = Color(0xFF9AA8BC)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { ZyronApp() }
    }
}

@Composable
private fun ZyronApp() {
    var selected by remember { mutableStateOf("Overview") }
    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = Ink) {
            Column(modifier = Modifier.fillMaxSize().padding(22.dp)) {
                Text("ZYRON", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Black)
                Text("BEYOND THE GAME", color = Accent, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
                Spacer(Modifier.height(28.dp))
                Text("Your local testing workspace", color = Color.White, fontSize = 23.sp, fontWeight = FontWeight.Bold)
                Text("Tools for projects and data you own or are authorized to test.", color = Muted, fontSize = 13.sp)
                Spacer(Modifier.height(22.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("Overview", "Test Lab", "File Lab").forEach { tab ->
                        val active = selected == tab
                        Text(
                            tab,
                            modifier = Modifier
                                .background(if (active) Accent.copy(alpha = .18f) else Panel, RoundedCornerShape(12.dp))
                                .clickable { selected = tab }
                                .padding(horizontal = 13.dp, vertical = 10.dp),
                            color = if (active) Accent else Muted,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
                Spacer(Modifier.height(20.dp))
                when (selected) {
                    "Test Lab" -> ModulePanel("Test Lab", "Experiment with ZYRON-owned sample data in an isolated local workspace.", "Local test workspace")
                    "File Lab" -> ModulePanel("File Lab", "Review files that you explicitly select for the app.", "File picker integration planned")
                    else -> {
                        Text("WORKSPACE", color = Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
                        Spacer(Modifier.height(12.dp))
                        ModulePanel("Test Lab", "Experiment with ZYRON sample data in an isolated local workspace.", "Open Test Lab")
                        Spacer(Modifier.height(12.dp))
                        ModulePanel("File Lab", "Review files you choose to share with the app.", "Open File Lab")
                        Spacer(Modifier.height(12.dp))
                        ModulePanel("Diagnostics", "Review ZYRON app status and local diagnostic information.", "View diagnostics")
                    }
                }
                Spacer(Modifier.weight(1f))
                Text("ZYRON  •  VERSION 1.0.0", color = Muted, fontSize = 10.sp)
            }
        }
    }
}

@Composable
private fun ModulePanel(title: String, description: String, action: String) {
    Column(modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(18.dp)) {
        Text(title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(description, color = Muted, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        Text(action, color = Accent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}
