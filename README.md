# Taodock Catalog Review for SHOPLINE

Draft and review English product descriptions for a Singapore SHOPLINE store. The app compares each draft with approved measurements and required wording, then sends a description update only after you confirm it.

**Version 0.1.0** · Self-hosted single-store app · Node.js 22+ · MIT

[Download the release](https://github.com/taodock-api/taodock-shopline/releases) · [Support](https://github.com/taodock-api/taodock-shopline/issues) · [Privacy and data handling](PRIVACY.md)

## Try the demo

Download and extract the release ZIP. Start the demo with this command.

```sh
npm run demo
```

Open `http://127.0.0.1:8787`. Select some of the six fictional products. Their approved facts are prefilled. Generate drafts to see clean descriptions, missing phrases and changed measurements. Edit a flagged draft and check it again. Tick the replacement confirmation to try saving a checked draft to the in-memory store. The demo uses fixed replies, and all changes disappear when the process stops.

## Connect your own store

1. In your SHOPLINE admin, use the store-owner account to create and install a **Private App**. Give it `read_products` and `write_products` access. Copy its access token and locate your store handle, the prefix in `{handle}.myshopline.com`. [SHOPLINE app distribution and permissions](https://developer.shopline.com/docs/apps/application-management/application-distribution-methods/)
2. Copy `.env.example` to `.env` and fill in `SHOPLINE_STORE_HANDLE`, `SHOPLINE_ACCESS_TOKEN`, and a dedicated `TAODOCK_API_KEY`. Set `APP_PASSWORD` to a private password of at least 16 characters. You can also supply these values through your server's secret manager. [Taodock API keys and models](https://docs.taodock.com/en/api/overview.html)
3. Run `node --env-file=.env src/server.mjs` or use `npm start` with the environment already configured. Sign in as `admin` with your chosen password. The app binds to loopback. If you expose it to your team, put it behind an HTTPS reverse proxy that preserves the external Host header, set `APP_ORIGIN` to the exact HTTPS origin, and run one instance for the store.
4. Select up to five products, check the title shown for each, and enter the approved measurements and required phrases. Select a text model from the IDs returned to your Taodock key. Generation uses one Chat Completions request per product.
5. Compare the current description with the draft and resolve any findings. You can **Check edited draft** or **Flag draft** and choose a reason. After reviewing the entire description, confirm the replacement and choose **Apply description**.

The API is pinned to SHOPLINE Admin REST `v20260901`. The app reads products and updates only the approved product's `body_html` field. Applying a draft replaces the existing HTML with paragraphs of escaped plain text, removing previous formatting or media embedded in the description. The product's publish status and its separately managed media are outside the update payload. The app rereads the product before writing and verifies the saved description afterward. Avoid editing the same product in SHOPLINE during the update.

[SHOPLINE product list API](https://developer.shopline.com/docs/admin-rest-api/v20260901/product/product/get-products/) · [SHOPLINE update API](https://developer.shopline.com/docs/admin-rest-api/v20260901/product/product/update-a-product/)

## What the checks cover

Enter one number and unit per line, such as `500 ml`, `30 cm`, `15 W` or `4 pieces`. The app recognises metric length, weight, volume and power, durations, piece counts and percentages. Equivalent units such as `0.5 L` and `500 ml` match. Required phrases are checked literally, with case and spacing normalised.

The checker flags missing or added supported measurements and missing phrases. It does not interpret negation, number words, ranges, paraphrases or other commercial claims. Review accuracy, claims and suitability before publishing. Drafts are available for one hour or until the server restarts.

Catalogue checks and samples adapt work from [Taodock Catalog Copy Audit](https://github.com/taodock-api/taodock-aiverify/tree/v0.1.0). SHOPLINE identifies the platform this independent app integrates with. Distribution for this release is through GitHub Releases.

## Build and test

The app has no npm dependencies. The package script uses the command-line `zip` tool.

```sh
npm test
npm run package
(cd dist && shasum -a 256 -c SHA256SUMS)
```

The integration tests exercise the live-mode adapters over local simulated HTTP services. The demo runs without any store or Taodock credentials.
