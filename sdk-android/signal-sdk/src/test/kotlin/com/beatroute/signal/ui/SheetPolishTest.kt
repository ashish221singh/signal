package com.beatroute.signal.ui

import android.os.Looper.getMainLooper
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.widget.NestedScrollView
import com.beatroute.signal.R
import com.google.android.material.chip.ChipGroup
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Robolectric coverage for the E.5 sheet polish: window-insets bottom padding,
 * the scrollable content wrapper, the dark-mode paper via `values-night`, and
 * rating-button content descriptions.
 *
 * Follows the established host pattern from [SheetScaffoldTest]: a Material3
 * themed [AppCompatActivity] hosts the fragment, `show` is called, and the main
 * looper is drained so the dialog's view tree is realised.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SheetPolishTest {

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
        val activity = Robolectric.buildActivity(HostActivity::class.java).setup().get()
        val fragment = SignalBottomSheetFragment.newInstance(configJson)
        fragment.show(activity.supportFragmentManager, "signal")
        shadowOf(getMainLooper()).idle()
        return fragment
    }

    // 1. The sheet root pads its bottom by the dispatched system-bar / IME inset.
    @Test
    fun `root applies bottom window-insets padding`() {
        val fragment = showFragment()
        val root = fragment.dialog!!.findViewById<View>(R.id.signal_sheet_root)
        val basePaddingBottom = root.paddingBottom

        val insets = WindowInsetsCompat.Builder()
            .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(0, 0, 0, 64))
            .build()
        ViewCompat.dispatchApplyWindowInsets(root, insets)
        shadowOf(getMainLooper()).idle()

        assertTrue(
            "root bottom padding ($${root.paddingBottom}) should grow to cover the inset",
            root.paddingBottom >= 64,
        )
        assertTrue(
            "insets padding should not shrink below the base padding",
            root.paddingBottom >= basePaddingBottom,
        )
    }

    // 2. The chip container lives inside a scrollable ancestor.
    @Test
    fun `chip container is inside a scroll view`() {
        val fragment = showFragment()
        fragment.onRatingSelected(2) // < threshold -> NEGATIVE
        shadowOf(getMainLooper()).idle()

        val chips = fragment.dialog!!.findViewById<ChipGroup>(R.id.signal_negative_chips)
        assertNotNull("chip group should be inflated", chips)

        var p: ViewGroup? = chips.parent as? ViewGroup
        var foundScroll = false
        while (p != null) {
            if (p is NestedScrollView || p is ScrollView) {
                foundScroll = true
                break
            }
            p = p.parent as? ViewGroup
        }
        assertTrue("an ancestor of the chip container must be a (Nested)ScrollView", foundScroll)
    }

    // 3. values-night resolves a dark paper distinct from the light paper.
    @Test
    fun `light paper resolves the light white`() {
        val light = RuntimeEnvironment.getApplication().getColor(R.color.signal_bg)
        // Default (non-night) config resolves values/colors.xml -> signal_white.
        assertTrue("light paper should be the light white", light == 0xFFFFFFFF.toInt())
    }

    @Test
    @Config(sdk = [33], qualifiers = "night")
    fun `night qualifier resolves a dark paper distinct from light`() {
        val nightBg = RuntimeEnvironment.getApplication().getColor(R.color.signal_bg)
        val darkPaper = 0xFF191815.toInt() // near-black ink shade from values-night
        assertTrue("night paper should be the dark shade", nightBg == darkPaper)
        assertNotEquals(
            "night paper must differ from the light white",
            0xFFFFFFFF.toInt(),
            nightBg,
        )
    }

    // 4. Rating buttons expose non-empty content descriptions.
    @Test
    fun `rating buttons expose content descriptions`() {
        val fragment = showFragment()
        // RATING is the initial state; grab the RatingView from the container.
        val container = fragment.dialog!!.findViewById<ViewGroup>(R.id.signal_state_container)
        val rating = (0 until container.childCount)
            .map { container.getChildAt(it) }
            .filterIsInstance<RatingView>()
            .single()

        assertTrue("rating view should expose rated children", rating.ratedChildren.isNotEmpty())
        rating.ratedChildren.forEach { child ->
            val cd = child.contentDescription
            assertTrue(
                "each rated child must carry a non-empty contentDescription",
                !cd.isNullOrBlank(),
            )
        }
    }
}
