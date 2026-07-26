import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as cache from '@actions/cache'
import * as glob from '@actions/glob'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as Handlebars from 'handlebars'

// ─── Constants ───────────────────────────────────────────────────────────────

const UNISTACK_CONFIG_FILE_PATTERNS = [
  '**/.unistack.toml',
  '**/unistack.toml',
  '**/unistack.lock',
  '**/.unistack.lock',
  '**/.tool-versions'
]

const DEFAULT_CACHE_KEY_TEMPLATE =
  '{{cache_key_prefix}}-{{platform}}' +
  '{{#if version}}-{{version}}{{/if}}' +
  '{{#if unistack_env}}-{{unistack_env}}{{/if}}' +
  '-{{#if file_hash}}{{file_hash}}{{else}}no-config{{/if}}'

const GITHUB_RELEASES_API =
  'https://api.github.com/repos/snowdreamtech/UniStack/releases'

const GITHUB_RELEASE_DOWNLOAD_BASE =
  'https://github.com/snowdreamtech/UniStack/releases/download'

const NPM_PACKAGE = '@snowdreamtech/unistack'

const GO_MODULE = 'github.com/snowdreamtech/unistack'

// ─── Types ───────────────────────────────────────────────────────────────────

type InstallMethod = 'npm' | 'pip' | 'release' | 'go'

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * The main function for the action.
 */
export async function run(): Promise<void> {
  try {
    const requestedVersion = core
      .getInput('unistack-version')
      .trim()
      .replace(/^[vV]/, '')
    const requestedMethod = core.getInput('install_method').trim() as
      InstallMethod | 'auto'

    // 1. Determine installation method
    const method: InstallMethod =
      requestedMethod === 'auto' ? await detectInstallMethod() : requestedMethod

    core.info(`Using installation method: ${method}`)
    core.setOutput('install-method', method)

    // 2. Resolve version based on install method
    let installVersion: string
    let cacheVersion: string

    if (methodUsesRegistryLatest(method)) {
      // For npm/pip, pass the requested version directly (fallback to 'latest').
      // No GitHub API requests.
      installVersion = requestedVersion || 'latest'
      cacheVersion = installVersion
    } else {
      // For release/go, resolve via GitHub API if 'latest' or empty.
      if (!requestedVersion) {
        installVersion = await fetchLatestVersion(false)
      } else if (requestedVersion.toLowerCase() === 'latest') {
        installVersion = await fetchLatestVersion(true)
      } else {
        installVersion = requestedVersion
      }
      cacheVersion = installVersion
    }

    core.info(`Target unistack version: ${installVersion}`)

    // 3. Restore cache
    let cacheKey: string | undefined
    let cacheHit = false
    if (core.getBooleanInput('cache')) {
      const result = await restoreUnistackCache(cacheVersion)
      cacheKey = result.primaryKey
      cacheHit = result.hit
    } else {
      core.setOutput('cache-hit', false)
    }

    // Always install unistack to ensure the binary is correctly placed and PATH is set
    const installed = await installUnistack(method, installVersion)
    if (!installed) {
      core.setFailed(
        `Failed to install unistack@${installVersion} via method "${method}"`
      )
      return
    }

    if (cacheHit) {
      core.notice('✅ Cache hit — tools data restored from cache')
    }

    // Verify installation
    const installedVersion = await verifyUnistack()
    core.setOutput('unistack-version', installedVersion)
    core.info(`unistack ${installedVersion} is ready`)

    // Save cache (only on cache miss; post-action handles the actual save)
    if (cacheKey && core.getBooleanInput('cache_save')) {
      core.saveState('PRIMARY_KEY', cacheKey)
      core.saveState('CACHE_PATHS', JSON.stringify(getCachePaths()))
      core.saveState('CACHE_RESULT', cacheHit ? 'true' : 'false')
    }

    // Write Job Summary
    await core.summary
      .addHeading('UniStack Setup Summary', 2)
      .addTable([
        [
          { data: 'Item', header: true },
          { data: 'Details', header: true }
        ],
        ['**UniStack Version**', `v${installedVersion}`],
        ['**Install Method**', `\`${method}\``],
        ['**Cache Hit**', cacheHit ? '✅ Yes' : '❌ No']
      ])
      .write()
  } catch (err) {
    if (err instanceof Error) core.setFailed(err.message)
    else throw err
  }
}

