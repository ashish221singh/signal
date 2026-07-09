package com.beatroute.signal.ui

import android.content.Intent
import android.os.Looper.getMainLooper
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.beatroute.signal.R
import com.beatroute.signal.internal.ResponseBody
import com.google.android.material.bottomsheet.BottomSheetDragHandleView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Robolectric scaffold test for [SignalBottomSheetFragment] (Task E.1).
 *
 * There is no `fragment-testing` dependency and a [BottomSheetDialogFragment] is
 * a DialogFragment (its view lives in a dialog window, not in the activity's
 * container), so `FragmentScenario.launchInContainer` would not surface the
 * inflated view. Instead we host the fragment in a real Robolectric-driven
 * [AppCompatActivity] themed with [R.style.Theme_Signal] (a Material3-based
 * theme, so the Material widgets in the layout resolve their theme attrs) and
 * call [show], then drain the main looper and read from `fragment.dialog`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SheetScaffoldTest {

    /** Minimal Material3-themed host activity so Material widgets can inflate. */
    class HostActivity : AppCompatActivity() {
        override fun onCreate(savedInstanceState: android.os.Bundle?) {
            setTheme(R.style.Theme_Signal)
            super.onCreate(savedInstanceState)
        }
    }

    private val configJson = """
        {
          "trigger_id": "11111111-1111-4111-8111-111111111111",
          "campaign_id": "22222222-2222-4222-8222-222222222222",
          "metric_type": "CSAT",
          "header": "How was your delivery?",
          "rating_type": "star",
          "rating_scale_max": 5,
          "positive_threshold": 4,
          "chips_on_negative": ["Too slow", "Wrong item"],
          "other_requires_text": true,
          "other_allows_image": true,
          "on_positive_action": "play_store_review",
          "skip_enabled": true
        }
    """.trimIndent()

    /** Build a config JSON string with the given overrides applied. */
    private fun configJson(
        onPositiveAction: String = "play_store_review",
        positiveThreshold: Int = 4,
    ): String = """
        {
          "trigger_id": "11111111-1111-4111-8111-111111111111",
          "campaign_id": "22222222-2222-4222-8222-222222222222",
          "metric_type": "CSAT",
          "header": "How was your delivery?",
          "rating_type": "star",
          "rating_scale_max": 5,
          "positive_threshold": $positiveThreshold,
          "chips_on_negative": ["Too slow", "Wrong item"],
          "other_requires_text": true,
          "other_allows_image": true,
          "on_positive_action": "$onPositiveAction",
          "skip_enabled": true
        }
    """.trimIndent()

    private fun showFragment(json: String = configJson): SignalBottomSheetFragment {
        val activity = Robolectric.buildActivity(HostActivity::class.java)
            .setup()
            .get()
        val fragment = SignalBottomSheetFragment.newInstance(json)
        fragment.show(activity.supportFragmentManager, "signal")
        shadowOf(getMainLooper()).idle()
        return fragment
    }

    @Test
    fun `header shows configured text`() {
        val fragment = showFragment()
        val header = fragment.dialog?.findViewById<TextView>(R.id.signal_header)
        assertNotNull("header view should be inflated", header)
        assertEquals("How was your delivery?", header?.text?.toString())
    }

    @Test
    fun `drag handle is present in the hierarchy`() {
        val fragment = showFragment()
        val handle = fragment.dialog?.findViewById<BottomSheetDragHandleView>(R.id.signal_drag_handle)
        assertTrue(
            "a BottomSheetDragHandleView should be present",
            handle is BottomSheetDragHandleView,
        )
    }

    @Test
    fun `initial state is RATING`() {
        val fragment = showFragment()
        assertEquals(SignalBottomSheetFragment.State.RATING, fragment.currentState)
    }

    @Test
    fun `positive score transitions to POSITIVE and shows thank-you text`() {
        val fragment = showFragment(configJson(positiveThreshold = 4))

        // Select score 5 (>= threshold 4) by driving the exposed hook directly.
        fragment.onRatingSelected(5)
        shadowOf(getMainLooper()).idle()

        assertEquals(SignalBottomSheetFragment.State.POSITIVE, fragment.currentState)
        val thanks = fragment.dialog?.findViewById<TextView>(R.id.signal_positive_message)
        assertNotNull("thank-you message should be inflated", thanks)
        assertTrue("thank-you text should be non-empty", !thanks?.text.isNullOrBlank())
    }

    @Test
    fun `play_store_review shows rate button that fires a market intent`() {
        val activity = Robolectric.buildActivity(HostActivity::class.java).setup().get()
        val fragment = SignalBottomSheetFragment.newInstance(
            configJson(onPositiveAction = "play_store_review"),
        )
        fragment.show(activity.supportFragmentManager, "signal")
        shadowOf(getMainLooper()).idle()

        fragment.onRatingSelected(5)
        shadowOf(getMainLooper()).idle()

        val rate = fragment.dialog?.findViewById<Button>(R.id.signal_positive_rate)
        assertNotNull("rate button should be shown for play_store_review", rate)
        rate!!.performClick()
        shadowOf(getMainLooper()).idle()

        val started: Intent? = shadowOf(activity).peekNextStartedActivity()
        assertNotNull("tapping rate should start an activity", started)
        assertEquals(Intent.ACTION_VIEW, started?.action)
        assertTrue(
            "intent data should point at the play store",
            started?.data?.toString()?.startsWith("market://details?id=") == true,
        )
    }

    @Test
    fun `none positive action shows no rate button`() {
        val fragment = showFragment(configJson(onPositiveAction = "none"))

        fragment.onRatingSelected(5)
        shadowOf(getMainLooper()).idle()

        assertEquals(SignalBottomSheetFragment.State.POSITIVE, fragment.currentState)
        val rate = fragment.dialog?.findViewById<Button>(R.id.signal_positive_rate)
        assertNull("no rate button when on_positive_action is none", rate)
    }

    @Test
    fun `positive score enqueues a response with rating and null chip and text`() {
        val fragment = showFragment(configJson(positiveThreshold = 4))
        val submitted = mutableListOf<ResponseBody>()
        fragment.onSubmit = { submitted.add(it) }

        fragment.onRatingSelected(5)
        shadowOf(getMainLooper()).idle()

        assertEquals("onSubmit should fire exactly once", 1, submitted.size)
        val body = submitted.single()
        assertEquals(5, body.ratingValue)
        assertNull(body.chipSelected)
        assertNull(body.otherText)
    }
}
