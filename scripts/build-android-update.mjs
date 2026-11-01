import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Metadata is produced from the signed APK, not the extension's version number.
export function makeAndroidUpdate({ apk, badging, gradle, tag, notes }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid release tag');
  const identity = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  const sdk = badging.match(/^sdkVersion:'(\d+)'/m);
  if (!identity || !sdk) throw new Error('Cannot read APK identity using aapt');
  const [, packageName, code, versionName] = identity;
  const versionCode = Number(code), minSdk = Number(sdk[1]);
  if (packageName !== 'io.starpost.mobile' || versionCode !== Number(gradle.match(/\bversionCode\s*=\s*(\d+)/)?.[1]) ||
    versionName !== gradle.match(/\bversionName\s*=\s*"([^"]+)"/)?.[1] || minSdk !== Number(gradle.match(/\bminSdk\s*=\s*(\d+)/)?.[1])) {
    throw new Error('APK and Android source versions differ; rebuild and sign the APK first');
  }
  if (!/^\d+\.\d+\.\d+$/.test(versionName) || versionCode < 1 || versionCode > 2_100_000_000 ||
    minSdk < 26 || minSdk > 100 || !apk.length || apk.length > 150 * 1024 * 1024) throw new Error('Invalid APK metadata');
  return {
    schema: 1, packageName, versionCode, versionName, minSdk,
    bytes: apk.length, sha256: createHash('sha256').update(apk).digest('hex'),
    apkUrl: `https://github.com/hth768/cortico-world-starpost/releases/download/${tag}/starpost-android.apk`,
    notes: String(notes).trim().slice(0, 6000),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const tag = option('--tag') ?? `v${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`;
  let aapt = option('--aapt');
  if (!aapt) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error('Set ANDROID_HOME or pass --aapt');
    const versions = readdirSync(join(sdk, 'build-tools')).filter(x => /^\d+(\.\d+)+$/.test(x)).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
    aapt = versions.map(x => join(sdk, 'build-tools', x, process.platform === 'win32' ? 'aapt.exe' : 'aapt')).find(existsSync);
  }
  if (!aapt) throw new Error('aapt not found');
  const distribution = join(root, 'android/distribution');
  const apkPath = join(distribution, 'starpost-android.apk');
  const manifest = makeAndroidUpdate({ apk: readFileSync(apkPath), badging: execFileSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' }),
    gradle: readFileSync(join(root, 'android/build.gradle.kts'), 'utf8'), tag, notes: readFileSync(join(root, 'server/android-release-notes.md'), 'utf8') });
  if (!readFileSync(`${apkPath}.sha256`, 'utf8').trim().startsWith(`${manifest.sha256}  starpost-android.apk`)) throw new Error('APK checksum file does not match');
  writeFileSync(join(distribution, 'android-update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Android update metadata ready: ${manifest.versionName} (${manifest.versionCode}), ${manifest.bytes} bytes`);
}