// ─── Version Resolution ───────────────────────────────────────────────────────

/**
 * Fetch the target unistack version from GitHub API.
 * @param absoluteLatest If true, fetches the absolute latest release. If false, fetches the second latest.
 */
async function fetchLatestVersion(absoluteLatest: boolean): Promise<string> {
  const targetDesc = absoluteLatest ? 'latest' : 'second latest'
  core.startGroup(`Fetching target unistack version (${targetDesc})`)
  try {
    const token = core.getInput('github_token')
    const args = ['-fsSL', GITHUB_RELEASES_API]
    if (token) {
      args.push('-H', `Authorization: Bearer ${token}`)
    }
    args.push('-H', 'Accept: application/vnd.github+json')

    const result = await exec.getExecOutput('curl', args, { silent: true })
    const releases = JSON.parse(result.stdout) as {
      tag_name: string
      draft: boolean
      prerelease: boolean
    }[]

    // Filter out drafts and prereleases to ensure stability
    const stableReleases = releases.filter(r => !r.draft && !r.prerelease)

    if (absoluteLatest && stableReleases.length >= 1) {
      const version = stableReleases[0].tag_name.replace(/^v/, '')
      core.info(`Latest version: ${version}`)
      return version
    } else if (!absoluteLatest && stableReleases.length >= 2) {
      const version = stableReleases[1].tag_name.replace(/^v/, '')
      core.info(`Second latest version: ${version}`)
      return version
    } else {
      core.info(`Not enough stable releases found, falling back to 'latest'`)
      return 'latest'
    }
  } finally {
    core.endGroup()
  }
}

// ─── Smart Detection ──────────────────────────────────────────────────────────

/**
 * Auto-detect the best installation method based on available tools.
 * Priority: npm → pip → GitHub Release → go install
 */
async function detectInstallMethod(): Promise<InstallMethod> {
  core.startGroup('Detecting available installation method')
  try {
    if (await isCommandAvailable('npm')) {
      core.info('✅ npm detected → using npm install')
      return 'npm'
    }
    if (
      (await isCommandAvailable('pip')) ||
      (await isCommandAvailable('pip3'))
    ) {
      core.info('✅ pip detected → using pip install')
      return 'pip'
    }
    if (await isCommandAvailable('go')) {
      core.info('✅ go detected → using go install')
      return 'go'
    }
    core.info(
      'ℹ️ No preferred runtime found → falling back to GitHub Release download'
    )
    return 'release'
  } finally {
    core.endGroup()
  }
}

/**
 * Check if a CLI command is available in PATH.
 * Uses @actions/io to safely resolve executables across platforms.
 */
async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    const toolPath = await io.which(cmd, false)
    return !!toolPath
  } catch {
    return false
  }
}

// ─── Installation Dispatch ────────────────────────────────────────────────────

/**
 * Returns true for install methods that can resolve 'latest' via their own
 * registry (npm, pip), so we don't need to pre-resolve the version via GitHub.
 */
function methodUsesRegistryLatest(method: InstallMethod): boolean {
  return method === 'npm' || method === 'pip'
}

async function installUnistack(
  method: InstallMethod,
  version: string
): Promise<boolean> {
  switch (method) {
    case 'npm':
      return installViaNpm(version)
    case 'pip':
      return installViaPip(version)
    case 'release':
      return installViaRelease(version)
    case 'go':
      return installViaGo(version)
  }
}

// ─── npm Installation ─────────────────────────────────────────────────────────

/**
 * Install unistack via npm global install.
 * Requires npm to be available in PATH.
 */
