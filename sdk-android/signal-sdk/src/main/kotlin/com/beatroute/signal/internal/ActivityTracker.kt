package com.beatroute.signal.internal

import android.app.Activity
import android.app.Application
import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import androidx.fragment.app.FragmentManager

/**
 * Seam that hands the presenter the host's current [FragmentManager] without the SDK
 * hard-coding (or leaking) an Activity. Returns `null` when there is no suitable host
 * (no resumed activity, or the resumed activity isn't a [FragmentActivity]); the
 * presenter treats a null manager as "can't show right now" and drops silently.
 */
internal fun interface FragmentHostProvider {
    fun currentFragmentManager(): FragmentManager?
}

/**
 * Production [FragmentHostProvider]: tracks the currently RESUMED activity via the host
 * [Application]'s lifecycle callbacks and exposes its `supportFragmentManager` when it is
 * a [FragmentActivity]. Registered in `Signal.init`; the reference is held only while an
 * activity is resumed and cleared on pause, so no Activity is leaked.
 */
internal class ActivityTracker :
    Application.ActivityLifecycleCallbacks,
    FragmentHostProvider {

    @Volatile
    private var currentActivity: Activity? = null

    override fun currentFragmentManager(): FragmentManager? {
        val activity = currentActivity as? FragmentActivity ?: return null
        return activity.supportFragmentManager
    }

    override fun onActivityResumed(activity: Activity) {
        currentActivity = activity
    }

    override fun onActivityPaused(activity: Activity) {
        if (currentActivity === activity) currentActivity = null
    }

    override fun onActivityDestroyed(activity: Activity) {
        if (currentActivity === activity) currentActivity = null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
}
