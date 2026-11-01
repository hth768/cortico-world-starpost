package io.starpost.mobile

import java.io.File

// AndroidX FileProvider checks root + "/" (correct on Android). Robolectric on
// Windows uses host File paths instead. Model the Android child separator in
// tests only; retain the real root so provider scoping is still exercised.
internal fun providerTestFile(file:File):File = if(File.separatorChar!='\\')file else object:File(file.path) {
    override fun getCanonicalPath()=parentFile!!.canonicalPath+"/"+name
}