async function installViaNpm(version: string): Promise<boolean> {
  core.startGroup(`Installing unistack@${version} via npm`)
  try {
    const pkg = version ? `${NPM_PACKAGE}@${version}` : NPM_PACKAGE
    const code = await exec.exec('npm', ['install', '-g', pkg])
    if (code !== 0) return false

    // Ensure npm global bin is in PATH (npm bin was removed in npm v9+)
    const npmPrefixRes = await exec.getExecOutput('npm', ['prefix', '-g'], {
      silent: true
    })
    const npmPrefix = npmPrefixRes.stdout.trim()
    if (npmPrefix) {
      const npmBinDir =
        process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin')
      core.addPath(npmBinDir)
    }

    return true
  } catch (err) {
    core.warning(`npm install failed: ${errorMessage(err)}`)
    return false
  } finally {
    core.endGroup()
  }
}

// ─── pip Installation ─────────────────────────────────────────────────────────

/**
 * Install unistack via pip.
 * NOTE: PyPI package is not yet available; this is a reserved implementation.
 * Falls back to GitHub Release download with a warning.
 */
async function installViaPip(version: string): Promise<boolean> {
  core.startGroup(`Installing unistack@${version} via pip`)
  try {
    const pipCmd =
      (await io.which('pip3', false)) || (await io.which('pip', false))
    if (!pipCmd) {
      core.warning('pip3 or pip not found in PATH')
      return false
    }

    const args = ['install']
    if (version !== 'latest') {
      args.push(`snowdreamtech-unistack==${version}`)
    } else {
      args.push('snowdreamtech-unistack')
    }

    const res = await exec.getExecOutput(pipCmd, args, {
      ignoreReturnCode: true
    })
    if (res.exitCode !== 0) {
      core.warning(
        `pip install failed (exit code ${res.exitCode}). stderr: ${res.stderr}`
      )
      return false
    }

    core.info('✅ Successfully installed unistack via pip')
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    core.warning(`Error during pip install: ${msg}`)
    return false
  } finally {
    core.endGroup()
  }
}

// ─── GitHub Release Installation ─────────────────────────────────────────────

/**
 * Download and install unistack binary from GitHub Releases.
 * Supports github_proxy prefix and automatic retry.
 */
async function installViaRelease(version: string): Promise<boolean> {
  core.startGroup(`Installing unistack@${version} via GitHub Release`)
  try {
    const targetStr = getTarget()
    const ext = process.platform === 'win32' ? '.zip' : '.tar.gz'
    const assetName = `unistack_${targetStr}${ext}`
    const githubProxy =
      core.getInput('github_proxy').trim() ||
      process.env.GITHUB_PROXY?.trim() ||
      ''

    const rawUrl =
      version === 'latest'
        ? `https://github.com/snowdreamtech/UniStack/releases/latest/download/${assetName}`
        : `${GITHUB_RELEASE_DOWNLOAD_BASE}/v${version}/${assetName}`
    const downloadUrl = githubProxy
      ? `${githubProxy.replace(/\/$/, '')}/${rawUrl}`
      : rawUrl

    core.info(`Download URL: ${downloadUrl}`)

    // Install binary into ~/.local/bin
    const binDir = getInstallBinDir()
    await fs.promises.mkdir(binDir, { recursive: true })

    const archivePath = path.join(os.tmpdir(), assetName)
    const extractDir = path.join(os.tmpdir(), `unistack-extract-${Date.now()}`)

    // Download with retry
    await downloadWithRetry(downloadUrl, archivePath)

    // Extract
    await fs.promises.mkdir(extractDir, { recursive: true })
    if (ext === '.zip') {
      await exec.exec('unzip', ['-o', archivePath, '-d', extractDir])
    } else {
      await exec.exec('tar', ['-xzf', archivePath, '-C', extractDir])
    }

    // Find and move binary
    const binaryName =
      process.platform === 'win32' ? 'unistack.exe' : 'unistack'
    const binaryPath = await findFile(extractDir, binaryName)
    if (!binaryPath) {
      throw new Error(`Binary "${binaryName}" not found in extracted archive`)
    }
    const destPath = path.join(binDir, binaryName)
    await fs.promises.copyFile(binaryPath, destPath)
    if (process.platform !== 'win32') {
      await exec.exec('chmod', ['+x', destPath])
    }

    core.addPath(binDir)
    core.info(`unistack installed to ${destPath}`)

    // Cleanup temp files
    await fs.promises.rm(archivePath, { force: true })
    await fs.promises.rm(extractDir, { recursive: true, force: true })

    return true
  } catch (err) {
    core.warning(`GitHub Release install failed: ${errorMessage(err)}`)
    return false
  } finally {
    core.endGroup()
  }
}

