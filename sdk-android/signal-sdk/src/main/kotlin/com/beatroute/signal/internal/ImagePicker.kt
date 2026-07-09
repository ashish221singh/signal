package com.beatroute.signal.internal

import android.net.Uri
import androidx.activity.result.ActivityResultCaller
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia

/**
 * Thin wrapper over the Android photo picker ([PickVisualMedia]) restricted to images.
 *
 * Registration must happen while the host (fragment/activity) is being created, so the caller
 * passes an [ActivityResultCaller] plus a callback that receives the picked [Uri] (or null if the
 * rep dismissed the picker). The bottom sheet wires this in Task F.2; keep this minimal.
 */
internal class ImagePicker(
    caller: ActivityResultCaller,
    onResult: (Uri?) -> Unit,
) {
    private val launcher: ActivityResultLauncher<PickVisualMediaRequest> =
        caller.registerForActivityResult(PickVisualMedia()) { uri -> onResult(uri) }

    /** Opens the system photo picker, images only. */
    fun launch() {
        launcher.launch(
            PickVisualMediaRequest.Builder()
                .setMediaType(PickVisualMedia.ImageOnly)
                .build()
        )
    }
}
