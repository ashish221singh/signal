package com.beatroute.signal.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import com.beatroute.signal.R
import com.beatroute.signal.databinding.SignalSheetBinding
import com.beatroute.signal.internal.EligibilityConfig
import com.beatroute.signal.internal.ResponseBody
import com.beatroute.signal.internal.SignalJson
import com.google.android.material.bottomsheet.BottomSheetDialogFragment

/**
 * The Signal feedback bottom sheet (Task E.1 scaffold).
 *
 * Hosts a drag handle, a header, a close affordance, and a [FrameLayout] state
 * container that later tasks (E.2+) inflate the RATING / POSITIVE / NEGATIVE /
 * OTHER views into. The sheet is entirely config-driven: the [EligibilityConfig]
 * is passed in as a JSON string via [arguments] under [ARG_CONFIG_JSON].
 *
 * A missing or invalid config is handled defensively (the sheet dismisses)
 * rather than crashing the host app.
 */
internal class SignalBottomSheetFragment : BottomSheetDialogFragment() {

    /** The branch of the feedback flow currently rendered in the state container. */
    internal enum class State { RATING, POSITIVE, NEGATIVE, OTHER }

    private var _binding: SignalSheetBinding? = null
    private val binding get() = _binding!!

    /** The decoded config, or `null` when the argument was missing/invalid. */
    internal var config: EligibilityConfig? = null
        private set

    /** The state currently rendered; exposed for tests. Starts at [State.RATING]. */
    internal var currentState: State = State.RATING
        private set

    /**
     * Invoked when the user completes a response. The presenter wired in Task G.3
     * persists the [ResponseBody] to the outbox; for now it is a plain callback so
     * tests can assert the assembled body.
     */
    internal var onSubmit: ((ResponseBody) -> Unit)? = null

    /** Invoked when the sheet is dismissed without submitting (wired fully in E.4). */
    internal var onDismiss: (() -> Unit)? = null

    /**
     * When the sheet was shown, used as [ResponseBody.shownAt]. A real monotonic /
     * wall-clock fill lands in G.3; for now it is captured at view creation and
     * formatted as an epoch-millis string placeholder.
     */
    private var shownAtMillis: Long = 0L

    /**
     * Return a dialog theme that carries the Signal bottom-sheet look
     * (shape + colors + drag-handle tint via `bottomSheetStyle`).
     */
    override fun getTheme(): Int = R.style.Theme_Signal_BottomSheetDialog

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = SignalSheetBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        config = decodeConfig()
        val config = config
        if (config == null) {
            // Nothing to show without a valid config; never crash the host.
            dismissAllowingStateLoss()
            return
        }

        shownAtMillis = System.currentTimeMillis()
        binding.signalHeader.text = config.header
        binding.signalClose.setOnClickListener { dismissAllowingStateLoss() }

        render(State.RATING)
    }

    /**
     * Swap the content shown in the state container for [state].
     *
     * RATING and POSITIVE are wired here (Task E.3). NEGATIVE / OTHER content
     * arrives in Task E.4; for now they render nothing (no crash).
     */
    internal fun render(state: State) {
        currentState = state
        val container = binding.signalStateContainer
        container.removeAllViews()
        val config = config ?: return

        when (state) {
            State.RATING -> {
                val ratingView = RatingView(container.context).apply {
                    render(config.ratingType, config.ratingScaleMax)
                    onScore = { score -> onRatingSelected(score) }
                }
                container.addView(ratingView)
            }

            State.POSITIVE -> {
                val view = layoutInflater.inflate(
                    R.layout.signal_state_positive, container, false,
                )
                val rate = view.findViewById<Button>(R.id.signal_positive_rate)
                if (config.onPositiveAction == "play_store_review") {
                    rate.visibility = View.VISIBLE
                    rate.setOnClickListener { openPlayStoreReview() }
                } else {
                    // "none": remove the button entirely so no rate affordance exists.
                    (rate.parent as? ViewGroup)?.removeView(rate)
                }
                container.addView(view)
            }

            // NEGATIVE / OTHER: Task E.4 inflates the concrete content here.
            State.NEGATIVE, State.OTHER -> Unit
        }
    }

    /**
     * Handle a rating tap: scores at/above [EligibilityConfig.positiveThreshold]
     * branch into POSITIVE and enqueue the response; lower scores route toward the
     * NEGATIVE branch (completed in Task E.4). Exposed for tests so they can drive
     * a selection without depending on the concrete rating view internals.
     */
    internal fun onRatingSelected(score: Int) {
        val config = config ?: return
        if (score >= config.positiveThreshold) {
            render(State.POSITIVE)
            onSubmit?.invoke(assembleResponse(score, chip = null, text = null))
        } else {
            // Task E.4 completes the NEGATIVE content; keep this non-crashing.
            render(State.NEGATIVE)
        }
    }

    /**
     * Assemble a [ResponseBody] for a submission.
     *
     * device_os / app_version / timestamps are placeholders here: the real
     * Build.VERSION / package versionName / clock fill lands in Task G.3 when the
     * presenter wires the outbox. [shownAtMillis] is captured at view creation;
     * responded_at is captured now. Both are emitted as epoch-millis strings for
     * now — G.3 will normalise to the wire format (ISO-8601).
     */
    private fun assembleResponse(score: Int, chip: String?, text: String?): ResponseBody {
        val config = requireNotNull(config)
        return ResponseBody(
            triggerId = config.triggerId,
            ratingValue = score,
            chipSelected = chip,
            otherText = text,
            otherImageUrl = null,
            deviceOs = "android", // placeholder; real Build.VERSION fill in G.3
            appVersion = "", // placeholder; real versionName fill in G.3
            repTenureDays = null,
            shownAt = shownAtMillis.toString(), // placeholder format; G.3 normalises
            respondedAt = System.currentTimeMillis().toString(),
        )
    }

    /** Fire a Play Store review intent for the host app's package. */
    private fun openPlayStoreReview() {
        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("market://details?id=" + requireContext().packageName),
        ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        startActivity(intent)
    }

    private fun decodeConfig(): EligibilityConfig? {
        val json = arguments?.getString(ARG_CONFIG_JSON) ?: return null
        return runCatching { SignalJson.decodeFromString<EligibilityConfig>(json) }.getOrNull()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        /** Bundle key holding the [EligibilityConfig] JSON string. */
        const val ARG_CONFIG_JSON: String = "com.beatroute.signal.ARG_CONFIG_JSON"

        /** Build a fragment whose config is packed from [configJson]. */
        fun newInstance(configJson: String): SignalBottomSheetFragment =
            SignalBottomSheetFragment().apply {
                arguments = Bundle().apply { putString(ARG_CONFIG_JSON, configJson) }
            }
    }
}
