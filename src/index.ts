// An elizaOS plugin on Datacircle's open API: find the best GTM APIs. The API needs no key: https://api.datacircle.dev/v1
// (its spec: https://api.datacircle.dev/v1/openapi.json). More at https://datacircle.dev

import type { Action, ActionParameter, ActionResult, ContextDefinition, HandlerOptions, IAgentRuntime, Plugin } from '@elizaos/core';
import { ApiError, BASE_URL, Client, VERSION, brief, briefPlans, clamp, objects, slugify } from './client.js';
import type { Answer, DatacircleOptions } from './client.js';

export { ApiError, BASE_URL, VERSION };
export type { Answer, DatacircleOptions };

/**
 * The actions' names, as the other actions' answers give them. None holds an operation's word (list, search, get...): when the
 * user's words or Stage 1's intents hold one, elizaOS' planner offers only the actions whose names hold it, so that "retrieve the
 * best email finders" would offer DATACIRCLE_LIST_APIS alone.
 */
export const APIS = 'DATACIRCLE_APIS';
export const BEST_PLANS = 'DATACIRCLE_BEST_PLANS';
export const PLANS = 'DATACIRCLE_PLANS';
export const PROVIDER = 'DATACIRCLE_PROVIDER';

/** The context the actions belong to, which elizaOS' first stage offers the model for GTM API questions. */
export const GTM_CONTEXT = 'gtm_apis';

const GTM_CONTEXT_DEFINITION: ContextDefinition = {
  id: GTM_CONTEXT,
  label: 'GTM APIs',
  description: "Live data from Datacircle's benchmark of GTM (go-to-market) APIs, looked up by its actions: which provider is best for an API like email finder or LinkedIn profile, the plans and their prices, and where a provider ranks. Scores change as the benchmark runs, so they are never known in advance.",
  descriptionCompressed: "Live data from Datacircle's benchmark of GTM APIs, looked up by its actions: who is best for each API, plans and prices, a provider's ranks.",
  sensitivity: 'public',
  cacheStable: true,
  cacheScope: 'global',
  aliases: ['datacircle', 'gtm'],
};

const LIST_APIS_ABOUT = "Lists the GTM APIs on Datacircle's sheet (https://datacircle.dev). GTM means go-to-market. GTM APIs are the APIs sales and marketing teams use. Gives each API's slug, how many plans and providers it has and its best plan. Call it first to find an API's slug.";
const BEST_PLANS_ABOUT = "Gives an API's plans best first by their score out of 100 on Datacircle's benchmark (https://datacircle.dev), each with its rank, provider, plan, $ per 1,000 calls and its page. One provider can hold several of the best plans, so ask for more plans than the providers you need. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const SEARCH_PLANS_ABOUT = "Searches every plan on Datacircle's sheet (https://datacircle.dev), or one API's, by provider or plan name, sorted by score, provider or price. Gives how many were found and up to limit of them. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const PROVIDER_ABOUT = "Gives each API one provider sells and its rank on each on Datacircle's benchmark (https://datacircle.dev), with its best plan there, its best rank first. total is how many APIs it sells, ranked on how many of them it has a rank.";

// Tells a model that sent a provider's name to an API's action where a provider's plans are.
const FOR_PROVIDER = `A provider's plans: ${PLANS} with its name as query, like bright data, or ${PROVIDER}.`;

/** DATACIRCLE_APIS' parameters. */
export type ApisInput = { query?: string; limit?: number };
/** DATACIRCLE_BEST_PLANS' parameters. */
export type BestPlansInput = { slug: string; limit?: number };
/** DATACIRCLE_PLANS' parameters. */
export type PlansInput = { api?: string; query?: string; sort?: 'score' | 'provider' | 'price'; limit?: number; offset?: number };
/** DATACIRCLE_PROVIDER's parameters. */
export type ProviderInput = { slug: string };

const optional = (name: string, description: string, schema: ActionParameter['schema'], examples?: ActionParameter['examples']): ActionParameter =>
  ({ name, description, required: false, schema, ...(examples ? { examples } : {}) });

const LIST_APIS_PARAMETERS: ActionParameter[] = [
  optional('query', "Words of the API's name or slug, like email or linkedin profile: the APIs that hold the most of them come first. The sheet's order when left out", { type: 'string' }, ['email finder']),
  optional('limit', 'How many APIs to give, 1 to 200. 20 when left out: the sheet has about 150', { type: 'integer', minimum: 1, maximum: 200 }),
];

