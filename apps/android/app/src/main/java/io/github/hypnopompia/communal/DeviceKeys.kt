package io.github.hypnopompia.communal

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * This phone's Ed25519 device key (its identity on every hub), kept wrapped by an AES key in the
 * Android Keystore, like the desktop keeps it with Electron's safeStorage. The core gets the raw
 * seed on stdin when it starts and never writes it anywhere.
 */
class DeviceKeys(context: Context) {
    private val file = File(context.filesDir, "device.key.enc")

    /** The 32-byte seed, base64url without padding (the core's encoding), made on first use. */
    @Synchronized
    fun seed(): String {
        val raw = if (file.exists()) unwrap(file.readBytes()) else create()
        return Base64.encodeToString(raw, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    private fun create(): ByteArray {
        val seed = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val tmp = File(file.path + ".tmp")
        tmp.writeBytes(wrap(seed))
        check(tmp.renameTo(file)) { "could not save the device key" }
        return seed
    }

    private fun wrap(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, aesKey())
        return c.iv + c.doFinal(plain)
    }

    private fun unwrap(blob: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, aesKey(), GCMParameterSpec(128, blob, 0, IV_BYTES))
        return c.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
    }

    private fun aesKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val ALIAS = "communal-device-key"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