/**
 * Download a file with automatic retry (up to 3 attempts).
 */
async function downloadWithRetry(
  url: string,
  dest: string,
  maxRetries = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      core.info(`Downloading (attempt ${attempt}/${maxRetries}): ${url}`)
      const code = await exec.exec('curl', [
        '-fsSL',
        '--retry',
        '3',
        '--retry-delay',
        '2',
        '-o',
        dest,
        url
      ])
      if (code === 0) return
      throw new Error(`curl exited with code ${code}`)
    } catch (err) {
      if (attempt === maxRetries) throw err
      const delay = attempt * 2000
      core.info(`Retrying in ${delay / 1000}s...`)
      await sleep(delay)
    }
  }
}

/**
 * Recursively find the first file matching a name inside a directory.
 */
async function findFile(
  dir: string,
  name: string
): Promise<string | undefined> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, name)
      if (found) return found
    } else if (entry.name === name) {
      return fullPath
    }
  }
  return undefined
}

// ─── go Installation ──────────────────────────────────────────────────────────

/**
 * Install unistack via `go install`.
 * Requires go to be available in PATH.
 */
async function installViaGo(version: string): Promise<boolean> {
  core.startGroup(`Installing unistack@${version} via go install`)
  try {
    const pkg =
      version && version !== 'latest'
        ? `${GO_MODULE}@v${version}`
        : `${GO_MODULE}@latest`
    const code = await exec.exec('go', ['install', pkg])
    if (code !== 0) return false

    // go installs to $GOPATH/bin or $HOME/go/bin
    const goPathBin = process.env.GOPATH
      ? path.join(process.env.GOPATH, 'bin')
      : path.join(os.homedir(), 'go', 'bin')
    core.addPath(goPathBin)
    core.info(`Added ${goPathBin} to PATH`)
    return true
  } catch (err) {
    core.warning(`go install failed: ${errorMessage(err)}`)
    return false
  } finally {
    core.endGroup()
  }
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify unistack is accessible and return its version string.
 */
async function verifyUnistack(): Promise<string> {
  core.startGroup('Verifying unistack installation')
  try {
    const result = await exec.getExecOutput('unistack', ['version'], {
      silent: false,
      ignoreReturnCode: true
    })
    const versionMatch = result.stdout
      .trim()
      .match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)
    return versionMatch ? versionMatch[1] : result.stdout.trim()
  } finally {
    core.endGroup()
  }
}

/**
 * Return platform-specific paths that should be cached.
 * UniStack uses XDG Base Directory convention:
 *   Linux & macOS: ~/.local/share/unistack
 *   Windows:       %LOCALAPPDATA%\unistack
 */
function getCachePaths(): string[] {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return [
      path.join(
        process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
        'unistack'
      )
    ]
  }
  return [path.join(home, '.local', 'share', 'unistack')]
}

/**
 * Restore the unistack installation from cache.
 * Supports primary key + OS-prefixed restore-keys for better hit rates.
 */
async function restoreUnistackCache(
  version: string
): Promise<{ primaryKey: string; hit: boolean }> {
  core.startGroup('Restoring unistack cache')

  const cacheKeyTemplate =
    core.getInput('cache_key') || DEFAULT_CACHE_KEY_TEMPLATE
  const primaryKey = await processCacheKeyTemplate(cacheKeyTemplate, version)

  // Fallback restore-keys (OS-scoped, progressively broader)
  const runnerOs = process.env.RUNNER_OS ?? process.platform
  const restoreKeys = [
    `${core.getInput('cache_key_prefix') || 'setup-unistack-v1'}-${runnerOs.toLowerCase()}-unistack-`,
    `${core.getInput('cache_key_prefix') || 'setup-unistack-v1'}-${runnerOs.toLowerCase()}-`
  ]

  const cachePaths = getCachePaths()
  core.info(`Cache paths:\n  ${cachePaths.join('\n  ')}`)
  core.info(`Primary key: ${primaryKey}`)
  core.info(`Restore keys:\n  ${restoreKeys.join('\n  ')}`)

  const hitKey = await cache.restoreCache(cachePaths, primaryKey, restoreKeys)
  const isExactHit = hitKey === primaryKey

  core.setOutput('cache-hit', isExactHit)
  if (hitKey) {
    core.notice(`✅ Cache restored from key: ${hitKey}`)
  } else {
    core.warning('⚠️ No cache found, will install fresh')
  }

  core.endGroup()
  return { primaryKey, hit: isExactHit }
}