const BEST_PLANS_PARAMETERS: ActionParameter[] = [
  { name: 'slug', description: `The API's slug, like email-finder or linkedin-profile, as ${APIS} gives it`, required: true, schema: { type: 'string' }, examples: ['email-finder'] },
  optional('limit', 'How many plans to give, 1 to 50. 10 when left out', { type: 'integer', minimum: 1, maximum: 50 }),
];

const SEARCH_PLANS_PARAMETERS: ActionParameter[] = [
  optional('api', "Only this API's plans: its name or slug, like email-finder. A provider's name goes in query, never here. Every API when left out", { type: 'string' }),
  optional('query', "Words that must all appear in the provider's or plan's name, like bright data", { type: 'string' }, ['bright data']),
  optional('sort', 'score (best first, the default), provider (A to Z) or price (the lowest perThousand first). Only these three words', { type: 'string', enum: ['score', 'provider', 'price'] }),
  optional('limit', 'How many plans to give, 1 to 50. 10 when left out', { type: 'integer', minimum: 1, maximum: 50 }),
  optional('offset', 'How many found plans to skip first. 0 when left out', { type: 'integer', minimum: 0 }),
];

const PROVIDER_PARAMETERS: ActionParameter[] = [
  { name: 'slug', description: "The provider's slug, like bright-data, or its name, like Bright Data: the name is made a slug", required: true, schema: { type: 'string' }, examples: ['bright-data'] },
];

/** A limit the model sent, within the API's bounds, or undefined for the API's default. */
const bounded = (n: number | undefined, high: number) => (n === undefined || n < 1 ? undefined : clamp(n, 1, high));

/** An answer of 4xx (an unknown slug, a wrong argument) is the action's result as {error}, so that the model reads the API's words and can call again. */
function asResult(error: unknown): Answer {
  if (error instanceof ApiError) return { error: error.message };
  throw error;
}

async function listApisRun(client: Client, { query, limit }: ApisInput, signal?: AbortSignal): Promise<Answer> {
  let apis: Answer[];
  try {
    apis = objects(await client.get<unknown>('/apis', {}, signal));
  } catch (error) {
    return asResult(error);
  }
  const words = (query ?? '').toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const found = apis
    .map((api, order) => {
      const name = `${String(api.api ?? '')} ${String(api.slug ?? '').replace(/-/g, ' ')}`.toLowerCase();
      return { order, matched: words.filter((word) => name.includes(word)).length, api };
    })
    .filter(({ matched }) => matched > 0 || words.length === 0)
    // The most words matched first, the sheet's order within each.
    .sort((a, b) => b.matched - a.matched || a.order - b.order);
  const answer: Answer = {
    total: found.length,
    apis: found.slice(0, bounded(limit, 200) ?? 20)
      .map(({ api }) => brief(api, ['api', 'slug', 'plans', 'providers', 'best', 'bestPage', 'sheetPage'])),
  };
  if (words.length > 0 && (found.length === 0 || found[0].matched < words.length)) {
    // A provider's name sent as an API's, like Bright Data, whose data matches many APIs: where its plans are.
    answer.note = `No API's name holds every word of ${JSON.stringify(query)}. A provider's plans: ${PLANS} with its name as query, or ${PROVIDER}.`;
  }
  return answer;
}

async function bestPlansRun(client: Client, { slug, limit }: BestPlansInput, signal?: AbortSignal): Promise<Answer> {
  const api = slugify(slug ?? '');
  if (api === '') return { error: `Give an API's slug, like email-finder: ${APIS} gives every slug. ${FOR_PROVIDER}` };
  try {
    const answer = await client.get(`/apis/${api}/best`, { limit: bounded(limit, 50) }, signal);
    return { ...answer, plans: briefPlans(answer.plans) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // A provider's name sent as the API's slug: the API's words, and where a provider's plans are.
      return { error: `${error.message}. ${APIS} gives every API's slug. ${FOR_PROVIDER}` };
    }
    return asResult(error);
  }
}

