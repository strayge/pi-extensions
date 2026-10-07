# pi-speed

Model-request speed reporting for [pi](https://github.com/earendil-works/pi).
The extension provides a historical `/speed` report and a current-session
`speed` statusline item without making provider or quota requests.

## Requirements

- Node.js >=22.19.0
- pi >=1.0.2

## Development

Install dependencies and run the package checks from this directory:

```bash
npm install
npm run check
```

The package is self-contained and does not depend on `@strayge/pi-usage` or
another repository extension.

The extension entry point is under construction during the ownership-transfer
step of the extraction. Installation and activation instructions will be added
when `/speed` is registered here.
