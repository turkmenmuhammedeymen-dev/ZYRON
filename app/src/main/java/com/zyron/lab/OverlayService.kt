package com.zyron.lab

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs

/**
 * Memory Lab'in oyunun üstünde duran yüzen penceresi: küçük bir baloncuk, dokununca açılan panel.
 * Panel, aynı web arayüzünü (index.html?overlay=1) ve aynı çekirdeği kullanır.
 * Gereken izinler: "Diğer uygulamaların üzerinde göster" (SYSTEM_ALERT_WINDOW) ve bildirim (ön plan servisi).
 */
class OverlayService : Service() {
    private var windowManager: WindowManager? = null
    private var rootView: FrameLayout? = null
    private var bubble: TextView? = null
    private var panel: LinearLayout? = null
    private var webView: WebView? = null
    private var params: WindowManager.LayoutParams? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        if (rootView == null) {
            if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
                stopSelf()
                return START_NOT_STICKY
            }
            createOverlay()
        }
        return START_NOT_STICKY
    }

    private fun startAsForeground() {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    @Suppress("DEPRECATION")
    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "ZYRON Memory Lab", NotificationManager.IMPORTANCE_LOW)
            )
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("ZYRON Memory Lab")
            .setContentText("Yüzen pencere açık")
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setOngoing(true)
            .build()
    }

    @Suppress("DEPRECATION")
    private fun overlayType(): Int =
        if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else WindowManager.LayoutParams.TYPE_PHONE

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun createOverlay() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        windowManager = wm
        val dm = resources.displayMetrics
        val density = dm.density
        fun dp(v: Int): Int = (v * density).toInt()

        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = dp(8)
        lp.y = (dm.heightPixels * 0.25).toInt()
        params = lp

        val root = FrameLayout(this)
        rootView = root

        // --- baloncuk ---
        val b = TextView(this)
        b.text = "Z"
        b.setTextColor(Color.rgb(125, 244, 213))
        b.textSize = 22f
        b.gravity = Gravity.CENTER
        val bg = GradientDrawable()
        bg.shape = GradientDrawable.OVAL
        bg.setColor(Color.rgb(16, 36, 36))
        bg.setStroke(dp(2), Color.rgb(125, 244, 213))
        b.background = bg
        root.addView(b, FrameLayout.LayoutParams(dp(52), dp(52)))
        bubble = b
        attachDrag(b)
        b.setOnClickListener { setExpanded(true) }

        // --- panel ---
        val p = LinearLayout(this)
        p.orientation = LinearLayout.VERTICAL
        p.setBackgroundColor(Color.rgb(7, 11, 18))
        val header = LinearLayout(this)
        header.orientation = LinearLayout.HORIZONTAL
        header.setBackgroundColor(Color.rgb(16, 36, 36))
        header.gravity = Gravity.CENTER_VERTICAL
        val title = TextView(this)
        title.text = "  ZYRON Memory Lab  (sürükle)"
        title.setTextColor(Color.rgb(125, 244, 213))
        title.textSize = 13f
        header.addView(title, LinearLayout.LayoutParams(0, dp(40), 1f))
        attachDrag(title)
        val minimize = TextView(this)
        minimize.text = "—"
        minimize.setTextColor(Color.WHITE)
        minimize.textSize = 20f
        minimize.gravity = Gravity.CENTER
        minimize.setOnClickListener { setExpanded(false) }
        header.addView(minimize, LinearLayout.LayoutParams(dp(48), dp(40)))
        val close = TextView(this)
        close.text = "✕"
        close.setTextColor(Color.rgb(255, 141, 152))
        close.textSize = 18f
        close.gravity = Gravity.CENTER
        close.setOnClickListener { stopSelf() }
        header.addView(close, LinearLayout.LayoutParams(dp(48), dp(40)))
        p.addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)))

        val web = WebView(applicationContext)
        web.setBackgroundColor(Color.rgb(7, 11, 18))
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.settings.allowContentAccess = false
        web.settings.allowFileAccessFromFileURLs = false
        web.settings.allowUniversalAccessFromFileURLs = false
        web.webViewClient = object : WebViewClient() {
            @Deprecated("Needed for API 23")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean =
                url == null || !url.startsWith(LOCAL_ROOT)

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val u = request?.url?.toString()
                return u == null || !u.startsWith(LOCAL_ROOT)
            }
        }
        web.addJavascriptInterface(
            MemoryBridge(applicationContext, MemoryCore.get(applicationContext), web, null), "ZyronMem"
        )
        web.loadUrl(LOCAL_ROOT + "index.html?overlay=1")
        webView = web
        p.addView(web, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        p.visibility = View.GONE
        root.addView(
            p,
            FrameLayout.LayoutParams((dm.widthPixels * 0.94).toInt(), (dm.heightPixels * 0.62).toInt())
        )
        panel = p

        wm.addView(root, lp)
    }

    private fun setExpanded(on: Boolean) {
        bubble?.visibility = if (on) View.GONE else View.VISIBLE
        panel?.visibility = if (on) View.VISIBLE else View.GONE
        val p = params ?: return
        // Panel açıkken klavye girişi için pencere odaklanabilir olmalı; baloncukken oyuna dokunuşlar geçsin.
        p.flags = if (on) {
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        } else {
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        }
        p.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        try {
            windowManager?.updateViewLayout(rootView, p)
        } catch (e: Exception) {
            // pencere zaten kaldırılmış olabilir
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun attachDrag(handle: View) {
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        var moved = false
        handle.setOnTouchListener { v, e ->
            val p = params
            if (p == null) {
                false
            } else {
                when (e.action) {
                    MotionEvent.ACTION_DOWN -> {
                        startX = p.x
                        startY = p.y
                        touchX = e.rawX
                        touchY = e.rawY
                        moved = false
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dx = (e.rawX - touchX).toInt()
                        val dy = (e.rawY - touchY).toInt()
                        if (abs(dx) > 8 || abs(dy) > 8) moved = true
                        p.x = startX + dx
                        p.y = startY + dy
                        try {
                            windowManager?.updateViewLayout(rootView, p)
                        } catch (ex: Exception) {
                            // yoksay
                        }
                        true
                    }
                    MotionEvent.ACTION_UP -> {
                        if (!moved) v.performClick()
                        true
                    }
                    else -> false
                }
            }
        }
    }

    override fun onDestroy() {
        try {
            val r = rootView
            if (r != null) windowManager?.removeView(r)
        } catch (e: Exception) {
            // yoksay
        }
        rootView = null
        webView?.stopLoading()
        webView?.loadUrl("about:blank")
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    private companion object {
        const val NOTIF_ID = 7302
        const val CHANNEL_ID = "zyron_memlab_overlay"
        const val LOCAL_ROOT = "file:///android_asset/www/"
    }
}