async function searchPlansRun(client: Client, input: PlansInput, signal?: AbortSignal): Promise<Answer> {
  const search = (api: string, query: string) =>
    client.get('/plans', {
      api: api.trim(),
      query: query.trim(),
      sort: input.sort,
      limit: bounded(input.limit, 50),
      offset: input.offset === undefined || input.offset <= 0 ? undefined : Math.trunc(input.offset),
    }, signal);
  let api = input.api ?? '';
  let query = input.query ?? '';
  const notes: string[] = [];
  try {
    let answer: Answer;
    try {
      answer = await search(api, query);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 400 && error.message.includes('api must be') && query.trim() === '')) throw error;
      // A provider's name sent as the API: the plans whose provider or plan name holds it.
      [api, query] = ['', api];
      answer = await search(api, query);
      notes.push(`No API is named ${JSON.stringify(input.api)}: these are the plans whose provider or plan name holds it.`);
    }
    if (answer.total === 0 && query.includes('-')) {
      // A slug sent as a name, like bright-data, which no name holds: its words, like bright data. A name with a
      // hyphen, like A-Leads, is found as it is first.
      const words = query.replace(/-/g, ' ').split(/\s+/).filter(Boolean).join(' ');
      try {
        answer = await search(api, words);
        notes.push(`No provider's or plan's name holds ${JSON.stringify(query)}: these are the plans whose name holds ${JSON.stringify(words)}.`);
      } catch {
        // The first answer stands.
      }
    }
    return { ...answer, plans: briefPlans(answer.plans), ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
  } catch (error) {
    return asResult(error);
  }
}

async function providerRun(client: Client, { slug }: ProviderInput, signal?: AbortSignal): Promise<Answer> {
  const provider = slugify(slug ?? '');
  if (provider === '') return { error: "Give a provider's slug or name, like bright-data or Bright Data" };
  let answer: Answer;
  try {
    answer = await client.get(`/providers/${provider}`, {}, signal);
  } catch (error) {
    return asResult(error);
  }
  const apis = objects(answer.apis).map((entry) => {
    const plans = objects(entry.plans);
    const kept: Answer = { ...brief(entry, ['api', 'slug', 'rank', 'bestPage']), plans: plans.length };
    const best = bestPlan(plans);
    if (best) kept.best = brief(best, ['plan', 'score', 'perThousand', 'page']);
    return kept;
  });
  // Its best rank first, the APIs where it has none last, in the API's order.
  const rank = (api: Answer) => (typeof api.rank === 'number' ? api.rank : Infinity);
  apis.sort((a, b) => rank(a) - rank(b));
  return { ...answer, apis, total: apis.length, ranked: apis.filter((api) => typeof api.rank === 'number').length };
}

/** A provider's best plan on an API: its lowest rank, the first when none has a rank. */
function bestPlan(plans: Answer[]): Answer | undefined {
  const ranked = plans.filter((plan) => typeof plan.rank === 'number');
  if (ranked.length === 0) return plans[0];
  return ranked.reduce((best, plan) => ((plan.rank as number) < (best.rank as number) ? plan : best));
}

type Options = HandlerOptions | Record<string, unknown> | undefined;

/** The parameters elizaOS validated for the call, or the options themselves where a host passes them so. */
function parametersOf(options: Options): Record<string, unknown> {
  if (!options || typeof options !== 'object') return {};
  const record = options as Record<string, unknown>;
  const parameters = record.parameters;
  return parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? (parameters as Record<string, unknown>) : record;
}

function signalOf(options: Options): AbortSignal | undefined {
  const signal = options && typeof options === 'object' ? (options as Record<string, unknown>).abortSignal : undefined;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** A string the model sent, trimmed, or undefined. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** A number the model sent, as a number or a string, or undefined. */
function countOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * The action's result: the API's answer as JSON in text, which the model reads, and as data.answer for the code that
 * reads results. promptData stands in for data on the model's side, so that the model reads the answer once.
 */
function resultOf(name: string, answer: Answer): ActionResult {
  const text = JSON.stringify(answer);
  if (typeof answer.error === 'string') {
    return { success: false, text, error: answer.error, data: { actionName: name } };
  }
  return { success: true, text, data: { actionName: name, answer }, promptData: { actionName: name }, promptDataMode: 'replace-data' };
}

type Run<Input> = (client: Client, input: Input, signal?: AbortSignal) => Promise<Answer>;

function action<Input>(
  client: Client,
  spec: Pick<Action, 'name' | 'similes' | 'description' | 'descriptionCompressed' | 'routingHint' | 'parameters' | 'exampleCalls'>,
  read: (parameters: Record<string, unknown>) => Input,
  run: Run<Input>,
): Action {
  return {
    ...spec,
    tags: ['resource:web', 'capability:read'],
    contexts: [GTM_CONTEXT, 'web'],
    roleGate: { minRole: 'GUEST' },
    egress: ['api.datacircle.dev'],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options) => {
      const signal = signalOf(options);
      signal?.throwIfAborted();
      const answer = await run(client, read(parametersOf(options)), signal);
      return resultOf(spec.name, answer);
    },
  };
}

