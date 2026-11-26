/** Seal the complete audited deployment inventory into pkg's SEA virtual filesystem. */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * pkg's prelude text that pins the Windows snapshot root to the `V:` sentinel and
 * the `C:` drive.
 */
const DRIVE_PINNED_SNAPSHOT_PRELUDE = String.raw`    function toPlatformPath(p) {
      if (process.platform !== "win32") return p;
      if (p.startsWith("/snapshot")) {
        return "C:" + p.replace(/\//g, "\\");
      }
      return p.replace(/\//g, "\\");
    }
    var SNAPSHOT_PREFIXES_POSIX = [{ prefix: "/snapshot", sep: "/" }];
    var SNAPSHOT_PREFIXES_WIN = [
      { prefix: "V:\\snapshot", sep: "\\" },
      { prefix: "V:/snapshot", sep: "/" },
      { prefix: "C:\\snapshot", sep: "\\" },
      { prefix: "C:/snapshot", sep: "/" }
    ];
    function insideSnapshot(f) {
      if (typeof f !== "string") return false;
      var prefixes = process.platform === "win32" ? SNAPSHOT_PREFIXES_POSIX.concat(SNAPSHOT_PREFIXES_WIN) : SNAPSHOT_PREFIXES_POSIX;
      for (var i = 0; i < prefixes.length; i++) {
        var p = prefixes[i].prefix;
        if (f === p || f.startsWith(p + prefixes[i].sep)) return true;
      }
      return false;
    }`

/**
 * Replacement that recognizes the snapshot root on any drive. The virtual
 * filesystem mounts at `/snapshot` and strips the drive before resolving, so
 * recognizing every drive keeps the module hooks working wherever the
 * executable was extracted.
 */
const DRIVE_AGNOSTIC_SNAPSHOT_PRELUDE = String.raw`    // The snapshot root surfaces to the platform as a native path on the drive of
    // the running executable, which is not a fixed letter: a runner may extract
    // the application to D: while C: holds the system volume. Accept every drive
    // and emit the executable drive, so an extraction anywhere still resolves.
    var SNAPSHOT_DRIVE = (function() {
      var drive = /^([A-Za-z]):/.exec(process.execPath || "");
      return drive ? drive[1] : "C";
    })();
    function toPlatformPath(p) {
      if (process.platform !== "win32") return p;
      if (p === "/snapshot" || p.startsWith("/snapshot/")) {
        return SNAPSHOT_DRIVE + ":" + p.replace(/\//g, "\\");
      }
      return p.replace(/\//g, "\\");
    }
    function insideSnapshot(f) {
      if (typeof f !== "string") return false;
      if (f === "/snapshot" || f.startsWith("/snapshot/")) return true;
      if (process.platform !== "win32") return false;
      return /^[A-Za-z]:[\\/]snapshot(?:[\\/]|$)/.test(f);
    }`

/**
 * Count non-overlapping occurrences of literal text.
 * @param {string} source - text to search.
 * @param {string} search - literal needle.
 * @returns {number} occurrences.
 */
function occurrences(source, search) {
  return source.split(search).length - 1
}

/**
 * Escape prelude text the way the pkg bundle embeds it inside a single-quoted
 * worker string. Backslashes must double before newlines turn into `\n`, or the
 * backslash those escapes introduce gets doubled too and the embedded copy no
 * longer parses as the same code.
 */
function asEmbeddedString(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')
}

/**
 * Refuse to rewrite a prelude that does not carry one region exactly once. A pkg
 * upgrade that moves this region must fail here instead of sealing a package
 * whose native modules cannot load off the C: drive.
 * @param {string} source - prelude text under rewrite.
 * @param {string} search - literal region that must appear once.
 * @param {string} region - copy being rewritten, for the failure report.
 */
function assertSingleRegion(source, search, region) {
  const found = occurrences(source, search)
  if (found !== 1) throw new Error(`pkg SEA prelude has ${found} ${region} snapshot drive regions; expected exactly one.`)
}

/**
 * Rewrite the pkg SEA prelude so the Windows snapshot root resolves on any drive
 * and extracted native addons cache under the instance-owned runtime cache.
 *
 * The prelude carries this region twice: as bootstrap code, and again as the
 * single-quoted string a worker thread evaluates. A pnpm patch cannot express the
 * second copy without putting a 190KB line into the patch, so sealing owns the
 * rewrite and refuses to continue if either copy is missing.
 * @param {string} source - contents of pkg `prelude/sea-bootstrap.bundle.js`.
 * @param {string} [nativeCacheHome] - channel-specific data-home directory name used
 *   when `MAPHARNESS_HOME` is unset; omitted keeps pkg's ordinary `~/.cache` base.
 * @returns {string} prelude with drive-agnostic snapshot paths.
 */
