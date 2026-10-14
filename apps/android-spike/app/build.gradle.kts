plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.communal.spike"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.communal.spike"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1-spike"
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    buildFeatures { compose = true }
    // libnode.so is executed, so it must exist as a real file in nativeLibraryDir.
    packaging { jniLibs { useLegacyPackaging = true } }
    // The core's native addons are loaded from filesDir; keep .node files out of compression games.
    androidResources { noCompress += listOf("node") }
    buildTypes { release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("debug") } }
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2026.03.00")
    implementation(bom)
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
}
