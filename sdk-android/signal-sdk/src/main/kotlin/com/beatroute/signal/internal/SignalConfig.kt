package com.beatroute.signal.internal

import android.content.Context
import com.beatroute.signal.SessionProvider
import kotlinx.coroutines.CoroutineScope
import okhttp3.HttpUrl

/**
 * Resolved runtime state for an initialized SDK.
 *
 * Built once by `Signal.init` and stored in a nullable holder there; every public
 * hook reads it through a `val s = state ?: return` guard so calls before init are
 * silent no-ops. Holds the resolved base URL + app key, the host [SessionProvider],
 * the constructed internal clients, and the SDK-owned [scope] (M3-D16: a single
 * supervised scope so one thrown coroutine never crashes the host).
 */
internal class SignalState(
    val applicationContext: Context,
    val baseUrl: HttpUrl,
    val appKey: String,
    val sessionProvider: SessionProvider,
    val eligibilityClient: EligibilityClient,
    val feedbackClient: FeedbackClient,
    val scope: CoroutineScope,
)
