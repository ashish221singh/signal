package com.beatroute.signal.internal.outbox

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [OutboxEntity::class], version = 1, exportSchema = false)
internal abstract class OutboxDatabase : RoomDatabase() {
    abstract fun outboxDao(): OutboxDao

    companion object {
        fun create(context: Context): OutboxDatabase =
            Room.databaseBuilder(context, OutboxDatabase::class.java, "signal_outbox.db").build()
    }
}
