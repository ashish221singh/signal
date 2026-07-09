package com.beatroute.signal.ui

import android.content.DialogInterface
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.lifecycleScope
import androidx.transition.TransitionManager
import com.beatroute.signal.R
import com.google.android.material.transition.MaterialFade
import com.beatroute.signal.databinding.SignalSheetBinding
import com.beatroute.signal.internal.EligibilityConfig
import com.beatroute.signal.internal.ImageUploader
import com.beatroute.signal.internal.ResponseBody
import com.beatroute.signal.internal.processImage
import com.beatroute.signal.internal.SignalJson
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import java.time.Instant
import kotlinx.coroutines.launch

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

    /** Invoked when the sheet is dismissed without submitting (drag / scrim / back / close). */
    internal var onDismiss: (() -> Unit)? = null

    /**
     * Invoked when the user taps "Add photo" in the OTHER sub-branch. Phase F wires
     * this to the real image picker / downscale / upload flow; here it is a stub so
     * the affordance is functional and testable without the picker existing yet.
     */
    internal var onPickImage: (() -> Unit)? = null

    /**
     * The uploader used to push a picked+downscaled image to storage (Task F.2). Set by the
     * G.3 presenter; may be null (e.g. in current tests / when uploads aren't configured), in
     * which case the OTHER branch simply submits without an attachment.
     */
    internal var imageUploader: ImageUploader? = null

    /**
     * The `object_url` of an image the rep attached in the OTHER branch, or null. Assembled
     * into [ResponseBody.otherImageUrl] on the OTHER-submit path. The image is optional, so a
     * pick/process/upload failure simply leaves this null.
     */
    private var otherImageUrl: String? = null

    /** Test hook: seed a pending attachment url so the OTHER submit path can be exercised. */
    internal fun setOtherImageUrlForTest(url: String?) {
        otherImageUrl = url
    }

    /**
     * Registered in [onCreate] (before the fragment reaches STARTED) so the OTHER branch can
     * launch the system photo picker. The picked [Uri] is processed and uploaded off the main
     * thread; the resulting url is stored in [otherImageUrl].
     */
    private var pickImageLauncher: ActivityResultLauncher<PickVisualMediaRequest>? = null

    /** The "Add photo" button of the currently-rendered OTHER view, for async state updates. */
    private var addPhotoButton: Button? = null

    /**
     * The score that routed the flow into the NEGATIVE branch, captured when
     * [onRatingSelected] fires below the positive threshold. Reused when the user
     * submits a chip or free-text so the assembled [ResponseBody] carries the
     * original rating.
     */
    private var negativeScore: Int = 0

    /** Guards [onDismiss] so it fires at most once even if multiple paths race. */
    private var dismissFired: Boolean = false

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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Registration must happen before STARTED; onCreate is the safe point. Images only.
        pickImageLauncher = registerForActivityResult(PickVisualMedia()) { uri ->
            if (uri != null) onImagePicked(uri)
        }
    }

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

        applyWindowInsets(view)

        shownAtMillis = System.currentTimeMillis()
        binding.signalHeader.text = config.header
        // The close "x" is a user-driven dismiss (not a submit): fire onDismiss
        // exactly once, then dismiss. Guarded so submit paths never route here.
        binding.signalClose.setOnClickListener {
            fireDismissOnce()
            dismissAllowingStateLoss()
        }

        render(State.RATING)
    }

    /**
     * The bottom padding baked into the layout (base) — captured on first insets
     * pass so IME/nav-bar insets are added on top of it rather than replacing it.
     */
    private var baseBottomPadding: Int = -1

    /**
     * Keyboard- and gesture-nav-aware bottom padding (Task E.5): pad the sheet
     * root's bottom by max(imeInset, navBarInset) on top of the layout's base
     * padding, so neither the soft keyboard nor the gesture-nav bar can cover the
     * Submit button. The insets are NOT consumed so children still see them.
     */
    private fun applyWindowInsets(root: View) {
        if (baseBottomPadding < 0) baseBottomPadding = root.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val nav = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
            v.updatePadding(bottom = baseBottomPadding + maxOf(ime, nav))
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }

    /**
     * True when the system animator duration scale is 0 (the user disabled
     * animations in Developer options / "Remove animations" accessibility). Used
     * to skip the state-transition motion so we respect reduced-motion prefs.
     */
    private fun reducedMotion(): Boolean {
        val resolver = context?.contentResolver ?: return true
        val scale = Settings.Global.getFloat(
            resolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        )
        return scale == 0f
    }

    /**
     * Swap the content shown in the state container for [state].
     *
     * RATING and POSITIVE are wired here (Task E.3). NEGATIVE / OTHER content
     * arrives in Task E.4; for now they render nothing (no crash).
     *
     * A subtle [MaterialFade] cross-fades the container on each swap (Task E.5),
     * skipped entirely when [reducedMotion] is true.
     */
    internal fun render(state: State) {
        currentState = state
        val container = binding.signalStateContainer
        if (!reducedMotion()) {
            // Subtle fade so RATING -> POSITIVE/NEGATIVE/OTHER swaps feel smooth.
            TransitionManager.beginDelayedTransition(container, MaterialFade())
        }
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

            State.NEGATIVE -> renderNegative(container, config)

            State.OTHER -> renderOther(container, config)
        }
    }

    /**
     * NEGATIVE branch: one single-select chip per [EligibilityConfig.chipsOnNegative],
     * an "Other" affordance that routes to the OTHER sub-branch, and a Submit button
     * that assembles a chip response (or a null chip if none was selected) and
     * dismisses without firing the dismiss callback.
     */
    private fun renderNegative(container: ViewGroup, config: EligibilityConfig) {
        val view = layoutInflater.inflate(R.layout.signal_state_negative, container, false)
        val chips = view.findViewById<ChipGroup>(R.id.signal_negative_chips)
        // Wrap the context in the Signal chip style so each Chip inflates with the
        // pill look (bg/text/stroke selectors) without a per-view style attr.
        val chipContext = ContextThemeWrapper(chips.context, R.style.Widget_Signal_Chip)
        config.chipsOnNegative.forEach { label ->
            val chip = Chip(chipContext).apply {
                text = label
                isCheckable = true
            }
            chips.addView(chip)
        }

        view.findViewById<Button>(R.id.signal_negative_other).setOnClickListener {
            render(State.OTHER)
        }

        view.findViewById<Button>(R.id.signal_negative_submit).setOnClickListener {
            val checkedId = chips.checkedChipId
            val chipText = if (checkedId != View.NO_ID) {
                chips.findViewById<Chip>(checkedId)?.text?.toString()
            } else {
                null
            }
            onSubmit?.invoke(assembleResponse(negativeScore, chip = chipText, text = null))
            dismissAllowingStateLoss()
        }

        container.addView(view)
    }

    /**
     * OTHER sub-branch: a free-text field, an "Add photo" affordance shown only when
     * [EligibilityConfig.otherAllowsImage], and a Submit button. When
     * [EligibilityConfig.otherRequiresText] the Submit button stays disabled until
     * the text is non-empty. Submit assembles a free-text response and dismisses
     * without firing the dismiss callback.
     */
    private fun renderOther(container: ViewGroup, config: EligibilityConfig) {
        val view = layoutInflater.inflate(R.layout.signal_state_other, container, false)
        val text = view.findViewById<EditText>(R.id.signal_other_text)
        val submit = view.findViewById<Button>(R.id.signal_other_submit)
        val addPhoto = view.findViewById<Button>(R.id.signal_add_photo)
        // Keep a handle so the async pick->process->upload callback can reflect state onto the
        // affordance (progress / attached / failed) even after this render() returns.
        addPhotoButton = addPhoto

        addPhoto.visibility = if (config.otherAllowsImage) View.VISIBLE else View.GONE
        addPhoto.setOnClickListener {
            // Preserve the E.4 contract (the add-photo test asserts this fires) AND launch the
            // real system photo picker so a rep can actually attach an image.
            onPickImage?.invoke()
            if (otherImageUrl == null) {
                pickImageLauncher?.launch(
                    PickVisualMediaRequest.Builder()
                        .setMediaType(PickVisualMedia.ImageOnly)
                        .build(),
                )
            } else {
                // Second tap while an image is attached acts as a "remove" affordance.
                clearAttachedImage()
            }
        }
        // Reflect any already-attached image (e.g. after a config-change re-render).
        renderAttachmentState()

        if (config.otherRequiresText) {
            submit.isEnabled = !text.text.isNullOrBlank()
            text.doAfterTextChanged { editable ->
                submit.isEnabled = !editable.isNullOrBlank()
            }
        }

        submit.setOnClickListener {
            onSubmit?.invoke(
                assembleResponse(
                    negativeScore,
                    chip = null,
                    text = text.text?.toString(),
                    imageUrl = otherImageUrl,
                ),
            )
            dismissAllowingStateLoss()
        }

        container.addView(view)
    }

    /**
     * A [Uri] came back from the photo picker. Process it (downscale + guardrails, F.1) then
     * upload via [imageUploader] (F.2) off the main thread, storing the returned `object_url`
     * in [otherImageUrl]. Everything is guarded: the image is optional, so any failure just
     * leaves the sheet submittable without an attachment and never crashes the host.
     */
    private fun onImagePicked(uri: Uri) {
        val uploader = imageUploader ?: return
        val ctx = context ?: return
        val declaredType = ctx.contentResolver.getType(uri)
        setUploadingUi(true)
        viewLifecycleOwner.lifecycleScope.launch {
            val url = try {
                val processed = processImage(ctx, uri, declaredType)
                if (processed != null) {
                    uploader.upload(processed.bytes, processed.contentType)
                } else {
                    null
                }
            } catch (_: Exception) {
                null
            }
            otherImageUrl = url
            setUploadingUi(false)
            renderAttachmentState()
        }
    }

    /** Show a lightweight "uploading…" state on the add-photo affordance. */
    private fun setUploadingUi(uploading: Boolean) {
        val button = addPhotoButton ?: return
        if (uploading) {
            button.isEnabled = false
            button.text = getString(R.string.signal_photo_uploading)
        } else {
            button.isEnabled = true
        }
    }

    /** Reflect [otherImageUrl] onto the add-photo affordance (attached vs. add). */
    private fun renderAttachmentState() {
        val button = addPhotoButton ?: return
        button.isEnabled = true
        button.text = if (otherImageUrl != null) {
            getString(R.string.signal_photo_attached)
        } else {
            getString(R.string.signal_add_photo)
        }
    }

    /** Clear an attached image (the "remove" affordance). */
    private fun clearAttachedImage() {
        otherImageUrl = null
        renderAttachmentState()
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
            // Remember the score so a chip/free-text submit carries the original rating.
            negativeScore = score
            render(State.NEGATIVE)
        }
    }

    /**
     * Assemble a [ResponseBody] for a submission.
     *
     * device_os / app_version / timestamps are filled here (Task G.3): the running
     * Android release, the host app's versionName, and ISO-8601 timestamps.
     * [shownAtMillis] is captured at view creation; responded_at is captured now.
     * `rep_tenure_days` is left null — the presenter patches it from the host
     * [com.beatroute.signal.SessionProvider], which the fragment can't see.
     */
    private fun assembleResponse(
        score: Int,
        chip: String?,
        text: String?,
        imageUrl: String? = null,
    ): ResponseBody {
        val config = requireNotNull(config)
        return ResponseBody(
            triggerId = config.triggerId,
            ratingValue = score,
            chipSelected = chip,
            otherText = text,
            otherImageUrl = imageUrl,
            deviceOs = "Android " + Build.VERSION.RELEASE,
            appVersion = hostAppVersion(),
            repTenureDays = null, // presenter patches this from the SessionProvider.
            shownAt = Instant.ofEpochMilli(shownAtMillis).toString(),
            respondedAt = Instant.ofEpochMilli(System.currentTimeMillis()).toString(),
        )
    }

    /** The host app's versionName, or "" when it can't be resolved (never crashes). */
    private fun hostAppVersion(): String = runCatching {
        val ctx = requireContext()
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    }.getOrDefault("")

    /** Fire a Play Store review intent for the host app's package. */
    private fun openPlayStoreReview() {
        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("market://details?id=" + requireContext().packageName),
        ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        startActivity(intent)
    }

    /**
     * Covers every user-driven, non-submit dismissal that routes through the dialog:
     * drag-to-dismiss, scrim tap, and the system back button all reach [onCancel].
     * A submit-driven [dismissAllowingStateLoss] does NOT call [onCancel], so
     * `onSubmit` and `onDismiss` never both fire for one interaction.
     */
    override fun onCancel(dialog: DialogInterface) {
        fireDismissOnce()
        super.onCancel(dialog)
    }

    /** Invoke [onDismiss] at most once across all dismiss paths (close / cancel). */
    private fun fireDismissOnce() {
        if (dismissFired) return
        dismissFired = true
        onDismiss?.invoke()
    }

    private fun decodeConfig(): EligibilityConfig? {
        val json = arguments?.getString(ARG_CONFIG_JSON) ?: return null
        return runCatching { SignalJson.decodeFromString<EligibilityConfig>(json) }.getOrNull()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        addPhotoButton = null
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
