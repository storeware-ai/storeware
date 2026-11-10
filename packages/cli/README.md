# @storeware/cli

Scaffold, run, check and ship apps for [Storeware](https://storeware.ai) shops.

```bash
npx @storeware/cli init my-app --template react-router
cd my-app
npm install
npx @storeware/cli login
npx @storeware/cli app dev -- npm run dev
```

`init` starts from one of four templates: `node` (plain JavaScript), `typescript` (Hono),
`react-router` or `nextjs`. Each has an `AGENTS.md` for coding agents.

`login` approves the CLI in the Storeware admin with a code, and offers to make a developer
account, with a development store, if you have none. `app dev` installs your app on a development
store through a tunnel to your machine, downloading Cloudflare's `cloudflared` and checking its
checksum the first time. `app preflight` runs the checks a review runs, and `app submit` sends your
listing for review. `storeware mcp` serves the docs and your app to a coding agent over MCP.

Every command: [storeware.ai/docs/cli](https://storeware.ai/docs/cli).

MIT licensed.
