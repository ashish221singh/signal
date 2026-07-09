package com.beatroute.signal.ui

import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.view.ContextThemeWrapper
import com.beatroute.signal.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric tests for the config-driven [RatingView] (Task E.2).
 *
 * Follows the same host/theme pattern as [SheetScaffoldTest]: a Robolectric
 * [AppCompatActivity] themed with [R.style.Theme_Signal], wrapped in a
 * [ContextThemeWrapper] so Material widgets resolve their theme attrs.
 *
 * The rated children are located via [RatingView.ratedChildren], the ordered
 * list of tappable rating elements the view builds (index 0 == score 1, etc.).
 * The test never reaches into the concrete view type — it just clicks the
 * k-th tappable child and asserts the reported score.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RatingViewTest {

    class HostActivity : AppCompatActivity() {
        override fun onCreate(savedInstanceState: android.os.Bundle?) {
            setTheme(R.style.Theme_Signal)
            super.onCreate(savedInstanceState)
        }
    }

    private fun newView(): RatingView {
        val activity = Robolectric.buildActivity(HostActivity::class.java).setup().get()
        val themed = ContextThemeWrapper(activity, R.style.Theme_Signal)
        return RatingView(themed)
    }

    @Test
    fun `star renders 5 buttons and reports the tapped rank`() {
        val view = newView()
        var captured: Int? = null
        view.onScore = { captured = it }

        view.render("star", 5)

        val children: List<View> = view.ratedChildren
        assertEquals("star mode should build 5 stars", 5, children.size)

        // Tap the 4th star (index 3) -> score 4.
        children[3].performClick()
        assertEquals(4, captured)
    }

    @Test
    fun `emoji renders 3 tiles and happy reports 3`() {
        val view = newView()
        var captured: Int? = null
        view.onScore = { captured = it }

        view.render("emoji", 3)

        val children: List<View> = view.ratedChildren
        assertEquals("emoji mode should build 3 tiles", 3, children.size)

        // Tap the happy (3rd) tile -> score 3.
        children[2].performClick()
        assertEquals(3, captured)
    }

    @Test
    fun `effort_scale honours the configured scale max`() {
        val three = newView()
        three.render("effort_scale", 3)
        assertEquals("effort_scale(3) should build 3 segments", 3, three.ratedChildren.size)

        val five = newView()
        five.render("effort_scale", 5)
        assertEquals("effort_scale(5) should build 5 segments", 5, five.ratedChildren.size)
    }

    @Test
    fun `effort_scale reports the tapped segment`() {
        val view = newView()
        var captured: Int? = null
        view.onScore = { captured = it }

        view.render("effort_scale", 5)
        view.ratedChildren[4].performClick()
        assertEquals(5, captured)
    }

    @Test
    fun `every rated child has a 48dp touch target and a content description`() {
        val view = newView()
        view.render("star", 5)
        val target = view.resources.getDimensionPixelSize(R.dimen.signal_touch_target)
        view.ratedChildren.forEachIndexed { index, child ->
            assertTrue(
                "child $index should have a >=48dp touch target",
                child.minimumWidth >= target && child.minimumHeight >= target,
            )
            assertTrue(
                "child $index should have a content description",
                !child.contentDescription.isNullOrEmpty(),
            )
        }
    }
}
