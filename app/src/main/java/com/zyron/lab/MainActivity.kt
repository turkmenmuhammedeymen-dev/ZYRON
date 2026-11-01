package com.zyron.lab

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var memoryBridge: MemoryBridge? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this).apply {
            setBackgroundColor(android.graphics.Color.rgb(7, 11, 18))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                // Required for the user-selected ACTION_OPEN_DOCUMENT content URI.
                allowContentAccess = true
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
                allowFileAccessFromFileURLs = false
                allowUniversalAccessFromFileURLs = false
            }
            // Memory Lab köprüsü root yetkili çekirdeğe konuşur; bu yüzden WebView yalnızca
            // paketlenmiş yerel sayfayı gösterir, dış adreslere gitmesine izin verilmez.
            webViewClient = object : WebViewClient() {
                private fun isLocal(url: String?) = url != null && url.startsWith(LOCAL_ROOT)

                @Deprecated("Needed for API 23")
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = !isLocal(url)

                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                    !isLocal(request?.url?.toString())
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView?,
                    callback: ValueCallback<Array<Uri>>?,
                    params: FileChooserParams?
                ): Boolean {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = callback ?: return false
                    return try {
                        val intent = params?.createIntent() ?: Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                        }
                        startActivityForResult(intent, FILE_CHOOSER_REQUEST)
                        true
                    } catch (_: Exception) {
                        fileChooserCallback?.onReceiveValue(null)
                        fileChooserCallback = null
                        false
                    }
                }
            }
        }
        memoryBridge = MemoryBridge(this, MemoryCore.get(this), webView) { runOnUiThread { openOverlay() } }
            .also { webView.addJavascriptInterface(it, "ZyronMem") }
        webView.loadUrl(LOCAL_ROOT + "index.html")
        setContentView(webView)
    }

    @Deprecated("Deprecated in Android, retained for broad device compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_CHOOSER_REQUEST) return
        val result = if (resultCode == RESULT_OK && data?.data != null) arrayOf(data.data!!) else null
        fileChooserCallback?.onReceiveValue(result)
        fileChooserCallback = null
    }

    /** Memory Lab'in yüzen penceresini açar; gerekirse önce "üstte göster" iznini ister. */
    private fun openOverlay() {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "ZYRON için \"Diğer uygulamaların üzerinde göster\" iznini aç, sonra tekrar dene.", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 7303)
        }
        val intent = Intent(this, OverlayService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        Toast.makeText(this, "Yüzen pencere açıldı. Oyunu aç ve Z baloncuğuna dokun.", Toast.LENGTH_LONG).show()
    }

    @Deprecated("Deprecated in Android, retained for broad device compatibility")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        memoryBridge = null
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.destroy()
        }
        super.onDestroy()
    }

    private companion object {
        const val FILE_CHOOSER_REQUEST = 7301
        const val LOCAL_ROOT = "file:///android_asset/www/"
    }
}
