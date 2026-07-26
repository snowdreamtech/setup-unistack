/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, beforeEach, afterAll, vi, Mock } from 'vitest'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as cache from '@actions/cache'
import * as glob from '@actions/glob'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { run, saveUnistackCache } from './main.js'
import './post.js'

// Mock dependencies
vi.mock('@actions/core')
vi.mock('@actions/exec')
vi.mock('@actions/io')
vi.mock('@actions/cache')
vi.mock('@actions/glob')
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    promises: {
      mkdir: vi.fn(),
      copyFile: vi.fn(),
      rm: vi.fn(),
      readdir: vi.fn(),
      access: vi.fn()
    },
    existsSync: vi.fn()
  }
})
vi.mock('os')

describe('main.ts', () => {
  const originalPlatform = process.platform
  const originalArch = process.arch
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()

    // Restore original process values
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    Object.defineProperty(process, 'arch', { value: originalArch })
    process.env = { ...originalEnv }

    // Default mock inputs
    ;(core.getInput as Mock).mockImplementation((input: string) => {
      switch (input) {
        case 'unistack-version':
          return ''
        case 'install_method':
          return 'auto'
        case 'github_token':
          return ''
        case 'github_proxy':
          return ''
        case 'cache_key':
          return ''
        case 'cache_key_prefix':
          return ''
        default:
          return ''
      }
    })
    ;(core.getBooleanInput as Mock).mockImplementation((input: string) => {
      switch (input) {
        case 'cache':
          return false
        case 'cache_save':
          return false
        default:
          return false
      }
    })

    // Mock exec and find commands
    ;(exec.exec as Mock).mockResolvedValue(0)
    ;(io.which as Mock).mockImplementation(async cmd => {
      if (cmd === 'npm') return '/usr/bin/npm'
      throw new Error('not found')
    })
    ;(exec.getExecOutput as Mock).mockImplementation(async (cmd, _args) => {
      if (cmd === 'curl') {
        return {
          stdout: JSON.stringify([
            { tag_name: 'v1.0.0', draft: false, prerelease: false }
          ]),
          exitCode: 0
        }
      }
      if (cmd === 'unistack') {
        return { stdout: '1.0.0', exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    })

    // Mock cache
    ;(cache.restoreCache as Mock).mockResolvedValue(undefined)
    ;(cache.saveCache as Mock).mockResolvedValue(1)

    // Mock fs and os
    ;(os.homedir as Mock).mockReturnValue('/home/user')
    ;(os.tmpdir as Mock).mockReturnValue('/tmp')
    ;(fs.existsSync as Mock).mockReturnValue(true)
    ;(glob.hashFiles as Mock).mockResolvedValue('fakehash')
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    Object.defineProperty(process, 'arch', { value: originalArch })
    process.env = originalEnv
  })

  describe('detectInstallMethod', () => {
    it('should detect npm if available', async () => {
      ;(io.which as Mock).mockImplementation(async cmd => {
        if (cmd === 'npm') return '/usr/bin/npm'
        throw new Error('not found')
      })
      ;(exec.exec as Mock).mockImplementation(async (cmd, _args) => {
        if (cmd === 'npm') return 0
        throw new Error('not found')
      })

      await run()
      expect(core.setOutput).toHaveBeenCalledWith('install-method', 'npm')
      expect(exec.exec).toHaveBeenCalledWith(
        'npm',
        expect.arrayContaining([
          'install',
          '-g',
          '@snowdreamtech/unistack@latest'
        ])
      )
    })

    it('should detect pip if pip is available and npm is not', async () => {
      ;(io.which as Mock).mockImplementation(async (cmd: string) => {
        if (cmd === 'pip') return '/usr/bin/pip'
        if (cmd === 'pip3') return ''
        if (cmd === 'npm') return ''
        return ''
      })
      ;(exec.getExecOutput as Mock).mockImplementation(async (cmd: string) => {
        if (cmd === '/usr/bin/pip') return { stdout: '', exitCode: 0 }
        return { stdout: '', exitCode: 0 }
      })

      await run()

      expect(core.setOutput).toHaveBeenCalledWith('install-method', 'pip')
      expect(exec.getExecOutput).toHaveBeenCalledWith(
        '/usr/bin/pip',
        ['install', 'snowdreamtech-unistack'],
        expect.anything()
      )
    })

    it('should detect go if go is available and npm/pip are not', async () => {
      ;(io.which as Mock).mockImplementation(async cmd => {
        if (cmd === 'go') return '/usr/bin/go'
        throw new Error('not found')
      })
      ;(exec.exec as Mock).mockImplementation(async (cmd, _args) => {
        if (cmd === 'go') return 0
        throw new Error('not found')
      })

      await run()
      expect(core.setOutput).toHaveBeenCalledWith('install-method', 'go')
      expect(exec.exec).toHaveBeenCalledWith(
        'go',
        expect.arrayContaining(['install'])
      )
    })

    it('should fallback to release if no tools available', async () => {
      ;(io.which as Mock).mockImplementation(async () => {
        throw new Error('not found')
      })
      ;(exec.exec as Mock).mockImplementation(async (cmd, _args) => {
        if (cmd === 'curl') return 0
        return 0
      })

      // We need to mock curl for the github API call to fetch version
      ;(exec.getExecOutput as Mock).mockImplementation(async (cmd, args) => {
        if (
          cmd === 'curl' &&
          args &&
          args.some((a: string) => a.includes('api.github.com'))
        ) {
          return {
            stdout: JSON.stringify([
              { tag_name: 'v1.0.0', draft: false, prerelease: false }
            ]),
            exitCode: 0
          }
        }
        if (cmd === 'unistack' && args && args.includes('version')) {
          return { stdout: '1.0.0', exitCode: 0 }
        }
        return { stdout: '', exitCode: 0 }
      })

      // We need fs to pretend to find the binary
      ;(fs.promises.readdir as Mock).mockResolvedValue([
        { name: 'unistack', isDirectory: () => false }
      ])

      await run()
      expect(core.setOutput).toHaveBeenCalledWith('install-method', 'release')
      // curl download
      expect(exec.exec).toHaveBeenCalledWith(
        'curl',
        expect.arrayContaining(['-fsSL', '--retry', '3'])
      )
    })
  })

  describe('Version Resolution via GitHub Release', () => {
    beforeEach(() => {
      ;(core.getInput as Mock).mockImplementation((input: string) => {
        if (input === 'install_method') return 'release'
        return ''
      })
      // Ensure commands mock out to not fail
      ;(exec.exec as Mock).mockResolvedValue(0)
      ;(fs.promises.readdir as Mock).mockResolvedValue([
        { name: 'unistack', isDirectory: () => false }
      ])
      ;(exec.getExecOutput as Mock).mockImplementation(async (cmd, args) => {
        if (cmd === 'unistack' && args.includes('version')) {
          return { stdout: '1.0.0', exitCode: 0 }
        }
        return { stdout: '', exitCode: 0 }
      })
    })

    it('should fetch latest version if no version specified', async () => {
      ;(exec.getExecOutput as Mock).mockImplementationOnce(
        async (_cmd, _args) => {
          return {
            stdout: JSON.stringify([
              { tag_name: 'v1.1.0', draft: false, prerelease: true },
              { tag_name: 'v1.0.0', draft: false, prerelease: false },
              { tag_name: 'v0.9.0', draft: false, prerelease: false }
            ]),
            exitCode: 0
          }
        }
      )
      await run()
      expect(core.info).toHaveBeenCalledWith('Target unistack version: 0.9.0')
    })

    it('should fetch latest version if version is "latest"', async () => {
      ;(core.getInput as Mock).mockImplementation((input: string) => {
        if (input === 'install_method') return 'release'
        if (input === 'unistack-version') return 'latest'
        return ''
      })
      ;(exec.getExecOutput as Mock).mockImplementationOnce(
        async (_cmd, _args) => {
          return {
            stdout: JSON.stringify([
              { tag_name: 'v1.1.0', draft: false, prerelease: false },
              { tag_name: 'v1.0.0', draft: false, prerelease: false }
            ]),
            exitCode: 0
          }
        }
      )
      await run()
      expect(core.info).toHaveBeenCalledWith('Target unistack version: 1.1.0')
    })

    it('should fallback to latest string if not enough releases', async () => {
      ;(exec.getExecOutput as Mock).mockImplementationOnce(
        async (_cmd, _args) => {
          return { stdout: JSON.stringify([]), exitCode: 0 }
        }
      )
      await run()
      expect(core.info).toHaveBeenCalledWith('Target unistack version: latest')
    })

    it('should pass github_token if provided', async () => {
      ;(core.getInput as Mock).mockImplementation((input: string) => {
        if (input === 'install_method') return 'release'
        if (input === 'github_token') return 'fake_token'
        return ''
      })
      ;(exec.getExecOutput as Mock).mockImplementationOnce(
        async (_cmd, _args) => {
          return {
            stdout: JSON.stringify([
              { tag_name: 'v1.0.0', draft: false, prerelease: false }
            ]),
            exitCode: 0
          }
        }
      )
      await run()
      expect(exec.getExecOutput).toHaveBeenCalledWith(
        'curl',
        expect.arrayContaining(['Authorization: Bearer fake_token']),
        expect.anything()
      )
    })
  })

  describe('Installation Methods Specifics', () => {
    describe('npm', () => {
      beforeEach(() => {
        ;(core.getInput as Mock).mockImplementation((input: string) => {
          if (input === 'install_method') return 'npm'
          if (input === 'unistack-version') return '2.0.0'
          return ''
        })
      })

      it('should install via npm with specific version', async () => {
        ;(exec.getExecOutput as Mock).mockImplementation(async (cmd, args) => {
          if (cmd === 'npm' && args.includes('prefix'))
            return { stdout: '/npm/prefix', exitCode: 0 }
          if (cmd === 'unistack') return { stdout: '2.0.0', exitCode: 0 }
          return { stdout: '', exitCode: 0 }
        })

        await run()
        expect(exec.exec).toHaveBeenCalledWith('npm', [
          'install',
          '-g',
          '@snowdreamtech/unistack@2.0.0'
        ])
        expect(core.addPath).toHaveBeenCalledWith(
          path.join('/npm/prefix', 'bin')
        )
      })

      it('should fail if npm install fails', async () => {
        ;(exec.exec as Mock).mockResolvedValue(1) // Failed
        await run()
        expect(core.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('Failed to install unistack')
        )
      })
    })

    describe('pip', () => {
      beforeEach(() => {
        ;(core.getInput as Mock).mockImplementation((input: string) => {
          if (input === 'install_method') return 'pip'
          if (input === 'unistack-version') return '3.0.0'
          return ''
        })
        ;(io.which as Mock).mockImplementation(async cmd => {
          if (cmd === 'pip3') return '/usr/bin/pip3'
          if (cmd === 'pip') return '/usr/bin/pip'
          throw new Error('not found')
        })
      })

      it('should install via pip with specific version', async () => {
        ;(exec.getExecOutput as Mock).mockImplementation(async cmd => {
          if (cmd === '/usr/bin/pip3' || cmd === '/usr/bin/pip')
            return { exitCode: 0 }
          if (cmd === 'unistack') return { stdout: '3.0.0', exitCode: 0 }
          return { stdout: '', exitCode: 0 }
        })

        await run()
        expect(exec.getExecOutput).toHaveBeenCalledWith(
          '/usr/bin/pip3',
          ['install', 'snowdreamtech-unistack==3.0.0'],
          expect.anything()
        )
      })

      it('should install latest unistack via pip', async () => {
        ;(core.getInput as Mock).mockImplementation((input: string) => {
          if (input === 'install_method') return 'pip'
          if (input === 'unistack-version') return ''
          return ''
        })
        ;(exec.getExecOutput as Mock).mockImplementation(async cmd => {
          if (cmd === '/usr/bin/pip3' || cmd === '/usr/bin/pip')
            return { exitCode: 0 }
          if (cmd === 'unistack') return { stdout: '4.0.0', exitCode: 0 }
          if (cmd === 'curl')
            return {
              stdout: JSON.stringify([
                { tag_name: 'v4.0.0', draft: false, prerelease: false }
              ]),
              exitCode: 0
            }
          return { stdout: '', exitCode: 0 }
        })

        await run()
        expect(exec.getExecOutput).toHaveBeenCalledWith(
          '/usr/bin/pip3',
          ['install', 'snowdreamtech-unistack'],
          expect.anything()
        )
      })

      it('should fail if pip install fails', async () => {
        ;(exec.getExecOutput as Mock).mockImplementation(async cmd => {
          if (cmd === '/usr/bin/pip3' || cmd === '/usr/bin/pip')
            return { exitCode: 1, stderr: 'error' }
          return { stdout: '', exitCode: 0 }
        })

        await run()
        expect(core.setFailed).toHaveBeenCalled()
      })
    })

    describe('go', () => {
      beforeEach(() => {
        ;(core.getInput as Mock).mockImplementation((input: string) => {
          if (input === 'install_method') return 'go'
          if (input === 'unistack-version') return '1.2.3'
          return ''
        })
      })

      it('should fail gracefully if go install fails', async () => {
        ;(core.getInput as Mock).mockImplementation(input =>
          input === 'install_method' ? 'go' : ''
        )
        ;(exec.exec as Mock).mockImplementation(async (_cmd, _args) => {
          if (_cmd === 'go') throw new Error('Go command failed network')
          return 0
        })
        await run()
        expect(core.warning).toHaveBeenCalledWith(
          expect.stringContaining('go install failed')
        )
      })

      it('should install via go', async () => {
        process.env.GOPATH = '/fake/gopath'
        ;(exec.getExecOutput as Mock).mockResolvedValue({
          stdout: '1.2.3',
          exitCode: 0
        })

        await run()
        expect(exec.exec).toHaveBeenCalledWith('go', [
          'install',
          'github.com/snowdreamtech/unistack@v1.2.3'
        ])
        expect(core.addPath).toHaveBeenCalledWith(
          path.join('/fake/gopath', 'bin')
        )
      })

      it('should handle go missing gopath', async () => {
        delete process.env.GOPATH
        ;(exec.getExecOutput as Mock).mockResolvedValue({
          stdout: '1.2.3',
          exitCode: 0
        })
        await run()
        expect(core.addPath).toHaveBeenCalledWith(
          path.join('/home/user', 'go', 'bin')
        )
      })
    })

    describe('release', () => {
      beforeEach(() => {
        ;(core.getInput as Mock).mockImplementation((input: string) => {
          if (input === 'install_method') return 'release'
          if (input === 'unistack-version') return '1.5.0'
          return ''
        })
        ;(exec.getExecOutput as Mock).mockResolvedValue({
          stdout: '1.5.0',
          exitCode: 0
        })
      })

      it('should download and extract for linux', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        Object.defineProperty(process, 'arch', { value: 'x64' })
        ;(fs.promises.readdir as Mock).mockResolvedValue([
          { name: 'unistack', isDirectory: () => false }
        ])

        await run()

        expect(exec.exec).toHaveBeenCalledWith(
          'curl',
          expect.arrayContaining(['-fsSL'])
        )
        expect(exec.exec).toHaveBeenCalledWith(
          'tar',
          expect.arrayContaining(['-xzf'])
        )
        expect(fs.promises.copyFile).toHaveBeenCalled()
        expect(exec.exec).toHaveBeenCalledWith('chmod', [
          '+x',
          expect.any(String)
        ])
      })

      it('should download and extract for windows', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        Object.defineProperty(process, 'arch', { value: 'x64' })
        ;(fs.promises.readdir as Mock).mockResolvedValue([
          { name: 'unistack.exe', isDirectory: () => false }
        ])

        await run()

        expect(exec.exec).toHaveBeenCalledWith(
          'unzip',
          expect.arrayContaining(['-o'])
        )
        expect(fs.promises.copyFile).toHaveBeenCalled()
        expect(exec.exec).not.toHaveBeenCalledWith('chmod', expect.anything())
      })

      it('should use github_proxy if provided', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        Object.defineProperty(process, 'arch', { value: 'arm64' })
        ;(core.getInput as Mock).mockImplementation((input: string) => {
          if (input === 'install_method') return 'release'
          if (input === 'unistack-version') return '1.5.0'
          if (input === 'github_proxy') return 'https://mirror.example.com/'
          return ''
        })
        ;(fs.promises.readdir as Mock).mockResolvedValue([
          { name: 'unistack', isDirectory: () => false }
        ])

        await run()

        const curlCall = (exec.exec as Mock).mock.calls.find(
          c => c[0] === 'curl'
        )
        expect(
          curlCall[1].some(
            arg =>
              typeof arg === 'string' &&
              arg.includes('https://mirror.example.com/https://github.com')
          )
        ).toBe(true)
      })

      it('should retry download on non-zero exit code', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        Object.defineProperty(process, 'arch', { value: 'x64' })
        let curlAttempts = 0
        ;(exec.exec as Mock).mockImplementation(async _cmd => {
          if (_cmd === 'curl') {
            curlAttempts++
            if (curlAttempts < 3) return 1
            return 0
          }
          return 0
        })
        await run()
        expect(curlAttempts).toBe(3)
      }, 10000)

      it('should recurse directories in findFile', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        Object.defineProperty(process, 'arch', { value: 'x64' })
        ;(fs.promises.readdir as Mock).mockResolvedValueOnce([
          { name: 'subdir', isDirectory: () => true, isFile: () => false }
        ] as never)
        ;(fs.promises.readdir as Mock).mockResolvedValueOnce([
          { name: 'unistack', isDirectory: () => false, isFile: () => true }
        ] as never)

        await run()
        expect(core.addPath).toHaveBeenCalled()
      })

      it('should retry download on failure', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        Object.defineProperty(process, 'arch', { value: 'x64' })
        ;(fs.promises.readdir as Mock).mockResolvedValue([
          { name: 'unistack', isDirectory: () => false }
        ])

        let curlAttempts = 0
        ;(exec.exec as Mock).mockImplementation(async cmd => {
          if (cmd === 'curl') {
            curlAttempts++
            if (curlAttempts < 3) throw new Error('Network fail')
            return 0
          }
          return 0
        })

        await run()
        expect(curlAttempts).toBe(3)
        expect(core.info).toHaveBeenCalledWith(
          expect.stringContaining('Downloading (attempt 3/3)')
        )
      }, 10000)

      it('should fail if file not found in extracted archive', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        Object.defineProperty(process, 'arch', { value: 'x64' })

        // Empty dir
        ;(fs.promises.readdir as Mock).mockResolvedValue([])

        await run()

        expect(core.warning).toHaveBeenCalledWith(
          expect.stringContaining('not found in extracted archive')
        )
        expect(core.setFailed).toHaveBeenCalledWith(
          expect.stringContaining(
            'Failed to install unistack@1.5.0 via method "release"'
          )
        )
      })
    })
  })

  describe('Error handling', () => {
    it('should catch errors and call setFailed', async () => {
      ;(core.getInput as Mock).mockImplementation(() => {
        throw new Error('Something terrible happened')
      })

      await run()

      expect(core.setFailed).toHaveBeenCalledWith('Something terrible happened')
    })

    it('should catch non-Error exceptions and throw', async () => {
      ;(core.getInput as Mock).mockImplementation(() => {
        throw 'String exception'
      })

      await expect(run()).rejects.toEqual('String exception')
      expect(core.setFailed).not.toHaveBeenCalled()
    })
  })

  describe('Unused exports and unsupported platforms', () => {
    it('saveUnistackCache does nothing if no paths exist', async () => {
      ;(fs.existsSync as Mock).mockReturnValue(false)
      await saveUnistackCache('test-key')
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('No cache paths found on disk')
      )
    })

    it('saveUnistackCache saves cache if paths exist', async () => {
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(cache.saveCache as Mock).mockResolvedValue(123)
      await saveUnistackCache('test-key')
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('Cache saved')
      )
    })

    it('saveUnistackCache logs if cache already exists', async () => {
      ;(fs.existsSync as Mock).mockReturnValue(true)
      ;(cache.saveCache as Mock).mockResolvedValue(-1)
      await saveUnistackCache('test-key')
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('Cache already exists')
      )
    })

    it('throws on unsupported platform', async () => {
      ;(core.getInput as Mock).mockImplementation(input =>
        input === 'install_method' ? 'release' : ''
      )
      Object.defineProperty(process, 'platform', { value: 'sunos' })
      await expect(run()).resolves.toBeUndefined()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported platform: sunos')
      )
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to install')
      )
    })

    it('throws on unsupported arch', async () => {
      ;(core.getInput as Mock).mockImplementation(input =>
        input === 'install_method' ? 'release' : ''
      )
      Object.defineProperty(process, 'platform', { value: 'linux' })
      Object.defineProperty(process, 'arch', { value: 'mips' })
      await expect(run()).resolves.toBeUndefined()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported arch: mips')
      )
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to install')
      )
    })

    it('supports ia32 and arm architectures for release', async () => {
      ;(core.getInput as Mock).mockImplementation(input =>
        input === 'install_method' ? 'release' : ''
      )

      Object.defineProperty(process, 'platform', { value: 'linux' })
      Object.defineProperty(process, 'arch', { value: 'ia32' })
      await expect(run()).resolves.toBeUndefined()

      Object.defineProperty(process, 'arch', { value: 'arm' })
      await expect(run()).resolves.toBeUndefined()
    })
  })
})
