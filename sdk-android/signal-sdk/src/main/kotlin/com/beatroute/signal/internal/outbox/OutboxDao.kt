package com.beatroute.signal.internal.outbox

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
internal interface OutboxDao {

    /**
     * Idempotent LOCAL enqueue. IGNORE makes a duplicate (triggerId, kind) a harmless
     * no-op; returns the new rowId, or -1 on conflict.
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun enqueue(item: OutboxEntity): Long

    @Query("SELECT * FROM outbox ORDER BY createdAt ASC")
    suspend fun pending(): List<OutboxEntity>

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun delete(id: Long)

    @Query("UPDATE outbox SET attempts = attempts + 1 WHERE id = :id")
    suspend fun incrementAttempts(id: Long)
}
