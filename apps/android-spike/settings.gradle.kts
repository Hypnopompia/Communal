// EXPERIMENTAL (Android spike, docs/adr/0023-android-client-spike.md). Not shipped.
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
rootProject.name = "communal-android-spike"
include(":app")
