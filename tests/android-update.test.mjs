import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeAndroidUpdate } from '../scripts/build-android-update.mjs';

const input = { apk: Buffer.from('test-apk'), badging: "package: name='io.starpost.mobile' versionCode='12' versionName='1.2.2'\nsdkVersion:'26'",
  gradle: 'versionCode = 12\nversionName = "1.2.2"\nminSdk = 26', tag: 'v0.21.0', notes: '  更新内容\n- 一键更新  ' };
test('Android update metadata uses APK version and immutable tagged assets', () => {
  const manifest = makeAndroidUpdate(input);
  assert.equal(manifest.versionName, '1.2.2');
  assert.equal(manifest.versionCode, 12);
  assert.equal(manifest.apkUrl, 'https://github.com/hth768/cortico-world-starpost/releases/download/v0.21.0/starpost-android.apk');
  assert.equal(manifest.sha256, createHash('sha256').update(input.apk).digest('hex'));
  assert.equal(manifest.bytes, input.apk.length);
  assert.equal(manifest.notes, '更新内容\n- 一键更新');
});
test('Publishing refuses stale APKs, wrong package, inconsistent platform and unsafe tags', () => {
  for (const changes of [
    { gradle: input.gradle.replace('12', '13') },
    { badging: input.badging.replace('io.starpost.mobile', 'other.app') },
    { badging: input.badging.replace("sdkVersion:'26'", "sdkVersion:'28'") },
    { tag: '../latest' }, { apk: Buffer.alloc(0) },
  ]) assert.throws(() => makeAndroidUpdate({ ...input, ...changes }));
});
