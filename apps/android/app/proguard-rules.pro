# kotlinx.serialization ships its own keep rules; OkHttp's optional platform classes:
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
# WorkManager's Room database is made by reflection; R8's full mode strips its constructor.
-keep class * extends androidx.room.RoomDatabase { <init>(); }
