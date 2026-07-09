package com.beatroute.signal.ui

import android.content.Context
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.Gravity
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.content.res.ResourcesCompat
import androidx.core.widget.ImageViewCompat
import com.beatroute.signal.R

/**
 * Config-driven rating widget (Task E.2).
 *
 * Renders one of three modes into a horizontal row via [render]:
 *  - `"star"`        → [scaleMax] star buttons; tapping the k-th lights stars
 *                      1..k and reports k.
 *  - `"emoji"`       → exactly 3 tiles (sad / neutral / happy); tapping the
 *                      k-th reports k (happy == 3).
 *  - `"effort_scale"`→ [scaleMax] numbered segments (3 or 5); tapping segment
 *                      k reports k.
 *
 * The tapped rank is delivered through [onScore]. Callers (and tests) locate the
 * tappable elements through [ratedChildren]: the ordered list this view builds,
 * where index 0 corresponds to score 1, index 1 to score 2, and so on. Tests use
 * that list to click the k-th element without depending on the concrete view
 * type or on layout wrappers.
 *
 * Every tappable element is given a >=48dp touch target (`minWidth`/`minHeight` =
 * `signal_touch_target`) and a `contentDescription` (e.g. "Rate 4 of 5") in
 * preparation for the a11y task (E.5).
 */
internal class RatingView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : LinearLayout(context, attrs) {

    /** Invoked with the tapped rank (1-based). */
    var onScore: ((Int) -> Unit)? = null

    /**
     * The tappable rating elements in score order: `ratedChildren[k - 1]` reports
     * score `k`. Rebuilt on each [render] call. Exposed for wiring and tests.
     */
    val ratedChildren: List<View> get() = _ratedChildren
    private val _ratedChildren = mutableListOf<View>()

    private val touchTarget: Int
        get() = resources.getDimensionPixelSize(R.dimen.signal_touch_target)

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER
    }

    /**
     * Build the rating UI for [type] with [scaleMax] steps. `star` always uses 5,
     * `emoji` always uses 3, `effort_scale` uses [scaleMax] (3 or 5).
     */
    fun render(type: String, scaleMax: Int) {
        removeAllViews()
        _ratedChildren.clear()

        when (type) {
            "star" -> buildStars(scaleMax = 5)
            "emoji" -> buildEmoji()
            "effort_scale" -> buildEffort(scaleMax = scaleMax)
            else -> Unit // Unknown type renders nothing; the sheet handles fallbacks.
        }
    }

    // ------------------------------------------------------------------ star ---

    private fun buildStars(scaleMax: Int) {
        val star = resources.getDimensionPixelSize(R.dimen.signal_rating_star)
        val pad = ((touchTarget - star).coerceAtLeast(0)) / 2
        val gap = resources.getDimensionPixelSize(R.dimen.signal_space_1)

        for (k in 1..scaleMax) {
            val button = ImageButton(context).apply {
                setImageDrawable(
                    ResourcesCompat.getDrawable(resources, R.drawable.signal_ic_star, context.theme),
                )
                setBackgroundColor(0) // transparent; the 35dp icon sits in a 48dp target
                scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                minimumWidth = touchTarget
                minimumHeight = touchTarget
                setPadding(pad, pad, pad, pad)
                contentDescription = context.getString(R.string.signal_rate_n_of_m, k, scaleMax)
                tintStar(this, lit = false)
                setOnClickListener { report(k) { litUpTo(k) } }
            }
            val lp = LayoutParams(touchTarget, touchTarget).apply {
                marginStart = if (k == 1) 0 else gap
            }
            addView(button, lp)
            _ratedChildren.add(button)
        }
    }

    private fun litUpTo(k: Int) {
        _ratedChildren.forEachIndexed { index, view ->
            tintStar(view as ImageButton, lit = index < k)
        }
    }

    private fun tintStar(button: ImageButton, lit: Boolean) {
        val color = if (lit) R.color.signal_orange_500 else R.color.signal_gray_200
        ImageViewCompat.setImageTintList(
            button,
            android.content.res.ColorStateList.valueOf(ContextCompat.getColor(context, color)),
        )
    }

    // ----------------------------------------------------------------- emoji ---

    private fun buildEmoji() {
        val glyphs = listOf("😞", "😐", "😊") // sad, neutral, happy
        val tile = resources.getDimensionPixelSize(R.dimen.signal_rating_emoji_tile)
            .coerceAtLeast(touchTarget)
        val glyphSize = resources.getDimension(R.dimen.signal_rating_emoji_glyph)
        val elevation = resources.getDimension(R.dimen.signal_rating_elevation)
        val gap = resources.getDimensionPixelSize(R.dimen.signal_space_3)

        glyphs.forEachIndexed { index, glyph ->
            val k = index + 1
            val cell = TextView(context).apply {
                text = glyph
                gravity = Gravity.CENTER
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, glyphSize)
                setBackgroundResource(R.drawable.signal_rating_tile_bg)
                this.elevation = elevation
                minimumWidth = touchTarget
                minimumHeight = touchTarget
                isClickable = true
                isFocusable = true
                contentDescription = context.getString(R.string.signal_rate_n_of_m, k, glyphs.size)
                setOnClickListener { report(k) }
            }
            val lp = LayoutParams(tile, tile).apply {
                marginStart = if (index == 0) 0 else gap
            }
            addView(cell, lp)
            _ratedChildren.add(cell)
        }
    }

    // ---------------------------------------------------------------- effort ---

    private fun buildEffort(scaleMax: Int) {
        val height = resources.getDimensionPixelSize(R.dimen.signal_rating_segment_height)
            .coerceAtLeast(touchTarget)
        val elevation = resources.getDimension(R.dimen.signal_rating_elevation)
        val bodyText = resources.getDimension(R.dimen.signal_text_body_md)
        val gap = resources.getDimensionPixelSize(R.dimen.signal_space_2)

        for (k in 1..scaleMax) {
            val segment = TextView(context).apply {
                text = k.toString()
                gravity = Gravity.CENTER
                typeface = Typeface.DEFAULT_BOLD
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, bodyText)
                setTextColor(ContextCompat.getColor(context, R.color.signal_ink))
                setBackgroundResource(R.drawable.signal_rating_segment_bg)
                this.elevation = elevation
                minimumWidth = touchTarget
                minimumHeight = touchTarget
                isClickable = true
                isFocusable = true
                contentDescription = context.getString(R.string.signal_rate_n_of_m, k, scaleMax)
                setOnClickListener { report(k) }
            }
            // flex:1 -> width 0 with equal weight fills the row.
            val lp = LayoutParams(0, height, 1f).apply {
                marginStart = if (k == 1) 0 else gap
            }
            addView(segment, lp)
            _ratedChildren.add(segment)
        }
    }

    // ----------------------------------------------------------------- common --

    private inline fun report(k: Int, sideEffect: () -> Unit = {}) {
        sideEffect()
        onScore?.invoke(k)
    }
}