const listApisAction = (client: Client): Action =>
  action<ApisInput>(client, {
    name: APIS,
    similes: ['LIST_GTM_APIS', 'DATACIRCLE_LIST_APIS'],
    description: LIST_APIS_ABOUT,
    descriptionCompressed: "List the GTM APIs on Datacircle's sheet, each with its slug and best plan.",
    routingHint: `which GTM APIs exist, an API's slug -> ${APIS}; then ${BEST_PLANS} for who is best on one`,
    parameters: LIST_APIS_PARAMETERS,
    exampleCalls: [{ user: 'Which GTM APIs does Datacircle cover for emails?', actions: [APIS], params: { [APIS]: { query: 'email' } } }],
  }, (p) => ({ query: textOf(p.query), limit: countOf(p.limit) }), listApisRun);

const bestPlansAction = (client: Client): Action =>
  action<BestPlansInput>(client, {
    name: BEST_PLANS,
    similes: ['BEST_GTM_API', 'DATACIRCLE_BEST'],
    description: BEST_PLANS_ABOUT,
    descriptionCompressed: "One GTM API's plans, best first by Datacircle's score out of 100, with their prices.",
    routingHint: `who is best, or cheapest, for one GTM API (email finder, LinkedIn profile...) -> ${BEST_PLANS}; its slug from ${APIS}`,
    parameters: BEST_PLANS_PARAMETERS,
    exampleCalls: [{ user: 'Who are the 3 best providers for the email-finder API?', actions: [BEST_PLANS], params: { [BEST_PLANS]: { slug: 'email-finder', limit: 10 } } }],
  }, (p) => ({ slug: textOf(p.slug) ?? '', limit: countOf(p.limit) }), bestPlansRun);

const searchPlansAction = (client: Client): Action =>
  action<PlansInput>(client, {
    name: PLANS,
    similes: ['SEARCH_GTM_PLANS', 'DATACIRCLE_SEARCH_PLANS'],
    description: SEARCH_PLANS_ABOUT,
    descriptionCompressed: "Search the plans on Datacircle's sheet by provider or plan name, sorted by score, provider or price.",
    routingHint: `a provider's plans and prices, or the cheapest plans of a GTM API -> ${PLANS}; a provider's name goes in query`,
    parameters: SEARCH_PLANS_PARAMETERS,
    exampleCalls: [{ user: 'What plans does Bright Data sell, cheapest first?', actions: [PLANS], params: { [PLANS]: { query: 'bright data', sort: 'price' } } }],
  }, (p) => {
    const sort = textOf(p.sort);
    return {
      api: textOf(p.api),
      query: textOf(p.query),
      // A sort the API refuses gets its words back, so that the model can call again.
      sort: sort as PlansInput['sort'],
      limit: countOf(p.limit),
      offset: countOf(p.offset),
    };
  }, searchPlansRun);

const providerAction = (client: Client): Action =>
  action<ProviderInput>(client, {
    name: PROVIDER,
    similes: ['DATACIRCLE_PROVIDER_RANKS', 'GTM_PROVIDER_RANKS'],
    description: PROVIDER_ABOUT,
    descriptionCompressed: "Where one provider ranks on each GTM API it sells, on Datacircle's benchmark.",
    routingHint: `where one provider (Bright Data, Apollo...) ranks across GTM APIs -> ${PROVIDER}`,
    parameters: PROVIDER_PARAMETERS,
    exampleCalls: [{ user: 'Where does Bright Data rank?', actions: [PROVIDER], params: { [PROVIDER]: { slug: 'bright-data' } } }],
  }, (p) => ({ slug: textOf(p.slug) ?? '' }), providerRun);

/** The four actions: DATACIRCLE_APIS (GET /apis), DATACIRCLE_BEST_PLANS (GET /apis/{slug}/best), DATACIRCLE_PLANS (GET /plans) and DATACIRCLE_PROVIDER (GET /providers/{slug}). */
export function datacircleActions(options?: DatacircleOptions): Action[] {
  const client = new Client(options);
  return [listApisAction(client), bestPlansAction(client), searchPlansAction(client), providerAction(client)];
}

/** The plugin, with its own fetch or the API's address where a host needs them. */
export function createDatacirclePlugin(options?: DatacircleOptions): Plugin {
  return {
    name: 'datacircle',
    description: "Find the best GTM APIs on Datacircle's open API: every API on its sheet, who is best for each, every plan and a provider's ranks. No key.",
    contexts: [GTM_CONTEXT],
    actions: datacircleActions(options),
    init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
      // Registered once per runtime; a host that registered it first keeps its own.
      runtime.contexts?.tryRegister?.(GTM_CONTEXT_DEFINITION);
    },
  };
}

/** The plugin, for a character's plugins or an AgentRuntime's. */
export const datacirclePlugin: Plugin = createDatacirclePlugin();

export default datacirclePlugin;
