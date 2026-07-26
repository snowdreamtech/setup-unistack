# setup-unistack

[![CI](https://github.com/snowdreamtech/setup-unistack/actions/workflows/ci.yml/badge.svg)](https://github.com/snowdreamtech/setup-unistack/actions/workflows/ci.yml)
[![Check dist/](https://github.com/snowdreamtech/setup-unistack/actions/workflows/check-dist.yml/badge.svg)](https://github.com/snowdreamtech/setup-unistack/actions/workflows/check-dist.yml)

> GitHub Action to install and configure [UniStack](https://github.com/snowdreamtech/UniStack) — the Uni Runtime and Tools Manager.

---

## Features

- 🔍 **Smart auto-detection** — picks the best install method based on available runtimes
- 📦 **Multiple install methods** — npm, pip (coming soon), GitHub Release, go install
- 🌐 **GitHub Proxy support** — for restricted networks or mirrors
- 💾 **Caching** — Handlebars-based cache key templates for fast repeated runs
- 🖥️ **Cross-platform** — Linux, macOS, Windows

---

## Usage

### Minimal (auto-detect)

```yaml
steps:
  - uses: snowdreamtech/setup-unistack@v0
```

### Specify version

```yaml
steps:
  - uses: snowdreamtech/setup-unistack@v0
    with:
      unistack-version: '0.25.7'
```

### Force a specific install method

```yaml
steps:
  - uses: snowdreamtech/setup-unistack@v0
    with:
      install_method: npm # npm | pip | release | go | auto
```

### With GitHub Proxy (for restricted networks)

```yaml
steps:
  - uses: snowdreamtech/setup-unistack@v0
    with:
      install_method: release
      github_proxy: 'https://ghproxy.com/'
      github_token: ${{ secrets.GITHUB_TOKEN }}
```

### With caching

```yaml
steps:
  - uses: snowdreamtech/setup-unistack@v0
    with:
      unistack-version: '0.25.7'
      cache: true
      github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Custom cache key template

```yaml
steps:
  - uses: snowdreamtech/setup-unistack@v0
    with:
      cache_key: '{{cache_key_prefix}}-{{platform}}-{{version}}'
```

---

## Inputs

| Input              | Required | Default               | Description                                                               |
| ------------------ | -------- | --------------------- | ------------------------------------------------------------------------- |
| `unistack-version` | No       | `""` (latest)         | The unistack version to install (e.g. `0.25.7`)                           |
| `github_token`     | No       | `${{ github.token }}` | GitHub token for API auth and rate limit avoidance                        |
| `github_proxy`     | No       | `""`                  | Proxy prefix for GitHub download URLs (also reads `GITHUB_PROXY` env var) |
| `install_method`   | No       | `auto`                | Installation method: `auto` / `npm` / `pip` / `release` / `go`            |
| `cache`            | No       | `true`                | Enable caching of the unistack installation                               |
| `cache_save`       | No       | `true`                | Save cache after installation                                             |
| `cache_key_prefix` | No       | `setup-unistack-v1`   | Cache key prefix (change to invalidate cache)                             |
| `cache_key`        | No       | `""`                  | Override the full cache key (supports template variables)                 |

---

## Outputs

| Output             | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `cache-hit`        | `true` if the cache was restored                              |
| `unistack-version` | The installed unistack version string                         |
| `install-method`   | The method used for installation (`npm`/`pip`/`release`/`go`) |

---

## Install Methods

### `auto` (default)

Detects the best method based on available tools, in priority order:

| Priority | Method    | Requirement                                             |
| -------- | --------- | ------------------------------------------------------- |
| 1        | `npm`     | `npm` is in PATH                                        |
| 2        | `pip`     | `pip` or `pip3` is in PATH                              |
| 3        | `release` | Any environment (downloads binary from GitHub Releases) |
| 4        | `go`      | `go` is in PATH                                         |

### `npm`

```bash
npm install -g @snowdreamtech/unistack@<version>
```

### `pip`

```bash
pip install snowdreamtech-unistack==<version>
```

### `release`

Downloads the prebuilt binary from [GitHub Releases](https://github.com/snowdreamtech/UniStack/releases).
Supports `github_proxy` for mirror acceleration and retries (up to 3 attempts).

### `go`

```bash
go install github.com/snowdreamtech/unistack@v<version>
```

---

## Cache Key Template Variables

When using a custom `cache_key`, the following [Handlebars](https://handlebarsjs.com/) variables are available:

| Variable               | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `{{version}}`          | The unistack version (from the `unistack-version` input)          |
| `{{cache_key_prefix}}` | The cache key prefix (from `cache_key_prefix` input)              |
| `{{platform}}`         | Target platform + runner image (e.g. `linux-x64-ubuntu24`)        |
| `{{file_hash}}`        | Hash of unistack config files (`.unistack.toml`, `unistack.lock`) |
| `{{unistack_env}}`     | Value of `UNISTACK_ENV` environment variable                      |
| `{{default}}`          | The computed default cache key (useful for extending)             |

**Conditional syntax:**

```
{{#if version}}-{{version}}{{/if}}
```

---

## License

[MIT](./LICENSE) © [Snowdream Tech](https://github.com/snowdreamtech)
