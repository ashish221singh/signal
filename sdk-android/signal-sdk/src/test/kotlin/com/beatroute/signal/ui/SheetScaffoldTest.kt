package com.beatroute.signal.ui

import android.os.Looper.getMainLooper
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.beatroute.signal.R
import com.google.android.material.bottomsheet.BottomSheetDragHandleView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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

    private fun showFragment(): SignalBottomSheetFragment {
        val activity = Robolectric.buildActivity(HostActivity::class.java)
            .setup()
            .get()
        val fragment = SignalBottomSheetFragment.newInstance(configJson)
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
}
