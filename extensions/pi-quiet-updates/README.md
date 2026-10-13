# pi-quiet-updates

Replaces pi's bordered startup banners ("Update Available" and "Package Updates
Available") with one muted line:

```
Updates available: pi 1.1.0 -> 1.2.0 · pi-web-access 0.37.0 -> 0.40.0
```

Update checks still run; only their presentation changes. Unlike `PI_OFFLINE`,
model catalog refreshes and other network features keep working. npm packages
show the installed -> latest version change when it could be captured; git packages and any
lookup that fails show just the name.

## Usage

```bash
pi -e "$PWD/extensions/pi-quiet-updates/src/index.ts"
```

## Caveat

This patches pi internals (`InteractiveMode` notification methods and
`DefaultPackageManager`'s npm version lookup). If a future pi renames them, the
extension falls back to the stock banners or to names without versions.
