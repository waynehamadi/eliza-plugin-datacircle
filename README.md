# Datacircle plugin for elizaOS

Find the best GTM APIs. We benchmark all the GTM APIs and we put the results on our website.

Our website: https://datacircle.dev

This plugin gives an [elizaOS](https://github.com/elizaOS/eliza) agent four actions that call Datacircle's open API, https://api.datacircle.dev/v1. You need no key and no account.

| Action | What the action gives | Call |
| --- | --- | --- |
| `DATACIRCLE_APIS` | Every GTM API on Datacircle, with the API's slug, number of plans, number of providers and best plan | `GET /apis` |
| `DATACIRCLE_BEST_PLANS` | One API's plans, sorted by score out of 100, best first. Each plan comes with a rank and a price per 1,000 calls | `GET /apis/{slug}/best` |
| `DATACIRCLE_PLANS` | Plans that match a provider or plan name, on all APIs or on one API. You can sort them by score, provider or price | `GET /plans` |
| `DATACIRCLE_PROVIDER` | The APIs a provider sells, and the provider's rank on each API | `GET /providers/{slug}` |

## Install

```bash
npm install @datacircle/plugin-datacircle
```

The plugin works with elizaOS 2.x (`@elizaos/core` 2.0.0 and later) on Node 24.

## Add the plugin to an agent

Add `datacirclePlugin` to the plugins of your `AgentRuntime`, next to your storage, assistant and model plugins:

```ts
import { resolve } from 'node:path';
import { AgentRuntime, stringToUuid } from '@elizaos/core';
import { SQLiteDatabaseAdapter } from '@elizaos/plugin-sqlite';
import assistantPlugin from '@elizaos/plugin-assistant';
import openaiPlugin from '@elizaos/plugin-openai';
import { datacirclePlugin } from '@datacircle/plugin-datacircle';

const character = { name: 'GTM agent', bio: 'Finds the best GTM APIs for the user.' };
const agentId = stringToUuid(character.name);
const adapter = SQLiteDatabaseAdapter.create(resolve('agent.db'), agentId);
await adapter.initialize();

const runtime = new AgentRuntime({
  agentId,
  character,
  adapter,
  plugins: [assistantPlugin, openaiPlugin, datacirclePlugin],
});
await runtime.initialize();
```

`@elizaos/plugin-openai` reads your key from `OPENAI_API_KEY`. Then ask the agent, for example, "Who are the best providers for the email-finder API?". The agent calls `DATACIRCLE_BEST_PLANS` and answers from its result.

The plugin adds a context named `gtm_apis`, and its actions belong to `gtm_apis` and `web`. Any user can call them, guests too, as they only read public data.

`createDatacirclePlugin({ fetch })` makes the same plugin with the `fetch` you give it, for example to add a proxy or a timeout. `datacircleActions()` gives the four actions alone.

## What an action gives back

Each action's result holds the API's answer as JSON in `text`, and as an object in `data.answer`. Each plan comes with a rank, provider, plan, score, price per 1,000 (`perThousand`, in dollars) and a page on datacircle.dev. That page lists every field.

When the API gives no data, for example for an unknown slug, the result has `success: false` and the API's message in `error`. The model can then call again. When the network fails, the action throws an error.

## Network

Each action makes one HTTPS GET request to https://api.datacircle.dev/v1 and nothing else. The request holds only the action's own parameters: no key and nothing from your chats. The API takes up to 60 calls a minute from one IP address. The action waits once, for a minute at most, when the API asks it to wait. The plugin has no dependency and stores nothing.

## Links

- Datacircle: https://datacircle.dev
- The API: https://datacircle.dev/api
- The API's spec: https://api.datacircle.dev/v1/openapi.json
- What each key means: https://datacircle.dev/fields

MIT license.
