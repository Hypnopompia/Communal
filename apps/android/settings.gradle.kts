// The Android app (ADR 0023): a Kotlin/Compose shell around the TypeScript core.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "communal-android"
include(":app")
