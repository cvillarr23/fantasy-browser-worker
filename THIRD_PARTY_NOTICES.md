# Third-party dependencies

The [MIT License](LICENSE) covers this repository's code and documentation.
Dependencies retain their own licenses. The Docker image keeps npm package
license and NOTICE files in `/app/node_modules/`; retain those files when
redistributing it.

The 2026-10-11 npm check found no GPL, LGPL or MPL packages. It includes
development dependencies because the Dockerfile runs `npm ci` without omitting
them. `caniuse-lite` uses CC-BY-4.0; preserve its packaged attribution and license.

That npm check does not cover Chromium, OpenBao or Debian packages installed by
the Dockerfile. OpenBao uses MPL-2.0; Chromium and its bundled components have
their own notices. Preserve their upstream licenses and `/usr/share/doc/*/copyright`,
and supply corresponding covered source when distributing an image.

See the cross-repository [licensing guide](https://github.com/cvillarr23/fantasy-project/blob/main/docs/contributing/licensing.md)
for the audit scope and repeatable checks.
