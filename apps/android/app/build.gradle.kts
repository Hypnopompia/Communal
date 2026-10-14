import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// The version comes from package.json, which `pnpm release` bumps with every other package.
@Suppress("UNCHECKED_CAST")
val pkg = JsonSlurper().parse(rootProject.file("package.json")) as Map<String, Any>
val appVersion = pkg["version"] as String
val (major, minor, patch) = appVersion.split("-")[0].split(".").map { it.toInt() }
val abis = (findProperty("communal.abis") as String).split(",").map { it.trim() }

android {
    namespace = "io.github.hypnopompia.communal"
    compileSdk = 36
    defaultConfig {
        applicationId = "io.github.hypnopompia.communal"
        // Android 11: apps can write their own files into Download/ without a permission.
        minSdk = 30
        targetSdk = 36
        versionCode = major * 10000 + minor * 100 + patch
        versionName = appVersion
        ndk { abiFilters += abis }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // libnode.so is executed, so it must exist as a real file in nativeLibraryDir.
    packaging { jniLibs { useLegacyPackaging = true } }
    androidResources { noCompress += listOf("node") }
    signingConfigs {
        // Release signing from the environment (CI secrets); local builds fall back to debug.
        val store = System.getenv("COMMUNAL_ANDROID_KEYSTORE")
        if (store != null) {
            create("release") {
                storeFile = file(store)
                storePassword = System.getenv("COMMUNAL_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("COMMUNAL_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("COMMUNAL_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            buildConfigField("String", "COMMUNAL_BUILD", "\"dev\"")
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            buildConfigField("String", "COMMUNAL_BUILD", "\"release\"")
        }
    }
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2026.03.00")
    implementation(bom)
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
}
