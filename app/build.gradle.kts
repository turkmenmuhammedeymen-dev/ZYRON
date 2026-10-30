plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.zyron.lab"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.zyron.lab"
        minSdk = 23
        targetSdk = 35
        versionCode = 2
        versionName = "1.1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
val copyZyronWeb by tasks.registering(Copy::class) {
    from(rootProject.file("web"))
    into(layout.projectDirectory.dir("src/main/assets/www"))
}
tasks.named("preBuild").configure { dependsOn(copyZyronWeb) }