export function driveAgnosticSnapshotPrelude(source, nativeCacheHome) {
  const regions = [
    { region: 'bootstrap', from: DRIVE_PINNED_SNAPSHOT_PRELUDE, to: DRIVE_AGNOSTIC_SNAPSHOT_PRELUDE },
    { region: 'embedded worker', from: asEmbeddedString(DRIVE_PINNED_SNAPSHOT_PRELUDE), to: asEmbeddedString(DRIVE_AGNOSTIC_SNAPSHOT_PRELUDE) },
  ]
  for (const { region, from } of regions) assertSingleRegion(source, from, region)
  let rewritten = source
  for (const { from, to } of regions) rewritten = rewritten.replace(from, () => to)
  if (rewritten.includes('SNAPSHOT_PREFIXES_WIN')) throw new Error('pkg SEA prelude still pins the snapshot root to fixed drives.')
  if (nativeCacheHome !== undefined) {
    if (typeof nativeCacheHome !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(nativeCacheHome)
      || nativeCacheHome === '.' || nativeCacheHome === '..') {
      throw new Error('The sealed pkg addon cache home must be a simple data-directory name.')
    }
    const pinned = 'var PKG_NATIVE_CACHE_BASE = process.env.PKG_NATIVE_CACHE_PATH || path.join(homedir(), ".cache");'
    const expression = `process.env.PKG_NATIVE_CACHE_PATH || (process.env.MAPHARNESS_HOME ? process.env.MAPHARNESS_HOME + "/cache/runtime" : path.join(homedir(), ${JSON.stringify(nativeCacheHome)}, "cache", "runtime"))`
    const replacement = `var PKG_NATIVE_CACHE_BASE = ${expression};`
    // The one-line assignment contains no quote or newline, so its bootstrap and embedded-worker copies are identical.
    const found = occurrences(rewritten, pinned)
    if (found !== 2) throw new Error(`pkg SEA prelude has ${found} pkg addon cache base regions; expected exactly two`)
    rewritten = rewritten.split(pinned).join(replacement)
  }
  return rewritten
}

/**
 * Package exact staged files without dependency discovery adding unreviewed files.
 * @param {string} root - isolated, materialized runtime directory.
 * @param {string[]} files - full audited regular-file inventory relative to root.
 * @param {string} entry - relative application entry filename.
 * @param {string} engine - exact Node executable used to compile the map core.
 * @param {string} version - Node version without the v prefix.
 * @param {string} output - absolute host executable destination.
 * @param {string} [nativeCacheHome] - channel-specific data-home directory for pkg addons.
 * @returns {Promise<void>} resolves after SEA injection and host signing.
 */
export async function sealApplication(root, files, entry, engine, version, output, nativeCacheHome) {
  const pkg = dirname(require.resolve('@yao-pkg/pkg/package.json'))
  const { STORE_CONTENT, STORE_LINKS, STORE_STAT } = require(join(pkg, 'lib-es5/common.js'))
  const { generateSeaAssets } = require(join(pkg, 'lib-es5/sea-assets.js'))
  const { default: sea } = require(join(pkg, 'lib-es5/sea.js'))
  const records = {}
  for (const file of files) {
    const key = '/' + file.replaceAll('\\', '/')
    const path = join(root, file)
    records[key] = { file: path, [STORE_CONTENT]: true,
      [STORE_STAT]: { size: statSync(path).size, isFileValue: true, isDirectoryValue: false } }
    let child = key
    for (;;) {
      const parent = posix.dirname(child)
      records[parent] ??= { file: join(root, parent.slice(1)), [STORE_LINKS]: [],
        [STORE_STAT]: { size: 0, isFileValue: false, isDirectoryValue: true } }
      records[parent][STORE_LINKS].push(posix.basename(child))
      if (parent === '/') break
      child = parent
    }
  }
  const temp = mkdtempSync(join(tmpdir(), 'map-application-sea-'))
  try {
    const { assets, manifestPath } = await generateSeaAssets(records, '/' + entry, {}, temp, { doCompress: 1 })
    const bootstrap = join(temp, 'sea-main.cjs')
    writeFileSync(bootstrap, driveAgnosticSnapshotPrelude(
      readFileSync(join(pkg, 'prelude/sea-bootstrap.bundle.js'), 'utf8'), nativeCacheHome))
    await sea(bootstrap, { nodePath: engine, targets: [{ nodeRange: `node${version}`,
      platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux', arch: process.arch, output }],
      params: {}, signature: true, seaConfig: { disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false,
        assets: { __pkg_manifest__: manifestPath, ...assets } } })
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
