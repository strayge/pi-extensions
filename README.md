# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent.

All extensions require pi >=1.0.2.

## vendor/

`vendor/docs` and `vendor/examples` are expected to be **symlinks** into the
locally installed `@earendil-works/pi-coding-agent`.

Recreate them after installing or upgrading pi:

```sh
PI_PKG=$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")
ln -sfn "$PI_PKG/docs"     vendor/docs
ln -sfn "$PI_PKG/examples" vendor/examples
```
