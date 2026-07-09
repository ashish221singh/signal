package com.beatroute.signal.internal.outbox

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "outbox",
    indices = [Index(value = ["triggerId", "kind"], unique = true)],
)
internal data class OutboxEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val kind: String, // "response" | "dismiss"
    val triggerId: String,
    val payloadJson: String, // the serialized ResponseBody / DismissBody
    val attempts: Int = 0,
    val createdAt: Long, // epoch millis, for FIFO ordering
)
