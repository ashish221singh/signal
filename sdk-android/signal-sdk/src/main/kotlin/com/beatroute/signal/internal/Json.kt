package com.beatroute.signal.internal

import kotlinx.serialization.json.Json

internal val SignalJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}