/**
 * Save the unistack installation to cache.
 * Called from post-action (src/post.ts) after the job completes.
 */
async function saveUnistackCache(cacheKey: string): Promise<void> {
  core.startGroup('Saving unistack cache')
  const cachePaths = getCachePaths()

  // Filter to paths that actually exist (non-existent paths cause cache errors)
  const existingPaths = cachePaths.filter(p => fs.existsSync(p))
  if (existingPaths.length === 0) {
    core.warning('No cache paths found on disk, skipping cache save')
    core.endGroup()
    return
  }

  core.info(`Saving paths:\n  ${existingPaths.join('\n  ')}`)
  const id = await cache.saveCache(existingPaths, cacheKey)
  if (id !== -1) {
    core.info(`Cache saved (key: ${cacheKey})`)
  } else {
    core.info('Cache already exists for this key')
  }
  core.endGroup()
}

// Export for use by post.ts
export { saveUnistackCache, getCachePaths }

// ─── Cache Key Template ───────────────────────────────────────────────────────

async function processCacheKeyTemplate(
  template: string,
  version: string
): Promise<string> {
  const cacheKeyPrefix =
    core.getInput('cache_key_prefix') || 'setup-unistack-v1'
  const unistackEnv = process.env.UNISTACK_ENV?.replace(/,/g, '-') ?? ''
  const platform = `${getPlatformArch()}-${getRunnerImageId()}`

  // Hash unistack config files
  const fileHash = await glob.hashFiles(
    UNISTACK_CONFIG_FILE_PATTERNS.join('\n')
  )

  const baseData = {
    version,
    cache_key_prefix: cacheKeyPrefix,
    platform,
    file_hash: fileHash,
    unistack_env: unistackEnv
  }

  // Compute default key first
  const defaultKey = Handlebars.compile(DEFAULT_CACHE_KEY_TEMPLATE)(baseData)

  const templateData = {
    ...baseData,
    default: defaultKey,
    env: process.env
  }

  return Handlebars.compile(template)(templateData)
}

// ─── Platform Helpers ─────────────────────────────────────────────────────────

/**
 * Return the platform-arch string matching goreleaser naming:
 * e.g. Linux_x86_64, Darwin_arm64, Windows_x86_64
 */
function getTarget(): string {
  const osName = getPlatformName()
  const arch = getArchName()
  return `${osName}_${arch}`
}

function getPlatformName(): string {
  switch (process.platform) {
    case 'linux':
      return 'Linux'
    case 'darwin':
      return 'Darwin'
    case 'win32':
      return 'Windows'
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

function getArchName(): string {
  switch (process.arch) {
    case 'x64':
      return 'x86_64'
    case 'ia32':
      return 'i386'
    case 'arm64':
      return 'arm64'
    case 'arm':
      return 'armv6'
    default:
      throw new Error(`Unsupported arch: ${process.arch}`)
  }
}

/**
 * Platform-arch string for cache key (lowercase, e.g. linux-x64).
 */
function getPlatformArch(): string {
  const p =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'macos'
        : 'linux'
  const a = process.arch
  return `${p}-${a}`
}

/**
 * Return the runner image ID for cache key uniqueness.
 * GitHub-hosted runners expose ImageOS (e.g. "ubuntu24", "macos15").
 */
function getRunnerImageId(): string {
  return process.env.ImageOS ?? 'self-hosted'
}

// ─── Install Dirs ─────────────────────────────────────────────────────────────

/**
 * Return the directory where the unistack binary should be placed.
 * This is always ~/.local/bin (cross-platform).
 */
function getInstallBinDir(): string {
  return path.join(os.homedir(), '.local', 'bin')
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
