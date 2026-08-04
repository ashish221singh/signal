package com.beatroute.signal.ui

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.DialogFragment
import com.beatroute.signal.R
import com.beatroute.signal.internal.SignalBridge
import com.beatroute.signal.internal.SignalJson
import kotlinx.serialization.builtins.serializer

/**
 * The WebView shell that hosts the bundled `@signal/web-core` (F2-D3/D13/D14).
 *
 * It loads the local `assets/web-core/sheet.html` harness, waits for the JS `ready`
 * signal, then injects the **raw** eligibility config JSON (relayed as-is — native
 * does NOT parse the full config, GR-2). All impure sheet intents cross the bridge
 * as JSON via [SignalBridge] (`@JavascriptInterface`); this fragment implements the
 * native side of that bridge (submit/dismiss/openUrl/openReview/resize) and routes
 * the sheet's photo `<input type=file>` to the system picker via
 * [WebChromeClient.onShowFileChooser] so web-core can PUT the file itself (GR-3).
 *
 * A missing WebView, a JS crash, or a show-after-state-loss is swallowed — the SDK
 * never crashes the host (F2-D10 / Android specifics).
 */
internal class WebViewSheetFragment : DialogFragment() {

    /** The raw eligibility config JSON to hand to web-core, decoded from [arguments]. */
    private val configJson: String? get() = arguments?.getString(ARG_CONFIG_JSON)

    /** The bridge object exposed to JS. Set by the presenter before [show]. */
    internal var bridge: SignalBridge? = null

    private var webView: WebView? = null

    /** In-flight file-chooser callback for the photo `<input type=file>`. */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /**
     * System file picker launcher for [WebChromeClient.onShowFileChooser]. Registered in
     * [onCreate] (before STARTED). The picked content Uri is handed straight back to the
     * WebView so web-core reads the file and performs its own downscale + presign + PUT.
     */
    private var fileChooserLauncher: ActivityResultLauncher<Array<String>>? = null

    override fun getTheme(): Int = R.style.Theme_Signal_WebSheetDialog

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.OpenDocument(),
        ) { uri ->
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(if (uri != null) arrayOf(uri) else emptyArray())
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        // A full-bleed transparent container; web-core paints its own backdrop + card.
        val root = FrameLayout(requireContext()).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        val wv = createWebView()
        webView = wv
        root.addView(wv)
        return root
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView = WebView(requireContext()).apply {
        layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        setBackgroundColor(0x00000000) // transparent so the host shows through the backdrop
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true

        val theBridge = bridge
        if (theBridge != null) {
            // @JavascriptInterface surface consumed by sheet.html (name must match).
            addJavascriptInterface(theBridge, BRIDGE_NAME)
        }

        webViewClient = object : WebViewClient() {
            // Keep every navigation inside the WebView except real external links, which
            // should never occur from the local harness; external URLs go through the
            // bridge's openUrl instead. Deny any unexpected top-level navigation.
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                if (url.scheme == "file") return false // our local harness/assets
                return true // block anything else from taking over the WebView
            }
        }

        webChromeClient = object : WebChromeClient() {
            // Route the sheet's photo <input type=file> to the native system picker.
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                // Cancel any prior in-flight pick before starting a new one.
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val types = params.acceptTypes.filter { it.isNotBlank() }
                    .ifEmpty { listOf("image/*") }
                    .toTypedArray()
                return try {
                    fileChooserLauncher?.launch(types)
                    true
                } catch (_: Throwable) {
                    filePathCallback = null
                    false
                }
            }
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        // The bridge needs a way to (a) inject the config after READY, (b) resize the
        // dialog, (c) close the sheet — all of which route back through this fragment.
        bridge?.attach(
            SignalBridge.Ui(
                injectConfig = { injectConfig() },
                requestClose = { dismissSafely() },
            ),
        )
        // Load the local harness. When the bundle is live it fires READY -> injectConfig.
        webView?.loadUrl(HARNESS_URL)
    }

    /** Push the raw config into the WebView once JS is ready (host -> core INIT). */
    private fun injectConfig() {
        val json = configJson ?: run { dismissSafely(); return }
        // The harness's SignalSheet.init takes the raw config JSON *string* and JSON.parses
        // it. Encode the raw JSON as a JS string literal by JSON-encoding it once more
        // (kotlinx handles all escaping: quotes, backslashes, control + line-separator
        // chars), yielding a safe literal to pass verbatim.
        val jsStringLiteral = SignalJson.encodeToString(String.serializer(), json)
        webView?.evaluateJavascript(
            "window.SignalSheet && SignalSheet.init($jsStringLiteral);",
            null,
        )
    }

    /** Dismiss without ever throwing on a saved-state host. */
    internal fun dismissSafely() {
        runCatching { dismissAllowingStateLoss() }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        webView?.let {
            it.stopLoading()
            it.removeJavascriptInterface(BRIDGE_NAME)
            it.destroy()
        }
        webView = null
    }

    companion object {
        const val SHEET_TAG = "signal_web_sheet"
        const val BRIDGE_NAME = "SignalBridge"
        private const val ARG_CONFIG_JSON = "com.beatroute.signal.ARG_CONFIG_JSON"
        private const val HARNESS_URL = "file:///android_asset/web-core/sheet.html"

        /** Build a fragment whose raw config JSON is packed into [arguments]. */
        fun newInstance(rawConfigJson: String): WebViewSheetFragment =
            WebViewSheetFragment().apply {
                arguments = Bundle().apply { putString(ARG_CONFIG_JSON, rawConfigJson) }
            }
    }
}
