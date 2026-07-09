package com.beatroute.signal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.beatroute.signal.R
import com.beatroute.signal.databinding.SignalSheetBinding
import com.beatroute.signal.internal.EligibilityConfig
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

        binding.signalHeader.text = config.header
        binding.signalClose.setOnClickListener { dismissAllowingStateLoss() }

        render(State.RATING)
    }

    /**
     * Swap the content shown in the state container for [state].
     *
     * For this scaffold the container is left empty; later tasks (E.2+) inflate
     * the concrete RATING / POSITIVE / NEGATIVE / OTHER views here.
     */
    internal fun render(state: State) {
        currentState = state
        binding.signalStateContainer.removeAllViews()
        // TODO(E.2+): inflate the concrete view for [state] into the container.
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
