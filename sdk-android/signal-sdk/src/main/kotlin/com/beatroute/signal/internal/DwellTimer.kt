package com.beatroute.signal.internal

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal const val DEFAULT_DWELL_MS = 3_000L

/**
 * Fires [onFire] once a screen has been dwelled on for [dwellMs] without leaving.
 * A per-screen [Job] map: entering (re)starts the timer; exiting cancels it.
 * All calls happen on the SDK's main-immediate scope, so the map needs no extra locking.
 */
internal class DwellTimer(
    private val scope: CoroutineScope,
    private val dwellMs: Long = DEFAULT_DWELL_MS,
    private val onFire: suspend (String) -> Unit,
) {
    private val jobs = mutableMapOf<String, Job>()

    fun enter(screenId: String) {
        jobs.remove(screenId)?.cancel() // re-enter restarts the dwell
        jobs[screenId] = scope.launch {
            delay(dwellMs)
            runCatching { onFire(screenId) } // M3-D16: a fire failure never escapes
        }
    }

    fun exit(screenId: String) {
        jobs.remove(screenId)?.cancel() // no-op if never entered
    }
}
