package com.zyron.lab

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

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
        memoryBridge = MemoryBridge(this, webView).also { webView.addJavascriptInterface(it, "ZyronMem") }
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

    @Deprecated("Deprecated in Android, retained for broad device compatibility")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        memoryBridge?.shutdown()
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
