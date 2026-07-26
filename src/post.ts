/**
 * Post-action: save the unistack cache after the main job completes.
 * Reads PRIMARY_KEY and CACHE_PATHS state saved by main action.
 */
import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as fs from 'fs'

export async function post(): Promise<void> {
  try {
    const shouldCache = core.getBooleanInput('cache')
    const cacheHit = core.getState('CACHE_RESULT')
    const primaryKey = core.getState('PRIMARY_KEY')
    if (cacheHit === 'true') {
      core.info(`Cache was hit for key ${primaryKey}, not saving cache.`)
      return
    }

    const shouldSave = core.getBooleanInput('cache_save')
    if (!shouldCache || !shouldSave) {
      core.info('Cache save skipped (cache or cache_save is false)')
      return
    }

    const cachePathsJson = core.getState('CACHE_PATHS')

    if (!primaryKey || !cachePathsJson) {
      core.info(
        'No cache state found (cache may have been hit or disabled), skipping save'
      )
      return
    }

    let cachePaths: string[]
    try {
      cachePaths = JSON.parse(cachePathsJson) as string[]
    } catch {
      core.warning('Failed to parse CACHE_PATHS state, skipping cache save')
      return
    }

    // Filter to paths that actually exist on disk
    const existingPaths = cachePaths.filter(p => fs.existsSync(p))
    if (existingPaths.length === 0) {
      core.info('No cache paths exist on disk, skipping cache save')
      return
    }

    core.startGroup('Saving unistack cache (post-action)')
    core.info(`Paths to cache:\n  ${existingPaths.join('\n  ')}`)
    core.info(`Cache key: ${primaryKey}`)

    const id = await cache.saveCache(existingPaths, primaryKey)
    if (id !== -1) {
      core.info(`Cache saved successfully (key: ${primaryKey})`)
    } else {
      core.info('Cache already exists for this key, skipping save')
    }
    core.endGroup()
  } catch (err) {
    // Never fail the workflow due to cache errors
    if (err instanceof Error) {
      core.warning(`Cache save failed (non-fatal): ${err.message}`)
    }
  }
}
post()
