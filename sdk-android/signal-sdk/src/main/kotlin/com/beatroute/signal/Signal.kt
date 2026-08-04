package com.beatroute.signal

import android.app.Application
import android.content.Context
import android.util.Log
import com.beatroute.signal.internal.ActivityTracker
import com.beatroute.signal.internal.EligibilityClient
import com.beatroute.signal.internal.FeedbackClient
import com.beatroute.signal.internal.LocalSuppressionCache
import com.beatroute.signal.internal.SignalState
import com.beatroute.signal.internal.WebSheetPresenter
import com.beatroute.signal.internal.outbox.OutboxDatabase
import com.beatroute.signal.internal.outbox.OutboxDependencies
import com.beatroute.signal.internal.runTrigger
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl

/**
 * The entire public surface of the Signal SDK.
 *
 * After the F2 refit the surface is exactly [init] and [trackEvent] (the event model;
 * F2-D3). Screen-dwell hooks were removed with the native sheet — the SDK fires on
 * named events only. Every hook is a silent no-op before [init] and never throws — the
 * SDK must never crash a host that forgot (or chose not) to init.
 *
 * When eligible, [trackEvent] shows the feedback sheet as a WebView hosting the bundled
 * `@signal/web-core` (F2-D13/D14); native forwards the raw eligibility config unparsed
 * (GR-2) and bridges the sheet's impure intents over `@JavascriptInterface`.
 */
object Signal {

    /**
     * Resolved runtime state, or `null` before [init] / after teardown.
     * `internal` so same-module tests can assert on initialization.
     */
    internal var state: SignalState? = null

    /**
     * The activity tracker registered on the host [Application] (production wiring). Held
     * so a re-init / [resetForTest] can unregister it and avoid stacking callbacks.
     */
    private var activityTracker: ActivityTracker? = null

    /**
     * Initialize the SDK. Idempotent: calling again cancels the previous scope and
     * rebuilds state, so a host may safely re-init on identity change.
     *
     * @param context any [Context]; the application context is retained to avoid
     *   leaking an Activity.
     * @param environment fixes the base URL + app key (M3-D12).
     * @param sessionProvider host-owned source of identity, resolved per call (M3-D10).
     * @param baseUrlOverride overrides [environment]'s base URL — for tests / local
     *   dev (e.g. `http://10.0.2.2:3000/`).
     * @param appKeyOverride overrides [environment]'s app key — for tests / local dev.
     */
    fun init(
        context: Context,
        environment: SignalEnvironment,
        sessionProvider: SessionProvider,
        baseUrlOverride: String? = null,
        appKeyOverride: String? = null,
    ) {
        // Idempotent re-init: tear down the previous supervised scope + tracker first.
        state?.scope?.cancel()
        (context.applicationContext as? Application)?.let { app ->
            activityTracker?.let { app.unregisterActivityLifecycleCallbacks(it) }
        }
        activityTracker = null

        val baseUrl = (baseUrlOverride ?: environment.baseUrl).toHttpUrl()
        val appKey = appKeyOverride ?: environment.appKey
        val appContext = context.applicationContext

        // M3-D16: one SDK-owned supervised scope; a single thrown coroutine can
        // never propagate to sibling work or crash the host. The handler is
        // defense-in-depth — call sites also wrap flows in runCatching.
        val handler = CoroutineExceptionHandler { _, t ->
            Log.w("Signal", "Swallowed uncaught coroutine failure", t)
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + handler)

        // Precious outbox wiring (M3-D7): the worker pulls its collaborators from the
        // process-global holder, so populate it here.
        val outboxDb = OutboxDatabase.create(appContext)
        OutboxDependencies.dao = outboxDb.outboxDao()
        OutboxDependencies.feedback = FeedbackClient(baseUrl, appKey)

        val suppressionCache = LocalSuppressionCache.create(appContext)
        val clock: () -> Long = System::currentTimeMillis

        // Find the host's current FragmentManager without leaking an Activity.
        val tracker = ActivityTracker()
        (appContext as? Application)?.registerActivityLifecycleCallbacks(tracker)
        activityTracker = tracker

        state = SignalState(
            applicationContext = appContext,
            baseUrl = baseUrl,
            appKey = appKey,
            sessionProvider = sessionProvider,
            eligibility = EligibilityClient(baseUrl, appKey),
            suppressionCache = suppressionCache,
            sheetPresenter = WebSheetPresenter(
                context = appContext,
                sessionProvider = sessionProvider,
                suppressionCache = suppressionCache,
                clock = clock,
                scope = scope,
                host = tracker,
            ),
            feedbackClient = FeedbackClient(baseUrl, appKey),
            scope = scope,
            clock = clock,
        )
    }

    /**
     * Action hook — signals a meaningful in-app event (e.g. `"order_completion"`).
     * When a workflow matches and eligibility passes, the WebView feedback sheet is
     * shown. No-op before [init]; never throws into the host (F2-D10).
     */
    fun trackEvent(eventName: String) {
        val s = state ?: return // no-op before init
        s.scope.launch {
            // M3-D16: never let a trigger failure escape into the host.
            runCatching { runTrigger(s, eventName) }
        }
    }

    /** Same-module visibility for tests: has the SDK been initialized? */
    internal fun isInitialized(): Boolean = state != null

    /** Test-only teardown: cancel the scope and drop state so tests stay isolated. */
    internal fun resetForTest() {
        state?.scope?.cancel()
        (state?.applicationContext as? Application)?.let { app ->
            activityTracker?.let { app.unregisterActivityLifecycleCallbacks(it) }
        }
        activityTracker = null
        OutboxDependencies.dao = null
        OutboxDependencies.feedback = null
        state = null
    }
}
